import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rollbackProductFields } from "../monitor.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const incidentId = parseInt(params.id);

  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, shop },
    include: {
      changes: { orderBy: { changedAt: "desc" } },
      triggeredRule: true,
      rollbackJobs: {
        orderBy: { createdAt: "desc" },
        include: { results: true },
      },
    },
  });

  if (!incident) throw new Response("Not Found", { status: 404 });

  // Group changes by product for rollback preview
  const byProduct = {};
  for (const c of incident.changes) {
    if (!byProduct[c.productId]) {
      byProduct[c.productId] = { title: c.productTitle, changes: [] };
    }
    byProduct[c.productId].changes.push(c);
  }

  return { incident, byProduct };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const incidentId = parseInt(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "resolve") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return { success: true, message: "Incident resolved." };
  }

  if (intent === "ignore") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "IGNORED", resolvedAt: new Date() },
    });
    return { success: true, message: "Incident ignored." };
  }

  if (intent === "rollback") {
    // Get all change events for this incident
    const changes = await prisma.changeEvent.findMany({
      where: { incidentId, shop },
    });

    // Group by productId
    const byProduct = {};
    for (const c of changes) {
      if (!byProduct[c.productId]) byProduct[c.productId] = [];
      byProduct[c.productId].push(c.id);
    }

    // Create rollback job
    const job = await prisma.rollbackJob.create({
      data: {
        shop,
        incidentId,
        status: "RUNNING",
        totalProducts: Object.keys(byProduct).length,
      },
    });

    // Process each product
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
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function fieldLabel(fn) {
  return fn.replace("variant.", "Variant ").replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

export default function IncidentDetail() {
  const { incident, byProduct } = useLoaderData();
  const fetcher = useFetcher();
  const isRolling = fetcher.state !== "idle";
  const result = fetcher.data;

  const canRollback = incident.status === "OPEN";

  return (
    <s-page
      heading={incident.name}
      backAction={{ url: "/app/incidents", label: "Incidents" }}
      inlineSize="large"
    >
      {/* ── Status & Meta Bar ── */}
      <div className="rv-hero-banner" style={{ padding: "16px 20px" }}>
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
                : incident.status === "RESOLVED"
                ? "rv-badge-success"
                : "rv-badge-neutral"
            }`}
          >
            {incident.status}
          </span>
          <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            🕒 Detected: {formatTime(incident.createdAt)}
          </span>
          <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            📦 <strong>{incident.affectedCount}</strong> product{incident.affectedCount !== 1 ? "s" : ""} affected
          </span>
        </div>

        <Link to="/app/incidents" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
          ← Back to Incidents
        </Link>
      </div>

      {/* ── Action Result Banner ── */}
      {result?.message && (
        <div
          style={{
            background: result.success ? "var(--rv-primary-surface)" : "var(--rv-critical-surface)",
            border: `1px solid ${result.success ? "var(--rv-primary-border)" : "var(--rv-critical-border)"}`,
            color: result.success ? "var(--rv-primary)" : "var(--rv-critical)",
            padding: "14px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>{result.success ? "✅" : "⚠️"}</span>
          <span>{result.message}</span>
        </div>
      )}

      {/* ── Emergency Action Bar ── */}
      {canRollback && (
        <div
          className="rv-card"
          style={{
            borderLeft: "4px solid var(--rv-critical)",
            background: "#fffaf9",
            marginBottom: "24px",
          }}
        >
          <div
            className="rv-card-body"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "16px",
            }}
          >
            <div>
              <strong style={{ fontSize: "15px", color: "var(--rv-critical)" }}>
                ⚡ Action Required: Incident is Open
              </strong>
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                Execute a 1-click atomic rollback to revert all {incident.affectedCount} affected product{incident.affectedCount !== 1 ? "s" : ""} back to their pre-incident values.
              </p>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="rollback" />
                <button
                  type="submit"
                  disabled={isRolling}
                  className="rv-btn rv-btn-critical"
                  style={{ fontWeight: 600 }}
                >
                  {isRolling ? "Rolling back catalog..." : `⚡ Confirm Rollback (${Object.keys(byProduct).length} Products)`}
                </button>
              </fetcher.Form>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="resolve" />
                <button type="submit" className="rv-btn rv-btn-secondary" style={{ color: "var(--rv-primary)" }}>
                  ✓ Mark Resolved
                </button>
              </fetcher.Form>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="ignore" />
                <button type="submit" className="rv-btn rv-btn-subtle">
                  Ignore
                </button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      )}

      {/* ── Affected Products & Granular Diffs ── */}
      <div style={{ marginBottom: "24px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 12px", color: "var(--rv-text)" }}>
          Affected Products &amp; Recorded Changes ({Object.keys(byProduct).length})
        </h3>
        <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: "0 0 16px" }}>
          The following product fields were modified during this incident. Executing a rollback will restore these exact previous values.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {Object.entries(byProduct).map(([productId, data]) => (
            <div key={productId} className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header" style={{ background: "#fbfcfd" }}>
                <h4 className="rv-card-title">
                  <span>📦</span> {data.title}
                </h4>
                <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Product ID: #{productId}
                </span>
              </div>
              <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
                <table className="rv-table">
                  <thead>
                    <tr>
                      <th style={{ width: "200px" }}>Field Changed</th>
                      <th>Pre-Incident Value (To Restore)</th>
                      <th style={{ width: "20px" }}></th>
                      <th>Incident Value (Current)</th>
                      <th style={{ width: "160px" }}>Changed At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.changes.map((c) => (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600 }}>
                          <span className="rv-badge rv-badge-neutral">{fieldLabel(c.fieldName)}</span>
                        </td>
                        <td>
                          <span className="rv-diff-new">{c.oldValue || "—"}</span>
                        </td>
                        <td style={{ color: "var(--rv-text-subdued)", textAlign: "center" }}>→</td>
                        <td>
                          <span className="rv-diff-old">{c.newValue || "—"}</span>
                        </td>
                        <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
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

      {/* ── Rollback Job History ── */}
      {incident.rollbackJobs.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>⏪</span> Rollback Execution History
            </h3>
          </div>
          <div className="rv-card-body">
            {incident.rollbackJobs.map((job) => (
              <div
                key={job.id}
                style={{
                  padding: "14px 16px",
                  borderRadius: "var(--rv-radius-sm)",
                  background: "#f8fafc",
                  border: "1px solid var(--rv-border)",
                  marginBottom: "12px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span
                      className={`rv-badge ${
                        job.status === "COMPLETED"
                          ? "rv-badge-success"
                          : job.status === "FAILED"
                          ? "rv-badge-critical"
                          : "rv-badge-warning"
                      }`}
                    >
                      {job.status}
                    </span>
                    <span style={{ fontSize: "13px", fontWeight: 600 }}>
                      {job.successCount}/{job.totalProducts} products restored
                    </span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    Executed: {formatTime(job.createdAt)}
                  </span>
                </div>

                {job.results.length > 0 && (
                  <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {job.results.map((r) => (
                      <div key={r.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className={`rv-badge ${r.status === "SUCCESS" ? "rv-badge-success" : "rv-badge-critical"}`} style={{ fontSize: "10px", padding: "2px 6px" }}>
                          {r.status}
                        </span>
                        <span>{r.productTitle}</span>
                        {r.errorMessage && <span style={{ color: "var(--rv-critical)" }}>— {r.errorMessage}</span>}
                      </div>
                    ))}
                  </div>
                )}
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
  return boundary.headers(headersArgs);
};
