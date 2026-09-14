import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";

  const incidents = await prisma.incident.findMany({
    where: {
      shop,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { changes: true } },
    },
  });

  return { incidents, currentStatus: status };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const incidentId = parseInt(formData.get("incidentId"));

  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, shop },
  });
  if (!incident) return { success: false, message: "Incident not found." };

  if (intent === "resolve") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return { success: true, message: "Incident marked as resolved." };
  }

  if (intent === "ignore") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "IGNORED", resolvedAt: new Date() },
    });
    return { success: true, message: "Incident ignored." };
  }

  return { success: false, message: "Action failed." };
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

export default function Incidents() {
  const { incidents, currentStatus } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;

  const handleAction = (intent, incidentId) => {
    fetcher.submit({ intent, incidentId: String(incidentId) }, { method: "POST" });
  };

  const statuses = [
    { id: "", label: "All Incidents" },
    { id: "OPEN", label: "Open" },
    { id: "RESOLVED", label: "Resolved" },
    { id: "ROLLED_BACK", label: "Rolled Back" },
    { id: "IGNORED", label: "Ignored" },
  ];

  return (
    <s-page heading="Incidents" inlineSize="large">

      {/* ── Action Feedback Toast / Banner ── */}
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

      {/* ── Filter Toolbar & Navigation ── */}
      <div className="rv-filter-bar">
        <div className="rv-pills-row" style={{ margin: 0 }}>
          {statuses.map((s) => {
            const isActive = s.id === currentStatus;
            return (
              <Link
                key={s.id || "all"}
                to={`/app/incidents${s.id ? `?status=${s.id}` : ""}`}
                className={`rv-pill ${isActive ? "rv-pill-active" : ""}`}
              >
                {s.label}
              </Link>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", fontWeight: 500 }}>
            {incidents.length} incident{incidents.length !== 1 ? "s" : ""}
          </span>
          <Link to="/app/rules" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
            ⚙️ Configure Rules →
          </Link>
        </div>
      </div>

      {/* ── Incidents List / Empty State ── */}
      {incidents.length === 0 ? (
        <div className="rv-empty-state">
          <div className="rv-empty-icon-circle" style={{ background: "#e8f5e9", color: "#16a34a" }}>
            🛡️
          </div>
          <div className="rv-empty-title">
            {currentStatus ? `No ${currentStatus.toLowerCase()} incidents` : "All Clear — Zero Incidents Detected"}
          </div>
          <div className="rv-empty-desc">
            {currentStatus
              ? `There are currently no incidents matching the "${currentStatus}" filter.`
              : "Revertly monitors your catalog 24/7. When unauthorized bulk changes, price crashes, or rule violations occur, they will be quarantined here for 1-click rollback."}
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            {currentStatus ? (
              <Link to="/app/incidents" className="rv-btn rv-btn-secondary">
                View All Incidents
              </Link>
            ) : (
              <Link to="/app/rules" className="rv-btn rv-btn-primary">
                Review Detection Rules
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {incidents.map((inc) => {
            const isCritical = inc.severity === "CRITICAL";
            const isOpen = inc.status === "OPEN";

            return (
              <div
                key={inc.id}
                className="rv-card"
                style={{
                  borderLeft: `4px solid ${
                    isCritical ? "var(--rv-critical)" : isOpen ? "var(--rv-warning)" : "var(--rv-border)"
                  }`,
                  margin: 0,
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
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <Link
                        to={`/app/incidents/${inc.id}`}
                        style={{ fontSize: "15px", fontWeight: 700, color: "var(--rv-text)", textDecoration: "none" }}
                      >
                        {inc.name}
                      </Link>
                      <span
                        className={`rv-badge ${
                          inc.severity === "CRITICAL"
                            ? "rv-badge-critical"
                            : inc.severity === "HIGH"
                            ? "rv-badge-warning"
                            : "rv-badge-info"
                        }`}
                      >
                        {inc.severity}
                      </span>
                      <span
                        className={`rv-badge ${
                          inc.status === "OPEN"
                            ? "rv-badge-critical"
                            : inc.status === "RESOLVED"
                            ? "rv-badge-success"
                            : "rv-badge-neutral"
                        }`}
                      >
                        {inc.status}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "14px", fontSize: "12px", color: "var(--rv-text-subdued)", flexWrap: "wrap" }}>
                      <span>🕒 Detected: {formatTime(inc.createdAt)}</span>
                      <span>·</span>
                      <span>📦 <strong>{inc.affectedCount}</strong> product{inc.affectedCount !== 1 ? "s" : ""} affected</span>
                      <span>·</span>
                      <span>📋 <strong>{inc._count.changes}</strong> change events recorded</span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    {isOpen ? (
                      <>
                        <Link
                          to={`/app/incidents/${inc.id}`}
                          className="rv-btn rv-btn-critical"
                          style={{ fontSize: "13px" }}
                        >
                          ⚡ Review &amp; Rollback
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleAction("resolve", inc.id)}
                          className="rv-btn rv-btn-secondary"
                          style={{ fontSize: "13px", color: "var(--rv-primary)" }}
                        >
                          ✓ Resolve
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAction("ignore", inc.id)}
                          className="rv-btn rv-btn-subtle"
                          style={{ fontSize: "13px" }}
                        >
                          Ignore
                        </button>
                      </>
                    ) : (
                      <Link
                        to={`/app/incidents/${inc.id}`}
                        className="rv-btn rv-btn-secondary"
                        style={{ fontSize: "13px" }}
                      >
                        Inspect Details →
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
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
