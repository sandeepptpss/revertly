import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { getOrCreateSettings } from "../monitor.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkFeatureAccess } from "../billing.server.js";
import { getCloudProviderStatus, listCloudBackups } from "../cloudSync.server.js";
import { checkPermission, PERMISSIONS } from "../team.server.js";
import {
  SettingsIcon,
  ShieldCheckIcon,
  ClockIcon,
  BoxIcon,
  SaveIcon,
  ExternalLinkIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  ZapIcon,
  BellIcon,
  MailIcon,
  CloudIcon,
  CloudUploadIcon,
  GoogleDriveIcon,
  DropboxIcon,
  DatabaseIcon,
  RefreshCwIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, cbAccess, slackAccess] = await Promise.all([
    getOrCreateSettings(shop),
    checkFeatureAccess(shop, "circuitBreaker"),
    checkFeatureAccess(shop, "slack"),
  ]);

  // Drives an honest "needs configuration" state instead of a Connect button
  // that could only fail. The missing-env detail is for operators only — the
  // merchant-facing banner must not mention server configuration.
  const cloudProviders = getCloudProviderStatus();
  for (const p of cloudProviders) {
    if (!p.configured) {
      console.warn(
        `[Cloud Sync] ${p.label} is unavailable to merchants — missing ${p.missingEnv.join(", ")}`,
      );
    }
  }
  const url = new URL(request.url);
  const cloudNotice = {
    error: url.searchParams.get("cloud_error"),
    connected: url.searchParams.get("cloud_connected"),
    warning: url.searchParams.get("cloud_warning"),
  };

  let themeEmbedActive = false;
  let activeThemeName = "Dawn";
  try {
    const themeRes = await fetch(`https://${shop}/admin/api/2026-01/themes.json`, {
      headers: { "X-Shopify-Access-Token": session.accessToken },
    });
    if (themeRes.ok) {
      const themesData = await themeRes.json();
      const mainTheme = themesData.themes?.find((t) => t.role === "main");
      if (mainTheme) {
        activeThemeName = mainTheme.name;
        const assetRes = await fetch(
          `https://${shop}/admin/api/2026-01/themes/${mainTheme.id}/assets.json?asset[key]=config/settings_data.json`,
          { headers: { "X-Shopify-Access-Token": session.accessToken } }
        );
        if (assetRes.ok) {
          const assetData = await assetRes.json();
          const settingsJson = JSON.parse(assetData.asset?.value || "{}");
          const blocks = settingsJson.current?.blocks || {};
          for (const block of Object.values(blocks)) {
            if (block.type?.includes("revertly_embed") && !block.disabled) {
              themeEmbedActive = true;
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Could not check theme embed status:", err.message);
  }

  const cleanShopName = shop.replace(".myshopify.com", "");
  const themeEditorUrl = `https://admin.shopify.com/store/${cleanShopName}/themes/current/editor?context=apps`;

  return {
    settings,
    hasCircuitBreakerAccess: cbAccess.allowed,
    hasSlackAccess: slackAccess.allowed,
    plan: cbAccess.plan,
    themeEmbedActive,
    activeThemeName,
    themeEditorUrl,
    cloudProviders,
    cloudNotice,
  };
};

function safeParseInt(val, fallback) {
  if (val === null || val === undefined || String(val).trim() === "") return fallback;
  const parsed = parseInt(String(val).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function computeNextAutoBackup(schedule, timeStr) {
  if (!schedule || schedule === "OFF") return null;
  const [hours, minutes] = (timeStr || "02:00").split(":").map((v) => parseInt(v, 10) || 0);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
  if (next.getTime() <= now.getTime()) {
    if (schedule === "TWICE_DAILY") {
      next.setUTCHours(next.getUTCHours() + 12);
    } else if (schedule === "WEEKLY") {
      next.setUTCDate(next.getUTCDate() + 7);
    } else {
      // DAILY
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next;
}

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");

    // Every action on this page mutates shop configuration.
    const settingsPerm = await checkPermission(shop, session, PERMISSIONS.SETTINGS_WRITE);
    if (!settingsPerm.allowed) {
      return { success: false, message: settingsPerm.message };
    }

    if (intent === "testSlack") {
      const slackCheck = await checkFeatureAccess(shop, "slack");
      if (!slackCheck.allowed) {
        return {
          success: false,
          message: `Slack Alerts require the Business ($49) or Enterprise ($79) plan. Please upgrade your plan in Plans & Billing to enable Slack webhooks.`,
        };
      }

      const slackUrl = formData.get("slackWebhookUrl")?.trim();
      if (!slackUrl) {
        return { success: false, message: "Please provide a Slack Webhook URL first." };
      }
      try {
        const resp = await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "*[Revertly Test Notification]*",
            attachments: [
              {
                color: "#008060",
                title: "Slack Alerts Connected Successfully!",
                text: `Revertly is active for ${shop}. Critical price drops and anomaly incidents will be delivered to this channel in real time.`,
                footer: "Revertly Product Guard",
                ts: Math.floor(Date.now() / 1000),
              },
            ],
          }),
        });
        if (resp.ok) {
          return { success: true, message: "Test Slack alert delivered successfully!" };
        } else {
          return { success: false, message: `Slack webhook responded with status ${resp.status}` };
        }
      } catch (err) {
        return { success: false, message: `Failed to deliver Slack alert: ${err.message}` };
      }
    }

    // Note: there is deliberately no "connectCloud" action. Connecting requires
    // a real OAuth consent round-trip, which starts at /auth/cloud/:provider —
    // a form post here could only ever fake a connection.

    if (intent === "disconnectCloud") {
      await prisma.appSettings.update({
        where: { shop },
        data: {
          cloudSyncConnected: false,
          cloudSyncProvider: "NONE",
          cloudSyncEmail: null,
          cloudSyncAutoUpload: false,
          // Drop the credentials too; leaving them behind would keep a usable
          // token for an account the merchant believes they disconnected.
          cloudSyncAccessToken: null,
          cloudSyncRefreshToken: null,
          cloudSyncTokenExpiry: null,
        },
      });
      return {
        success: true,
        message: "Cloud storage disconnected and stored credentials deleted. Backups are retained locally.",
      };
    }

    if (intent === "testCloudSync") {
      // A real round-trip against the provider, so a failure is reported as one.
      const res = await listCloudBackups(shop);
      if (!res.success) {
        return { success: false, message: `Connection test failed: ${res.error}` };
      }
      const existing = await getOrCreateSettings(shop);
      const providerName = existing.cloudSyncProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox";
      return {
        success: true,
        message: `Connection verified. ${res.files?.length ?? 0} backup file(s) found in ${providerName} folder "/${existing.cloudSyncFolder}".`,
      };
    }

    const [cbCheck, slackCheck, existing] = await Promise.all([
      checkFeatureAccess(shop, "circuitBreaker"),
      checkFeatureAccess(shop, "slack"),
      getOrCreateSettings(shop),
    ]);

    const hasCbParam = formData.has("circuitBreakerEnabled");
    const requestedCb = formData.get("circuitBreakerEnabled") === "true";

    const circuitBreakerEnabled = cbCheck.allowed
      ? (hasCbParam ? requestedCb : (existing.circuitBreakerEnabled || false))
      : false;

    const circuitBreakerThreshold = cbCheck.allowed && formData.has("circuitBreakerThreshold")
      ? safeParseInt(formData.get("circuitBreakerThreshold"), existing.circuitBreakerThreshold || 50)
      : (existing.circuitBreakerThreshold || 50);

    const circuitBreakerAction = cbCheck.allowed && formData.has("circuitBreakerAction")
      ? (formData.get("circuitBreakerAction") || existing.circuitBreakerAction || "DRAFT")
      : (existing.circuitBreakerAction || "DRAFT");

    const slackWebhookUrl = slackCheck.allowed
      ? (formData.has("slackWebhookUrl") ? (formData.get("slackWebhookUrl")?.trim() || null) : existing.slackWebhookUrl)
      : existing.slackWebhookUrl;

    const alertEmail = formData.has("alertEmail") ? (formData.get("alertEmail")?.trim() || null) : existing.alertEmail;
    const alertOnCritical = formData.has("alertOnCritical") ? formData.get("alertOnCritical") === "true" : existing.alertOnCritical;
    const alertOnHigh = formData.has("alertOnHigh") ? formData.get("alertOnHigh") === "true" : existing.alertOnHigh;
    const alertOnMedium = formData.has("alertOnMedium") ? formData.get("alertOnMedium") === "true" : existing.alertOnMedium;
    const monitoringEnabled = formData.has("monitoringEnabled") ? formData.get("monitoringEnabled") === "true" : existing.monitoringEnabled;

    const bulkThreshold = safeParseInt(formData.get("bulkThreshold"), existing.bulkThreshold || 20);
    const bulkWindowMinutes = safeParseInt(formData.get("bulkWindowMinutes"), existing.bulkWindowMinutes || 10);

    const autoBackupSchedule = formData.has("autoBackupSchedule")
      ? (formData.get("autoBackupSchedule") || "DAILY")
      : (existing.autoBackupSchedule || "DAILY");

    const autoBackupTime = formData.has("autoBackupTime")
      ? (formData.get("autoBackupTime") || "02:00")
      : (existing.autoBackupTime || "02:00");

    const cloudSyncFolder = formData.has("cloudSyncFolder")
      ? (formData.get("cloudSyncFolder")?.trim() || "Revertly_Backups")
      : (existing.cloudSyncFolder || "Revertly_Backups");

    const cloudSyncAutoUpload = formData.has("cloudSyncAutoUpload")
      ? formData.get("cloudSyncAutoUpload") === "true"
      : existing.cloudSyncAutoUpload;

    const nextAutoBackupAt = computeNextAutoBackup(autoBackupSchedule, autoBackupTime);

    await prisma.appSettings.upsert({
      where: { shop },
      create: {
        shop,
        alertEmail,
        alertOnCritical,
        alertOnHigh,
        alertOnMedium,
        monitoringEnabled,
        bulkThreshold,
        bulkWindowMinutes,
        slackWebhookUrl,
        circuitBreakerEnabled,
        circuitBreakerThreshold,
        circuitBreakerAction,
        autoBackupSchedule,
        autoBackupTime,
        nextAutoBackupAt,
        cloudSyncFolder,
        cloudSyncAutoUpload,
      },
      update: {
        alertEmail,
        alertOnCritical,
        alertOnHigh,
        alertOnMedium,
        monitoringEnabled,
        bulkThreshold,
        bulkWindowMinutes,
        slackWebhookUrl,
        circuitBreakerEnabled,
        circuitBreakerThreshold,
        circuitBreakerAction,
        autoBackupSchedule,
        autoBackupTime,
        nextAutoBackupAt,
        cloudSyncFolder,
        cloudSyncAutoUpload,
      },
    });

    return { success: true, message: "Settings saved successfully." };
  } catch (err) {
    console.error("[Revertly Settings Error] Failed to save settings:", err);
    return {
      success: false,
      message: `Failed to save settings: ${err?.message || "An unexpected database error occurred. Please try again."}`,
    };
  }
};

export default function Settings() {
  const {
    settings,
    hasCircuitBreakerAccess = false,
    hasSlackAccess = false,
    plan = "free",
    themeEmbedActive = false,
    activeThemeName = "Dawn",
    themeEditorUrl = "",
    cloudProviders = [],
    cloudNotice = {},
  } = useLoaderData();

  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSaving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save";
  const isTestingSlack = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "testSlack";

  // Navigation tab
  const [activeTab, setActiveTab] = useState("all");

  // Local form states for real-time reactivity
  const [monitoringEnabled, setMonitoringEnabled] = useState(settings?.monitoringEnabled ?? true);
  const [circuitBreakerEnabled, setCircuitBreakerEnabled] = useState(Boolean(hasCircuitBreakerAccess && settings?.circuitBreakerEnabled));
  const [threshold, setThreshold] = useState(settings?.circuitBreakerThreshold || 50);
  const [actionChoice, setActionChoice] = useState(settings?.circuitBreakerAction || "DRAFT");
  const [slackUrl, setSlackUrl] = useState(settings?.slackWebhookUrl || "");
  const [alertCritical, setAlertCritical] = useState(settings?.alertOnCritical ?? true);
  const [alertHigh, setAlertHigh] = useState(settings?.alertOnHigh ?? true);
  const [alertMedium, setAlertMedium] = useState(settings?.alertOnMedium ?? false);

  // Auto Backup & Cloud Storage states
  const [autoBackupSchedule, setAutoBackupSchedule] = useState(settings?.autoBackupSchedule || "DAILY");
  const [autoBackupTime, setAutoBackupTime] = useState(settings?.autoBackupTime || "02:00");
  const [cloudSyncFolder, setCloudSyncFolder] = useState(settings?.cloudSyncFolder || "Revertly_Backups");
  const [cloudSyncAutoUpload, setCloudSyncAutoUpload] = useState(settings?.cloudSyncAutoUpload ?? true);
  const [connectProvider, setConnectProvider] = useState("GOOGLE_DRIVE");

  const isCloudConnected = Boolean(settings?.cloudSyncConnected);
  const activeCloudProvider = settings?.cloudSyncProvider || "NONE";
  const selectedProviderStatus = (cloudProviders || []).find((p) => p.id === connectProvider);
  // If only one provider is enabled, point the merchant at the one that works
  // rather than leaving them with a dead end.
  const otherProviderAvailable = (cloudProviders || []).some(
    (p) => p.configured && p.id !== connectProvider,
  );

  const numThreshold = parseInt(String(threshold), 10) || 50;
  const sampleReducedPrice = Math.max(0, 100 * (1 - numThreshold / 100)).toFixed(0);

  const navItems = [
    { id: "all", label: "All Settings", icon: SettingsIcon, statusBadge: null, statusTone: "neutral" },
    { id: "schedules", label: "Scheduled Backups", icon: ClockIcon, statusBadge: autoBackupSchedule !== "OFF" ? autoBackupSchedule : "Disabled", statusTone: autoBackupSchedule !== "OFF" ? "success" : "neutral" },
    { id: "cloud", label: "Cloud Sync (Drive / Dropbox)", icon: CloudUploadIcon, statusBadge: isCloudConnected ? (activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox") : "Not Linked", statusTone: isCloudConnected ? "success" : "warning" },
    { id: "monitoring", label: "Catalog Monitoring", icon: ClockIcon, statusBadge: monitoringEnabled ? "Active" : "Paused", statusTone: monitoringEnabled ? "success" : "neutral" },
    { id: "circuit", label: "Price Crash Breaker", icon: ZapIcon, statusBadge: circuitBreakerEnabled ? "Armed" : "Off", statusTone: circuitBreakerEnabled ? "warning" : "neutral" },
    { id: "bulk", label: "Anomaly Detection", icon: BoxIcon, statusBadge: `${settings?.bulkThreshold ?? 20} items`, statusTone: "neutral" },
    { id: "alerts", label: "Alert Channels", icon: BellIcon, statusBadge: hasSlackAccess ? "Slack + Email" : "Email", statusTone: "neutral" },
    { id: "embed", label: "Storefront Embed", icon: ShieldCheckIcon, statusBadge: themeEmbedActive ? "Active" : "Setup", statusTone: themeEmbedActive ? "success" : "warning" },
  ];

  return (
    <s-page heading="Settings" inlineSize="full">
      <div className="rv-settings-wrapper">

        {/* Cloud OAuth round-trip result (redirected back from the provider) */}
        {cloudNotice?.error && (
          <Banner tone="critical" title="Cloud connection failed" className="rv-fade-in">
            {cloudNotice.error}
          </Banner>
        )}
        {cloudNotice?.connected && (
          <Banner tone="success" title="Cloud storage connected" className="rv-fade-in">
            {cloudNotice.connected === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox"} is now linked to this store.
            {cloudNotice.warning === "no_refresh_token" && (
              <strong>
                {" "}
                The provider did not return a refresh token, so this connection will stop working when
                the access token expires. Disconnect and reconnect to fix it.
              </strong>
            )}
          </Banner>
        )}

        {/* Action Result Banner */}
        {result?.message && (
          <Banner
            tone={result.success ? "success" : "critical"}
            title={result.success ? "Settings Saved" : "Settings Error"}
            className="rv-fade-in"
          >
            {result.message}
          </Banner>
        )}

        <fetcher.Form method="POST">
          <input type="hidden" name="intent" value="save" />

          {/* Top Hero Banner */}
          <div
            className="rv-hero-banner"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "16px",
              marginBottom: "24px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                className="rv-card-icon-badge success"
                style={{ width: "42px", height: "42px", borderRadius: "var(--rv-radius-md)" }}
              >
                <SettingsIcon size={22} />
              </div>
              <div>
                <h1 style={{ fontSize: "18px", fontWeight: 800, color: "var(--rv-text)", margin: "0 0 3px" }}>
                  Store Protection &amp; Alert Engine
                </h1>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                  Automate catalog change defense, price crash circuit breakers, and operations alerting.
                </p>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSaving}
              className="rv-btn rv-btn-primary rv-btn-lg"
              style={{ minWidth: "160px" }}
            >
              <SaveIcon size={16} />
              <span>{isSaving ? "Saving Settings..." : "Save All Settings"}</span>
            </button>
          </div>

          {/* 2-Column Responsive Layout */}
          <div className="rv-settings-grid">

            {/* Left Sidebar: Navigation & Protection Health Card */}
            <aside className="rv-settings-sidebar">
              <nav className="rv-settings-nav" aria-label="Settings Categories">
                <div style={{ padding: "6px 10px 4px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--rv-text-subdued)" }}>
                  Settings Menu
                </div>
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`rv-settings-nav-item ${isActive ? "active" : ""}`}
                      onClick={() => setActiveTab(item.id)}
                    >
                      <div className="rv-settings-nav-item-content">
                        <span className="rv-settings-nav-icon">
                          <Icon size={16} />
                        </span>
                        <span>{item.label}</span>
                      </div>
                      {item.statusBadge && (
                        <span className={`rv-badge rv-badge-${item.statusTone} rv-badge-sm`} style={{ fontSize: "10px", padding: "1px 6px" }}>
                          {item.statusBadge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>

              {/* Store Protection Overview Card */}
              <div
                className="rv-card"
                style={{
                  padding: "16px",
                  margin: 0,
                  background: "linear-gradient(135deg, var(--rv-surface) 0%, var(--rv-surface-subdued) 100%)",
                  border: "1px solid var(--rv-border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                  <ShieldCheckIcon size={18} style={{ color: "var(--rv-primary)" }} />
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--rv-text)" }}>
                    Protection Status
                  </span>
                </div>
                <p style={{ margin: "0 0 12px", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Webhooks are active and syncing changes in real time.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px", borderTop: "1px solid var(--rv-border-subtle)", paddingTop: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Active Plan:</span>
                    <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontWeight: 700, textTransform: "uppercase" }}>
                      {plan}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Monitoring:</span>
                    <span style={{ fontWeight: 600, color: monitoringEnabled ? "var(--rv-primary)" : "var(--rv-text-subdued)" }}>
                      {monitoringEnabled ? "Enabled" : "Paused"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Circuit Breaker:</span>
                    <span style={{ fontWeight: 600, color: circuitBreakerEnabled ? "var(--rv-warning)" : "var(--rv-text-subdued)" }}>
                      {circuitBreakerEnabled ? "Armed" : "Inactive"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Auto Schedule:</span>
                    <span style={{ fontWeight: 600, color: autoBackupSchedule !== "OFF" ? "var(--rv-primary)" : "var(--rv-text-subdued)" }}>
                      {autoBackupSchedule}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Cloud Sync:</span>
                    <span style={{ fontWeight: 600, color: isCloudConnected ? "var(--rv-primary)" : "var(--rv-text-subdued)" }}>
                      {isCloudConnected ? (activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox") : "Disabled"}
                    </span>
                  </div>
                </div>
              </div>
            </aside>

            {/* Right Column: Settings Cards */}
            <main style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

              {/* ── 0. Scheduled Backups Card ── */}
              {(activeTab === "all" || activeTab === "schedules") && (
                <div className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge info">
                        <ClockIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Automated Scheduled Backups
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Set automatic background snapshots for products, theme code, collections, and vault logs.
                        </p>
                      </div>
                    </div>
                    <span className={`rv-badge ${autoBackupSchedule !== "OFF" ? "rv-badge-success" : "rv-badge-neutral"}`}>
                      {autoBackupSchedule !== "OFF" ? `Cadence: ${autoBackupSchedule}` : "Manual Only"}
                    </span>
                  </div>

                  <div className="rv-card-body">
                    {/* Live Schedule Status Indicator */}
                    <div
                      style={{
                        padding: "14px 16px",
                        background: "linear-gradient(135deg, rgba(0, 128, 96, 0.06) 0%, rgba(37, 99, 235, 0.06) 100%)",
                        borderRadius: "var(--rv-radius-sm)",
                        border: "1px solid rgba(0, 128, 96, 0.2)",
                        marginBottom: "18px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "12px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "50%",
                            background: "var(--rv-primary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#fff",
                            flexShrink: 0,
                          }}
                        >
                          <ClockIcon size={18} />
                        </div>
                        <div>
                          <strong style={{ fontSize: "13px", color: "var(--rv-text)", display: "block" }}>
                            {autoBackupSchedule !== "OFF"
                              ? `Active Cadence: ${autoBackupSchedule === "DAILY" ? "Daily at " + autoBackupTime + " UTC" : autoBackupSchedule === "TWICE_DAILY" ? "Every 12 Hours" : "Weekly"}`
                              : "Automated Cadence is Disabled"}
                          </strong>
                          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            Last backup: {settings?.lastAutoBackupAt ? new Date(settings.lastAutoBackupAt).toLocaleString() : "Never (Pending first scheduled run)"} &bull; Next scheduled: {settings?.nextAutoBackupAt ? new Date(settings.nextAutoBackupAt).toLocaleString() : "Calculated on save"}
                          </span>
                        </div>
                      </div>
                      <Link to="/app/restore-points" className="rv-btn rv-btn-secondary rv-btn-sm">
                        View Restore Points
                      </Link>
                    </div>

                    {/* Cadence Selector */}
                    <div className="rv-form-group" style={{ marginBottom: "16px" }}>
                      <label className="rv-label" htmlFor="autoBackupSchedule">
                        Backup Cadence Frequency
                      </label>
                      <select
                        id="autoBackupSchedule"
                        name="autoBackupSchedule"
                        className="rv-select"
                        value={autoBackupSchedule}
                        onChange={(e) => setAutoBackupSchedule(e.target.value)}
                      >
                        <option value="DAILY">Daily Safe Snapshot (Recommended - runs every 24 hours)</option>
                        <option value="TWICE_DAILY">Twice Daily (Every 12 hours - for high velocity stores)</option>
                        <option value="WEEKLY">Weekly Snapshot (Every 7 days)</option>
                        <option value="OFF">Disabled (Manual on-demand backups only)</option>
                      </select>
                      <span className="rv-helper-text">
                        Automated snapshots take a complete versioned snapshot including products, themes, and navigation menus.
                      </span>
                    </div>

                    {/* Target Time */}
                    {autoBackupSchedule !== "OFF" && (
                      <div className="rv-form-group" style={{ marginBottom: "12px" }}>
                        <label className="rv-label" htmlFor="autoBackupTime">
                          Preferred Backup Window (UTC)
                        </label>
                        <select
                          id="autoBackupTime"
                          name="autoBackupTime"
                          className="rv-select"
                          value={autoBackupTime}
                          onChange={(e) => setAutoBackupTime(e.target.value)}
                        >
                          <option value="00:00">00:00 UTC (Midnight)</option>
                          <option value="02:00">02:00 UTC (Recommended low-traffic window)</option>
                          <option value="04:00">04:00 UTC</option>
                          <option value="08:00">08:00 UTC</option>
                          <option value="12:00">12:00 UTC (Midday)</option>
                          <option value="18:00">18:00 UTC</option>
                          <option value="22:00">22:00 UTC</option>
                        </select>
                        <span className="rv-helper-text">
                          Choose off-peak hours when inventory updates and order traffic are lowest.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── 0.1 Cloud Storage Sync Card ── */}
              {(activeTab === "all" || activeTab === "cloud") && (
                <div className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge" style={{ background: "rgba(37, 99, 235, 0.1)", color: "#2563eb" }}>
                        <CloudUploadIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Offsite Cloud Storage Sync (Google Drive &amp; Dropbox)
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Keep independent disaster recovery archives in your personal or company cloud storage.
                        </p>
                      </div>
                    </div>
                    <span className={`rv-badge ${isCloudConnected ? "rv-badge-success" : "rv-badge-warning"}`}>
                      {isCloudConnected ? `${activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox"} Linked` : "Not Linked"}
                    </span>
                  </div>

                  <div className="rv-card-body">
                    {isCloudConnected ? (
                      <div>
                        {/* Connected State Box */}
                        <div
                          style={{
                            padding: "16px",
                            background: "var(--rv-surface-subdued)",
                            borderRadius: "var(--rv-radius-sm)",
                            border: "1px solid var(--rv-border-subtle)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            flexWrap: "wrap",
                            gap: "14px",
                            marginBottom: "16px",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "42px",
                                height: "42px",
                                borderRadius: "8px",
                                background: activeCloudProvider === "GOOGLE_DRIVE" ? "rgba(234, 67, 53, 0.1)" : "rgba(0, 97, 254, 0.1)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                color: activeCloudProvider === "GOOGLE_DRIVE" ? "#ea4335" : "#0061fe",
                                flexShrink: 0,
                              }}
                            >
                              {activeCloudProvider === "GOOGLE_DRIVE" ? <GoogleDriveIcon size={22} /> : <DropboxIcon size={22} />}
                            </div>
                            <div>
                              <strong style={{ fontSize: "14px", color: "var(--rv-text)", display: "block" }}>
                                {activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive Connected" : "Dropbox Connected"}
                              </strong>
                              <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                                Account: <strong>{settings?.cloudSyncEmail || "Active Account"}</strong> &bull; Remote Target: <code>/{cloudSyncFolder}</code>
                              </span>
                            </div>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <button
                              type="submit"
                              name="intent"
                              value="testCloudSync"
                              className="rv-btn rv-btn-secondary rv-btn-sm"
                            >
                              <RefreshCwIcon size={13} />
                              <span>Test Sync</span>
                            </button>
                            <button
                              type="submit"
                              name="intent"
                              value="disconnectCloud"
                              className="rv-btn rv-btn-danger rv-btn-sm"
                              onClick={(e) => {
                                if (!confirm("Disconnect cloud storage? Backups will remain stored in Revertly database.")) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              Disconnect
                            </button>
                          </div>
                        </div>

                        {/* Cloud Folder & Auto Upload Settings */}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginBottom: "16px" }}>
                          <div className="rv-form-group" style={{ margin: 0 }}>
                            <label className="rv-label" htmlFor="cloudSyncFolder">
                              Target Cloud Directory / Folder
                            </label>
                            <input
                              id="cloudSyncFolder"
                              type="text"
                              name="cloudSyncFolder"
                              className="rv-input"
                              value={cloudSyncFolder}
                              onChange={(e) => setCloudSyncFolder(e.target.value)}
                              placeholder="Revertly_Backups"
                            />
                            <span className="rv-helper-text">
                              Subfolder inside your Drive/Dropbox where JSON and zip archives will be saved.
                            </span>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "12px",
                              padding: "12px 14px",
                              background: "#ffffff",
                              borderRadius: "var(--rv-radius-sm)",
                              border: "1px solid var(--rv-border-subtle)",
                            }}
                          >
                            <div>
                              <strong style={{ fontSize: "13px", color: "var(--rv-text)", display: "block" }}>
                                Auto-Push New Snapshots
                              </strong>
                              <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>
                                Automatically push every new restore point to cloud storage.
                              </span>
                            </div>
                            <div className="rv-switch">
                              <input
                                id="set-cloud-autoupload"
                                type="checkbox"
                                name="cloudSyncAutoUpload"
                                value="true"
                                checked={cloudSyncAutoUpload}
                                onChange={(e) => setCloudSyncAutoUpload(e.target.checked)}
                              />
                              <label htmlFor="set-cloud-autoupload" className="rv-switch-slider">
                                <span className="rv-sr-only">Toggle Cloud Auto-Upload</span>
                              </label>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* Not Connected: Choose Provider */
                      <div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "16px" }}>
                          <div
                            onClick={() => setConnectProvider("GOOGLE_DRIVE")}
                            style={{
                              padding: "16px",
                              borderRadius: "var(--rv-radius-sm)",
                              border: `2px solid ${connectProvider === "GOOGLE_DRIVE" ? "var(--rv-primary)" : "var(--rv-border-subtle)"}`,
                              background: connectProvider === "GOOGLE_DRIVE" ? "rgba(0, 128, 96, 0.04)" : "#ffffff",
                              cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                              <GoogleDriveIcon size={24} style={{ color: "#ea4335" }} />
                              <div>
                                <strong style={{ fontSize: "14px", color: "var(--rv-text)", display: "block" }}>Google Drive</strong>
                                <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Personal or Google Workspace</span>
                              </div>
                            </div>
                            <p style={{ fontSize: "12px", color: "var(--rv-text-subdued)", margin: 0, lineHeight: 1.4 }}>
                              Export catalog snapshots directly to Google Drive folder for offsite data safety.
                            </p>
                          </div>

                          <div
                            onClick={() => setConnectProvider("DROPBOX")}
                            style={{
                              padding: "16px",
                              borderRadius: "var(--rv-radius-sm)",
                              border: `2px solid ${connectProvider === "DROPBOX" ? "var(--rv-primary)" : "var(--rv-border-subtle)"}`,
                              background: connectProvider === "DROPBOX" ? "rgba(0, 128, 96, 0.04)" : "#ffffff",
                              cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                              <DropboxIcon size={24} style={{ color: "#0061fe" }} />
                              <div>
                                <strong style={{ fontSize: "14px", color: "var(--rv-text)", display: "block" }}>Dropbox</strong>
                                <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Dropbox Business or Basic</span>
                              </div>
                            </div>
                            <p style={{ fontSize: "12px", color: "var(--rv-text-subdued)", margin: 0, lineHeight: 1.4 }}>
                              Sync versioned restore points to Dropbox with automated historical retention.
                            </p>
                          </div>
                        </div>

                        {/* Real OAuth handoff. Connecting requires provider
                            consent, so this is a link out, not a form post. */}
                        <div
                          style={{
                            padding: "16px",
                            background: "var(--rv-surface-subdued)",
                            borderRadius: "var(--rv-radius-sm)",
                            border: "1px solid var(--rv-border-subtle)",
                            display: "flex",
                            flexDirection: "column",
                            gap: "12px",
                          }}
                        >
                          {selectedProviderStatus?.configured ? (
                            <>
                              <p style={{ fontSize: "12px", color: "var(--rv-text-subdued)", margin: 0, lineHeight: 1.5 }}>
                                You will be sent to {selectedProviderStatus.label} to approve access. Revertly
                                only requests permission for the files it creates, and your account
                                email is read from the provider after you approve — nothing is stored
                                until then.
                              </p>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px" }}>
                                {/* target="_top" is required: the app runs inside
                                    Shopify Admin's iframe, and Google/Dropbox both
                                    refuse to render their consent screen in a frame
                                    (X-Frame-Options). Without this the click stays
                                    inside the iframe and the OAuth page loads blank. */}
                                <a
                                  href={`/auth/cloud/${connectProvider.toLowerCase()}`}
                                  target="_top"
                                  rel="noopener"
                                  className="rv-btn rv-btn-primary"
                                >
                                  <CloudUploadIcon size={14} />
                                  <span>Connect {selectedProviderStatus.label}</span>
                                </a>
                              </div>
                            </>
                          ) : (
                            /* Merchant-facing copy: a merchant has no server and
                               no environment file, so this must not tell them to
                               set env vars. This is also NOT a per-store toggle —
                               it is one app-wide setup step the app operator does
                               once for every merchant — so the copy must not
                               imply support can switch it on for one store. The
                               operator detail is logged server-side instead. */
                            <Banner
                              tone="warning"
                              title={`${selectedProviderStatus?.label || "This provider"} isn't available yet`}
                            >
                              <p style={{ margin: "0 0 6px" }}>
                                Offsite sync to {selectedProviderStatus?.label} is being set up for Revertly and
                                isn&apos;t ready yet. Your backups are still being captured and stored safely —
                                this only affects keeping an extra copy in your own cloud storage.
                              </p>
                              <p style={{ margin: 0, fontSize: "12px" }}>
                                {otherProviderAvailable ? (
                                  <>
                                    You can connect{" "}
                                    <strong>
                                      {(cloudProviders || []).find((p) => p.configured && p.id !== connectProvider)?.label}
                                    </strong>{" "}
                                    now instead. We&apos;ll let you know when {selectedProviderStatus?.label} support
                                    is available.
                                  </>
                                ) : (
                                  <>We&apos;ll let you know as soon as this is available.</>
                                )}
                              </p>
                            </Banner>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── 1. Catalog Monitoring Card ── */}
              {(activeTab === "all" || activeTab === "monitoring") && (
                <div className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge info">
                        <ClockIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Real-Time Catalog Monitoring
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Background event listener for price drops, title changes, and inventory spikes.
                        </p>
                      </div>
                    </div>
                    <span className={`rv-badge ${monitoringEnabled ? "rv-badge-success" : "rv-badge-neutral"}`}>
                      {monitoringEnabled ? "Actively Protecting" : "Paused"}
                    </span>
                  </div>

                  <div className="rv-card-body">
                    {/* Modern Switch Row */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "16px",
                        padding: "16px 18px",
                        background: "var(--rv-surface-subdued)",
                        borderRadius: "var(--rv-radius-sm)",
                        border: "1px solid var(--rv-border-subtle)",
                        marginBottom: "16px",
                      }}
                    >
                      <div>
                        <label
                          htmlFor="set-monitoring"
                          style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", display: "block", cursor: "pointer", marginBottom: "2px" }}
                        >
                          Enable Real-Time Catalog Monitoring
                        </label>
                        <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5, display: "block" }}>
                          Capture instant Shopify webhooks for product edits and inventory events to maintain drift history.
                        </span>
                      </div>
                      <div className="rv-switch">
                        <input
                          id="set-monitoring"
                          type="checkbox"
                          name="monitoringEnabled"
                          value="true"
                          checked={monitoringEnabled}
                          onChange={(e) => setMonitoringEnabled(e.target.checked)}
                        />
                        <label htmlFor="set-monitoring" className="rv-switch-slider">
                          <span className="rv-sr-only">Toggle Real-Time Catalog Monitoring</span>
                        </label>
                      </div>
                    </div>

                    {/* Monitored Webhook Events Grid */}
                    <div>
                      <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--rv-text-subdued)", display: "block", marginBottom: "8px" }}>
                        Active Monitored Webhook Channels:
                      </span>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" }}>
                        {[
                          { title: "Price Adjustments", desc: "Variants & Compare-at prices" },
                          { title: "Product Deletions", desc: "Deleted item recovery guard" },
                          { title: "Inventory Depletions", desc: "Out-of-stock anomaly watch" },
                          { title: "Metafield Updates", desc: "Custom fields & SEO tags" },
                        ].map((evt, idx) => (
                          <div
                            key={idx}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              padding: "8px 12px",
                              background: "#ffffff",
                              border: "1px solid var(--rv-border-subtle)",
                              borderRadius: "var(--rv-radius-sm)",
                              fontSize: "12px",
                            }}
                          >
                            <CheckCircleIcon size={14} style={{ color: "var(--rv-primary)", flexShrink: 0 }} />
                            <div>
                              <strong style={{ display: "block", color: "var(--rv-text)" }}>{evt.title}</strong>
                              <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>{evt.desc}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 2. Price Crash Circuit Breaker Card ── */}
              {(activeTab === "all" || activeTab === "circuit") && (
                <div className="rv-card" style={{ margin: 0, opacity: hasCircuitBreakerAccess ? 1 : 0.9 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge warning">
                        <ZapIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Emergency Circuit Breaker (Price Crash Guard)
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Automatic emergency defensive action when sudden price drops threaten merchant revenue.
                        </p>
                      </div>
                    </div>
                    {hasCircuitBreakerAccess ? (
                      <span className="rv-badge rv-badge-warning">
                        {circuitBreakerEnabled ? "Armed & Protecting" : "Disarmed"}
                      </span>
                    ) : (
                      <span className="rv-badge rv-badge-neutral">Requires Business Plan</span>
                    )}
                  </div>

                  <div className="rv-card-body">
                    {!hasCircuitBreakerAccess && (
                      <div
                        style={{
                          background: "var(--rv-warning-surface)",
                          border: "1px solid var(--rv-warning-border)",
                          borderRadius: "var(--rv-radius-sm)",
                          padding: "12px 16px",
                          fontSize: "13px",
                          color: "var(--rv-text)",
                          marginBottom: "16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "12px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <AlertTriangleIcon size={16} style={{ color: "var(--rv-warning)", flexShrink: 0 }} />
                          <span>Emergency Circuit Breaker is an automated revenue guard available on <strong>Business</strong> and <strong>Enterprise</strong> tiers.</span>
                        </div>
                        <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
                          Upgrade to Business ($49/mo)
                        </Link>
                      </div>
                    )}

                    {/* Switch Row */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "16px",
                        padding: "16px 18px",
                        background: "var(--rv-surface-subdued)",
                        borderRadius: "var(--rv-radius-sm)",
                        border: "1px solid var(--rv-border-subtle)",
                        marginBottom: "18px",
                      }}
                    >
                      <div>
                        <label
                          htmlFor="set-circuit-breaker"
                          style={{
                            fontSize: "14px",
                            fontWeight: 600,
                            color: "var(--rv-text)",
                            display: "block",
                            cursor: hasCircuitBreakerAccess ? "pointer" : "not-allowed",
                            marginBottom: "2px",
                          }}
                        >
                          Activate Price Crash Circuit Breaker
                        </label>
                        <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5, display: "block" }}>
                          Intervene instantly if an unauthorized CSV upload or rogue app drops prices past safety margins.
                        </span>
                      </div>
                      <div className={`rv-switch ${!hasCircuitBreakerAccess ? "disabled" : ""}`}>
                        <input
                          id="set-circuit-breaker"
                          type="checkbox"
                          name="circuitBreakerEnabled"
                          value="true"
                          disabled={!hasCircuitBreakerAccess}
                          checked={circuitBreakerEnabled}
                          onChange={(e) => setCircuitBreakerEnabled(e.target.checked)}
                        />
                        <label htmlFor="set-circuit-breaker" className="rv-switch-slider">
                          <span className="rv-sr-only">Toggle Price Crash Circuit Breaker</span>
                        </label>
                      </div>
                    </div>

                    {/* Interactive Live Formula / Simulation Box */}
                    <div
                      style={{
                        background: "linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(245, 158, 11, 0.02) 100%)",
                        border: "1px solid var(--rv-warning-border)",
                        borderRadius: "var(--rv-radius-sm)",
                        padding: "14px 16px",
                        marginBottom: "18px",
                        fontSize: "13px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, color: "var(--rv-warning)", marginBottom: "4px" }}>
                        <ZapIcon size={14} />
                        <span>Live Protection Formula:</span>
                      </div>
                      <p style={{ margin: 0, color: "var(--rv-text)", lineHeight: 1.5 }}>
                        If a product priced at <strong>$100.00</strong> suddenly drops by <strong>{numThreshold}%</strong> or more (to <strong>${sampleReducedPrice}</strong> or less), Revertly will automatically <strong>{actionChoice === "DRAFT" ? "switch it to DRAFT to instantly hide it from customers" : "auto-revert the price to its baseline"}</strong>.
                      </p>
                    </div>

                    {/* Inputs */}
                    <div className="rv-form-grid" style={{ opacity: hasCircuitBreakerAccess && circuitBreakerEnabled ? 1 : 0.65 }}>
                      <div className="rv-form-field">
                        <label htmlFor="circuit-breaker-threshold" className="rv-form-label">
                          Crash Trigger Threshold (%)
                        </label>
                        <div className="rv-input-group">
                          <input
                            id="circuit-breaker-threshold"
                            type="number"
                            min="5"
                            max="95"
                            name="circuitBreakerThreshold"
                            disabled={!hasCircuitBreakerAccess}
                            value={threshold}
                            onChange={(e) => setThreshold(e.target.value)}
                            className="rv-input"
                          />
                          <span className="rv-input-suffix">% price drop</span>
                        </div>
                        <span className="rv-form-help">Trigger when variant price drops by this percentage or more.</span>
                      </div>

                      <div className="rv-form-field">
                        <label htmlFor="circuit-breaker-action" className="rv-form-label">
                          Emergency Defensive Action
                        </label>
                        <select
                          id="circuit-breaker-action"
                          name="circuitBreakerAction"
                          disabled={!hasCircuitBreakerAccess}
                          value={actionChoice}
                          onChange={(e) => setActionChoice(e.target.value)}
                          className="rv-select"
                        >
                          <option value="DRAFT">Set Product to DRAFT (Hide from storefront instantly)</option>
                          <option value="AUTO_REVERT">Auto-Revert Price (Restore previous baseline price)</option>
                        </select>
                        <span className="rv-form-help">Action taken automatically within seconds of webhook detection.</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 3. Bulk Change Anomaly Detection Card ── */}
              {(activeTab === "all" || activeTab === "bulk") && (
                <div className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge info">
                        <BoxIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Bulk Change Anomaly Detection
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Detect and quarantine rogue bulk syncs, CSV import mistakes, or third-party app crashes.
                        </p>
                      </div>
                    </div>
                    <span className="rv-badge rv-badge-neutral">Burst Guard</span>
                  </div>

                  <div className="rv-card-body">
                    <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: "0 0 16px", lineHeight: 1.5 }}>
                      When products are modified in sudden bursts exceeding your threshold, Revertly registers a high-priority incident and alerts your team immediately.
                    </p>

                    <div className="rv-form-grid">
                      <div className="rv-form-field">
                        <label htmlFor="bulk-threshold" className="rv-form-label">
                          Bulk Product Threshold
                        </label>
                        <div className="rv-input-group">
                          <input
                            id="bulk-threshold"
                            type="number"
                            min="1"
                            max="1000"
                            name="bulkThreshold"
                            defaultValue={String(settings?.bulkThreshold ?? 20)}
                            className="rv-input"
                          />
                          <span className="rv-input-suffix">products</span>
                        </div>
                        <span className="rv-form-help">Trigger incident if this many products change...</span>
                      </div>

                      <div className="rv-form-field">
                        <label htmlFor="bulk-window-minutes" className="rv-form-label">
                          Burst Time Window
                        </label>
                        <div className="rv-input-group">
                          <input
                            id="bulk-window-minutes"
                            type="number"
                            min="1"
                            max="120"
                            name="bulkWindowMinutes"
                            defaultValue={String(settings?.bulkWindowMinutes ?? 10)}
                            className="rv-input"
                          />
                          <span className="rv-input-suffix">minutes</span>
                        </div>
                        <span className="rv-form-help">...within this sliding time window.</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 4. Alert Channels & Notifications Card ── */}
              {(activeTab === "all" || activeTab === "alerts") && (
                <div className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge neutral">
                        <BellIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Alert Channels &amp; Notifications
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Deliver instant warnings to your operations team via Email and Slack webhooks.
                        </p>
                      </div>
                    </div>
                    <span className="rv-badge rv-badge-neutral">Instant Delivery</span>
                  </div>

                  <div className="rv-card-body">
                    {/* Email Input */}
                    <div className="rv-form-field" style={{ marginBottom: "22px" }}>
                      <label htmlFor="alert-email" className="rv-form-label">
                        Primary Alert Email Address
                      </label>
                      <div className="rv-search-wrapper" style={{ width: "100%", maxWidth: "460px" }}>
                        <span className="rv-search-icon">
                          <MailIcon size={16} />
                        </span>
                        <input
                          id="alert-email"
                          type="email"
                          name="alertEmail"
                          defaultValue={settings?.alertEmail || ""}
                          placeholder="merchant-security@example.com"
                          className="rv-input rv-input-with-icon"
                          style={{ width: "100%" }}
                        />
                      </div>
                      <span className="rv-form-help">Incidents, circuit breaker trips, and recovery confirmations are sent here.</span>
                    </div>

                    {/* Slack Webhook */}
                    <div className="rv-form-field" style={{ marginBottom: "24px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <label htmlFor="slack-webhook-url" className="rv-form-label" style={{ margin: 0 }}>
                          Slack Incoming Webhook URL
                        </label>
                        {!hasSlackAccess && (
                          <span className="rv-badge rv-badge-neutral rv-badge-sm">
                            Requires Business Plan ($49/mo)
                          </span>
                        )}
                      </div>

                      {!hasSlackAccess ? (
                        <div
                          style={{
                            background: "var(--rv-surface-subdued)",
                            border: "1px dashed var(--rv-border)",
                            borderRadius: "var(--rv-radius-sm)",
                            padding: "14px 18px",
                            fontSize: "13px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "12px",
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ color: "var(--rv-text-subdued)" }}>
                            Real-time Slack Webhook notifications require the <strong>Business</strong> or <strong>Enterprise</strong> plan.
                          </span>
                          <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
                            Upgrade to Business
                          </Link>
                        </div>
                      ) : (
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", maxWidth: "640px" }}>
                            <input
                              id="slack-webhook-url"
                              type="url"
                              name="slackWebhookUrl"
                              value={slackUrl}
                              onChange={(e) => setSlackUrl(e.target.value)}
                              placeholder="https://hooks.slack.com/services/T.../B.../..."
                              className="rv-input"
                              style={{ flex: 1, minWidth: "260px" }}
                            />
                            <button
                              type="button"
                              disabled={isTestingSlack}
                              onClick={() => {
                                fetcher.submit(
                                  { intent: "testSlack", slackWebhookUrl: slackUrl },
                                  { method: "POST" }
                                );
                              }}
                              className="rv-btn rv-btn-secondary"
                            >
                              <BellIcon size={14} />
                              <span>{isTestingSlack ? "Delivering Test..." : "Send Test Alert"}</span>
                            </button>
                          </div>
                          <span className="rv-form-help">Post automated incident cards into your team&apos;s Slack channel.</span>
                        </div>
                      )}
                    </div>

                    {/* Interactive Severity Selection Cards */}
                    <div>
                      <div className="rv-form-label" style={{ marginBottom: "10px", display: "block" }}>
                        Notify on Incidents of Severity:
                      </div>
                      <div className="rv-severity-grid">

                        {/* Critical Card */}
                        <div className={`rv-severity-card critical ${alertCritical ? "selected" : ""}`}>
                          <input
                            id="alert-critical"
                            type="checkbox"
                            name="alertOnCritical"
                            value="true"
                            checked={alertCritical}
                            onChange={(e) => setAlertCritical(e.target.checked)}
                            style={{ marginTop: "3px", cursor: "pointer" }}
                          />
                          <label htmlFor="alert-critical" style={{ cursor: "pointer", flex: 1 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                              <span className="rv-badge rv-badge-critical rv-badge-sm">CRITICAL</span>
                            </span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                              Price crashes, mass deletions, and circuit breaker activations.
                            </span>
                          </label>
                        </div>

                        {/* High Card */}
                        <div className={`rv-severity-card warning ${alertHigh ? "selected" : ""}`}>
                          <input
                            id="alert-high"
                            type="checkbox"
                            name="alertOnHigh"
                            value="true"
                            checked={alertHigh}
                            onChange={(e) => setAlertHigh(e.target.checked)}
                            style={{ marginTop: "3px", cursor: "pointer" }}
                          />
                          <label htmlFor="alert-high" style={{ cursor: "pointer", flex: 1 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                              <span className="rv-badge rv-badge-warning rv-badge-sm">HIGH</span>
                            </span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                              Bulk discount anomalies and sudden variant updates.
                            </span>
                          </label>
                        </div>

                        {/* Medium Card */}
                        <div className={`rv-severity-card info ${alertMedium ? "selected" : ""}`}>
                          <input
                            id="alert-medium"
                            type="checkbox"
                            name="alertOnMedium"
                            value="true"
                            checked={alertMedium}
                            onChange={(e) => setAlertMedium(e.target.checked)}
                            style={{ marginTop: "3px", cursor: "pointer" }}
                          />
                          <label htmlFor="alert-medium" style={{ cursor: "pointer", flex: 1 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                              <span className="rv-badge rv-badge-info rv-badge-sm">MEDIUM</span>
                            </span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                              Moderate catalog modifications exceeding detection rules.
                            </span>
                          </label>
                        </div>

                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 5. Theme App Embed Card ── */}
              {(activeTab === "all" || activeTab === "embed") && (
                <div className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header">
                    <div className="rv-card-icon-title">
                      <div className="rv-card-icon-badge success">
                        <ShieldCheckIcon size={18} />
                      </div>
                      <div>
                        <h3 className="rv-card-title" style={{ margin: 0, fontSize: "15px" }}>
                          Theme App Embed (Storefront Protection)
                        </h3>
                        <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          Injects baseline checkpoints into your active theme for frontend drift detection.
                        </p>
                      </div>
                    </div>
                    {themeEmbedActive ? (
                      <span className="rv-badge rv-badge-success">Active on {activeThemeName}</span>
                    ) : (
                      <span className="rv-badge rv-badge-warning">Action Required</span>
                    )}
                  </div>

                  <div className="rv-card-body">
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "14px",
                        background: themeEmbedActive ? "var(--rv-primary-surface)" : "var(--rv-warning-surface)",
                        border: `1px solid ${themeEmbedActive ? "var(--rv-primary-border)" : "var(--rv-warning-border)"}`,
                        borderRadius: "var(--rv-radius-md)",
                        padding: "18px 20px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
                        <div>
                          <h4 style={{ margin: "0 0 4px", fontSize: "15px", fontWeight: 700, color: "var(--rv-text)" }}>
                            {themeEmbedActive ? "Revertly Protection App Embed is Enabled" : "Theme Embed is Not Yet Activated"}
                          </h4>
                          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                            {themeEmbedActive
                              ? `Your active theme (${activeThemeName}) has Revertly Protection enabled. Storefront activity monitoring and rollback checkpoints are active.`
                              : "To enable storefront change monitoring and instant checkpoint verification, please enable Revertly in your Shopify Theme Editor under App Embeds."}
                          </p>
                        </div>
                        <a
                          href={themeEditorUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rv-btn rv-btn-primary rv-btn-sm"
                        >
                          <span>{themeEmbedActive ? "Configure in Theme Editor" : "Enable in Theme Editor"}</span>
                          <ExternalLinkIcon size={13} />
                        </a>
                      </div>

                      {!themeEmbedActive && (
                        <div style={{ borderTop: "1px dashed rgba(245, 158, 11, 0.4)", paddingTop: "14px", marginTop: "4px" }}>
                          <strong style={{ fontSize: "12px", color: "var(--rv-text)", display: "block", marginBottom: "6px" }}>
                            Quick 4-Step Setup:
                          </strong>
                          <ol style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.6 }}>
                            <li>Click <strong>Enable in Theme Editor</strong> above to open your store theme customizer.</li>
                            <li>In the left sidebar, locate <strong>Revertly Protection</strong> under <em>App embeds</em>.</li>
                            <li>Toggle the switch <strong>ON</strong>.</li>
                            <li>Click <strong>Save</strong> in the top right corner.</li>
                          </ol>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Sticky Bottom Action Bar ── */}
              <div className="rv-sticky-save-bar">
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background: "var(--rv-primary)",
                      boxShadow: "0 0 0 3px rgba(0, 128, 96, 0.2)",
                    }}
                  />
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--rv-text)" }}>
                    {isSaving ? "Saving changes..." : "Ready to update store settings"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="rv-btn rv-btn-primary rv-btn-lg"
                  >
                    <SaveIcon size={16} />
                    <span>{isSaving ? "Saving..." : "Save Settings"}</span>
                  </button>
                </div>
              </div>

            </main>
          </div>

        </fetcher.Form>

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
