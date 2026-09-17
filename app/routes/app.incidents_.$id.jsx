import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rollbackProductFields } from "../monitor.server.js";
import { checkFeatureAccess } from "../billing.server.js";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  BoxIcon,
  ArrowLeftIcon,
  HistoryIcon,
  ShieldCheckIcon,
  RefreshCwIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { logAudit } from "../team.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const incidentId = parseInt(params.id, 10);

  const [incident, bulkCheck] = await Promise.all([
    prisma.incident.findFirst({
      where: { id: incidentId, shop },
      include: {
        changes: { orderBy: { changedAt: "desc" } },
        triggeredRule: true,
        rollbackJobs: {
          orderBy: { createdAt: "desc" },
          include: { results: true },
        },
      },
    }),
    checkFeatureAccess(shop, "bulkRollback"),
  ]);

  if (!incident) throw new Response("Not Found", { status: 404 });

  // Group changes by product for rollback preview
  const byProduct = {};
  for (const c of incident.changes) {
    if (!byProduct[c.productId]) {
      byProduct[c.productId] = { title: c.productTitle, changes: [] };
    }
    byProduct[c.productId].changes.push(c);
  }

  return { incident, byProduct, hasBulkRollback: bulkCheck.allowed };
};

export const action = async ({ request, params }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;
    const incidentId = parseInt(params.id, 10);
    if (!incidentId || isNaN(incidentId)) {
      return { success: false, message: "Invalid incident ID." };
    }
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "resolve") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
      await logAudit(shop, session, "INCIDENT_RESOLVE", { incidentId, name: incident?.name });
      return { success: true, message: "Incident marked as resolved." };
    }

    if (intent === "ignore") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "IGNORED", resolvedAt: new Date() },
      });
      const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
      await logAudit(shop, session, "INCIDENT_IGNORE", { incidentId, name: incident?.name });
      return { success: true, message: "Incident marked as ignored." };
    }

    if (intent === "reopen") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "OPEN", resolvedAt: null },
      });
      const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
      await logAudit(shop, session, "INCIDENT_REOPEN", { incidentId, name: incident?.name });
      return { success: true, message: "Incident reopened as Open." };
    }

    if (intent === "rollback") {
      const changes = await prisma.changeEvent.findMany({
        where: { incidentId, shop },
      });

      const byProduct = {};
      for (const c of changes) {
        if (!byProduct[c.productId]) byProduct[c.productId] = [];
        byProduct[c.productId].push(c.id);
      }

      const productCount = Object.keys(byProduct).length;
      if (productCount > 1) {
        const bulkCheck = await checkFeatureAccess(shop, "bulkRollback");
        if (!bulkCheck.allowed) {
          return {
            success: false,
            message: `Bulk rollback of multi-product incidents (${productCount} products) requires Growth, Business, or Enterprise. Free and Starter plans include manual single-product rollback.`,
          };
        }
      }

      const job = await prisma.rollbackJob.create({
        data: {
          shop,
          incidentId,
          status: "RUNNING",
          totalProducts: productCount,
        },
      });

      let successCount = 0;
      let failedCount = 0;

      for (const [productId, eventIds] of Object.entries(byProduct)) {
        const result = await rollbackProductFields(admin, shop, productId, eventIds);

        await prisma.rollbackResult.create({
          data: {
            rollbackJobId: job.id,
            productId,
            productTitle:
              changes.find((c) => c.productId === productId)?.productTitle ||
              productId,
            status: result.success ? "SUCCESS" : "FAILED",
            errorMessage: result.error || null,
            restoredFields: result.restoredFields || {},
          },
        });

        if (result.success) successCount++;
        else failedCount++;
      }

      const finalStatus =
        failedCount === 0 ? "COMPLETED" : successCount === 0 ? "FAILED" : "PARTIAL";

      await prisma.rollbackJob.update({
        where: { id: job.id },
        data: {
          status: finalStatus,
          processedCount: successCount + failedCount,
          successCount,
          failedCount,
          completedAt: new Date(),
        },
      });

      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "ROLLED_BACK", resolvedAt: new Date() },
      });

      return {
        success: true,
        message: `Rollback ${finalStatus.toLowerCase()}: ${successCount} products restored, ${failedCount} failed.`,
      };
    }

    return { success: false, message: "Action failed." };
  } catch (error) {
    console.error("Incident action error:", error);
    return {
      success: false,
      message: error?.message || "An unexpected error occurred while processing the incident.",
    };
  }
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function fieldLabel(fn) {
  return fn.replace("variant.", "Variant ").replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

export default function IncidentDetail() {
  const { incident, byProduct, hasBulkRollback } = useLoaderData();
  const fetcher = useFetcher();
  const isRolling = fetcher.state !== "idle";
  const result = fetcher.data;

  const productCount = Object.keys(byProduct).length;
  const isBulkBlocked = productCount > 1 && !hasBulkRollback;
  const canRollback = incident.status === "OPEN";

  return (
    <s-page
      heading={incident.name}
      backAction={{ url: "/app/incidents", label: "Incidents" }}
      inlineSize="large"
    >
      {/* ── Status & Meta Hero Bar ── */}
      <div className="rv-hero-banner" style={{ padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span
            className={`rv-badge ${
              incident.severity === "CRITICAL"
                ? "rv-badge-critical"
                : incident.severity === "HIGH"
                ? "rv-badge-warning"
                : "rv-badge-info"
            }`}
          >
            {incident.severity}
          </span>
          <span
            className={`rv-badge ${
              incident.status === "OPEN"
                ? "rv-badge-critical"
                : incident.status === "ROLLED_BACK"
                ? "rv-badge-success"
                : "rv-badge-neutral"
            }`}
          >
            {incident.status}
          </span>
          {incident.triggeredRule && (
            <span className="rv-badge rv-badge-info">
              Rule: {incident.triggeredRule.name}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ClockIcon size={14} />
            <span>Detected: {formatTime(incident.createdAt)}</span>
          </span>
          {incident.resolvedAt && (
            <span>• Resolved: {formatTime(incident.resolvedAt)}</span>
          )}
          <Link to="/app/incidents" className="rv-btn rv-btn-subtle rv-btn-sm">
            <ArrowLeftIcon size={14} />
            <span>All Incidents</span>
          </Link>
        </div>
      </div>

      {/* ── Action Feedback Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Rollback Completed" : "Operation Warning"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Incident Banner / Action Bar (if OPEN) ── */}
      {canRollback && (
        <div
          className="rv-card"
          style={{
            borderLeft: "4px solid var(--rv-critical)",
            background: "var(--rv-critical-surface)",
            marginBottom: "24px",
          }}
        >
          <div
            style={{
              padding: "18px 22px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "18px",
            }}
          >
            <div>
              <strong style={{ fontSize: "16px", color: "var(--rv-critical-text)", display: "flex", alignItems: "center", gap: "8px" }}>
                <AlertTriangleIcon size={18} />
                <span>Action Required: Incident is Open</span>
              </strong>
              <p style={{ margin: "6px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                Execute a 1-click atomic rollback to revert all {incident.affectedCount} affected product{incident.affectedCount !== 1 ? "s" : ""} back to their pre-incident values.
              </p>
              {isBulkBlocked && (
                <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--rv-warning-text)" }}>
                  ⚠️ Multi-product bulk rollback requires <strong>Growth ($24/mo)</strong> or higher.{" "}
                  <Link to="/app/plan" style={{ textDecoration: "underline", fontWeight: 600 }}>Upgrade Plan</Link> to perform 1-click bulk rollbacks.
                </p>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="rollback" />
                <button
                  type="submit"
                  disabled={isRolling || isBulkBlocked}
                  className="rv-btn rv-btn-critical rv-btn-lg"
                  title={isBulkBlocked ? "Bulk rollback requires Growth or higher plan" : ""}
                >
                  <ShieldCheckIcon size={16} />
                  <span>{isRolling ? "Rolling back catalog..." : `Confirm Rollback (${productCount} Products)`}</span>
                </button>
              </fetcher.Form>

              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="resolve" />
                <button type="submit" className="rv-btn rv-btn-secondary rv-btn-lg" style={{ color: "var(--rv-primary)" }}>
                  <CheckCircleIcon size={15} />
                  <span>Mark Resolved</span>
                </button>
              </fetcher.Form>

              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="ignore" />
                <button type="submit" className="rv-btn rv-btn-subtle rv-btn-lg">
                  Ignore
                </button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      )}

      {/* ── Status Banner if Incident is Not Open ── */}
      {!canRollback && (
        <div
          className="rv-card"
          style={{
            borderLeft: `4px solid ${
              incident.status === "RESOLVED"
                ? "var(--rv-success)"
                : incident.status === "ROLLED_BACK"
                ? "var(--rv-primary)"
                : "var(--rv-border)"
            }`,
            marginBottom: "24px",
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "16px",
            }}
          >
            <div>
              <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleIcon size={16} />
                <span>Incident Status: {incident.status.replace(/_/g, " ")}</span>
              </strong>
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                {incident.status === "RESOLVED"
                  ? `Marked as resolved on ${formatTime(incident.resolvedAt || incident.createdAt)}.`
                  : incident.status === "ROLLED_BACK"
                  ? `Catalog restored on ${formatTime(incident.resolvedAt || incident.createdAt)}.`
                  : `Ignored on ${formatTime(incident.resolvedAt || incident.createdAt)}.`}
              </p>
            </div>

            {(incident.status === "RESOLVED" || incident.status === "IGNORED") && (
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="reopen" />
                <button
                  type="submit"
                  disabled={fetcher.state !== "idle"}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                >
                  <RefreshCwIcon size={14} className={fetcher.state !== "idle" ? "rv-spin" : ""} />
                  <span>{fetcher.state !== "idle" ? "Reopening..." : "Reopen Incident"}</span>
                </button>
              </fetcher.Form>
            )}
          </div>
        </div>
      )}

      {/* ── Affected Products & Granular Diffs ── */}
      <div style={{ marginBottom: "24px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 6px", color: "var(--rv-text)" }}>
          Affected Products &amp; Recorded Changes ({Object.keys(byProduct).length})
        </h3>
        <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: "0 0 16px" }}>
          The following product fields were modified during this incident. Executing a rollback will restore these exact previous values.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {Object.entries(byProduct).map(([productId, data]) => (
            <div key={productId} className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h4 className="rv-card-title">
                  <BoxIcon size={16} style={{ color: "var(--rv-info)" }} />
                  <span>{data.title}</span>
                </h4>
                <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Product ID: #{productId}
                </span>
              </div>
              <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
                <table className="rv-table">
                  <thead>
                    <tr>
                      <th style={{ width: "220px" }}>Field Changed</th>
                      <th>Pre-Incident Value (To Restore)</th>
                      <th style={{ width: "24px" }}></th>
                      <th>Incident Value (Current Live)</th>
                      <th style={{ width: "160px" }}>Changed At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.changes.map((c) => (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600 }}>
                          <span className="rv-badge rv-badge-neutral rv-badge-sm">{fieldLabel(c.fieldName)}</span>
                        </td>
                        <td>
                          <span className="rv-diff-new">{c.oldValue || "—"}</span>
                        </td>
                        <td style={{ color: "var(--rv-text-subdued)", textAlign: "center" }}>→</td>
                        <td>
                          <span className="rv-diff-old">{c.newValue || "—"}</span>
                        </td>
                        <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                          {formatTime(c.changedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Rollback Job Results (if any) ── */}
      {incident.rollbackJobs?.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <HistoryIcon size={18} />
              <span>Rollback Execution Log</span>
            </h3>
          </div>
          <div className="rv-card-body">
            {incident.rollbackJobs.map((job) => (
              <div key={job.id} style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap", marginBottom: "10px" }}>
                <span className={`rv-badge rv-badge-sm ${job.status === "COMPLETED" ? "rv-badge-success" : "rv-badge-critical"}`}>
                  {job.status}
                </span>
                <span style={{ fontSize: "13px", fontWeight: 600 }}>
                  {job.successCount} of {job.totalProducts} products restored
                </span>
                <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Executed: {formatTime(job.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return {
    ...boundary.headers(headersArgs),
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };
};
