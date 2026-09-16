import { Fragment, useState } from "react";
import { useLoaderData, useFetcher, useRouteError, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { isPlatformAdmin, getSessionEmail, PLATFORM_ADMIN_SHOP } from "../platformAdmin.server.js";
import {
  computeExpiry,
  getPlatformSettings,
  getActiveGlobalDiscount,
  isStoreDiscountInForce,
} from "../storeDiscount.server.js";
import { getFreeGrowthStatus } from "../freeGrowth.server.js";
import {
  DISCOUNT_DURATION_MONTHS,
  normalizeTier,
  TIER_STANDARD,
  TIER_VIP,
} from "../discount.constants.js";
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

  const [
    settingsRows,
    installedShops,
    discounts,
    restorePointCounts,
    openIncidentCounts,
    platformSettings,
    freeGrowth,
    freeGrowthGrants,
  ] = await Promise.all([
    prisma.appSettings.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.session.findMany({ distinct: ["shop"], select: { shop: true } }),
    prisma.storeDiscount.findMany(),
    prisma.restorePoint.groupBy({ by: ["shop"], _count: { _all: true } }),
    prisma.incident.groupBy({ by: ["shop"], _count: { _all: true }, where: { status: "OPEN" } }),
    getPlatformSettings(),
    getFreeGrowthStatus(),
    prisma.freeGrowthGrant.findMany(),
  ]);

  // AppSettings rows are written lazily, so a store can be installed without
  // one. Union the two lists so a freshly-installed merchant is still visible
  // here — and therefore still grantable.
  const settingsByShop = new Map(settingsRows.map((s) => [s.shop, s]));
  const merchants = [
    ...settingsRows,
    ...installedShops.filter((s) => !settingsByShop.has(s.shop)).map((s) => ({ shop: s.shop })),
  ];

  const discountByShop = new Map(discounts.map((d) => [d.shop, d]));
  const restoreCountByShop = new Map(restorePointCounts.map((r) => [r.shop, r._count._all]));
  const incidentCountByShop = new Map(openIncidentCounts.map((r) => [r.shop, r._count._all]));
  const freeGrowthByShop = new Map(freeGrowthGrants.map((g) => [g.shop, g]));

  const now = Date.now();
  const globalDiscount = await getActiveGlobalDiscount(platformSettings);

  const rows = merchants.map((m) => {
    const discount = discountByShop.get(m.shop) || null;
    // An unclaimed VIP offer discounts nothing, so it must not count here
    // either — the admin's "Effective" column has to match what the merchant
    // is actually charged.
    const discountActive = isStoreDiscountInForce(discount);
    const awaitingClaim = Boolean(
      discount?.isActive && normalizeTier(discount.tier) === TIER_VIP && !discount.claimedAt,
    );
    const seat = freeGrowthByShop.get(m.shop) || null;
    const seatActive = Boolean(seat && new Date(seat.expiresAt).getTime() > now);

    // Mirrors resolveBestDiscount(): largest wins, store-specific breaks ties.
    const storePercent = discountActive ? discount.discountPercent : 0;
    const globalPercent = globalDiscount ? globalDiscount.percent : 0;
    const effective =
      storePercent === 0 && globalPercent === 0
        ? null
        : storePercent >= globalPercent
          ? { percent: storePercent, source: normalizeTier(discount?.tier) }
          : { percent: globalPercent, source: "GLOBAL" };

    const normPlan = normalizePlanId(m.planId);
    const planOrder = PLAN_TIERS[normPlan]?.order ?? 0;
    const effectivePlanId = seatActive && planOrder < (PLAN_TIERS.growth?.order ?? 2) ? "growth" : normPlan;

    return {
      shop: m.shop,
      planId: effectivePlanId,
      hasUsedTrial: Boolean(m.hasUsedTrial),
      trialEndsAt: m.trialEndsAt ?? null,
      monitoringEnabled: Boolean(m.monitoringEnabled),
      circuitBreakerEnabled: Boolean(m.circuitBreakerEnabled),
      alertEmail: m.alertEmail ?? null,
      lastAutoBackupAt: m.lastAutoBackupAt ?? null,
      firstSeenAt: m.createdAt ?? null,
      restorePointCount: restoreCountByShop.get(m.shop) || 0,
      openIncidentCount: incidentCountByShop.get(m.shop) || 0,
      discount: discount
        ? {
            percent: discount.discountPercent,
            tier: normalizeTier(discount.tier),
            note: discount.note,
            isActive: discountActive,
            awaitingClaim,
            claimedAt: discount.claimedAt,
            expiresAt: discount.expiresAt,
            updatedByEmail: discount.updatedByEmail,
            updatedAt: discount.updatedAt,
          }
        : null,
      effectiveDiscount: effective,
      freeGrowthSeat: seat ? { expiresAt: seat.expiresAt, isActive: seatActive } : null,
    };
  });

  return {
    merchants: rows,
    adminShop: PLATFORM_ADMIN_SHOP,
    durationMonths: DISCOUNT_DURATION_MONTHS,
    global: {
      percent: platformSettings.globalDiscountPercent,
      note: platformSettings.globalDiscountNote,
      isActive: Boolean(globalDiscount),
      expiresAt: platformSettings.globalDiscountExpiresAt,
    },
    freeGrowth,
  };
};

