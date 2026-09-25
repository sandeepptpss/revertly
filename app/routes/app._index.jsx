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
  FileCodeIcon,
  ExternalLinkIcon,
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
    activeRulesCount,
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
      take: 6,
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
        themeData: true,
        themeCount: true,
      },
    }),
    prisma.detectionRule.count({ where: { shop, isActive: true } }),
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
    connected: Boolean(planLimitsInfo?.cloudSync && settings?.cloudSyncConnected),
    provider: settings?.cloudSyncProvider || "NONE",
    email: settings?.cloudSyncEmail || null,
    folder: settings?.cloudSyncFolder || "Revertly_Backups",
  };

  const monitoringEnabled = settings ? Boolean(settings.monitoringEnabled) : true;

  const activeThemeName =
    latestRestorePoint?.themeData?.activeTheme?.name ||
    (latestRestorePoint?.themeCount > 0 ? "Dawn" : null);

  return {
    stats: { totalProducts, todayChanges, openIncidents, readyRestorePoints, totalRollbacks },
    recentChanges,
    recentIncidents,
    shop,
    monitoringEnabled,
    isInitialized: totalProducts > 0,
    activeThemeName,
    latestRestorePoint: latestRestorePoint
      ? {
          id: latestRestorePoint.id,
          name: latestRestorePoint.name,
          createdAt:
            latestRestorePoint.createdAt instanceof Date
              ? latestRestorePoint.createdAt.toISOString()
              : new Date(latestRestorePoint.createdAt).toISOString(),
          status: latestRestorePoint.status,
          productCount: latestRestorePoint.productCount,
          themeCount: latestRestorePoint.themeCount,
        }
      : null,
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
    productLimitReachedAt: settings?.productLimitReachedAt || null,
    activeRulesCount,
    currentPlan: planLimitsInfo.plan || "free",
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

function formatDiffDisplay(fieldName, oldValue, newValue) {
  const fn = (fieldName || "").toLowerCase();

  // Published at timestamps -> Draft / Published (Live)
  if (fn.includes("publishedat") || fn.includes("published_at")) {
    const wasPublished = Boolean(oldValue && oldValue !== "—" && oldValue !== "null" && oldValue.trim() !== "");
    const isPublished = Boolean(newValue && newValue !== "—" && newValue !== "null" && newValue.trim() !== "");
    if (!wasPublished && isPublished) {
      return { oldText: "Draft / Hidden", newText: "Published (Live)", tone: "success" };
    }
    if (wasPublished && !isPublished) {
      return { oldText: "Published", newText: "Unpublished (Draft)", tone: "warning" };
    }
    return {
      oldText: oldValue ? new Date(oldValue).toLocaleDateString() : "—",
      newText: newValue ? new Date(newValue).toLocaleDateString() : "—",
      tone: "neutral",
    };
  }

  // Price formatting
  if (fn.includes("price") || fn.includes("cost") || fn.includes("compareat")) {
    const formatPrice = (val) => {
      if (!val || val === "—") return "—";
      const num = parseFloat(val);
      return isNaN(num) ? val : `$${num.toFixed(2)}`;
    };
    const oldNum = parseFloat(oldValue);
    const newNum = parseFloat(newValue);
    return {
      oldText: formatPrice(oldValue),
      newText: formatPrice(newValue),
      tone: !isNaN(oldNum) && !isNaN(newNum) && newNum < oldNum ? "critical" : "neutral",
    };
  }

  // Inventory quantity
  if (fn.includes("inventory") || fn.includes("quantity")) {
    const oldQty = oldValue || "—";
    let newQty = newValue || "—";
    let tone = "neutral";
    if (newValue === "0" || newValue === 0) {
      newQty = "0 (Out of stock)";
      tone = "critical";
    }
    return {
      oldText: String(oldQty),
      newText: String(newQty),
      tone,
    };
  }

  // Status changes
  if (fn.includes("status")) {
    const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "—");
    return {
      oldText: capitalize(oldValue),
      newText: capitalize(newValue),
      tone: newValue?.toLowerCase() === "active" ? "success" : "neutral",
    };
  }

  return {
    oldText: oldValue || "—",
    newText: newValue || "—",
    tone: "neutral",
  };
}

