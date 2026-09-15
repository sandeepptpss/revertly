import { useLoaderData, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ShieldCheckIcon,
  BoxIcon,
  ClockIcon,
  AlertTriangleIcon,
  SaveIcon,
  ArrowRightIcon,
  HistoryIcon,
  DatabaseIcon,
  SettingsIcon,
  FilterIcon,
} from "../components/Icons.jsx";
import { StatCard } from "../components/StatCard.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";

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
          <div className="rv-pulse-wrapper">
            <div
              className="rv-pulse-indicator"
              style={{ background: isInitialized ? "var(--rv-primary)" : "var(--rv-warning)" }}
            />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "3px", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "16px", color: "var(--rv-text)", fontWeight: 700 }}>
                {isInitialized ? "Store Protection Active" : "Store Monitoring Setup Required"}
              </strong>
              <span className={`rv-badge ${isInitialized ? "rv-badge-success" : "rv-badge-warning"}`}>
                {isInitialized ? "Guarded 24/7" : "Action Needed"}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              {isInitialized
                ? `${stats.totalProducts.toLocaleString()} products guarded against accidental price crashes, bad CSV imports, and unintended deletions.`
                : "Initialize your store baseline snapshot to start monitoring product edits and prevent revenue loss."}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {!isInitialized ? (
            <Link to="/app/initialize" className="rv-btn rv-btn-primary rv-btn-lg">
              <ShieldCheckIcon size={16} />
              <span>Initialize Monitoring Now</span>
            </Link>
          ) : (
            <>
              <Link to="/app/restore-points" className="rv-btn rv-btn-primary">
                <SaveIcon size={15} />
                <span>+ Create Restore Point</span>
              </Link>
              <Link to="/app/vault" className="rv-btn rv-btn-secondary">
                <DatabaseIcon size={15} />
                <span>Data Vault</span>
              </Link>
            </>
          )}
        </div>
      </div>

      {/* ── Open Incidents Warning Banner ── */}
      {stats.openIncidents > 0 && (
        <Banner
          tone="critical"
          title={`${stats.openIncidents} open incident${stats.openIncidents > 1 ? "s" : ""} require your attention`}
          action={
            <Link to="/app/incidents" className="rv-btn rv-btn-critical rv-btn-sm">
              <span>Review Incidents</span>
              <ArrowRightIcon size={13} />
            </Link>
          }
        >
          Suspicious product edits or steep price crashes have been flagged by your detection rules. Review and rollback immediately.
        </Banner>
      )}

      {/* ── 4 KPI Stats Grid ── */}
      <div className="rv-stat-grid">
        <StatCard
          label="Monitored Products"
          value={stats.totalProducts.toLocaleString()}
          subtext={
            <>
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: isInitialized ? "#10b981" : "#f59e0b",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span>{isInitialized ? "Real-time tracking active" : "Baseline not initialized"}</span>
            </>
          }
          icon={<BoxIcon size={18} />}
          iconTone="blue"
          linkTo="/app/initialize"
          linkLabel={isInitialized ? "Sync catalog snapshots" : "Initialize baseline"}
        />

        <StatCard
          label="Changes Today (24h)"
          value={stats.todayChanges.toLocaleString()}
          subtext={stats.todayChanges === 0 ? "No catalog edits in 24h" : "Logged in the last 24 hours"}
          icon={<ClockIcon size={18} />}
          iconTone="purple"
          linkTo="/app/activity"
          linkLabel="Open activity stream"
        />

        <StatCard
          label="Open Incidents"
          value={stats.openIncidents.toLocaleString()}
          subtext={stats.openIncidents > 0 ? "Requires merchant review" : "Store catalog is all clear"}
          icon={stats.openIncidents > 0 ? <AlertTriangleIcon size={18} /> : <ShieldCheckIcon size={18} />}
          iconTone={stats.openIncidents > 0 ? "rose" : "emerald"}
          linkTo="/app/incidents"
          linkLabel={stats.openIncidents > 0 ? "Resolve incidents" : "View incidents log"}
        />

        <StatCard
          label="Restore Points"
          value={stats.readyRestorePoints.toLocaleString()}
          subtext={stats.readyRestorePoints === 0 ? "None captured yet" : "Ready for 1-click restore"}
          icon={<SaveIcon size={18} />}
          iconTone="emerald"
          linkTo="/app/restore-points"
          linkLabel={stats.readyRestorePoints === 0 ? "Take first snapshot" : "Manage backups"}
        />
      </div>

      {/* ── Quick Navigation Hub ── */}
      <div className="rv-quick-nav-row">
        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--rv-text-subdued)", textTransform: "uppercase", letterSpacing: "0.5px", marginRight: "4px" }}>
          Quick Hub:
        </span>
        <Link to="/app/activity" className="rv-quick-pill">
          <ClockIcon size={14} />
          <span>Activity Log</span>
        </Link>
        <Link to="/app/incidents" className="rv-quick-pill">
          <AlertTriangleIcon size={14} />
          <span>Incidents</span>
        </Link>
        <Link to="/app/restore-points" className="rv-quick-pill">
          <SaveIcon size={14} />
          <span>Restore Points</span>
        </Link>
        <Link to="/app/vault" className="rv-quick-pill">
          <DatabaseIcon size={14} />
          <span>Data Vault</span>
        </Link>
        <Link to="/app/rules" className="rv-quick-pill">
          <FilterIcon size={14} />
          <span>Detection Rules</span>
        </Link>
        <Link to="/app/rollback-history" className="rv-quick-pill">
          <HistoryIcon size={14} />
          <span>Rollback History</span>
        </Link>
        <Link to="/app/settings" className="rv-quick-pill">
          <SettingsIcon size={14} />
          <span>Settings</span>
        </Link>
      </div>

      {/* ── Two Column Feed: Incidents & Activity ── */}
      <div className="rv-two-col" style={{ marginBottom: "24px" }}>
        
        {/* Left Column: Recent Incidents */}
        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <AlertTriangleIcon size={18} style={{ color: "var(--rv-critical)" }} />
              <span>Recent Incidents</span>
            </h3>
            <Link to="/app/incidents" className="rv-stat-link">
              <span>View all</span>
              <ArrowRightIcon size={13} />
            </Link>
          </div>

          <div>
            {recentIncidents.length === 0 ? (
              <EmptyState
                icon={<ShieldCheckIcon size={26} style={{ color: "var(--rv-primary)" }} />}
                title="Zero Incidents Detected"
                description="Your store catalog is safe and sound. Any bulk changes or steep price crashes will be flagged here immediately."
                action={
                  <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm">
                    Configure Rules
                  </Link>
                }
              />
            ) : (
              recentIncidents.map((inc) => (
                <div key={inc.id} className="rv-item-card">
                  <div className="rv-item-main">
                    <div className="rv-item-title">
                      <Link to={`/app/incidents/${inc.id}`} style={{ color: "var(--rv-text)", textDecoration: "none" }}>
                        {inc.name}
                      </Link>
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
                        className={`rv-badge rv-badge-sm ${
                          inc.severity === "CRITICAL"
                            ? "rv-badge-critical"
                            : inc.severity === "HIGH"
                            ? "rv-badge-warning"
                            : "rv-badge-info"
                        }`}
                      >
                        {inc.severity}
                      </span>
                      <span>{inc.affectedCount} product{inc.affectedCount !== 1 ? "s" : ""}</span>
                      <span>·</span>
                      <span>{timeAgo(inc.createdAt)}</span>
                    </div>
                  </div>
                  <div>
                    {inc.status === "OPEN" ? (
                      <Link to={`/app/incidents/${inc.id}`} className="rv-btn rv-btn-critical rv-btn-sm">
                        Review &amp; Rollback
                      </Link>
                    ) : (
                      <Link to={`/app/incidents/${inc.id}`} className="rv-btn rv-btn-secondary rv-btn-sm">
                        Details
                      </Link>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Column: Recent Activity Log */}
        <div className="rv-card" style={{ margin: 0 }}>
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <ClockIcon size={18} style={{ color: "var(--rv-info)" }} />
              <span>Recent Activity Log</span>
            </h3>
            <Link to="/app/activity" className="rv-stat-link">
              <span>View all</span>
              <ArrowRightIcon size={13} />
            </Link>
          </div>

          <div>
            {recentChanges.length === 0 ? (
              <EmptyState
                icon={<ClockIcon size={26} style={{ color: "var(--rv-info)" }} />}
                title="Listening for Updates"
                description="When you or an external app edit product prices, titles, or inventory, change records will stream here in real time."
                action={
                  <Link to="/app/activity" className="rv-btn rv-btn-secondary rv-btn-sm">
                    Open Activity Stream
                  </Link>
                }
              />
            ) : (
              recentChanges.map((c) => (
                <div key={c.id} className="rv-item-card">
                  <div className="rv-item-main" style={{ maxWidth: "70%" }}>
                    <div className="rv-item-title" style={{ fontSize: "13px" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.productTitle}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "3px" }}>
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">
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

      {/* ── System Status & Guardrails ── */}
      <div className="rv-card">
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <ShieldCheckIcon size={18} style={{ color: "var(--rv-primary)" }} />
            <span>Protection Engine &amp; Health Status</span>
          </h3>
          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            Shop: <code>{stats.shop || "Connected"}</code>
          </span>
        </div>
        <div className="rv-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Live Webhooks Active</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Encrypted Snapshot Storage</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Automatic Anomaly Detection</span>
            </div>
            {stats.totalRollbacks > 0 && (
              <span className="rv-badge rv-badge-success">
                {stats.totalRollbacks} safe rollbacks completed
              </span>
            )}
          </div>
          <Link to="/app/settings" className="rv-btn rv-btn-secondary rv-btn-sm">
            <SettingsIcon size={14} />
            <span>Protection Settings</span>
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