/** Strict 1-100 whole percent, or null. parseInt would accept "50abc"/"1e9". */
function parsePercent(raw) {
  const s = String(raw ?? "").trim();
  const n = /^\d{1,3}$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/**
 * Truncate by code point: slicing UTF-16 units can split an emoji's surrogate
 * pair, which MySQL rejects outright.
 */
function truncateNote(raw) {
  return Array.from(String(raw || "").trim()).slice(0, 500).join("") || null;
}

/**
 * Platform-wide audit entries have no single merchant to file under, so they
 * are recorded against the operator's own store.
 */
async function writeAdminAudit(action, adminEmail, details) {
  await prisma.auditLog
    .create({
      data: {
        shop: PLATFORM_ADMIN_SHOP,
        userEmail: adminEmail || null,
        userName: "Platform Admin",
        action,
        resourceType: "PlatformSettings",
        details,
      },
    })
    .catch(() => {});
}

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
  const adminEmail = getSessionEmail(session);

  // ── Platform-wide intents (no target store) ──────────────────────────────

  if (intent === "setGlobalDiscount") {
    const percent = parsePercent(formData.get("globalDiscountPercent"));
    if (percent === null) {
      return { success: false, message: "Global discount must be a whole number percentage between 1 and 100." };
    }
    const note = truncateNote(formData.get("globalNote"));
    const expiresAt = computeExpiry();

    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        globalDiscountPercent: percent,
        globalDiscountNote: note,
        globalDiscountActive: true,
        globalDiscountExpiresAt: expiresAt,
        updatedByEmail: adminEmail || null,
      },
      update: {
        globalDiscountPercent: percent,
        globalDiscountNote: note,
        globalDiscountActive: true,
        globalDiscountExpiresAt: expiresAt,
        updatedByEmail: adminEmail || null,
      },
    });

    await writeAdminAudit("ADMIN_GLOBAL_DISCOUNT_SET", adminEmail, {
      discountPercent: percent,
      note,
      expiresAt,
    });

    return {
      success: true,
      message: `${percent}% global discount is now live for every store, until ${formatDate(expiresAt)}.`,
    };
  }

  if (intent === "clearGlobalDiscount") {
    const current = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    if (!current?.globalDiscountActive) {
      return { success: false, message: "There is no active global discount to turn off." };
    }
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { globalDiscountActive: false, updatedByEmail: adminEmail || null },
    });
    await writeAdminAudit("ADMIN_GLOBAL_DISCOUNT_CLEARED", adminEmail, {
      previousPercent: current.globalDiscountPercent,
    });
    return { success: true, message: "Global discount turned off. Store-specific discounts are unaffected." };
  }

  if (intent === "updateFreeGrowth") {
    const rawLimit = String(formData.get("freeGrowthSeatLimit") ?? "").trim();
    const limit = /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      return { success: false, message: "Seat limit must be a whole number between 0 and 1000." };
    }
    const enabled = formData.get("freeGrowthEnabled") === "1";

    const used = await prisma.freeGrowthGrant.count();
    if (limit < used) {
      return {
        success: false,
        message: `${used} seats are already awarded, so the limit cannot be lowered to ${limit}. Existing seats are never revoked automatically.`,
      };
    }

    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, freeGrowthEnabled: enabled, freeGrowthSeatLimit: limit, updatedByEmail: adminEmail || null },
      update: { freeGrowthEnabled: enabled, freeGrowthSeatLimit: limit, updatedByEmail: adminEmail || null },
    });

    await writeAdminAudit("ADMIN_FREE_GROWTH_UPDATED", adminEmail, { enabled, seatLimit: limit });

    return {
      success: true,
      message: enabled
        ? `Free Growth promotion is on, ${limit} seats total (${used} already awarded).`
        : "Free Growth promotion is off. Stores that already hold a seat keep it until it expires.",
    };
  }

  // ── Store-scoped intents ─────────────────────────────────────────────────

  if (!targetShop) {
    return { success: false, message: "Choose a merchant store first." };
  }

  // Mirrors the loader's union: a store with a live session but no settings
  // row yet is still a real merchant.
  const [merchantSettings, merchantSession] = await Promise.all([
    prisma.appSettings.findUnique({ where: { shop: targetShop } }),
    prisma.session.findFirst({ where: { shop: targetShop }, select: { id: true } }),
  ]);
  if (!merchantSettings && !merchantSession) {
    return { success: false, message: `"${targetShop}" is not a known merchant store.` };
  }

  if (intent === "setDiscount") {
    const percent = parsePercent(formData.get("discountPercent"));
    if (percent === null) {
      return { success: false, message: "Discount must be a whole number percentage between 1 and 100." };
    }
    const tier = normalizeTier(formData.get("tier"));
    const note = truncateNote(formData.get("note"));
    const expiresAt = computeExpiry();

    const existing = await prisma.storeDiscount.findUnique({ where: { shop: targetShop } });

    await prisma.storeDiscount.upsert({
      where: { shop: targetShop },
      create: {
        shop: targetShop,
        tier,
        discountPercent: percent,
        note,
        isActive: true,
        expiresAt,
        createdByEmail: adminEmail || null,
        updatedByEmail: adminEmail || null,
      },
      update: {
        tier,
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
        details: { discountPercent: percent, tier, note, expiresAt, durationMonths: DISCOUNT_DURATION_MONTHS },
      },
    }).catch(() => {});

    return {
      success: true,
      message: `${percent}% ${tier === TIER_VIP ? "VIP " : ""}discount ${existing ? "updated" : "granted"} for ${targetShop}, valid until ${formatDate(expiresAt)}.`,
    };
  }

  if (intent === "removeDiscount") {
    const existing = await prisma.storeDiscount.findUnique({ where: { shop: targetShop } });
    if (!existing || !existing.isActive) {
      return { success: false, message: `${targetShop} has no active discount to remove.` };
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

const EFFECTIVE_LABELS = {
  VIP: "VIP",
  STANDARD: "store",
  GLOBAL: "global",
};

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 10);
}

