import { Fragment, useState } from "react";
import { useLoaderData, useFetcher, useRouteError, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { isPlatformAdmin, PLATFORM_ADMIN_SHOP } from "../platformAdmin.server.js";
import { computeExpiry, DISCOUNT_DURATION_MONTHS } from "../storeDiscount.server.js";
import { PLAN_TIERS } from "../billing.constants.js";
import { normalizePlanId } from "../billing.server.js";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import {
  ShieldCheckIcon,
  DatabaseIcon,
  SparklesIcon,
  Trash2Icon,
  HistoryIcon,
} from "../components/Icons.jsx";

/**
 * Platform Admin Panel.
 *
 * Cross-merchant view, intentionally unlike every other route in this app —
 * everything else is scoped to `session.shop`. Gated by isPlatformAdmin(),
 * checked in BOTH the loader (page access) and the action (write access),
 * because a route guard on the page alone would not stop a direct POST.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  if (!isPlatformAdmin(shop, session)) {
    // Deliberately a quiet redirect rather than a 403 page: this route's
    // existence is not something an ordinary merchant needs to know about.
    throw redirect("/app");
  }

  const [merchants, discounts, restorePointCounts, openIncidentCounts] = await Promise.all([
    prisma.appSettings.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.storeDiscount.findMany(),
    prisma.restorePoint.groupBy({ by: ["shop"], _count: { _all: true } }),
    prisma.incident.groupBy({ by: ["shop"], _count: { _all: true }, where: { status: "OPEN" } }),
  ]);

  const discountByShop = new Map(discounts.map((d) => [d.shop, d]));
  const restoreCountByShop = new Map(restorePointCounts.map((r) => [r.shop, r._count._all]));
  const incidentCountByShop = new Map(openIncidentCounts.map((r) => [r.shop, r._count._all]));

  const now = Date.now();
  const rows = merchants.map((m) => {
    const discount = discountByShop.get(m.shop) || null;
    const discountActive = Boolean(discount?.isActive && new Date(discount.expiresAt).getTime() > now);
    return {
      shop: m.shop,
      planId: normalizePlanId(m.planId),
      hasUsedTrial: m.hasUsedTrial,
      trialEndsAt: m.trialEndsAt,
      monitoringEnabled: m.monitoringEnabled,
      circuitBreakerEnabled: m.circuitBreakerEnabled,
      alertEmail: m.alertEmail,
      lastAutoBackupAt: m.lastAutoBackupAt,
      createdAt: m.createdAt,
      restorePointCount: restoreCountByShop.get(m.shop) || 0,
      openIncidentCount: incidentCountByShop.get(m.shop) || 0,
      discount: discount
        ? {
            percent: discount.discountPercent,
            note: discount.note,
            isActive: discountActive,
            expiresAt: discount.expiresAt,
            updatedByEmail: discount.updatedByEmail,
            updatedAt: discount.updatedAt,
          }
        : null,
    };
  });

  return { merchants: rows, adminShop: PLATFORM_ADMIN_SHOP, durationMonths: DISCOUNT_DURATION_MONTHS };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Re-checked here independently of the loader: a direct POST to this route
  // must be refused even if it never rendered the page.
  if (!isPlatformAdmin(shop, session)) {
    return { success: false, message: "You do not have access to this action." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetShop = String(formData.get("targetShop") || "").trim().toLowerCase();
  const adminEmail = (session.email || "").trim().toLowerCase();

  if (!targetShop) {
    return { success: false, message: "Choose a merchant store first." };
  }

  const merchant = await prisma.appSettings.findUnique({ where: { shop: targetShop } });
  if (!merchant) {
    return { success: false, message: `"${targetShop}" is not a known merchant store.` };
  }

  if (intent === "setDiscount") {
    const rawPercent = formData.get("discountPercent");
    const percent = parseInt(String(rawPercent ?? "").trim(), 10);
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: "Discount must be a whole number percentage between 1 and 100." };
    }
    const note = String(formData.get("note") || "").trim().slice(0, 500) || null;
    const expiresAt = computeExpiry();

    const existing = await prisma.storeDiscount.findUnique({ where: { shop: targetShop } });

    await prisma.storeDiscount.upsert({
      where: { shop: targetShop },
      create: {
        shop: targetShop,
        discountPercent: percent,
        note,
        isActive: true,
        expiresAt,
        createdByEmail: adminEmail || null,
        updatedByEmail: adminEmail || null,
      },
      update: {
        discountPercent: percent,
        note,
        isActive: true,
        expiresAt,
        updatedByEmail: adminEmail || null,
      },
    });

    await prisma.auditLog.create({
      data: {
        shop: targetShop,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action: existing ? "ADMIN_DISCOUNT_UPDATED" : "ADMIN_DISCOUNT_GRANTED",
        resourceType: "StoreDiscount",
        details: { discountPercent: percent, note, expiresAt, durationMonths: DISCOUNT_DURATION_MONTHS },
      },
    }).catch(() => {});

    return {
      success: true,
      message: `${percent}% yearly discount ${existing ? "updated" : "granted"} for ${targetShop}, valid until ${expiresAt.toISOString().slice(0, 10)}.`,
    };
  }

  if (intent === "removeDiscount") {
    const existing = await prisma.storeDiscount.findUnique({ where: { shop: targetShop } });
    if (!existing) {
      return { success: false, message: `${targetShop} has no discount to remove.` };
    }

    // Soft-disable rather than delete, so the grant/removal history survives
    // for the audit trail — consistent with how the rest of this app treats
    // removal (suspended team members, disconnected cloud sync, etc).
    await prisma.storeDiscount.update({
      where: { shop: targetShop },
      data: { isActive: false, updatedByEmail: adminEmail || null },
    });

    await prisma.auditLog.create({
      data: {
        shop: targetShop,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action: "ADMIN_DISCOUNT_REMOVED",
        resourceType: "StoreDiscount",
        details: { previousPercent: existing.discountPercent },
      },
    }).catch(() => {});

    return { success: true, message: `Discount removed for ${targetShop}.` };
  }

  return { success: false, message: "Unknown action." };
};

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 10);
}

export default function AdminPanel() {
  const { merchants, durationMonths } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  const [editingShop, setEditingShop] = useState(null);
  const [percentDraft, setPercentDraft] = useState("10");
  const [noteDraft, setNoteDraft] = useState("");

  function startEditing(row) {
    setEditingShop(row.shop);
    setPercentDraft(String(row.discount?.percent ?? 10));
    setNoteDraft(row.discount?.note ?? "");
  }

  return (
    <s-page heading="Platform Admin" inlineSize="large">
      <div className="rv-settings-wrapper">
        <Banner tone="info" title="Operator-only panel" className="rv-fade-in">
          This page is visible only to the platform admin&apos;s login. Merchants never see this — the
          discount you grant here shows up automatically on that store&apos;s own Plans &amp; Billing page.
        </Banner>

        {result?.message && (
          <Banner tone={result.success ? "success" : "critical"} title={result.success ? "Done" : "Could not complete"} className="rv-fade-in">
            {result.message}
          </Banner>
        )}

        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge info">
                <DatabaseIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                  Merchant Stores ({merchants.length})
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Every store that has installed the app. Grant or update a yearly discount for any of them.
                </p>
              </div>
            </div>
          </div>

          <div className="rv-card-body">
            {merchants.length === 0 ? (
              <EmptyState
                icon={<DatabaseIcon size={22} />}
                title="No merchant stores yet"
                description="Stores will appear here once they install the app."
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="rv-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Store</th>
                      <th>Plan</th>
                      <th>Discount</th>
                      <th>Backups</th>
                      <th>Open Incidents</th>
                      <th>Installed</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {merchants.map((row) => (
                      <Fragment key={row.shop}>
                        <tr>
                          <td>
                            <strong>{row.shop}</strong>
                            {row.alertEmail && (
                              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{row.alertEmail}</div>
                            )}
                          </td>
                          <td>
                            <span className="rv-badge rv-badge-neutral" style={{ textTransform: "uppercase", fontWeight: 700 }}>
                              {PLAN_TIERS[row.planId]?.name || row.planId}
                            </span>
                          </td>
                          <td>
                            {row.discount?.isActive ? (
                              <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                                <SparklesIcon size={12} /> {row.discount.percent}% until {formatDate(row.discount.expiresAt)}
                              </span>
                            ) : (
                              <span className="rv-badge rv-badge-neutral">None</span>
                            )}
                          </td>
                          <td>{row.restorePointCount}</td>
                          <td>
                            {row.openIncidentCount > 0 ? (
                              <span className="rv-badge rv-badge-critical">{row.openIncidentCount}</span>
                            ) : (
                              <span className="rv-badge rv-badge-neutral">0</span>
                            )}
                          </td>
                          <td>{formatDate(row.createdAt)}</td>
                          <td>
                            <div style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                className="rv-btn rv-btn-secondary rv-btn-sm"
                                onClick={() => (editingShop === row.shop ? setEditingShop(null) : startEditing(row))}
                              >
                                <SparklesIcon size={14} />
                                <span>{row.discount?.isActive ? "Edit" : "Grant"}</span>
                              </button>
                              {row.discount?.isActive && (
                                <fetcher.Form method="POST" style={{ display: "inline" }}>
                                  <input type="hidden" name="intent" value="removeDiscount" />
                                  <input type="hidden" name="targetShop" value={row.shop} />
                                  <button
                                    type="submit"
                                    disabled={busy}
                                    className="rv-btn rv-btn-danger rv-btn-sm"
                                    onClick={(e) => {
                                      if (!window.confirm(`Remove the ${row.discount.percent}% discount for ${row.shop}?`)) {
                                        e.preventDefault();
                                      }
                                    }}
                                  >
                                    <Trash2Icon size={14} />
                                  </button>
                                </fetcher.Form>
                              )}
                            </div>
                          </td>
                        </tr>

                        {editingShop === row.shop && (
                          <tr>
                            <td colSpan={7} style={{ background: "var(--rv-surface-subdued)" }}>
                              <fetcher.Form
                                method="POST"
                                style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap", padding: "12px 4px" }}
                                onSubmit={() => setEditingShop(null)}
                              >
                                <input type="hidden" name="intent" value="setDiscount" />
                                <input type="hidden" name="targetShop" value={row.shop} />
                                <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                                  <label className="rv-form-label" htmlFor={`percent-${row.shop}`}>
                                    Discount %
                                  </label>
                                  <div className="rv-input-group">
                                    <input
                                      id={`percent-${row.shop}`}
                                      type="number"
                                      min="1"
                                      max="100"
                                      required
                                      name="discountPercent"
                                      value={percentDraft}
                                      onChange={(e) => setPercentDraft(e.target.value)}
                                      className="rv-input"
                                    />
                                    <span className="rv-input-suffix">%</span>
                                  </div>
                                </div>
                                <div className="rv-form-field" style={{ flex: 1, minWidth: "220px" }}>
                                  <label className="rv-form-label" htmlFor={`note-${row.shop}`}>
                                    Internal note (optional)
                                  </label>
                                  <input
                                    id={`note-${row.shop}`}
                                    type="text"
                                    name="note"
                                    value={noteDraft}
                                    onChange={(e) => setNoteDraft(e.target.value)}
                                    placeholder="e.g. Loyalty renewal, partner deal"
                                    className="rv-input"
                                    style={{ width: "100%" }}
                                  />
                                </div>
                                <button type="submit" disabled={busy} className="rv-btn rv-btn-primary rv-btn-sm">
                                  <HistoryIcon size={14} />
                                  <span>{busy ? "Saving..." : `Apply (valid ${durationMonths} months)`}</span>
                                </button>
                                <button
                                  type="button"
                                  className="rv-btn rv-btn-secondary rv-btn-sm"
                                  onClick={() => setEditingShop(null)}
                                >
                                  Cancel
                                </button>
                              </fetcher.Form>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge success">
                <ShieldCheckIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>How this works</h3>
              </div>
            </div>
          </div>
          <div className="rv-card-body" style={{ fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6 }}>
            <ul style={{ margin: 0, paddingLeft: "18px" }}>
              <li>A discount is always granted for {durationMonths} months from the moment you set or update it.</li>
              <li>The merchant sees it immediately on their own Plans &amp; Billing page — no separate sync step.</li>
              <li>If they upgrade or renew while it&apos;s active, the discount is applied to the real Shopify subscription charge for {durationMonths} billing cycles.</li>
              <li>Removing a discount here disables it immediately; it does not retroactively change a subscription that already applied it.</li>
            </ul>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
