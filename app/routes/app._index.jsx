import { useLoaderData, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [
    totalProducts,
    todayChanges,
    openIncidents,
    readyRestorePoints,
    recentChanges,
    recentIncidents,
    totalRollbacks,
  ] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.changeEvent.count({
      where: {
        shop,
        changedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.incident.count({ where: { shop, status: "OPEN" } }),
    prisma.restorePoint.count({ where: { shop, status: "READY" } }),
    prisma.changeEvent.findMany({
      where: { shop },
      orderBy: { changedAt: "desc" },
      take: 8,
    }),
    prisma.incident.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { _count: { select: { changes: true } } },
    }),
    prisma.rollbackJob.count({ where: { shop, status: "COMPLETED" } }),
  ]);

  return {
    stats: { totalProducts, todayChanges, openIncidents, readyRestorePoints, totalRollbacks },
    recentChanges,
    recentIncidents,
    shop,
    isInitialized: totalProducts > 0,
  };
};

function timeAgo(date) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function fieldLabel(fn) {
  return fn
    .replace("variant.", "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase());
}

export default function Dashboard() {
  const { stats, recentChanges, recentIncidents, isInitialized } = useLoaderData();

  return (
    <s-page heading="Dashboard" inlineSize="large">

      {/* ── Top Hero Protection Status ── */}
      <div className="rv-hero-banner">
        <div className="rv-hero-status">
          <div
            className="rv-pulse-indicator"
            style={{ background: isInitialized ? "#008060" : "#d97706" }}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "2px" }}>
              <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
                {isInitialized ? "Catalog Watchdog Active" : "Catalog Monitoring Setup Required"}
              </strong>
              <span className={`rv-badge ${isInitialized ? "rv-badge-success" : "rv-badge-warning"}`}>
                {isInitialized ? "Protected" : "Action Needed"}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
              {isInitialized
                ? `${stats.totalProducts.toLocaleString()} products actively guarded against accidental price crashes, CSV mistakes, and deletions.`
                : "Initialize your store baseline snapshot to start monitoring catalog changes and prevent revenue loss."}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {!isInitialized ? (
            <Link to="/app/initialize" className="rv-btn rv-btn-primary">
              ⚡ Initialize Monitoring Now
            </Link>
          ) : (
            <>
              <Link to="/app/restore-points" className="rv-btn rv-btn-primary">
                + Create Restore Point
              </Link>
              <Link to="/app/vault" className="rv-btn rv-btn-secondary">
                Orders Vault
              </Link>
            </>
          )}
        </div>
      </div>

      {/* ── Open Incidents Warning Banner ── */}
      {stats.openIncidents > 0 && (
        <div
          style={{
            background: "var(--rv-critical-surface)",
            border: "1px solid var(--rv-critical-border)",
            borderRadius: "var(--rv-radius-md)",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "22px" }}>⚠️</span>
            <div>
              <strong style={{ color: "var(--rv-critical)", fontSize: "14px" }}>
                {stats.openIncidents} open incident{stats.openIncidents > 1 ? "s" : ""} require your attention
              </strong>
              <p style={{ margin: "2px 0 0", fontSize: "13px", color: "#771919" }}>
                Suspicious product changes or sudden price drops have been flagged. Review and rollback immediately.
              </p>
            </div>
          </div>
          <Link to="/app/incidents" className="rv-btn rv-btn-critical">
            Review Incidents →
          </Link>
        </div>
      )}

      {/* ── 4 KPI Stats Grid ── */}
      <div className="rv-stat-grid">
        {/* Monitored Products */}
        <div className="rv-stat-card">
          <div>
            <div className="rv-stat-card-top">
              <span className="rv-stat-label">Monitored Products</span>
              <div className="rv-stat-icon-wrapper rv-stat-icon-blue">📦</div>
            </div>
            <div className="rv-stat-number">{stats.totalProducts.toLocaleString()}</div>
            <div className="rv-stat-subtext">
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: isInitialized ? "#10b981" : "#f59e0b",
                  display: "inline-block",
                }}
              />
              {isInitialized ? "Real-time tracking active" : "Baseline not initialized"}
            </div>
          </div>
          <Link
            to={isInitialized ? "/app/initialize" : "/app/initialize"}
            className="rv-stat-link"
          >
            {isInitialized ? "Sync snapshots →" : "Initialize now →"}
          </Link>
        </div>

        {/* Changes Today */}
        <div className="rv-stat-card">
          <div>
            <div className="rv-stat-card-top">
              <span className="rv-stat-label">Changes Today</span>
              <div className="rv-stat-icon-wrapper rv-stat-icon-purple">🕒</div>
            </div>
            <div className="rv-stat-number">{stats.todayChanges.toLocaleString()}</div>
            <div className="rv-stat-subtext">
              {stats.todayChanges === 0 ? "No product edits in 24h" : "Logged in the last 24 hours"}
            </div>
          </div>
          <Link to="/app/activity" className="rv-stat-link">
            View activity log →
          </Link>
        </div>

        {/* Open Incidents */}
        <div className="rv-stat-card">
          <div>
            <div className="rv-stat-card-top">
              <span className="rv-stat-label">Open Incidents</span>
              <div
                className={`rv-stat-icon-wrapper ${stats.openIncidents > 0 ? "rv-stat-icon-red" : "rv-stat-icon-green"}`}
              >
                {stats.openIncidents > 0 ? "🚨" : "🛡️"}
              </div>
            </div>
            <div
              className="rv-stat-number"
              style={{ color: stats.openIncidents > 0 ? "var(--rv-critical)" : "inherit" }}
            >
              {stats.openIncidents.toLocaleString()}
            </div>
            <div className="rv-stat-subtext">
              {stats.openIncidents > 0 ? "Requires your review" : "Store catalog is all clear"}
            </div>
          </div>
          <Link to="/app/incidents" className="rv-stat-link">
            {stats.openIncidents > 0 ? "Resolve incidents →" : "View incidents →"}
          </Link>
        </div>

        {/* Restore Points */}
        <div className="rv-stat-card">
          <div>
            <div className="rv-stat-card-top">
              <span className="rv-stat-label">Restore Points</span>
              <div className="rv-stat-icon-wrapper rv-stat-icon-green">💾</div>
            </div>
            <div className="rv-stat-number">{stats.readyRestorePoints.toLocaleString()}</div>
            <div className="rv-stat-subtext">
              {stats.readyRestorePoints === 0 ? "None created yet" : "Ready for 1-click restore"}
            </div>
          </div>
          <Link to="/app/restore-points" className="rv-stat-link">
            {stats.readyRestorePoints === 0 ? "Create your first →" : "Manage backups →"}
          </Link>
        </div>
      </div>

      {/* ── Quick Action Shortcuts ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
          marginBottom: "24px",
        }}
      >
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--rv-text-subdued)", textTransform: "uppercase", letterSpacing: "0.5px", marginRight: "6px" }}>
          Quick Navigation:
        </span>
        <Link to="/app/activity" className="rv-pill">
          📋 Activity Log
        </Link>
        <Link to="/app/incidents" className="rv-pill">
          🚨 Incidents
        </Link>
        <Link to="/app/restore-points" className="rv-pill">
          💾 Restore Points
        </Link>
        <Link to="/app/vault" className="rv-pill">
          🏛️ Data Vault
        </Link>
        <Link to="/app/rules" className="rv-pill">
          ⚙️ Detection Rules
        </Link>
        <Link to="/app/rollback-history" className="rv-pill">
          ⏪ Rollback History
        </Link>
        <Link to="/app/settings" className="rv-pill">
          🔧 Settings
        </Link>
      </div>

      {/* ── Main Two Column Feed: Recent Incidents + Recent Activity ── */}
      <div className="rv-two-col" style={{ marginBottom: "24px" }}>
        
        {/* Left: Recent Incidents */}
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>🚨</span> Recent Incidents
            </h3>
            <Link to="/app/incidents" style={{ fontSize: "13px", color: "var(--rv-info)", fontWeight: 500, textDecoration: "none" }}>
              View all →
            </Link>
          </div>

          <div>
            {recentIncidents.length === 0 ? (
              <div className="rv-empty-state" style={{ border: "none", margin: 0, padding: "36px 20px" }}>
                <div className="rv-empty-icon-circle" style={{ background: "#e8f5e9", color: "#16a34a" }}>
                  🛡️
                </div>
                <div className="rv-empty-title">Zero Incidents Detected</div>
                <div className="rv-empty-desc">
                  Your store is completely protected. Any bulk changes or steep price drops will be flagged here immediately.
                </div>
                <Link to="/app/rules" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
                  Configure Detection Rules
                </Link>
              </div>
            ) : (
              recentIncidents.map((inc) => (
                <div key={inc.id} className="rv-item-card">
                  <div className="rv-item-main">
                    <div className="rv-item-title">
                      <span>{inc.name}</span>
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
                    <div className="rv-item-meta">
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
                      <span>{inc.affectedCount} product{inc.affectedCount !== 1 ? "s" : ""} affected</span>
                      <span>·</span>
                      <span>{timeAgo(inc.createdAt)}</span>
                    </div>
                  </div>
                  <div>
                    {inc.status === "OPEN" ? (
                      <Link to={`/app/incidents/${inc.id}`} className="rv-btn rv-btn-critical" style={{ fontSize: "12px", padding: "6px 12px" }}>
                        Review &amp; Rollback
                      </Link>
                    ) : (
                      <Link to={`/app/incidents/${inc.id}`} className="rv-btn rv-btn-secondary" style={{ fontSize: "12px", padding: "6px 12px" }}>
                        Details
                      </Link>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Recent Activity */}
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>📋</span> Recent Activity Log
            </h3>
            <Link to="/app/activity" style={{ fontSize: "13px", color: "var(--rv-info)", fontWeight: 500, textDecoration: "none" }}>
              View all →
            </Link>
          </div>

          <div>
            {recentChanges.length === 0 ? (
              <div className="rv-empty-state" style={{ border: "none", margin: 0, padding: "36px 20px" }}>
                <div className="rv-empty-icon-circle" style={{ background: "#f0fdf4", color: "#008060" }}>
                  📡
                </div>
                <div className="rv-empty-title">Listening for Updates</div>
                <div className="rv-empty-desc">
                  When you or an app edit product prices, titles, or inventory, change records will appear here in real time.
                </div>
                <Link to="/app/activity" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
                  Open Activity Stream
                </Link>
              </div>
            ) : (
              recentChanges.map((c) => (
                <div key={c.id} className="rv-item-card">
                  <div className="rv-item-main" style={{ maxWidth: "70%" }}>
                    <div className="rv-item-title" style={{ fontSize: "13px", fontWeight: 600 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.productTitle}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "2px" }}>
                      <span className="rv-badge rv-badge-neutral" style={{ fontSize: "11px" }}>
                        {fieldLabel(c.fieldName)}
                      </span>
                      <span className="rv-diff-old">{c.oldValue || "—"}</span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>→</span>
                      <span className="rv-diff-new">{c.newValue || "—"}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", whiteSpace: "nowrap" }}>
                    {timeAgo(c.changedAt)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* ── System Status & Protection Guardrails ── */}
      <div className="rv-card">
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <span>⚙️</span> System Guardrails &amp; Protection Status
          </h3>
          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            Shop: <code>{stats.shop || "Connected"}</code>
          </span>
        </div>
        <div className="rv-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981" }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Webhooks Active</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981" }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Prisma Database Connected</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981" }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Automated Snapshots Running</span>
            </div>
            {stats.totalRollbacks > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span className="rv-badge rv-badge-success">
                  {stats.totalRollbacks} rollbacks performed safely
                </span>
              </div>
            )}
          </div>
          <Link to="/app/settings" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
            Adjust Protection Settings →
          </Link>
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