export default function AdminPanel() {
  const { merchants, durationMonths, global: globalDiscount, freeGrowth } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  const [editingShop, setEditingShop] = useState(null);
  const [percentDraft, setPercentDraft] = useState("10");
  const [noteDraft, setNoteDraft] = useState("");
  const [tierDraft, setTierDraft] = useState(TIER_STANDARD);

  const [globalPercentDraft, setGlobalPercentDraft] = useState(String(globalDiscount.percent ?? 10));
  const [globalNoteDraft, setGlobalNoteDraft] = useState(globalDiscount.note ?? "");
  const [seatLimitDraft, setSeatLimitDraft] = useState(String(freeGrowth.limit));
  const [freeGrowthOn, setFreeGrowthOn] = useState(freeGrowth.enabled);

  function startEditing(row) {
    setEditingShop(row.shop);
    setPercentDraft(String(row.discount?.percent ?? 10));
    setNoteDraft(row.discount?.note ?? "");
    setTierDraft(row.discount?.tier ?? TIER_STANDARD);
  }

  const seatPct = freeGrowth.limit > 0 ? Math.min(100, (freeGrowth.used / freeGrowth.limit) * 100) : 0;

  return (
    <s-page heading="Platform Admin" inlineSize="large">
      <div className="rv-settings-wrapper">
        <Banner tone="info" title="Operator-only panel" className="rv-fade-in">
          This page is visible only to the platform admin&apos;s login. Merchants never see this — anything
          you set here shows up automatically on the affected store&apos;s own Plans &amp; Billing page.
        </Banner>

        {result?.message && (
          <Banner tone={result.success ? "success" : "critical"} title={result.success ? "Done" : "Could not complete"} className="rv-fade-in">
            {result.message}
          </Banner>
        )}

        {/* ── Global yearly discount ── */}
        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge info">
                <SparklesIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>Global Yearly Discount</h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Applies to every store at once. A store with a bigger discount of its own keeps that instead —
                  discounts never stack.
                </p>
              </div>
            </div>
            {globalDiscount.isActive ? (
              <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                Live · {globalDiscount.percent}% until {formatDate(globalDiscount.expiresAt)}
              </span>
            ) : (
              <span className="rv-badge rv-badge-neutral">Off</span>
            )}
          </div>

          <div className="rv-card-body">
            <fetcher.Form method="POST" style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap" }}>
              <input type="hidden" name="intent" value="setGlobalDiscount" />
              <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                <label className="rv-form-label" htmlFor="global-percent">Discount %</label>
                <div className="rv-input-group">
                  <input
                    id="global-percent"
                    type="number"
                    min="1"
                    max="100"
                    required
                    name="globalDiscountPercent"
                    value={globalPercentDraft}
                    onChange={(e) => setGlobalPercentDraft(e.target.value)}
                    className="rv-input"
                  />
                  <span className="rv-input-suffix">%</span>
                </div>
              </div>
              <div className="rv-form-field" style={{ flex: 1, minWidth: "220px" }}>
                <label className="rv-form-label" htmlFor="global-note">Internal note (optional)</label>
                <input
                  id="global-note"
                  type="text"
                  name="globalNote"
                  value={globalNoteDraft}
                  onChange={(e) => setGlobalNoteDraft(e.target.value)}
                  placeholder="e.g. Black Friday campaign"
                  className="rv-input"
                  style={{ width: "100%" }}
                />
              </div>
              <button type="submit" disabled={busy} className="rv-btn rv-btn-primary rv-btn-sm">
                <SparklesIcon size={14} />
                <span>{busy ? "Saving..." : `Apply to all stores (${durationMonths} months)`}</span>
              </button>
            </fetcher.Form>

            {globalDiscount.isActive && (
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="clearGlobalDiscount" />
                <button
                  type="submit"
                  disabled={busy}
                  className="rv-btn rv-btn-critical rv-btn-sm"
                  onClick={(e) => {
                    if (!window.confirm("Turn off the global discount for every store?")) e.preventDefault();
                  }}
                >
                  <Trash2Icon size={14} />
                  <span>Turn off global discount</span>
                </button>
              </fetcher.Form>
            )}
          </div>
        </div>

        {/* ── Free Growth promotion ── */}
        <div className="rv-card" style={{ margin: "20px 0" }}>
          <div className="rv-card-header">
            <div className="rv-card-icon-title">
              <div className="rv-card-icon-badge success">
                <ShieldCheckIcon size={20} />
              </div>
              <div>
                <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                  Free Growth for the first {freeGrowth.limit} stores to claim
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Offered to every installed store while places remain. A place is taken only when the
                  merchant claims it, giving full Growth features at no charge for {durationMonths} months
                  with no Shopify subscription created.
                </p>
              </div>
            </div>
            <span className={`rv-badge ${freeGrowth.enabled ? "rv-badge-success" : "rv-badge-neutral"}`} style={{ fontWeight: 700 }}>
              {freeGrowth.enabled ? "Running" : "Paused"}
            </span>
          </div>

          <div className="rv-card-body">
            <div style={{ marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                <strong>{freeGrowth.used} of {freeGrowth.limit} seats claimed</strong>
                <span style={{ color: "var(--rv-text-subdued)" }}>{freeGrowth.remaining} left</span>
              </div>
              <div style={{ height: "8px", borderRadius: "999px", background: "var(--rv-surface-subdued)", overflow: "hidden" }}>
                <div style={{ width: `${seatPct}%`, height: "100%", background: "var(--rv-primary)" }} />
              </div>
            </div>

            <fetcher.Form method="POST" style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap" }}>
              <input type="hidden" name="intent" value="updateFreeGrowth" />
              <input type="hidden" name="freeGrowthEnabled" value={freeGrowthOn ? "1" : "0"} />
              <div className="rv-form-field" style={{ maxWidth: "160px" }}>
                <label className="rv-form-label" htmlFor="seat-limit">Total seats</label>
                <input
                  id="seat-limit"
                  type="number"
                  min={freeGrowth.used}
                  max="1000"
                  required
                  name="freeGrowthSeatLimit"
                  value={seatLimitDraft}
                  onChange={(e) => setSeatLimitDraft(e.target.value)}
                  className="rv-input"
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", paddingBottom: "8px" }}>
                <input
                  type="checkbox"
                  checked={freeGrowthOn}
                  onChange={(e) => setFreeGrowthOn(e.target.checked)}
                />
                <span>Offer seats to merchants</span>
              </label>
              <button type="submit" disabled={busy} className="rv-btn rv-btn-primary rv-btn-sm">
                <HistoryIcon size={14} />
                <span>{busy ? "Saving..." : "Save promotion"}</span>
              </button>
            </fetcher.Form>

            <p style={{ margin: "12px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              Stores that install but never claim take up nothing, so you always give away{" "}
              {freeGrowth.limit} real activations. A seat returns to the pool when that store uninstalls.
              Seats are never revoked automatically, so the total cannot be lowered below {freeGrowth.used}.
            </p>
          </div>
        </div>

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
                      <th>Store discount</th>
                      <th>Effective</th>
                      <th>Backups</th>
                      <th>Open Incidents</th>
                      <th>First seen</th>
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
                            {row.freeGrowthSeat?.isActive && (
                              <div style={{ marginTop: "4px" }}>
                                <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                                  Free Growth · to {formatDate(row.freeGrowthSeat.expiresAt)}
                                </span>
                              </div>
                            )}
                          </td>
                          <td>
                            {row.discount?.awaitingClaim ? (
                              <span className="rv-badge rv-badge-warning" style={{ fontWeight: 700 }}>
                                VIP {row.discount.percent}% · awaiting claim
                              </span>
                            ) : row.discount?.isActive ? (
                              <span
                                className={`rv-badge ${row.discount.tier === TIER_VIP ? "rv-badge-info" : "rv-badge-success"}`}
                                style={{ fontWeight: 700 }}
                              >
                                <SparklesIcon size={12} />{" "}
                                {row.discount.tier === TIER_VIP ? "VIP " : ""}
                                {row.discount.percent}% until {formatDate(row.discount.expiresAt)}
                              </span>
                            ) : (
                              <span className="rv-badge rv-badge-neutral">None</span>
                            )}
                          </td>
                          <td>
                            {row.effectiveDiscount ? (
                              <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                                {row.effectiveDiscount.percent}%
                                <span style={{ fontWeight: 500, marginLeft: "4px" }}>
                                  ({EFFECTIVE_LABELS[row.effectiveDiscount.source]})
                                </span>
                              </span>
                            ) : (
                              <span className="rv-badge rv-badge-neutral">—</span>
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
                          <td>{formatDate(row.firstSeenAt)}</td>
                          <td>
                            <div style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                className="rv-btn rv-btn-secondary rv-btn-sm"
                                onClick={() => (editingShop === row.shop ? setEditingShop(null) : startEditing(row))}
                              >
                                <SparklesIcon size={14} />
                                <span>{row.discount?.isActive || row.discount?.awaitingClaim ? "Edit" : "Grant"}</span>
                              </button>
                              {(row.discount?.isActive || row.discount?.awaitingClaim) && (
                                <fetcher.Form method="POST" style={{ display: "inline" }}>
                                  <input type="hidden" name="intent" value="removeDiscount" />
                                  <input type="hidden" name="targetShop" value={row.shop} />
                                  <button
                                    type="submit"
                                    disabled={busy}
                                    className="rv-btn rv-btn-critical rv-btn-sm"
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
                            <td colSpan={8} style={{ background: "var(--rv-surface-subdued)" }}>
                              <fetcher.Form
                                method="POST"
                                style={{ display: "flex", alignItems: "flex-end", gap: "14px", flexWrap: "wrap", padding: "12px 4px" }}
                                onSubmit={() => setEditingShop(null)}
                              >
                                <input type="hidden" name="intent" value="setDiscount" />
                                <input type="hidden" name="targetShop" value={row.shop} />
                                <div className="rv-form-field" style={{ maxWidth: "150px" }}>
                                  <label className="rv-form-label" htmlFor={`tier-${row.shop}`}>
                                    Discount type
                                  </label>
                                  <select
                                    id={`tier-${row.shop}`}
                                    name="tier"
                                    value={tierDraft}
                                    onChange={(e) => setTierDraft(e.target.value)}
                                    className="rv-input"
                                  >
                                    <option value={TIER_STANDARD}>Standard</option>
                                    <option value={TIER_VIP}>VIP</option>
                                  </select>
                                </div>
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
              <li>
                <strong>Discounts never stack.</strong> A store gets the single largest one it qualifies for —
                its own VIP or standard grant, or the global discount, whichever is bigger. The
                &ldquo;Effective&rdquo; column shows which one actually applies.
              </li>
              <li>
                <strong>VIP is a label on the store&apos;s own grant</strong>, not a second discount. Switching a
                store between Standard and VIP changes how it is badged for the merchant, not how many
                discounts they hold.
              </li>
              <li>
                <strong>A VIP grant is an offer the merchant must claim.</strong> It discounts nothing and
                shows as &ldquo;awaiting claim&rdquo; until they accept it on their own Plans &amp; Billing
                page. Their {durationMonths} months start from the claim, not from when you granted it, so
                there is no penalty for them deciding later. Standard and global discounts apply
                immediately, with no claim step.
              </li>
              <li>
                <strong>Free Growth is separate from discounts</strong>, and is also claimed by the merchant.
                It gives Growth features at no charge and creates no Shopify subscription. A seat holder who
                upgrades to Business or Enterprise pays for that plan, with their best discount applied.
              </li>
              <li>It reaches the real Shopify charge only when they start or switch to a paid plan, and then lasts {durationMonths} billing cycles.</li>
              <li>
                A merchant already on a paid plan keeps paying their current price until they apply it —
                their Plans &amp; Billing page prompts them to do so.
              </li>
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
