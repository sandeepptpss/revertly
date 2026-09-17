import { useLoaderData, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { calculateStoreStorageUsage } from "../backup.server.js";
import { getEffectiveLimits } from "../billing.server.js";
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
  CloudUploadIcon,
  GoogleDriveIcon,
  DropboxIcon,
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
    latestRestorePoint,
    settings,
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
    prisma.restorePoint.findFirst({
      where: { shop, status: "READY" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        status: true,
        productCount: true,
      },
    }),
    prisma.appSettings.findUnique({ where: { shop } }),
  ]);

  // Storage & retention posture. calculateStoreStorageUsage swallows its own
  // errors and returns a safe shape, so this cannot break the dashboard.
  const [storage, planLimitsInfo] = await Promise.all([
    calculateStoreStorageUsage(shop),
    getEffectiveLimits(shop, settings),
  ]);

  const retentionDays = planLimitsInfo.retentionDays || 7;
  const oldestRetained = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const schedule = settings?.autoBackupSchedule || "DAILY";
  const preferredTime = settings?.autoBackupTime || "02:00";
  const lastBackupAt = settings?.lastAutoBackupAt || latestRestorePoint?.createdAt || null;

  let nextBackupAt = settings?.nextAutoBackupAt;
  if (!nextBackupAt && schedule !== "OFF") {
    const [hours, minutes] = preferredTime.split(":").map((x) => parseInt(x, 10) || 0);
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
    if (next <= now) {
      if (schedule === "TWICE_DAILY") next.setUTCHours(next.getUTCHours() + 12);
      else if (schedule === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
      else next.setUTCDate(next.getUTCDate() + 1);
    }
    nextBackupAt = next;
  }

  const cloudSync = {
    connected: Boolean(settings?.cloudSyncConnected),
    provider: settings?.cloudSyncProvider || "NONE",
    email: settings?.cloudSyncEmail || null,
    folder: settings?.cloudSyncFolder || "Revertly_Backups",
  };

  const monitoringEnabled = settings ? Boolean(settings.monitoringEnabled) : true;

  return {
    stats: { totalProducts, todayChanges, openIncidents, readyRestorePoints, totalRollbacks },
    recentChanges,
    recentIncidents,
    shop,
    monitoringEnabled,
    isInitialized: totalProducts > 0,
    backupCadence: {
      schedule,
      preferredTime,
      lastBackupAt: lastBackupAt ? (lastBackupAt instanceof Date ? lastBackupAt.toISOString() : new Date(lastBackupAt).toISOString()) : null,
      nextBackupAt: nextBackupAt ? (nextBackupAt instanceof Date ? nextBackupAt.toISOString() : new Date(nextBackupAt).toISOString()) : null,
      cloudSync,
    },
    storage,
    retention: {
      retentionDays,
      isMaxRetention: retentionDays >= 365,
      oldestRetainedAt: oldestRetained.toISOString(),
    },
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

function timeUntil(date) {
  if (!date) return "";
  const diffMs = new Date(date).getTime() - Date.now();
  if (diffMs <= 0) return "overdue / running soon";
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "in < 1m";
  if (mins < 60) return `in ${mins}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${days}d`;
}

function fieldLabel(fn) {
  if (!fn) return "Field";
  return fn
    .replace("variant.", "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase());
}

export default function Dashboard() {
  const {
    stats,
    recentChanges,
    recentIncidents,
    shop,
    monitoringEnabled,
    isInitialized,
    backupCadence,
    storage,
    retention,
  } = useLoaderData();

  return (
    <s-page heading="Desktop" inlineSize="large">

      {/* ── Top Hero Protection Status ── */}
      <div className="rv-hero-banner">
        <div className="rv-hero-status">
          <div className="rv-pulse-wrapper">
            <div
              className="rv-pulse-indicator"
              style={{
                background: !isInitialized
                  ? "var(--rv-warning)"
                  : !monitoringEnabled
                  ? "var(--rv-warning)"
                  : "var(--rv-primary)",
              }}
            />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "3px", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "16px", color: "var(--rv-text)", fontWeight: 700 }}>
                {!isInitialized
                  ? "Store Monitoring Setup Required"
                  : !monitoringEnabled
                  ? "Store Protection Paused"
                  : "Store Protection Active"}
              </strong>
              <span
                className={`rv-badge ${
                  !isInitialized
                    ? "rv-badge-warning"
                    : !monitoringEnabled
                    ? "rv-badge-warning"
                    : "rv-badge-success"
                }`}
              >
                {!isInitialized
                  ? "Action Needed"
                  : !monitoringEnabled
                  ? "Monitoring Suspended"
                  : "Guarded 24/7"}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              {!isInitialized
                ? "Initialize your store baseline snapshot to start monitoring product edits and prevent revenue loss."
                : !monitoringEnabled
                ? "Real-time catalog webhooks are currently paused in Settings. Changes to products will not trigger alerts or incident logs."
                : `${stats.totalProducts.toLocaleString()} products guarded against accidental price crashes, bad CSV imports, and unintended deletions.`}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {!isInitialized ? (
            <Link to="/app/initialize" className="rv-btn rv-btn-primary rv-btn-lg">
              <ShieldCheckIcon size={16} />
              <span>Initialize Monitoring Now</span>
            </Link>
          ) : !monitoringEnabled ? (
            <>
              <Link to="/app/settings?tab=monitoring" className="rv-btn rv-btn-warning">
                <span>Re-enable Protection</span>
              </Link>
              <Link to="/app/restore-points?create=true" className="rv-btn rv-btn-secondary">
                <SaveIcon size={15} />
                <span>+ Create Restore Point</span>
              </Link>
            </>
          ) : (
            <>
              <Link to="/app/restore-points?create=true" className="rv-btn rv-btn-primary">
                <SaveIcon size={15} />
                <span>+ Create Restore Point</span>
              </Link>
              <Link to="/app/import-export" className="rv-btn rv-btn-secondary">
                <span>Import &amp; Export</span>
              </Link>
              <Link to="/app/vault" className="rv-btn rv-btn-secondary">
                <DatabaseIcon size={15} />
                <span>Data Vault</span>
              </Link>
            </>
          )}
        </div>
      </div>

      {/* ── Automated Scheduled Daily Backup & Cloud Sync Status Banner ── */}
      <div
        className="rv-card"
        style={{
          margin: "0 0 20px 0",
          padding: "16px 20px",
          background: "linear-gradient(135deg, rgba(0, 128, 96, 0.05) 0%, rgba(37, 99, 235, 0.05) 100%)",
          border: "1px solid rgba(0, 128, 96, 0.18)",
          boxShadow: "0 2px 8px rgba(0, 0, 0, 0.03)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: backupCadence?.schedule !== "OFF" ? "var(--rv-primary)" : "var(--rv-warning)",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                boxShadow: "0 2px 6px rgba(0, 128, 96, 0.25)",
              }}
            >
              <ClockIcon size={22} />
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "3px" }}>
                <strong style={{ fontSize: "15px", color: "var(--rv-text)", fontWeight: 700 }}>
                  {backupCadence?.schedule === "DAILY"
                    ? `Automated Daily Backup: Active (Scheduled ${backupCadence.preferredTime} UTC)`
                    : backupCadence?.schedule === "TWICE_DAILY"
                      ? "Automated High-Velocity Backup: Active (Every 12 Hours)"
                      : backupCadence?.schedule === "WEEKLY"
                        ? "Automated Weekly Backup: Active (Every 7 Days)"
                        : "Automated Backup Cadence: Disabled (Manual Only)"}
                </strong>
                <span className={`rv-badge ${backupCadence?.schedule !== "OFF" ? "rv-badge-success" : "rv-badge-warning"}`}>
                  {backupCadence?.schedule !== "OFF" ? "Auto-Guarded" : "Paused"}
                </span>

                {/* Cloud Sync Status Indicator Badge */}
                {backupCadence?.cloudSync?.connected ? (
                  <Link
                    to="/app/settings?tab=cloud"
                    className="rv-badge rv-badge-info"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    {backupCadence.cloudSync.provider === "GOOGLE_DRIVE" ? (
                      <GoogleDriveIcon size={13} style={{ color: "#ea4335" }} />
                    ) : (
                      <DropboxIcon size={13} style={{ color: "#0061fe" }} />
                    )}
                    <span>{backupCadence.cloudSync.provider === "GOOGLE_DRIVE" ? "G-Drive Sync: Active" : "Dropbox Sync: Active"}</span>
                  </Link>
                ) : (
                  <Link
                    to="/app/settings?tab=cloud"
                    className="rv-badge rv-badge-neutral"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    <CloudUploadIcon size={13} />
                    <span>Cloud Sync: Connect Drive</span>
                  </Link>
                )}
              </div>

              <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.4 }}>
                Last safe snapshot:{" "}
                <strong style={{ color: "var(--rv-text)" }}>
                  {backupCadence?.lastBackupAt ? timeAgo(backupCadence.lastBackupAt) : "No snapshots recorded yet"}
                </strong>
                {backupCadence?.nextBackupAt && backupCadence.schedule !== "OFF" && (
                  <>
                    {" "}
                    &bull; Next automated run:{" "}
                    <span style={{ color: "var(--rv-primary)", fontWeight: 600 }}>
                      {new Date(backupCadence.nextBackupAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC ({timeUntil(backupCadence.nextBackupAt)})
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Link to="/app/restore-points" className="rv-btn rv-btn-secondary rv-btn-sm">
              <SaveIcon size={14} />
              <span>Restore Points</span>
            </Link>
            <Link to="/app/settings?tab=schedules" className="rv-btn rv-btn-primary rv-btn-sm">
              <SettingsIcon size={14} />
              <span>Backup Schedule</span>
            </Link>
          </div>
        </div>
      </div>

      {/* ── Storage & Retention ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <DatabaseIcon size={18} />
            <span>Storage &amp; Backup History</span>
          </h3>
          <span className="rv-badge rv-badge-success">
            {storage?.isUnlimited ? "Unlimited Storage" : "Metered"}
          </span>
        </div>
        <div className="rv-card-body">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: "16px",
            }}
          >
            <div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: "var(--rv-text)" }}>
                {storage?.formattedSize || "0.0 MB"}
              </div>
              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                Archived across {storage?.totalRestorePoints ?? 0} restore point
                {storage?.totalRestorePoints === 1 ? "" : "s"}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: "var(--rv-text)" }}>
                {storage?.totalVaultRecords ?? 0}
              </div>
              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                Vaulted order &amp; customer records
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: "22px",
                  fontWeight: 700,
                  color: retention?.isMaxRetention ? "var(--rv-success)" : "var(--rv-text)",
                }}
              >
                {retention?.retentionDays ?? 7} days
              </div>
              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                Backup history retained
                {retention?.isMaxRetention ? " (full year)" : ""}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", marginTop: "6px" }}>
                {retention?.oldestRetainedAt
                  ? new Date(retention.oldestRetainedAt).toLocaleDateString()
                  : "—"}
              </div>
              <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                Max policy retention cutoff
              </div>
            </div>
          </div>

          {!retention?.isMaxRetention && (
            <p style={{ margin: "14px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Your plan retains {retention?.retentionDays} days of history.{" "}
              <Link to="/app/plan" style={{ color: "var(--rv-info)", fontWeight: 600 }}>
                Upgrade to Enterprise
              </Link>{" "}
              for the full 365-day backup history.
            </p>
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
                  background: !isInitialized ? "#f59e0b" : !monitoringEnabled ? "#f59e0b" : "#10b981",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span>
                {!isInitialized
                  ? "Baseline not initialized"
                  : !monitoringEnabled
                  ? "Tracking paused (in Settings)"
                  : "Real-time tracking active"}
              </span>
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
                      <span
                        className="rv-diff-old"
                        title={c.oldValue || "—"}
                      >
                        {c.oldValue || "—"}
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>→</span>
                      <span
                        className="rv-diff-new"
                        title={c.newValue || "—"}
                      >
                        {c.newValue || "—"}
                      </span>
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
            Shop: <code>{shop || "Connected"}</code>
          </span>
        </div>
        <div className="rv-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: monitoringEnabled ? "#10b981" : "#f59e0b",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>
                {monitoringEnabled ? "Live Webhooks Active" : "Webhooks Suspended"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>Encrypted Snapshot Storage</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: monitoringEnabled ? "#10b981" : "#f59e0b",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: "13px", fontWeight: 500 }}>
                {monitoringEnabled ? "Automatic Anomaly Detection" : "Anomaly Detection Paused"}
              </span>
            </div>
            {stats.totalRollbacks > 0 && (
              <span className="rv-badge rv-badge-success">
                {stats.totalRollbacks} safe rollbacks completed
              </span>
            )}
          </div>
          <Link to="/app/settings?tab=monitoring" className="rv-btn rv-btn-secondary rv-btn-sm">
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
