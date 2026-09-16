import { useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useFetcher, useRouteError, useBlocker, Link, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { getOrCreateSettings, validateSlackWebhookUrl } from "../monitor.server.js";
import { getThemeEmbedStatus } from "../themeEmbed.server.js";
import { EMBED_ACTIVE, EMBED_UNKNOWN } from "../monitoring.constants.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkFeatureAccess } from "../billing.server.js";
import { getCloudProviderStatus, listCloudBackups } from "../cloudSync.server.js";
import { createLaunchToken } from "../cloudOAuth.server.js";
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
  CloudUploadIcon,
  GoogleDriveIcon,
  DropboxIcon,
  RefreshCwIcon,
  HistoryIcon,
  ArrowRightIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, cbAccess, slackAccess, lastChangeEvent] = await Promise.all([
    getOrCreateSettings(shop),
    checkFeatureAccess(shop, "circuitBreaker"),
    checkFeatureAccess(shop, "slack"),
    // Real evidence that the webhook listeners are alive, rather than a
    // hardcoded "operating normally" claim.
    prisma.changeEvent.findFirst({
      where: { shop },
      orderBy: { changedAt: "desc" },
      select: { changedAt: true },
    }),
  ]);

  // Drives an honest "needs configuration" state instead of a Connect button
  // that could only fail. The missing-env detail is for operators only — the
  // merchant-facing banner must not mention server configuration.
  const cloudProviders = getCloudProviderStatus().map((p) => ({
    ...p,
    launchUrl: p.configured
      ? `/auth/cloud/${p.id.toLowerCase()}?token=${createLaunchToken(shop, p.id)}`
      : null,
  }));
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

  // GraphQL at the app's configured API version, cached per shop, and able to
  // say "I don't know" instead of defaulting to "Action Required".
  const themeEmbed = await getThemeEmbedStatus(admin, shop);

  const cleanShopName = shop.replace(".myshopify.com", "");
  const themeEditorUrl = `https://admin.shopify.com/store/${cleanShopName}/themes/current/editor?context=apps`;

  return {
    settings,
    hasCircuitBreakerAccess: cbAccess.allowed,
    hasSlackAccess: slackAccess.allowed,
    plan: cbAccess.plan,
    themeEmbedStatus: themeEmbed.status,
    activeThemeName: themeEmbed.themeName || "your live theme",
    themeEditorUrl,
    cloudProviders,
    cloudNotice,
    lastWebhookAt: lastChangeEvent?.changedAt ?? null,
  };
};

/**
 * Parses an integer setting and clamps it to the same range the UI advertises.
 *
 * The `min`/`max` attributes on the inputs are client-side only — a crafted
 * POST could previously store bulkThreshold=999999, silently disabling bulk
 * anomaly detection for that shop.
 */