export default function Dashboard() {
  const {
    stats,
    recentChanges,
    recentIncidents,
    shop,
    monitoringEnabled,
    isInitialized,
    activeThemeName,
    latestRestorePoint,
    backupCadence,
    storage,
    retention,
    productLimitReachedAt,
    activeRulesCount,
    currentPlan,
  } = useLoaderData();

  const cleanShop = shop ? shop.replace(".myshopify.com", "") : "";
  const urgentIncident = recentIncidents.find((i) => i.status === "OPEN");

  return (
    <s-page heading="Desktop" inlineSize="large">

      {/* ── Top Hero: Store Protection Command Center ── */}
      <div className="rv-command-hero">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, minWidth: "280px" }}>
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
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
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
              <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.4 }}>
                {!isInitialized
                  ? "Initialize your store baseline snapshot to start monitoring product edits and prevent revenue loss."
                  : !monitoringEnabled
                  ? "Real-time catalog webhooks are currently paused in Settings. Changes to products will not trigger alerts."
                  : `${stats.totalProducts.toLocaleString()} products & live themes guarded against accidental price crashes, bad CSV imports, and theme code errors.`}
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
                  <span>+ 1-Click Backup</span>
                </Link>
              </>
            ) : (
              <>
                <Link to="/app/restore-points?create=true" className="rv-btn rv-btn-primary">
                  <SaveIcon size={15} />
                  <span>+ 1-Click Backup</span>
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

        {/* Live Protection Status Chips Row */}
        {isInitialized && (
          <div className="rv-chip-row">
            {/* Active Live Theme Chip */}
            <div className="rv-chip" title="Active Theme currently protected">
              <FileCodeIcon size={13} style={{ color: "var(--rv-primary)" }} />
              <span>Theme:</span>
              <strong style={{ color: "var(--rv-text)" }}>{activeThemeName || "Dawn"}</strong>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
            </div>

            {/* Automated Schedule Chip */}
            <Link
              to="/app/settings?tab=schedules"
              className="rv-chip"
              title="Click to configure automated backup cadence"
            >
              <ClockIcon size={13} style={{ color: "var(--rv-info)" }} />
              <span>Auto-Backup:</span>
              <strong style={{ color: "var(--rv-text)" }}>
                {backupCadence?.schedule === "DAILY"
                  ? `Daily (${backupCadence.preferredTime} UTC)`
                  : backupCadence?.schedule === "TWICE_DAILY"
                  ? "Every 12h"
                  : backupCadence?.schedule === "WEEKLY"
                  ? "Weekly"
                  : "Manual Only"}
              </strong>
              {backupCadence?.nextBackupAt && backupCadence?.schedule !== "OFF" && (
                <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>
                  ({timeUntil(backupCadence.nextBackupAt)})
                </span>
              )}
            </Link>

            {/* Storage & Retention Posture */}
            <Link
              to="/app/restore-points"
              className="rv-chip"
              title="Total backup storage & retention policy"
            >
              <DatabaseIcon size={13} style={{ color: "#8b5cf6" }} />
              <span>Storage:</span>
              <strong style={{ color: "var(--rv-text)" }}>{storage?.formattedSize || "0.0 MB"}</strong>
              <span style={{ color: "var(--rv-text-subdued)" }}>·</span>
              <span>{storage?.totalRestorePoints ?? 0} snapshots</span>
              <span style={{ color: "var(--rv-text-subdued)" }}>·</span>
              <span>{retention?.retentionDays ?? 7}d retention</span>
            </Link>

            {/* Cloud Sync Status Chip */}
            <Link
              to="/app/settings?tab=cloud"
              className={`rv-chip ${backupCadence?.cloudSync?.connected ? "rv-chip-success" : ""}`}
              title="Off-site cloud redundancy (Google Drive / Dropbox)"
            >
              {backupCadence?.cloudSync?.connected ? (
                <>
                  {backupCadence.cloudSync.provider === "GOOGLE_DRIVE" ? (
                    <GoogleDriveIcon size={13} style={{ color: "#ea4335" }} />
                  ) : (
                    <DropboxIcon size={13} style={{ color: "#0061fe" }} />
                  )}
                  <span>Cloud Sync: <strong>Connected</strong></span>
                </>
              ) : (
                <>
                  <CloudUploadIcon size={13} style={{ color: "var(--rv-text-subdued)" }} />
                  <span>Cloud Backup: <strong style={{ textDecoration: "underline" }}>Connect Drive</strong></span>
                </>
              )}
            </Link>
          </div>
        )}
      </div>

      {/* ── First-Time Fast Setup Guide (60-Second Protection) ── */}
      {!isInitialized && (
        <div
          className="rv-card"
          style={{
            margin: "0 0 24px 0",
            padding: "20px 24px",
            background: "linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)",
            border: "1px solid #bfdbfe",
            borderRadius: "12px",
            boxShadow: "0 4px 12px rgba(37, 99, 235, 0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
            <div style={{ maxWidth: "640px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <ShieldCheckIcon size={20} style={{ color: "#2563eb" }} />
                <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#1e3a8a" }}>
                  Welcome to Revertly! Let&apos;s protect your store in 60 seconds
                </h3>
              </div>
              <p style={{ margin: "0 0 16px 0", fontSize: "13.5px", color: "#334155", lineHeight: 1.5 }}>
                Your store protection begins with an initial <strong>Baseline Snapshot</strong>. Revertly will snapshot your products, themes, and navigation hierarchy so you have an immediate safety net against accidental price drops, rogue bulk CSV imports, and theme errors.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px", marginBottom: "16px" }}>
                <div style={{ background: "#ffffff", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>1. Baseline Snapshot</div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Capture initial catalog state</div>
                </div>
                <div style={{ background: "#ffffff", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>2. Real-Time Webhooks</div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Track price &amp; product edits</div>
                </div>
                <div style={{ background: "#ffffff", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a" }}>3. 1-Click Safe Rollback</div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Revert errors with zero data loss</div>
                </div>
              </div>
            </div>

            <div style={{ alignSelf: "center" }}>
              <Link
                to="/app/initialize"
                className="rv-btn rv-btn-primary rv-btn-lg"
                style={{
                  padding: "12px 24px",
                  fontSize: "14px",
                  fontWeight: 700,
                  boxShadow: "0 4px 6px -1px rgba(37, 99, 235, 0.2)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <ShieldCheckIcon size={18} />
                <span>Start 60-Second Setup Now</span>
                <ArrowRightIcon size={16} />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ── Urgent Action Required: Open Incident Alert Card ── */}
      {stats.openIncidents > 0 && (
        <div className="rv-urgent-incident-card">
          <div className="rv-urgent-incident-main">
            <div className="rv-urgent-icon-wrapper">
              <AlertTriangleIcon size={20} />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                <strong style={{ fontSize: "15px", color: "var(--rv-critical)", fontWeight: 700 }}>
                  {stats.openIncidents} Open Incident{stats.openIncidents > 1 ? "s" : ""} Flagged
                </strong>
                <span className="rv-badge rv-badge-critical">Immediate Action Recommended</span>
              </div>
              <p style={{ margin: 0, fontSize: "13px", color: "#475569", lineHeight: 1.4 }}>
                {urgentIncident?.notes ? (
                  <span>
                    <strong>{urgentIncident.name}</strong>: {urgentIncident.notes}
                  </span>
                ) : (
                  <span>
                    Suspicious catalog anomalies or steep price drops detected. Review changes and revert with 1 click.
                  </span>
                )}
              </p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
            <Link
              to={urgentIncident ? `/app/incidents/${urgentIncident.id}` : "/app/incidents"}
              className="rv-btn rv-btn-critical"
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontWeight: 600 }}
            >
              <span>Review &amp; Rollback</span>
              <ArrowRightIcon size={14} />
            </Link>
          </div>
        </div>
      )}

      {/* ── Monitored Product Limit Reached Alert Banner ── */}
      {productLimitReachedAt && (
        <Banner
          tone="critical"
          title="Monitored Product Capacity Reached"
          action={
            currentPlan === "enterprise" ? (
              <Link
                to={`/app/support?category=Billing&priority=HIGH&subject=${encodeURIComponent("Custom Enterprise Plus Plan Quote (> 200k products)")}&products=${stats.totalProducts}`}
                className="rv-btn rv-btn-critical rv-btn-sm"
              >
                <span>Request Custom Plus</span>
                <ArrowRightIcon size={13} />
              </Link>
            ) : (
              <Link to="/app/plan" className="rv-btn rv-btn-critical rv-btn-sm">
                <span>Upgrade Plan</span>
                <ArrowRightIcon size={13} />
              </Link>
            )
          }
        >
          {currentPlan === "enterprise"
            ? "Your store has reached the 200,000 product limit for the Enterprise plan. New products are no longer monitored. Contact us for a Custom Enterprise Plus setup."
            : "You've reached your plan's monitored product limit — newly added products are no longer tracked. Upgrade your plan to restore full protection."}
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
          <AlertTriangleIcon size={14} style={{ color: stats.openIncidents > 0 ? "var(--rv-critical)" : "inherit" }} />
          <span>Incidents</span>
          {stats.openIncidents > 0 && (
            <span className="rv-badge rv-badge-critical rv-badge-sm" style={{ padding: "1px 6px", fontSize: "10px" }}>
              {stats.openIncidents}
            </span>
          )}
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

      {/* ── 3-Column Security, Backups & Incident Hub ── */}
      <div className="rv-three-col" style={{ marginBottom: "20px" }}>
        
        {/* Card 1: Incident Alerts */}
        <div className="rv-card" style={{ margin: 0, display: "flex", flexDirection: "column" }}>
          <div className="rv-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "6px",
                  background: stats.openIncidents > 0 ? "#fee2e2" : "var(--rv-primary-surface)",
                  color: stats.openIncidents > 0 ? "var(--rv-critical)" : "var(--rv-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AlertTriangleIcon size={16} />
              </div>
              <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                <span>Incident Alerts</span>
              </h3>
            </div>
            <Link to="/app/incidents" className="rv-stat-link">
              <span>View all</span>
              <ArrowRightIcon size={13} />
            </Link>
          </div>

          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }}>
            {recentIncidents.length === 0 ? (
              <div style={{ textAlign: "center", padding: "12px 0", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <div
                  style={{
                    width: "38px",
                    height: "38px",
                    borderRadius: "50%",
                    background: "var(--rv-primary-surface)",
                    color: "var(--rv-primary)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: "8px",
                  }}
                >
                  <ShieldCheckIcon size={20} />
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", marginBottom: "4px" }}>
                  Catalog Shield All Clear
                </div>
                <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, marginBottom: "12px" }}>
                  Zero suspicious edits or price drops detected.
                </div>
                <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm">
                  Configure Rules
                </Link>
              </div>
            ) : (
              <div>
                {recentIncidents.slice(0, 1).map((inc) => (
                  <div key={inc.id}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
                      <Link to={`/app/incidents/${inc.id}`} style={{ color: "var(--rv-text)", textDecoration: "none", fontWeight: 600, fontSize: "13.5px", lineHeight: 1.3 }}>
                        {inc.name}
                      </Link>
                      <span className={`rv-badge ${inc.status === "OPEN" ? "rv-badge-critical" : "rv-badge-success"}`}>
                        {inc.status}
                      </span>
                    </div>

                    {inc.notes && (
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#7f1d1d",
                          marginBottom: "10px",
                          lineHeight: 1.4,
                          background: "#fef2f2",
                          padding: "6px 10px",
                          borderRadius: "6px",
                          border: "1px solid #fee2e2",
                        }}
                      >
                        {inc.notes}
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginTop: "10px" }}>
                      <div className="rv-item-meta" style={{ margin: 0 }}>
                        <span className={`rv-badge rv-badge-sm ${inc.severity === "CRITICAL" ? "rv-badge-critical" : "rv-badge-warning"}`}>
                          {inc.severity}
                        </span>
                        <span>{inc.affectedCount} product{inc.affectedCount !== 1 ? "s" : ""}</span>
                        <span>·</span>
                        <span>{timeAgo(inc.createdAt)}</span>
                      </div>
                      <Link to={`/app/incidents/${inc.id}`} className="rv-btn rv-btn-critical rv-btn-sm">
                        Review &amp; Rollback
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Card 2: Latest Catalog Snapshot */}
        <div className="rv-card" style={{ margin: 0, display: "flex", flexDirection: "column" }}>
          <div className="rv-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "6px",
                  background: "rgba(139, 92, 246, 0.12)",
                  color: "#8b5cf6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <SaveIcon size={16} />
              </div>
              <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                <span>Latest Snapshot</span>
              </h3>
            </div>
            <Link to="/app/restore-points" className="rv-stat-link">
              <span>All backups</span>
              <ArrowRightIcon size={13} />
            </Link>
          </div>

          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }}>
            {latestRestorePoint ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginBottom: "10px" }}>
                  <div>
                    <div style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--rv-text)" }}>
                      {latestRestorePoint.name || `Restore Point #${latestRestorePoint.id}`}
                    </div>
                    <div style={{ fontSize: "11.5px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                      Captured {timeAgo(latestRestorePoint.createdAt)} &bull; {new Date(latestRestorePoint.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span className="rv-badge rv-badge-success">Ready</span>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "8px",
                    background: "var(--rv-surface-subdued)",
                    padding: "8px 10px",
                    borderRadius: "8px",
                    border: "1px solid var(--rv-border-subtle)",
                    marginBottom: "12px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "10.5px", color: "var(--rv-text-subdued)", textTransform: "uppercase", fontWeight: 600 }}>Products</div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--rv-text)", marginTop: "1px" }}>
                      {latestRestorePoint.productCount || stats.totalProducts}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "10.5px", color: "var(--rv-text-subdued)", textTransform: "uppercase", fontWeight: 600 }}>Theme</div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--rv-text)", marginTop: "1px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {activeThemeName || "Dawn"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "10.5px", color: "var(--rv-text-subdued)", textTransform: "uppercase", fontWeight: 600 }}>Size</div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--rv-text)", marginTop: "1px" }}>
                      {storage?.formattedSize || "0.0 MB"}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Link to="/app/restore-points?create=true" className="rv-btn rv-btn-primary rv-btn-sm" style={{ flex: 1, justifyContent: "center" }}>
                    <SaveIcon size={13} />
                    <span>+ 1-Click Backup</span>
                  </Link>
                  <Link to={`/app/restore-points/${latestRestorePoint.id}`} className="rv-btn rv-btn-secondary rv-btn-sm">
                    <span>Details</span>
                  </Link>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "12px 0" }}>
                <p style={{ margin: "0 0 10px", fontSize: "12.5px", color: "var(--rv-text-subdued)" }}>
                  No restore points taken yet.
                </p>
                <Link to="/app/restore-points?create=true" className="rv-btn rv-btn-primary rv-btn-sm">
                  <SaveIcon size={14} />
                  <span>Create First Snapshot</span>
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Card 3: Store Protection Guardrails & Security Posture */}
        <div className="rv-card" style={{ margin: 0, display: "flex", flexDirection: "column" }}>
          <div className="rv-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "6px",
                  background: "rgba(16, 185, 129, 0.12)",
                  color: "var(--rv-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <ShieldCheckIcon size={16} />
              </div>
              <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                <span>Active Guardrails</span>
              </h3>
            </div>
            <span className="rv-badge rv-badge-success">Guarded 24/7</span>
          </div>

          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12.5px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: monitoringEnabled ? "#10b981" : "#f59e0b" }} />
                  <span style={{ color: "var(--rv-text)", fontWeight: 500 }}>Catalog Webhooks</span>
                </div>
                <span style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                  {monitoringEnabled ? "Live & Guarded" : "Paused"}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12.5px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#10b981" }} />
                  <span style={{ color: "var(--rv-text)", fontWeight: 500 }}>Anomaly Engine</span>
                </div>
                <span style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                  {activeRulesCount ?? 2} rules active
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12.5px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#10b981" }} />
                  <span style={{ color: "var(--rv-text)", fontWeight: 500 }}>Theme Code Guard</span>
                </div>
                <span style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                  {activeThemeName || "Dawn"} protected
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12.5px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#10b981" }} />
                  <span style={{ color: "var(--rv-text)", fontWeight: 500 }}>Safe Rollbacks</span>
                </div>
                <span style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                  {stats.totalRollbacks} completed
                </span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--rv-border-subtle)" }}>
              <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm" style={{ flex: 1, justifyContent: "center" }}>
                <FilterIcon size={12} />
                <span>Rules</span>
              </Link>
              <Link to="/app/settings?tab=monitoring" className="rv-btn rv-btn-secondary rv-btn-sm" style={{ flex: 1, justifyContent: "center" }}>
                <SettingsIcon size={12} />
                <span>Settings</span>
              </Link>
            </div>
          </div>
        </div>

      </div>

      {/* ── Full-Width Recent Activity Log ── */}
      <div className="rv-card" style={{ marginBottom: "20px" }}>
        <div className="rv-card-header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "6px",
                background: "var(--rv-info-surface)",
                color: "var(--rv-info)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ClockIcon size={16} />
            </div>
            <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
              <span>Recent Activity Log</span>
            </h3>
          </div>
          <Link to="/app/activity" className="rv-stat-link">
            <span>Open activity stream</span>
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
            recentChanges.map((c) => {
              const cleanId = c.productId ? String(c.productId).replace(/^gid:\/\/shopify\/Product\//, "") : "";
              const productAdminUrl = cleanShop && cleanId ? `https://admin.shopify.com/store/${cleanShop}/products/${cleanId}` : null;
              const diff = formatDiffDisplay(c.fieldName, c.oldValue, c.newValue);

              return (
                <div key={c.id} className="rv-item-card" style={{ padding: "12px 20px" }}>
                  <div className="rv-item-main" style={{ maxWidth: "80%" }}>
                    <div className="rv-item-title" style={{ fontSize: "13.5px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        {productAdminUrl ? (
                          <a
                            href={productAdminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: "var(--rv-text)",
                              textDecoration: "none",
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                            title={`Open ${c.productTitle} in Shopify Admin`}
                          >
                            <span>{c.productTitle}</span>
                            <ExternalLinkIcon size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
                          </a>
                        ) : (
                          <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {c.productTitle}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">
                        {fieldLabel(c.fieldName)}
                      </span>
                      <span className="rv-diff-old" title={diff.oldText}>
                        {diff.oldText}
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>→</span>
                      <span
                        className={diff.tone === "critical" ? "rv-diff-new" : diff.tone === "success" ? "rv-badge rv-badge-success rv-badge-sm" : "rv-diff-new"}
                        title={diff.newText}
                        style={diff.tone === "success" ? { fontWeight: 600, textDecoration: "none" } : undefined}
                      >
                        {diff.newText}
                      </span>
                    </div>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {timeAgo(c.changedAt)}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid var(--rv-border-subtle)", background: "var(--rv-surface-subdued)", fontSize: "12.5px", color: "var(--rv-text-subdued)", flexWrap: "wrap", gap: "10px" }}>
          <span>Real-time catalog webhooks active &bull; Edits logged automatically</span>
          <Link to="/app/activity" style={{ fontWeight: 600, color: "var(--rv-primary)", textDecoration: "none" }}>
            View Full Activity History ({stats.todayChanges} today) &rarr;
          </Link>
        </div>
      </div>

      {/* ── Dashboard Footer / Protection Stamp ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", padding: "8px 4px 16px", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <ShieldCheckIcon size={14} style={{ color: "var(--rv-primary)" }} />
          <span>Revertly Continuous Protection Engine</span>
          <span>&bull;</span>
          <span>Store: <code>{shop || "Connected"}</code></span>
        </div>
        <div>
          <span>Catalog &amp; themes encrypted &bull; 1-Click Instant Revert</span>
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