function safeParseInt(val, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (val === null || val === undefined || String(val).trim() === "") return fallback;
  const parsed = parseInt(String(val).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const BACKUP_SCHEDULES = new Set(["DAILY", "TWICE_DAILY", "WEEKLY", "OFF"]);
const BACKUP_TIMES = new Set(["00:00", "02:00", "04:00", "08:00", "12:00", "18:00", "22:00"]);
const BREAKER_ACTIONS = new Set(["DRAFT", "AUTO_REVERT"]);

function pickFromSet(val, allowed, fallback) {
  const v = String(val ?? "").trim();
  return allowed.has(v) ? v : fallback;
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
    // Defence in depth for the submit-button intent. The form no longer carries
    // a hidden `intent`, but reading the LAST entry means a stray duplicate can
    // never mask a button's own value again (FormData preserves DOM order, so
    // `.get()` would return the hidden field and silently run the wrong branch).
    const intents = formData.getAll("intent");
    const intent = intents.length ? intents[intents.length - 1] : null;

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

      const slackTarget = validateSlackWebhookUrl(formData.get("slackWebhookUrl"));
      if (!slackTarget.ok) {
        return { success: false, message: slackTarget.message };
      }
      try {
        const resp = await fetch(slackTarget.url, {
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
      ? safeParseInt(formData.get("circuitBreakerThreshold"), existing.circuitBreakerThreshold || 50, { min: 5, max: 95 })
      : (existing.circuitBreakerThreshold || 50);

    const circuitBreakerAction = cbCheck.allowed && formData.has("circuitBreakerAction")
      ? pickFromSet(formData.get("circuitBreakerAction"), BREAKER_ACTIONS, existing.circuitBreakerAction || "DRAFT")
      : (existing.circuitBreakerAction || "DRAFT");

    // Reject a non-Slack host rather than storing it. Storing it would leave a
    // server-dialled URL in the row that every future incident re-triggers.
    let slackWebhookUrl = existing.slackWebhookUrl;
    if (slackCheck.allowed && formData.has("slackWebhookUrl")) {
      const raw = formData.get("slackWebhookUrl")?.trim();
      if (!raw) {
        slackWebhookUrl = null;
      } else {
        const slackTarget = validateSlackWebhookUrl(raw);
        if (!slackTarget.ok) {
          return { success: false, message: slackTarget.message };
        }
        slackWebhookUrl = slackTarget.url;
      }
    }

    let alertEmail = existing.alertEmail;
    if (formData.has("alertEmail")) {
      const rawEmail = formData.get("alertEmail")?.trim();
      if (!rawEmail) {
        alertEmail = null;
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        return { success: false, message: "Please enter a valid alert email address." };
      } else {
        alertEmail = rawEmail;
      }
    }

    const alertOnCritical = formData.has("alertOnCritical") ? formData.get("alertOnCritical") === "true" : existing.alertOnCritical;
    const alertOnHigh = formData.has("alertOnHigh") ? formData.get("alertOnHigh") === "true" : existing.alertOnHigh;
    const alertOnMedium = formData.has("alertOnMedium") ? formData.get("alertOnMedium") === "true" : existing.alertOnMedium;
    const alertOnLow = formData.has("alertOnLow") ? formData.get("alertOnLow") === "true" : existing.alertOnLow;
    const monitoringEnabled = formData.has("monitoringEnabled") ? formData.get("monitoringEnabled") === "true" : existing.monitoringEnabled;

    const bulkThreshold = safeParseInt(formData.get("bulkThreshold"), existing.bulkThreshold || 20, { min: 1, max: 1000 });
    const bulkWindowMinutes = safeParseInt(formData.get("bulkWindowMinutes"), existing.bulkWindowMinutes || 10, { min: 1, max: 120 });

    const autoBackupSchedule = formData.has("autoBackupSchedule")
      ? pickFromSet(formData.get("autoBackupSchedule"), BACKUP_SCHEDULES, existing.autoBackupSchedule || "DAILY")
      : (existing.autoBackupSchedule || "DAILY");

    const autoBackupTime = formData.has("autoBackupTime")
      ? pickFromSet(formData.get("autoBackupTime"), BACKUP_TIMES, existing.autoBackupTime || "02:00")
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
        alertOnLow,
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
        alertOnLow,
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

    // `savedAt` lets the client tell an actual save apart from a Test Sync or
    // Disconnect, which also revalidate the loader. Without it, those actions
    // would re-sync the form and silently discard unrelated draft edits.
    return { success: true, savedAt: Date.now(), message: "Settings saved successfully." };
  } catch (err) {
    console.error("[Revertly Settings Error] Failed to save settings:", err);
    return {
      success: false,
      message: `Failed to save settings: ${err?.message || "An unexpected database error occurred. Please try again."}`,
    };
  }
};

/** Renders a timestamp in UTC, so it never contradicts the UTC cadence labels. */
function formatUtc(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** "3 hours ago" / "just now", for freshness signals. */
function formatRelative(value) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function Settings() {
  const {
    settings,
    hasCircuitBreakerAccess = false,
    hasSlackAccess = false,
    plan = "free",
    themeEmbedStatus = EMBED_UNKNOWN,
    activeThemeName = "your live theme",
    themeEditorUrl = "",
    cloudProviders = [],
    cloudNotice = {},
    lastWebhookAt = null,
  } = useLoaderData();

  const fetcher = useFetcher();
  const result = fetcher.data;
  // Read the LAST intent for the same reason the action does — whichever
  // submit button was pressed is the one that owns this submission.
  const pendingIntents = fetcher.formData?.getAll("intent") ?? [];
  const pendingIntent = pendingIntents.length ? pendingIntents[pendingIntents.length - 1] : null;
  const isSaving = fetcher.state !== "idle" && pendingIntent === "save";
  const isTestingSlack = fetcher.state !== "idle" && pendingIntent === "testSlack";
  const isTestingCloud = fetcher.state !== "idle" && pendingIntent === "testCloudSync";
  const isDisconnecting = fetcher.state !== "idle" && pendingIntent === "disconnectCloud";

  // ────────────────────────────────────────────────────────────────────────
  // SAVED values — what the backend will actually act on. Every status badge,
  // chip and health row reads from here, never from the draft state below.
  // Showing draft state as "Armed" told merchants they were protected when
  // the database still had the feature switched off.
  // ────────────────────────────────────────────────────────────────────────
  const saved = useMemo(
    () => ({
      monitoringEnabled: settings?.monitoringEnabled ?? true,
      circuitBreakerEnabled: Boolean(hasCircuitBreakerAccess && settings?.circuitBreakerEnabled),
      threshold: Number(settings?.circuitBreakerThreshold ?? 50),
      actionChoice: settings?.circuitBreakerAction || "DRAFT",
      slackUrl: settings?.slackWebhookUrl || "",
      alertEmail: settings?.alertEmail || "",
      alertCritical: settings?.alertOnCritical ?? true,
      alertHigh: settings?.alertOnHigh ?? true,
      alertMedium: settings?.alertOnMedium ?? false,
      alertLow: settings?.alertOnLow ?? false,
      autoBackupSchedule: settings?.autoBackupSchedule || "DAILY",
      autoBackupTime: settings?.autoBackupTime || "02:00",
      cloudSyncFolder: settings?.cloudSyncFolder || "Revertly_Backups",
      cloudSyncAutoUpload: settings?.cloudSyncAutoUpload ?? false,
      bulkThreshold: Number(settings?.bulkThreshold ?? 20),
      bulkWindowMinutes: Number(settings?.bulkWindowMinutes ?? 10),
    }),
    [settings, hasCircuitBreakerAccess],
  );

  // Navigation tab
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(
    () => searchParams.get("tab") || "all",
  );

  useEffect(() => {
    const tabParam = searchParams.get("tab");
    if (tabParam) {
      setActiveTab(tabParam);
    }
  }, [searchParams]);

  // ── DRAFT values — what the merchant is currently editing ──
  const [monitoringEnabled, setMonitoringEnabled] = useState(saved.monitoringEnabled);
  const [circuitBreakerEnabled, setCircuitBreakerEnabled] = useState(saved.circuitBreakerEnabled);
  const [threshold, setThreshold] = useState(saved.threshold);
  const [actionChoice, setActionChoice] = useState(saved.actionChoice);
  const [slackUrl, setSlackUrl] = useState(saved.slackUrl);
  const [alertEmail, setAlertEmail] = useState(saved.alertEmail);
  const [alertCritical, setAlertCritical] = useState(saved.alertCritical);
  const [alertHigh, setAlertHigh] = useState(saved.alertHigh);
  const [alertMedium, setAlertMedium] = useState(saved.alertMedium);
  const [alertLow, setAlertLow] = useState(saved.alertLow);
  const [bulkThreshold, setBulkThreshold] = useState(String(saved.bulkThreshold));
  const [bulkWindowMinutes, setBulkWindowMinutes] = useState(String(saved.bulkWindowMinutes));

  // Auto Backup & Cloud Storage states
  const [autoBackupSchedule, setAutoBackupSchedule] = useState(saved.autoBackupSchedule);
  const [autoBackupTime, setAutoBackupTime] = useState(saved.autoBackupTime);
  const [cloudSyncFolder, setCloudSyncFolder] = useState(saved.cloudSyncFolder);
  const [cloudSyncAutoUpload, setCloudSyncAutoUpload] = useState(saved.cloudSyncAutoUpload);
  const [connectProvider, setConnectProvider] = useState("GOOGLE_DRIVE");

  const draft = {
    monitoringEnabled,
    circuitBreakerEnabled,
    threshold: Number(threshold),
    actionChoice,
    slackUrl,
    alertEmail,
    alertCritical,
    alertHigh,
    alertMedium,
    alertLow,
    autoBackupSchedule,
    autoBackupTime,
    cloudSyncFolder,
    cloudSyncAutoUpload,
    bulkThreshold: Number(bulkThreshold),
    bulkWindowMinutes: Number(bulkWindowMinutes),
  };

  const dirtyKeys = Object.keys(draft).filter((k) => draft[k] !== saved[k]);
  const isDirty = dirtyKeys.length > 0;

  // Re-sync the draft once a SAVE lands, so the form tracks whatever the server
  // actually stored (it clamps out-of-range numbers and may reject a field).
  // Keyed on savedAt rather than settings.updatedAt so that Test Sync and
  // Disconnect — which revalidate the loader too — leave draft edits alone.
  const lastSyncedRef = useRef(null);
  useEffect(() => {
    if (!result?.savedAt || result.savedAt === lastSyncedRef.current) return;
    lastSyncedRef.current = result.savedAt;
    setMonitoringEnabled(saved.monitoringEnabled);
    setCircuitBreakerEnabled(saved.circuitBreakerEnabled);
    setThreshold(saved.threshold);
    setActionChoice(saved.actionChoice);
    setSlackUrl(saved.slackUrl);
    setAlertEmail(saved.alertEmail);
    setAlertCritical(saved.alertCritical);
    setAlertHigh(saved.alertHigh);
    setAlertMedium(saved.alertMedium);
    setAlertLow(saved.alertLow);
    setBulkThreshold(String(saved.bulkThreshold));
    setBulkWindowMinutes(String(saved.bulkWindowMinutes));
    setAutoBackupSchedule(saved.autoBackupSchedule);
    setAutoBackupTime(saved.autoBackupTime);
    setCloudSyncFolder(saved.cloudSyncFolder);
    setCloudSyncAutoUpload(saved.cloudSyncAutoUpload);
  }, [result?.savedAt, saved]);

  const [showDisconnectCloudModal, setShowDisconnectCloudModal] = useState(false);

  // Auto-close disconnect modal when action finishes
  useEffect(() => {
    if (result && !isDisconnecting) {
      setShowDisconnectCloudModal(false);
    }
  }, [result, isDisconnecting]);

  // Warn before leaving with unsaved edits (in-app and full page unload).
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    isDirty && !isSaving && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!isDirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // The result banner is dismissible and is cleared the moment the merchant
  // edits again, so a stale "Settings Saved" can't vouch for unsaved changes.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  useEffect(() => {
    setBannerDismissed(false);
  }, [result]);
  // A success banner is withdrawn as soon as the form is dirty again, so
  // "Settings Saved" can never appear to vouch for unsaved edits. Error
  // banners stay put — the merchant still needs to act on them.
  const showResultBanner = Boolean(result?.message) && !bannerDismissed && !(result.success && isDirty);

  const isCloudConnected = Boolean(settings?.cloudSyncConnected);
  const activeCloudProvider = settings?.cloudSyncProvider || "NONE";
  const selectedProviderStatus = (cloudProviders || []).find((p) => p.id === connectProvider);
  // If only one provider is enabled, point the merchant at the one that works
  // rather than leaving them with a dead end.
  const otherProviderAvailable = (cloudProviders || []).some(
    (p) => p.configured && p.id !== connectProvider,
  );

  const numThreshold = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : 50;
  const sampleReducedPrice = Math.max(0, 100 * (1 - numThreshold / 100)).toFixed(0);

  const embedActive = themeEmbedStatus === EMBED_ACTIVE;
  const embedUnknown = themeEmbedStatus === EMBED_UNKNOWN;

  // ── Real Protection Health, computed from evidence rather than asserted ──
  const backupOverdue = Boolean(
    saved.autoBackupSchedule !== "OFF" &&
      settings?.nextAutoBackupAt &&
      new Date(settings.nextAutoBackupAt).getTime() < Date.now() - 60 * 60 * 1000,
  );
  const healthIssues = [];
  if (!saved.monitoringEnabled) healthIssues.push("Catalog monitoring is paused");
  if (saved.autoBackupSchedule === "OFF") healthIssues.push("Automated backups are off");
  if (backupOverdue) healthIssues.push("A scheduled backup is overdue");
  if (themeEmbedStatus === "INACTIVE") healthIssues.push("Storefront embed is not enabled");
  if (!saved.alertEmail && !saved.slackUrl) healthIssues.push("No alert destination configured");
  const healthTone = healthIssues.length === 0 ? "success" : healthIssues.length > 1 ? "critical" : "warning";
  const healthLabel = healthIssues.length === 0 ? "Healthy" : healthIssues.length > 1 ? "Needs attention" : "Degraded";

  const savedCadenceBadge = saved.autoBackupSchedule !== "OFF" ? saved.autoBackupSchedule : "Disabled";

  const breakerPending =
    dirtyKeys.includes("circuitBreakerEnabled") ||
    dirtyKeys.includes("threshold") ||
    dirtyKeys.includes("actionChoice");

  const navSections = [
    {
      title: null,
      items: [
        { id: "all", label: "All Settings", icon: SettingsIcon, statusBadge: null, statusTone: "neutral" },
      ],
    },
    {
      title: "Data & Backups",
      items: [
        { id: "schedules", label: "Scheduled Backups", icon: ClockIcon, statusBadge: savedCadenceBadge, statusTone: saved.autoBackupSchedule !== "OFF" ? "success" : "neutral" },
        { id: "cloud", label: "Cloud Storage Sync", icon: CloudUploadIcon, statusBadge: isCloudConnected ? (activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox") : "Not Linked", statusTone: isCloudConnected ? "success" : "warning" },
      ],
    },
    {
      title: "Protection & Defense",
      items: [
        { id: "embed", label: "Theme App Embed", icon: ShieldCheckIcon, statusBadge: embedUnknown ? "Unknown" : embedActive ? "Active" : "Setup", statusTone: embedUnknown ? "neutral" : embedActive ? "success" : "warning" },
        { id: "monitoring", label: "Catalog Monitoring", icon: ClockIcon, statusBadge: saved.monitoringEnabled ? "Active" : "Paused", statusTone: saved.monitoringEnabled ? "success" : "neutral" },
        { id: "circuit", label: "Price Crash Breaker", icon: ZapIcon, statusBadge: saved.circuitBreakerEnabled ? "Armed" : "Paused", statusTone: saved.circuitBreakerEnabled ? "success" : "neutral" },
        { id: "bulk", label: "Anomaly Detection", icon: BoxIcon, statusBadge: `${saved.bulkThreshold} items`, statusTone: "neutral" },
      ],
    },
    {
      title: "Notifications",
      items: [
        { id: "alerts", label: "Alert Channels", icon: BellIcon, statusBadge: hasSlackAccess ? "Slack + Email" : "Email", statusTone: "neutral" },
      ],
    },
  ];

  const allNavItems = navSections.flatMap((sec) => sec.items);

  return (
    <s-page heading="Settings" inlineSize="large">
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

        {/* Action Result Banner — announced to assistive tech, dismissible, and
            suppressed as soon as new edits make a "Saved" message misleading. */}
        <div role="status" aria-live="polite">
          {showResultBanner && (
            <Banner
              tone={result.success ? "success" : "critical"}
              title={result.success ? "Settings Saved" : "Settings Error"}
              className="rv-fade-in"
              onDismiss={() => setBannerDismissed(true)}
            >
              {result.message}
            </Banner>
          )}
        </div>

        {/*
          NOTE: there is deliberately no hidden `intent` field here. FormData
          preserves DOM order, so a hidden intent="save" placed above the
          Test Sync / Disconnect buttons won the `formData.get("intent")` lookup
          and those buttons silently ran a save instead. Each submit button now
          carries its own intent.
        */}
        <fetcher.Form method="POST">
          {/* Explicit boolean fallbacks so unchecking never loses state on POST */}
          <input type="hidden" name="monitoringEnabled" value={monitoringEnabled ? "true" : "false"} />
          <input type="hidden" name="circuitBreakerEnabled" value={circuitBreakerEnabled ? "true" : "false"} />
          <input type="hidden" name="cloudSyncAutoUpload" value={cloudSyncAutoUpload ? "true" : "false"} />
          <input type="hidden" name="alertOnCritical" value={alertCritical ? "true" : "false"} />
          <input type="hidden" name="alertOnHigh" value={alertHigh ? "true" : "false"} />
          <input type="hidden" name="alertOnMedium" value={alertMedium ? "true" : "false"} />
          <input type="hidden" name="alertOnLow" value={alertLow ? "true" : "false"} />

          {/* Top Hero Banner */}
          <div
            className="rv-hero-banner"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "18px",
              marginBottom: "24px",
              padding: "20px 24px",
              borderRadius: "var(--rv-radius-md)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "16px", minWidth: "280px", flex: 1 }}>
              <div
                className="rv-card-icon-badge success"
                style={{ width: "46px", height: "46px", borderRadius: "var(--rv-radius-md)", flexShrink: 0 }}
              >
                <SettingsIcon size={24} />
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "4px" }}>
                  <h1 style={{ fontSize: "19px", fontWeight: 800, color: "var(--rv-text)", margin: 0, letterSpacing: "-0.2px" }}>
                    Store Protection &amp; Alert Engine
                  </h1>
                  <span className={`rv-badge rv-badge-${healthTone} rv-badge-sm`} style={{ fontWeight: 600 }}>
                    {healthLabel}
                  </span>
                  {isDirty && (
                    <span className="rv-badge rv-badge-warning rv-badge-sm" style={{ fontWeight: 700 }}>
                      {dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <p style={{ margin: "0 0 8px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.4 }}>
                  Automate catalog change defense, price crash circuit breakers, and operations alerting.
                </p>

                {/* Quick Status Chips — these describe what is SAVED and live on
                    the backend, not what is currently typed into the form. */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontSize: "11px", padding: "2px 8px" }}>
                    <span className={`rv-status-dot ${saved.monitoringEnabled ? "success" : "neutral"}`} />
                    Monitoring: {saved.monitoringEnabled ? "Active" : "Paused"}
                  </span>
                  <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontSize: "11px", padding: "2px 8px" }}>
                    <span className={`rv-status-dot ${saved.autoBackupSchedule !== "OFF" ? "success" : "neutral"}`} />
                    Cadence: {saved.autoBackupSchedule}
                  </span>
                  <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontSize: "11px", padding: "2px 8px" }}>
                    <span className={`rv-status-dot ${isCloudConnected ? "success" : "warning"}`} />
                    Cloud: {isCloudConnected ? (activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox") : "Local Only"}
                  </span>
                  <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontSize: "11px", padding: "2px 8px" }}>
                    <span className={`rv-status-dot ${saved.circuitBreakerEnabled ? "warning" : "neutral"}`} />
                    Circuit Breaker: {saved.circuitBreakerEnabled ? `Armed (${saved.threshold}%)` : "Disarmed"}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button
                type="submit"
                name="intent"
                value="save"
                disabled={isSaving || !isDirty}
                className="rv-btn rv-btn-primary rv-btn-lg"
                style={{ minWidth: "160px", boxShadow: "0 2px 8px rgba(0, 128, 96, 0.25)" }}
              >
                <SaveIcon size={16} />
                <span>{isSaving ? "Saving Settings..." : isDirty ? "Save Settings" : "Saved"}</span>
              </button>
            </div>
          </div>

          {/* Mobile & Tablet Pill Navigation Bar */}
          <div className="rv-settings-pills">
            {allNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rv-settings-pill-btn ${activeTab === item.id ? "active" : ""}`}
                onClick={() => setActiveTab(item.id)}
              >
                <span>{item.label}</span>
                {item.statusBadge && (
                  <span className="rv-badge rv-badge-sm" style={{ fontSize: "10px", padding: "1px 6px" }}>
                    {item.statusBadge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* 2-Column Full-Width Responsive Layout */}
          <div className="rv-settings-grid">

            {/* Left Sidebar: Navigation & Protection Health Card */}
            <aside className="rv-settings-sidebar">
              <nav className="rv-settings-nav" aria-label="Settings Categories">
                <div className="rv-settings-nav-header">
                  <span>Settings Menu</span>
                  <span style={{ fontSize: "10px", color: "var(--rv-text-subdued)" }}>{allNavItems.length - 1} sections</span>
                </div>

                {navSections.map((sec, secIdx) => (
                  <div key={secIdx} className="rv-settings-nav-section">
                    {sec.title && (
                      <div className="rv-settings-nav-section-title">
                        {sec.title}
                      </div>
                    )}
                    <div className="rv-settings-nav-group">
                      {sec.items.map((item) => {
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
                              <span className="rv-settings-nav-label">{item.label}</span>
                            </div>
                            {item.statusBadge && (
                              <span
                                className={`rv-badge rv-badge-${item.statusTone} rv-badge-sm`}
                                style={{ fontSize: "10px", padding: "1px 6px", flexShrink: 0 }}
                              >
                                {item.statusBadge}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <ShieldCheckIcon size={18} style={{ color: "var(--rv-primary)" }} />
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--rv-text)" }}>
                      Protection Health
                    </span>
                  </div>
                  <span className={`rv-badge rv-badge-${healthTone} rv-badge-sm`} style={{ fontSize: "10px" }}>
                    {healthLabel}
                  </span>
                </div>
                {/* Derived from the saved configuration and real activity
                    timestamps. Previously this was a hardcoded "operating
                    normally" that rendered identically on a broken store. */}
                {healthIssues.length === 0 ? (
                  <p style={{ margin: "0 0 12px", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                    Monitoring, scheduled backups and alerting are all configured.
                    {lastWebhookAt
                      ? ` Last catalog event received ${formatRelative(lastWebhookAt)}.`
                      : " No catalog events recorded yet."}
                  </p>
                ) : (
                  <ul style={{ margin: "0 0 12px", paddingLeft: "16px", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.6 }}>
                    {healthIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px", borderTop: "1px solid var(--rv-border-subtle)", paddingTop: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Active Plan:</span>
                    <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontWeight: 700, textTransform: "uppercase" }}>
                      {plan}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Monitoring:</span>
                    <span style={{ fontWeight: 600, color: saved.monitoringEnabled ? "var(--rv-primary)" : "var(--rv-text-subdued)" }}>
                      <span className={`rv-status-dot ${saved.monitoringEnabled ? "success" : "neutral"}`} />
                      {saved.monitoringEnabled ? "Enabled" : "Paused"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Last event:</span>
                    <span style={{ fontWeight: 600, color: lastWebhookAt ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                      <span className={`rv-status-dot ${lastWebhookAt ? "success" : "neutral"}`} />
                      {lastWebhookAt ? formatRelative(lastWebhookAt) : "None yet"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Circuit Breaker:</span>
                    <span style={{ fontWeight: 600, color: saved.circuitBreakerEnabled ? "var(--rv-warning)" : "var(--rv-text-subdued)" }}>
                      <span className={`rv-status-dot ${saved.circuitBreakerEnabled ? "success" : "neutral"}`} />
                      {saved.circuitBreakerEnabled ? "Armed" : "Paused"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Auto Schedule:</span>
                    <span style={{ fontWeight: 600, color: saved.autoBackupSchedule !== "OFF" && !backupOverdue ? "var(--rv-primary)" : "var(--rv-text-subdued)" }}>
                      <span className={`rv-status-dot ${saved.autoBackupSchedule === "OFF" ? "neutral" : backupOverdue ? "warning" : "success"}`} />
                      {backupOverdue ? `${saved.autoBackupSchedule} (overdue)` : saved.autoBackupSchedule}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Cloud Sync:</span>
                    <span style={{ fontWeight: 600, color: isCloudConnected ? "var(--rv-primary)" : "var(--rv-text-subdued)" }}>
                      <span className={`rv-status-dot ${isCloudConnected ? "success" : "neutral"}`} />
                      {isCloudConnected ? (activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox") : "Disabled"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--rv-text-subdued)" }}>Storefront Embed:</span>
                    <span style={{ fontWeight: 600, color: embedActive ? "var(--rv-primary)" : embedUnknown ? "var(--rv-text-subdued)" : "var(--rv-warning)" }}>
                      <span className={`rv-status-dot ${embedActive ? "success" : embedUnknown ? "neutral" : "warning"}`} />
                      {embedActive ? "Active" : embedUnknown ? "Unavailable" : "Action Needed"}
                    </span>
                  </div>
                </div>
              </div>
            </aside>

            {/* Right Column: Settings Cards */}
            <main style={{ display: "flex", flexDirection: "column", gap: "20px", minWidth: 0 }}>

              {/* ── 0. Scheduled Backups Card ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  display: activeTab === "all" || activeTab === "schedules" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge info">
                      <ClockIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                        Automated Scheduled Backups
                      </h3>
                      <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        Set automatic background snapshots for products, theme code, collections, and vault logs.
                      </p>
                    </div>
                  </div>
                  <span className={`rv-badge ${saved.autoBackupSchedule !== "OFF" ? "rv-badge-success" : "rv-badge-neutral"}`}>
                    {saved.autoBackupSchedule !== "OFF" ? `Cadence: ${saved.autoBackupSchedule}` : "Manual Only"}
                  </span>
                </div>

                <div className="rv-card-body">
                  {/* Live Schedule Status Indicator */}
                  <div
                    style={{
                      padding: "16px 18px",
                      background: "linear-gradient(135deg, rgba(0, 128, 96, 0.06) 0%, rgba(37, 99, 235, 0.06) 100%)",
                      borderRadius: "var(--rv-radius-sm)",
                      border: "1px solid rgba(0, 128, 96, 0.2)",
                      marginBottom: "20px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: "14px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                      <div
                        style={{
                          width: "40px",
                          height: "40px",
                          borderRadius: "50%",
                          background: "var(--rv-primary)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          flexShrink: 0,
                          boxShadow: "0 2px 6px rgba(0, 128, 96, 0.3)",
                        }}
                      >
                        <ClockIcon size={20} />
                      </div>
                      <div>
                        <strong style={{ fontSize: "14px", color: "var(--rv-text)", display: "block", marginBottom: "2px" }}>
                          {saved.autoBackupSchedule !== "OFF"
                            ? `Active Cadence: ${saved.autoBackupSchedule === "DAILY" ? "Daily at " + saved.autoBackupTime + " UTC" : saved.autoBackupSchedule === "TWICE_DAILY" ? "Every 12 Hours from " + saved.autoBackupTime + " UTC" : "Weekly at " + saved.autoBackupTime + " UTC"}`
                            : "Automated Cadence is Disabled"}
                        </strong>
                        {/* Both stamps are rendered in UTC. They used to print in
                            browser-local time directly beneath a "02:00 UTC"
                            cadence label, which read as a timezone contradiction. */}
                        <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                          Last backup: {formatUtc(settings?.lastAutoBackupAt) || "Never (Pending first scheduled run)"} &bull; Next scheduled: {formatUtc(settings?.nextAutoBackupAt) || "Calculated on save"}
                        </span>
                        {isDirty && (dirtyKeys.includes("autoBackupSchedule") || dirtyKeys.includes("autoBackupTime")) && (
                          <span style={{ fontSize: "12px", color: "var(--rv-warning)", fontWeight: 600, display: "block", marginTop: "4px" }}>
                            Pending change — save to apply the new cadence.
                          </span>
                        )}
                      </div>
                    </div>
                    <Link to="/app/restore-points" className="rv-btn rv-btn-secondary rv-btn-sm">
                      <HistoryIcon size={14} />
                      <span>View Restore Points</span>
                    </Link>
                  </div>

                  {/* 2-Column Responsive Selector Grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
                    <div className="rv-form-field">
                      <label className="rv-form-label" htmlFor="autoBackupSchedule">
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
                      <span className="rv-form-help">
                        Automated snapshots take a complete versioned snapshot including products, themes, and navigation menus.
                      </span>
                    </div>

                    {autoBackupSchedule !== "OFF" ? (
                      <div className="rv-form-field">
                        <label className="rv-form-label" htmlFor="autoBackupTime">
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
                        <span className="rv-form-help">
                          Choose off-peak hours when inventory updates and order traffic are lowest.
                        </span>
                      </div>
                    ) : (
                      <div className="rv-form-field" style={{ justifyContent: "center" }}>
                        <div style={{ padding: "14px 18px", background: "var(--rv-warning-surface)", borderRadius: "var(--rv-radius-sm)", border: "1px solid var(--rv-warning-border)", fontSize: "12px", color: "var(--rv-text)" }}>
                          <strong>Automated backups are currently paused.</strong> You can still take manual snapshots anytime on the Restore Points page.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── 1. Cloud Storage Sync Card ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  display: activeTab === "all" || activeTab === "cloud" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge" style={{ background: "rgba(37, 99, 235, 0.1)", color: "#2563eb" }}>
                      <CloudUploadIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
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
                          padding: "16px 20px",
                          background: "var(--rv-surface-subdued)",
                          borderRadius: "var(--rv-radius-sm)",
                          border: "1px solid var(--rv-border-subtle)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          gap: "16px",
                          marginBottom: "20px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                          <div
                            style={{
                              width: "44px",
                              height: "44px",
                              borderRadius: "10px",
                              background: activeCloudProvider === "GOOGLE_DRIVE" ? "rgba(234, 67, 53, 0.1)" : "rgba(0, 97, 254, 0.1)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: activeCloudProvider === "GOOGLE_DRIVE" ? "#ea4335" : "#0061fe",
                              flexShrink: 0,
                            }}
                          >
                            {activeCloudProvider === "GOOGLE_DRIVE" ? <GoogleDriveIcon size={24} /> : <DropboxIcon size={24} />}
                          </div>
                          <div>
                            <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block" }}>
                              {activeCloudProvider === "GOOGLE_DRIVE" ? "Google Drive Connected" : "Dropbox Connected"}
                            </strong>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              Account: <strong>{settings?.cloudSyncEmail || "Active Account"}</strong> &bull; Remote Target: <code>/{cloudSyncFolder}</code>
                            </span>
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <button
                            type="submit"
                            name="intent"
                            value="testCloudSync"
                            // These branches return before the save path, so an
                            // invalid number elsewhere on the form must not block them.
                            formNoValidate
                            disabled={fetcher.state !== "idle"}
                            className="rv-btn rv-btn-secondary rv-btn-sm"
                          >
                            <RefreshCwIcon size={14} />
                            <span>{isTestingCloud ? "Testing..." : "Test Sync"}</span>
                          </button>
                          <button
                            type="button"
                            disabled={fetcher.state !== "idle"}
                            className="rv-btn rv-btn-critical rv-btn-sm"
                            onClick={() => setShowDisconnectCloudModal(true)}
                          >
                            {isDisconnecting ? "Disconnecting..." : "Disconnect"}
                          </button>
                        </div>
                      </div>

                      {/* Cloud Folder & Auto Upload Settings */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
                        <div className="rv-form-field">
                          <label className="rv-form-label" htmlFor="cloudSyncFolder">
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
                          <span className="rv-form-help">
                            Subfolder inside your Drive/Dropbox where JSON and zip archives will be saved.
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "14px",
                            padding: "16px 18px",
                            background: "#ffffff",
                            borderRadius: "var(--rv-radius-sm)",
                            border: "1px solid var(--rv-border-subtle)",
                            alignSelf: "start",
                          }}
                        >
                          <div>
                            <strong style={{ fontSize: "14px", color: "var(--rv-text)", display: "block" }}>
                              Auto-Push New Snapshots
                            </strong>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              Automatically push every new restore point to cloud storage.
                            </span>
                          </div>
                          <div className="rv-switch">
                            <input
                              id="set-cloud-autoupload"
                              type="checkbox"
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
                    /* Not Connected: Choose Provider in Side-by-Side Cards */
                    <div>
                      {/* Real radio inputs inside labels: keyboard reachable,
                          arrow-key navigable, and announced as a radio group.
                          These were <div onClick> and unusable without a mouse. */}
                      <fieldset className="rv-cloud-grid" style={{ border: 0, margin: 0, padding: 0 }}>
                        <legend className="rv-sr-only">Choose a cloud storage provider</legend>

                        {[
                          {
                            id: "GOOGLE_DRIVE",
                            name: "Google Drive",
                            sub: "Personal or Google Workspace",
                            desc: "Export catalog snapshots directly to Google Drive folder for offsite disaster recovery and team archiving.",
                            Icon: GoogleDriveIcon,
                            color: "#ea4335",
                          },
                          {
                            id: "DROPBOX",
                            name: "Dropbox",
                            sub: "Dropbox Business or Basic",
                            desc: "Sync versioned restore points to Dropbox with automated historical retention and folder management.",
                            Icon: DropboxIcon,
                            color: "#0061fe",
                          },
                        ].map(({ id, name, sub, desc, Icon, color }) => {
                          const isSelected = connectProvider === id;
                          return (
                            <label
                              key={id}
                              htmlFor={`cloud-provider-${id}`}
                              className={`rv-cloud-provider-card ${isSelected ? "active" : ""}`}
                            >
                              <input
                                id={`cloud-provider-${id}`}
                                type="radio"
                                name="cloudProviderChoice"
                                value={id}
                                checked={isSelected}
                                onChange={() => setConnectProvider(id)}
                                className="rv-sr-only"
                              />
                              <div>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                    <Icon size={26} style={{ color }} />
                                    <div>
                                      <strong style={{ fontSize: "15px", color: "var(--rv-text)", display: "block" }}>{name}</strong>
                                      <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{sub}</span>
                                    </div>
                                  </div>
                                  <span className={`rv-badge ${isSelected ? "rv-badge-success" : "rv-badge-neutral"}`} aria-hidden="true">
                                    {isSelected ? "Selected" : "Select"}
                                  </span>
                                </div>
                                <p style={{ fontSize: "12px", color: "var(--rv-text-subdued)", margin: 0, lineHeight: 1.5 }}>
                                  {desc}
                                </p>
                              </div>
                            </label>
                          );
                        })}
                      </fieldset>

                      {/* Real OAuth handoff */}
                      <div
                        style={{
                          padding: "16px 20px",
                          background: "var(--rv-surface-subdued)",
                          borderRadius: "var(--rv-radius-sm)",
                          border: "1px solid var(--rv-border-subtle)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          gap: "14px",
                        }}
                      >
                        {selectedProviderStatus?.configured ? (
                          <>
                            <p style={{ fontSize: "12px", color: "var(--rv-text-subdued)", margin: 0, lineHeight: 1.5, flex: 1, minWidth: "260px" }}>
                              You will be sent to {selectedProviderStatus.label} to approve access. Revertly
                              only requests permission for the backup files it creates — your account
                              data remains fully private.
                            </p>
                            <a
                              href={selectedProviderStatus?.launchUrl || `/auth/cloud/${connectProvider.toLowerCase()}`}
                              target="_top"
                              rel="noopener"
                              className="rv-btn rv-btn-primary"
                              style={{ flexShrink: 0 }}
                            >
                              <CloudUploadIcon size={14} />
                              <span>Connect {selectedProviderStatus.label}</span>
                            </a>
                          </>
                        ) : (
                          <Banner
                            tone="warning"
                            title={`${selectedProviderStatus?.label || "This provider"} isn't available yet`}
                          >
                            <p style={{ margin: "0 0 6px" }}>
                              Offsite sync to {selectedProviderStatus?.label} is being set up for Revertly. Backups are safely stored in your local Revertly database.
                            </p>
                            <p style={{ margin: 0, fontSize: "12px" }}>
                              {otherProviderAvailable ? (
                                <>
                                  You can connect{" "}
                                  <strong>
                                    {(cloudProviders || []).find((p) => p.configured && p.id !== connectProvider)?.label}
                                  </strong>{" "}
                                  now instead.
                                </>
                              ) : (
                                <>We will notify you as soon as this provider is activated.</>
                              )}
                            </p>
                          </Banner>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── 2. Theme App Embed Card (Protection & Defense) ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  display: activeTab === "all" || activeTab === "embed" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge success">
                      <ShieldCheckIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                        Theme App Embed (Storefront Protection)
                      </h3>
                      <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        Injects baseline checkpoints into your active theme for frontend drift detection.
                      </p>
                    </div>
                  </div>
                  {embedActive ? (
                    <span className="rv-badge rv-badge-success">Active on {activeThemeName}</span>
                  ) : embedUnknown ? (
                    <span className="rv-badge rv-badge-neutral">Status Unavailable</span>
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
                      background: embedActive ? "var(--rv-primary-surface)" : embedUnknown ? "var(--rv-surface-subdued)" : "var(--rv-warning-surface)",
                      border: `1px solid ${embedActive ? "var(--rv-primary-border)" : embedUnknown ? "var(--rv-border-subtle)" : "var(--rv-warning-border)"}`,
                      borderRadius: "var(--rv-radius-md)",
                      padding: "20px 24px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "18px", flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: "280px" }}>
                        <h4 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: "var(--rv-text)" }}>
                          {embedActive
                            ? "Revertly Protection App Embed is Enabled"
                            : embedUnknown
                              ? "We couldn't check your theme right now"
                              : "Theme Embed is Not Yet Activated"}
                        </h4>
                        <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                          {embedActive
                            ? `Your active theme (${activeThemeName}) has Revertly Protection enabled. Storefront activity monitoring and rollback checkpoints are active.`
                            : embedUnknown
                              ? "Shopify didn't return your theme settings, so we can't confirm whether the embed is on. This does not affect your backups or catalog monitoring — reload in a moment to check again."
                              : "To enable storefront change monitoring and instant checkpoint verification, please enable Revertly in your Shopify Theme Editor under App Embeds."}
                        </p>
                      </div>
                      <a
                        href={themeEditorUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rv-btn rv-btn-primary"
                        style={{ flexShrink: 0 }}
                      >
                        <span>{embedActive ? "Configure in Theme Editor" : "Open Theme Editor"}</span>
                        <ExternalLinkIcon size={14} />
                      </a>
                    </div>

                    {/* The setup walkthrough only appears when we actually KNOW
                        the embed is off, never on an inconclusive check. */}
                    {themeEmbedStatus === "INACTIVE" && (
                      <div style={{ borderTop: "1px dashed rgba(245, 158, 11, 0.4)", paddingTop: "14px", marginTop: "6px" }}>
                        <strong style={{ fontSize: "12px", color: "var(--rv-text)", display: "block", marginBottom: "8px" }}>
                          Quick 4-Step Setup:
                        </strong>
                        <ol style={{ margin: 0, paddingLeft: "20px", fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.7 }}>
                          <li>Click <strong>Open Theme Editor</strong> above to open your store theme customizer.</li>
                          <li>In the left sidebar, locate <strong>Revertly Protection</strong> under <em>App embeds</em>.</li>
                          <li>Toggle the switch <strong>ON</strong>.</li>
                          <li>Click <strong>Save</strong> in the top right corner.</li>
                        </ol>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── 3. Catalog Monitoring Card ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  display: activeTab === "all" || activeTab === "monitoring" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge info">
                      <ClockIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                        Real-Time Catalog Monitoring
                      </h3>
                      <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        Background event listener for price drops, title changes, and inventory spikes.
                      </p>
                    </div>
                  </div>
                  <span className={`rv-badge ${saved.monitoringEnabled ? "rv-badge-success" : "rv-badge-neutral"}`}>
                    {saved.monitoringEnabled ? "Actively Protecting" : "Paused"}
                  </span>
                  {dirtyKeys.includes("monitoringEnabled") && (
                    <span className="rv-badge rv-badge-warning rv-badge-sm" style={{ marginLeft: "8px", fontWeight: 700 }}>
                      UNSAVED
                    </span>
                  )}
                </div>

                <div className="rv-card-body">
                  {/* Master Switch Row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "16px",
                      padding: "16px 20px",
                      background: "var(--rv-surface-subdued)",
                      borderRadius: "var(--rv-radius-sm)",
                      border: "1px solid var(--rv-border-subtle)",
                      marginBottom: "20px",
                    }}
                  >
                    <div>
                      <label
                        htmlFor="set-monitoring"
                        style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", display: "block", cursor: "pointer", marginBottom: "3px" }}
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
                        checked={monitoringEnabled}
                        onChange={(e) => setMonitoringEnabled(e.target.checked)}
                      />
                      <label htmlFor="set-monitoring" className="rv-switch-slider">
                        <span className="rv-sr-only">Toggle Real-Time Catalog Monitoring</span>
                      </label>
                    </div>
                  </div>

                  {/* Monitored Webhook Channels 4-Column Responsive Grid */}
                  <div>
                    <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--rv-text-subdued)", display: "block", marginBottom: "10px" }}>
                      Active Monitored Webhook Channels:
                    </span>
                    <div className="rv-channels-grid">
                      {[
                        { title: "Price Adjustments", desc: "Variants & Compare-at prices" },
                        { title: "Product Deletions", desc: "Deleted item recovery guard" },
                        { title: "Inventory Depletions", desc: "Out-of-stock anomaly watch" },
                        { title: "Metafield Updates", desc: "Custom fields & SEO tags" },
                      ].map((evt, idx) => (
                        <div key={idx} className="rv-channel-card">
                          <CheckCircleIcon size={16} style={{ color: "var(--rv-primary)", flexShrink: 0, marginTop: "2px" }} />
                          <div>
                            <strong style={{ display: "block", color: "var(--rv-text)", fontSize: "13px" }}>{evt.title}</strong>
                            <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", lineHeight: 1.3 }}>{evt.desc}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 3. Price Crash Circuit Breaker Card ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  opacity: hasCircuitBreakerAccess ? 1 : 0.9,
                  display: activeTab === "all" || activeTab === "circuit" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge warning">
                      <ZapIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
                        Emergency Circuit Breaker (Price Crash Guard)
                      </h3>
                      <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        Automatic emergency defensive action when sudden price drops threaten merchant revenue.
                      </p>
                    </div>
                  </div>
                  {hasCircuitBreakerAccess ? (
                    <span className={`rv-badge ${saved.circuitBreakerEnabled ? "rv-badge-success" : "rv-badge-neutral"}`}>
                      {saved.circuitBreakerEnabled ? `Armed (${saved.threshold}% Drop)` : "Paused (Switch OFF)"}
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
                        padding: "14px 18px",
                        fontSize: "13px",
                        color: "var(--rv-text)",
                        marginBottom: "20px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "14px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <AlertTriangleIcon size={18} style={{ color: "var(--rv-warning)", flexShrink: 0 }} />
                        <span>Emergency Circuit Breaker is an automated revenue guard available on <strong>Business</strong> and <strong>Enterprise</strong> tiers.</span>
                      </div>
                      <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
                        Upgrade to Business ($49/mo)
                      </Link>
                    </div>
                  )}

                  {/* Feature Master Switch Card */}
                  <div
                    className="rv-feature-toggle-card"
                    style={{
                      background: circuitBreakerEnabled ? "rgba(0, 128, 96, 0.05)" : "var(--rv-surface-subdued)",
                      border: `1px solid ${circuitBreakerEnabled ? "rgba(0, 128, 96, 0.25)" : "var(--rv-border-subtle)"}`,
                      transition: "all 0.2s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                      <div
                        style={{
                          width: "42px",
                          height: "42px",
                          borderRadius: "var(--rv-radius-sm)",
                          background: circuitBreakerEnabled ? "rgba(0, 128, 96, 0.12)" : "var(--rv-surface)",
                          border: `1px solid ${circuitBreakerEnabled ? "rgba(0, 128, 96, 0.3)" : "var(--rv-border)"}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: circuitBreakerEnabled ? "var(--rv-primary)" : "var(--rv-text-subdued)",
                          flexShrink: 0,
                          transition: "all 0.2s ease",
                        }}
                      >
                        <ZapIcon size={22} />
                      </div>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "2px" }}>
                          <label
                            htmlFor="set-circuit-breaker"
                            style={{
                              fontSize: "14px",
                              fontWeight: 700,
                              color: "var(--rv-text)",
                              margin: 0,
                              cursor: hasCircuitBreakerAccess ? "pointer" : "not-allowed",
                            }}
                          >
                            Price Crash Protection Switch
                          </label>
                          {/* Reflects the SAVED breaker, so this can never claim
                              the store is defended while the row says otherwise. */}
                          <span
                            className={`rv-badge ${saved.circuitBreakerEnabled ? "rv-badge-success" : "rv-badge-neutral"} rv-badge-sm`}
                            style={{ fontWeight: 700 }}
                          >
                            {saved.circuitBreakerEnabled ? "ARMED & ACTIVE" : "PAUSED (OFF)"}
                          </span>
                          {breakerPending && (
                            <span className="rv-badge rv-badge-warning rv-badge-sm" style={{ fontWeight: 700 }}>
                              UNSAVED
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                          {saved.circuitBreakerEnabled
                            ? `Actively listening for rogue price drops \u2265 ${saved.threshold}%. Will automatically ${saved.actionChoice === "DRAFT" ? "hide product (DRAFT)" : "auto-revert baseline price"}.`
                            : "Protection is currently turned OFF. Toggle this switch to ON to arm real-time price crash defense."}
                        </span>
                        {breakerPending && (
                          <span style={{ fontSize: "12px", color: "var(--rv-warning)", fontWeight: 600, lineHeight: 1.4, display: "block", marginTop: "4px" }}>
                            {circuitBreakerEnabled && !saved.circuitBreakerEnabled
                              ? "Not protecting yet \u2014 click Save Settings to arm this."
                              : !circuitBreakerEnabled && saved.circuitBreakerEnabled
                                ? "Still armed \u2014 click Save Settings to disarm."
                                : "Pending change \u2014 click Save Settings to apply."}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={`rv-switch ${!hasCircuitBreakerAccess ? "disabled" : ""}`}>
                      <input
                        id="set-circuit-breaker"
                        type="checkbox"
                        disabled={!hasCircuitBreakerAccess}
                        checked={circuitBreakerEnabled}
                        onChange={(e) => setCircuitBreakerEnabled(e.target.checked)}
                      />
                      <label htmlFor="set-circuit-breaker" className="rv-switch-slider">
                        <span className="rv-sr-only">Toggle Price Crash Circuit Breaker</span>
                      </label>
                    </div>
                  </div>

                  {/* Visual Simulation Box - Always interactive */}
                  <div className="rv-sim-box">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 700, color: "var(--rv-warning)", fontSize: "13px" }}>
                        <ZapIcon size={16} />
                        <span>Live Protection Simulation</span>
                      </div>
                      <span className="rv-badge rv-badge-sm rv-badge-warning" style={{ fontWeight: 600 }}>
                        {numThreshold}% Drop Trigger
                      </span>
                    </div>

                    <div className="rv-sim-flow">
                      <div className="rv-sim-step">
                        <span className="rv-sim-step-label">Original Price</span>
                        <span className="rv-sim-step-val">$100.00</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--rv-warning)", fontWeight: 700, fontSize: "12px" }}>
                        <span>Drops &ge; {numThreshold}%</span>
                        <ArrowRightIcon size={14} />
                      </div>

                      <div className="rv-sim-step" style={{ borderColor: "rgba(239, 68, 68, 0.3)", background: "rgba(239, 68, 68, 0.04)" }}>
                        <span className="rv-sim-step-label" style={{ color: "#dc2626" }}>Glitched Price</span>
                        <span className="rv-sim-step-val" style={{ color: "#dc2626" }}>${sampleReducedPrice} or below</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--rv-primary)", fontWeight: 700, fontSize: "12px" }}>
                        <span>Auto-Defend</span>
                        <ArrowRightIcon size={14} />
                      </div>

                      <div className="rv-sim-step" style={{ borderColor: "rgba(0, 128, 96, 0.3)", background: "rgba(0, 128, 96, 0.04)" }}>
                        <span className="rv-sim-step-label" style={{ color: "var(--rv-primary)" }}>Revertly Action</span>
                        <span className="rv-sim-step-val" style={{ color: "var(--rv-primary)", fontSize: "13px" }}>
                          {actionChoice === "DRAFT" ? "Hide Item (Set to DRAFT)" : "Auto-Revert back to $100.00"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 2-Column Responsive Form Controls - Always interactive for customization */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px" }}>

                    {/* Left: Trigger Threshold */}
                    <div className="rv-form-field">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <label htmlFor="circuit-breaker-threshold" className="rv-form-label">
                          Crash Trigger Threshold
                        </label>
                        <span style={{ fontSize: "13px", fontWeight: 800, color: "var(--rv-warning)" }}>
                          {numThreshold}% drop
                        </span>
                      </div>

                      {/* Slider + Number Input in clean alignment */}
                      <div className="rv-slider-wrapper" style={{ marginTop: "4px" }}>
                        <input
                          type="range"
                          min="5"
                          max="95"
                          step="1"
                          disabled={!hasCircuitBreakerAccess}
                          value={threshold}
                          onChange={(e) => setThreshold(e.target.value)}
                          className="rv-range-slider"
                          aria-label="Crash Trigger Threshold Slider"
                        />
                        <div className="rv-input-group" style={{ width: "95px", flexShrink: 0 }}>
                          {/* `required` stops an empty field from submitting: it
                              used to pass validation, render the label as
                              "% drop", and be silently discarded by the server. */}
                          <input
                            id="circuit-breaker-threshold"
                            type="number"
                            min="5"
                            max="95"
                            step="1"
                            required
                            name="circuitBreakerThreshold"
                            disabled={!hasCircuitBreakerAccess}
                            value={threshold}
                            onChange={(e) => setThreshold(e.target.value)}
                            onBlur={(e) => {
                              const n = parseInt(e.target.value, 10);
                              if (!Number.isFinite(n)) setThreshold(saved.threshold);
                              else setThreshold(Math.min(95, Math.max(5, n)));
                            }}
                            className="rv-input"
                            style={{ textAlign: "center", fontWeight: 700 }}
                          />
                          <span className="rv-input-suffix">%</span>
                        </div>
                      </div>

                      {/* Quick Preset Buttons */}
                      <div className="rv-preset-group">
                        <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginRight: "4px" }}>Presets:</span>
                        {[
                          { label: "15% Mild", val: 15 },
                          { label: "30% Moderate", val: 30 },
                          { label: "50% Standard", val: 50 },
                          { label: "75% Severe", val: 75 },
                        ].map((preset) => (
                          <button
                            key={preset.val}
                            type="button"
                            disabled={!hasCircuitBreakerAccess}
                            className={`rv-preset-btn ${numThreshold === preset.val ? "active" : ""}`}
                            onClick={() => setThreshold(preset.val)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>

                      <span className="rv-form-help" style={{ marginTop: "6px" }}>
                        Fires defensive action if any product price is slashed by this percentage or more.
                      </span>
                    </div>

                    {/* Right: Emergency Defensive Action Cards */}
                    <div className="rv-form-field">
                      {/* Not a <label>: it names a radio GROUP, not one control.
                          The fieldset's <legend> carries that for assistive tech. */}
                      <div className="rv-form-label">
                        Emergency Defensive Action
                      </div>

                      {/* Genuine radio group — keyboard operable and announced as
                          one choice. The hidden mirror input is gone with it. */}
                      <fieldset className="rv-action-cards-grid" style={{ border: 0, margin: 0, padding: 0 }}>
                        <legend className="rv-sr-only">Emergency defensive action</legend>

                        {[
                          {
                            id: "DRAFT",
                            title: "Draft Product",
                            recommended: true,
                            desc: "Instantly unpublishes item from online storefront so customers cannot buy at the glitched price.",
                          },
                          {
                            id: "AUTO_REVERT",
                            title: "Auto-Revert Price",
                            recommended: false,
                            desc: "Immediately reverts price back to the previous snapshot baseline via Shopify API.",
                          },
                        ].map(({ id, title, recommended, desc }) => (
                          <label
                            key={id}
                            htmlFor={`cb-action-${id}`}
                            className={`rv-action-card ${actionChoice === id ? "selected" : ""}`}
                            style={{ cursor: hasCircuitBreakerAccess ? "pointer" : "default" }}
                          >
                            <input
                              id={`cb-action-${id}`}
                              type="radio"
                              name="circuitBreakerAction"
                              value={id}
                              checked={actionChoice === id}
                              disabled={!hasCircuitBreakerAccess}
                              onChange={() => setActionChoice(id)}
                              className="rv-sr-only"
                            />
                            <div className="rv-action-card-radio" aria-hidden="true">
                              {actionChoice === id && <div className="rv-action-card-radio-dot" />}
                            </div>
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>{title}</strong>
                                {recommended && (
                                  <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontSize: "9px", padding: "1px 5px" }}>Recommended</span>
                                )}
                              </div>
                              <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                                {desc}
                              </span>
                            </div>
                          </label>
                        ))}
                      </fieldset>

                      <span className="rv-form-help" style={{ marginTop: "6px" }}>
                        Action takes effect automatically within seconds of webhook detection.
                      </span>
                    </div>

                  </div>
                </div>
              </div>

              {/* ── 4. Bulk Change Anomaly Detection Card ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  display: activeTab === "all" || activeTab === "bulk" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge info">
                      <BoxIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
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
                  <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: "0 0 18px", lineHeight: 1.5 }}>
                    When products are modified in sudden bursts exceeding your threshold, Revertly registers a high-priority incident and alerts your team immediately.
                  </p>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
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
                          step="1"
                          required
                          name="bulkThreshold"
                          value={bulkThreshold}
                          onChange={(e) => setBulkThreshold(e.target.value)}
                          onBlur={(e) => {
                            const n = parseInt(e.target.value, 10);
                            setBulkThreshold(String(Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : saved.bulkThreshold));
                          }}
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
                          step="1"
                          required
                          name="bulkWindowMinutes"
                          value={bulkWindowMinutes}
                          onChange={(e) => setBulkWindowMinutes(e.target.value)}
                          onBlur={(e) => {
                            const n = parseInt(e.target.value, 10);
                            setBulkWindowMinutes(String(Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : saved.bulkWindowMinutes));
                          }}
                          className="rv-input"
                        />
                        <span className="rv-input-suffix">minutes</span>
                      </div>
                      <span className="rv-form-help">...within this sliding time window.</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 5. Alert Channels & Notifications Card ── */}
              <div
                className="rv-card"
                style={{
                  margin: 0,
                  display: activeTab === "all" || activeTab === "alerts" ? "block" : "none",
                }}
              >
                <div className="rv-card-header">
                  <div className="rv-card-icon-title">
                    <div className="rv-card-icon-badge neutral">
                      <BellIcon size={20} />
                    </div>
                    <div>
                      <h3 className="rv-card-title" style={{ margin: 0, fontSize: "16px" }}>
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
                  {/* Email & Slack Row */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "20px", marginBottom: "24px" }}>
                    {/* Email Input */}
                    <div className="rv-form-field">
                      <label htmlFor="alert-email" className="rv-form-label">
                        Primary Alert Email Address
                      </label>
                      <div className="rv-search-wrapper" style={{ width: "100%" }}>
                        <span className="rv-search-icon">
                          <MailIcon size={16} />
                        </span>
                        <input
                          id="alert-email"
                          type="email"
                          name="alertEmail"
                          value={alertEmail}
                          onChange={(e) => setAlertEmail(e.target.value)}
                          placeholder="merchant-security@example.com"
                          className="rv-input rv-input-with-icon"
                          style={{ width: "100%" }}
                        />
                      </div>
                      <span className="rv-form-help">Incidents, circuit breaker trips, and recovery confirmations are sent here.</span>
                    </div>

                    {/* Slack Webhook */}
                    <div className="rv-form-field">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                        <label htmlFor="slack-webhook-url" className="rv-form-label" style={{ margin: 0 }}>
                          Slack Incoming Webhook URL
                        </label>
                        {!hasSlackAccess && (
                          <span className="rv-badge rv-badge-neutral rv-badge-sm">
                            Requires Business Plan
                          </span>
                        )}
                      </div>

                      {!hasSlackAccess ? (
                        <div
                          style={{
                            background: "var(--rv-surface-subdued)",
                            border: "1px dashed var(--rv-border)",
                            borderRadius: "var(--rv-radius-sm)",
                            padding: "12px 16px",
                            fontSize: "12px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "10px",
                          }}
                        >
                          <span style={{ color: "var(--rv-text-subdued)" }}>
                            Slack Webhook alerts require <strong>Business</strong> plan.
                          </span>
                          <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
                            Upgrade
                          </Link>
                        </div>
                      ) : (
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <input
                              id="slack-webhook-url"
                              type="url"
                              name="slackWebhookUrl"
                              value={slackUrl}
                              onChange={(e) => setSlackUrl(e.target.value)}
                              placeholder="https://hooks.slack.com/services/..."
                              className="rv-input"
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              disabled={fetcher.state !== "idle"}
                              onClick={() => {
                                fetcher.submit(
                                  { intent: "testSlack", slackWebhookUrl: slackUrl },
                                  { method: "POST" }
                                );
                              }}
                              className="rv-btn rv-btn-secondary rv-btn-sm"
                              style={{ flexShrink: 0 }}
                            >
                              <BellIcon size={14} />
                              <span>{isTestingSlack ? "Testing..." : "Test"}</span>
                            </button>
                          </div>
                          <span className="rv-form-help">
                            Must be a https://hooks.slack.com/services/… URL.
                            {dirtyKeys.includes("slackUrl") && " Testing does not save it — click Save Settings to keep this URL."}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Severity selection.
                      - Now covers LOW, which detection rules could always be set
                        to but Settings had no toggle for, so those incidents were
                        silently dropped before any alert was sent.
                      - Each card is a <label> wrapping a real checkbox, so it is
                        keyboard reachable and properly named for screen readers
                        (previously a <div onClick> with an unlabelled input). */}
                  <div>
                    <div className="rv-form-label" style={{ marginBottom: "4px", display: "block" }} id="severity-group-label">
                      Notify on Incidents of Severity:
                    </div>
                    <p style={{ margin: "0 0 12px", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                      Applies to both email and Slack delivery.
                    </p>
                    <div className="rv-severity-grid" role="group" aria-labelledby="severity-group-label">
                      {[
                        {
                          id: "critical",
                          tone: "critical",
                          label: "CRITICAL",
                          desc: "Price crashes, mass product deletions, and circuit breaker activations.",
                          checked: alertCritical,
                          set: setAlertCritical,
                        },
                        {
                          id: "high",
                          tone: "warning",
                          label: "HIGH",
                          desc: "Bulk discount anomalies and sudden unexpected variant updates.",
                          checked: alertHigh,
                          set: setAlertHigh,
                        },
                        {
                          id: "medium",
                          tone: "info",
                          label: "MEDIUM",
                          desc: "Moderate catalog modifications exceeding configured detection rules.",
                          checked: alertMedium,
                          set: setAlertMedium,
                        },
                        {
                          id: "low",
                          tone: "info",
                          label: "LOW",
                          desc: "Minor changes flagged by your own low-severity detection rules.",
                          checked: alertLow,
                          set: setAlertLow,
                        },
                      ].map(({ id, tone, label, desc, checked, set }) => (
                        <label
                          key={id}
                          htmlFor={`alert-${id}`}
                          className={`rv-severity-card ${tone} ${checked ? "selected" : ""}`}
                          style={{ cursor: "pointer" }}
                        >
                          <input
                            id={`alert-${id}`}
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => set(e.target.checked)}
                            style={{ marginTop: "3px", cursor: "pointer" }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                              <span className={`rv-badge rv-badge-${tone === "info" && id === "medium" ? "info" : tone} rv-badge-sm`}>
                                {label}
                              </span>
                            </div>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", lineHeight: 1.4, display: "block" }}>
                              {desc}
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                    {!alertCritical && !alertHigh && !alertMedium && !alertLow && (
                      <p style={{ margin: "12px 0 0", fontSize: "12px", color: "var(--rv-warning)", fontWeight: 600 }}>
                        No severities selected — you will not receive any incident alerts.
                      </p>
                    )}
                  </div>
                </div>
              </div>


              {/* ── Sticky Bottom Action Bar ── */}
              <div className="rv-sticky-save-bar">
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background: isDirty ? "var(--rv-warning)" : "var(--rv-primary)",
                      boxShadow: `0 0 0 3px ${isDirty ? "rgba(245, 158, 11, 0.2)" : "rgba(0, 128, 96, 0.2)"}`,
                    }}
                  />
                  {/* States what is actually true, instead of always claiming
                      "Ready to update" whether or not anything is pending. */}
                  <span style={{ fontSize: "13px", fontWeight: 600, color: isDirty ? "var(--rv-warning)" : "var(--rv-text)" }}>
                    {isSaving
                      ? "Saving changes..."
                      : isDirty
                        ? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? "" : "s"} — not active until you save`
                        : "All settings saved and active"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  {isDirty && !isSaving && (
                    <button
                      type="button"
                      onClick={() => {
                        setMonitoringEnabled(saved.monitoringEnabled);
                        setCircuitBreakerEnabled(saved.circuitBreakerEnabled);
                        setThreshold(saved.threshold);
                        setActionChoice(saved.actionChoice);
                        setSlackUrl(saved.slackUrl);
                        setAlertEmail(saved.alertEmail);
                        setAlertCritical(saved.alertCritical);
                        setAlertHigh(saved.alertHigh);
                        setAlertMedium(saved.alertMedium);
                        setAlertLow(saved.alertLow);
                        setBulkThreshold(String(saved.bulkThreshold));
                        setBulkWindowMinutes(String(saved.bulkWindowMinutes));
                        setAutoBackupSchedule(saved.autoBackupSchedule);
                        setAutoBackupTime(saved.autoBackupTime);
                        setCloudSyncFolder(saved.cloudSyncFolder);
                        setCloudSyncAutoUpload(saved.cloudSyncAutoUpload);
                      }}
                      className="rv-btn rv-btn-secondary"
                    >
                      Discard changes
                    </button>
                  )}
                  <button
                    type="submit"
                    name="intent"
                    value="save"
                    disabled={isSaving || !isDirty}
                    className="rv-btn rv-btn-primary rv-btn-lg"
                    style={{ minWidth: "150px" }}
                  >
                    <SaveIcon size={16} />
                    <span>{isSaving ? "Saving..." : isDirty ? "Save Settings" : "Saved"}</span>
                  </button>
                </div>
              </div>

            </main>
          </div>

        </fetcher.Form>

      </div>

      {/* ── Disconnect Cloud Storage Modal ── */}
      <ConfirmModal
        isOpen={showDisconnectCloudModal}
        title="Disconnect Cloud Storage"
        message="Are you sure you want to disconnect your external cloud storage integration?"
        dangerNote="Stored cloud access credentials and tokens will be permanently deleted. Backups remain in your Revertly database, but automated cloud synchronization will be disabled."
        confirmLabel="Disconnect Cloud Storage"
        submittingLabel="Disconnecting..."
        tone="critical"
        isSubmitting={isDisconnecting}
        onConfirm={() => {
          fetcher.submit({ intent: "disconnectCloud" }, { method: "POST" });
        }}
        onClose={() => {
          if (!isDisconnecting) setShowDisconnectCloudModal(false);
        }}
      />

      {/* ── Unsaved Changes Modal (replaces browser window.confirm) ── */}
      <ConfirmModal
        isOpen={blocker.state === "blocked"}
        title="Unsaved Settings Changes"
        message="You have unsaved settings changes. Are you sure you want to leave without saving?"
        dangerNote="Any adjustments to alert preferences, thresholds, or schedules will not be saved."
        confirmLabel="Leave Without Saving"
        cancelLabel="Stay & Continue Editing"
        tone="warning"
        onConfirm={() => blocker.proceed()}
        onClose={() => blocker.reset()}
      />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
