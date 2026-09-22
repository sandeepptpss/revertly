import { useEffect, useRef } from "react";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useFetcher, useLoaderData, useRouteError, Link } from "react-router";
import {
  ShieldCheckIcon,
  RefreshCwIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  SparklesIcon,
  CheckCircleIcon,
  ClockIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { checkPermission, PERMISSIONS } from "../team.server.js";
import {
  startCatalogSync,
  getCatalogSyncStatus,
  cancelCatalogSync,
} from "../sync.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const count = await prisma.productSnapshot.count({ where: { shop } });
  const syncStatus = await getCatalogSyncStatus(shop);
  return { shop, count, syncStatus };
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;

    const formData = await request.formData();
    const intent = formData.get("intent");

    // Reading progress is not a mutation, so it is gated separately — otherwise
    // roles without backup-create (e.g. VIEWER) cannot watch a running sync.
    if (intent === "status") {
      const syncStatus = await getCatalogSyncStatus(shop);
      return { success: true, syncStatus };
    }

    const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
    if (!perm.allowed) return { success: false, message: perm.message };

    if (intent === "cancel") {
      await cancelCatalogSync(shop);
      return { success: true, cancelled: true };
    }

    // Start background catalog sync job. `force` is left off so the in-flight
    // job guard in startCatalogSync applies: a second submit returns the running
    // job instead of starting a competing one that writes the same snapshots.
    const result = await startCatalogSync(shop, { admin });
    const currentCount = await prisma.productSnapshot.count({ where: { shop } });

    return {
      success: true,
      count: currentCount,
      jobId: result.job?.id,
      status: result.job?.status,
      isBackground: true,
      alreadyRunning: result.alreadyRunning,
      message: result.message,
    };
  } catch (error) {
    console.error("Initialize action error:", error);
    return {
      success: false,
      error: error?.message || "An unexpected error occurred while scanning catalog.",
    };
  }
};

export default function InitialSnapshot() {
  const { count, syncStatus: initialSyncStatus } = useLoaderData();
  const fetcher = useFetcher();
  const pollFetcher = useFetcher();

  const actionResult = fetcher.data;
  const isLoading = fetcher.state !== "idle";

  // Derive active sync status from real-time poll or loader
  const currentSyncStatus = pollFetcher.data?.syncStatus ?? initialSyncStatus;
  // A freshly queued job is PENDING until its first batch runs, so PROCESSING
  // alone would miss the window in which polling most needs to start.
  const justQueued =
    actionResult?.isBackground && ["PENDING", "PROCESSING"].includes(actionResult?.status);
  const isSyncing = Boolean(!actionResult?.cancelled && (currentSyncStatus?.active || justQueued));

  const totalMonitored = currentSyncStatus?.totalSnapshots ?? (actionResult?.count ?? count);
  const isProtected = totalMonitored > 0;

  // Keep the live submit callback in a ref: useFetcher returns a new object each
  // render, so depending on it directly would clear and restart the interval on
  // every poll result and the 2.5s tick could never elapse.
  const submitPollRef = useRef(pollFetcher.submit);
  submitPollRef.current = pollFetcher.submit;

  // Auto-poll progress every 2.5s while background sync is running
  useEffect(() => {
    if (!isSyncing) return;

    const interval = setInterval(() => {
      const data = new FormData();
      data.append("intent", "status");
      submitPollRef.current(data, { method: "POST" });
    }, 2500);

    return () => clearInterval(interval);
  }, [isSyncing]);

  const percent = currentSyncStatus?.percent ?? 0;
  const processedCount = currentSyncStatus?.processedCount ?? 0;
  const estimatedTotal = currentSyncStatus?.totalEstimated ?? 0;

  return (
    <s-page
      heading="Initialize Product Snapshots"
      backAction={{ url: "/app", label: "Dashboard" }}
      inlineSize="large"
    >
      {/* ── Hero Status ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Store Catalog Baseline Snapshot
            </strong>
            <span className={`rv-badge ${isSyncing ? "rv-badge-info" : isProtected ? "rv-badge-success" : "rv-badge-warning"}`}>
              {isSyncing ? "Sync In Progress" : isProtected ? "Monitoring Active" : "Setup Required"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Before Revertly can detect price crashes, CSV bulk errors, or mass tag changes, an initial catalog baseline is required.
          </p>
        </div>

        <Link to="/app" className="rv-btn rv-btn-secondary rv-btn-sm">
          <ArrowLeftIcon size={14} />
          <span>Back to Dashboard</span>
        </Link>
      </div>

      {/* ── Active Background Queue Progress Card ── */}
      {isSyncing && (
        <div
          className="rv-card"
          style={{
            marginBottom: "24px",
            border: "1px solid var(--rv-primary-border, #bfdbfe)",
            background: "linear-gradient(180deg, #eff6ff 0%, #ffffff 100%)",
          }}
        >
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <RefreshCwIcon size={18} style={{ color: "var(--rv-primary)", animation: "spin 2s linear infinite" }} />
              <span>Catalog Background Sync Running</span>
            </h3>
            <span className="rv-badge rv-badge-info">High-Volume Queue Active</span>
          </div>
          <div className="rv-card-body">
            <div style={{ marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)" }}>
                {processedCount > 0
                  ? `Synced ${processedCount.toLocaleString()} ${estimatedTotal > 0 ? `of ~${estimatedTotal.toLocaleString()}` : ""} products...`
                  : "Scanning catalog batches via background queue..."}
              </span>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--rv-primary)" }}>
                {percent > 0 ? `${percent}%` : "Batching"}
              </span>
            </div>

            {/* Progress Bar */}
            <div
              style={{
                width: "100%",
                height: "10px",
                background: "#e2e8f0",
                borderRadius: "6px",
                overflow: "hidden",
                marginBottom: "16px",
              }}
            >
              <div
                style={{
                  width: `${Math.max(5, percent)}%`,
                  height: "100%",
                  background: "var(--rv-primary, #2563eb)",
                  borderRadius: "6px",
                  transition: "width 0.4s ease-in-out",
                }}
              />
            </div>

            <p style={{ margin: "0 0 16px", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Large catalogs (30,000+ products) are automatically segmented into memory-safe batches of 50 products to prevent Node.js heap overflow and web request timeouts. You can safely navigate away; syncing will continue in the background.
            </p>

            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="cancel" />
              <button
                type="submit"
                disabled={isLoading}
                className="rv-btn rv-btn-secondary rv-btn-sm"
              >
                <span>Cancel Sync</span>
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Baseline Setup Wizard Card ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <ShieldCheckIcon size={18} style={{ color: "var(--rv-primary)" }} />
            <span>Catalog Protection Wizard</span>
          </h3>
          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            High-speed GraphQL batching &amp; queue
          </span>
        </div>

        <div className="rv-card-body">
          {/* Status highlight callout */}
          <div
            style={{
              padding: "16px 20px",
              borderRadius: "var(--rv-radius-md)",
              background: isProtected ? "var(--rv-primary-surface)" : "var(--rv-warning-surface)",
              border: `1px solid ${isProtected ? "var(--rv-primary-border)" : "var(--rv-warning-border)"}`,
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
                className="rv-stat-icon-wrapper"
                style={{
                  background: isProtected ? "#dcfce7" : "#fef3c7",
                  color: isProtected ? "#166534" : "#b45309",
                }}
              >
                {isProtected ? <CheckCircleIcon size={20} /> : <ClockIcon size={20} />}
              </div>
              <div>
                <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
                  {isProtected
                    ? `${totalMonitored.toLocaleString()} Products Guarded in Catalog Baseline`
                    : "No baseline snapshots captured yet"}
                </strong>
                <p style={{ margin: "3px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                  {isProtected
                    ? "Real-time webhooks compare future updates against these frozen records."
                    : "Click below to scan your Shopify catalog and secure your initial snapshot."}
                </p>
              </div>
            </div>
          </div>

          {/* Error Banner */}
          {actionResult && !actionResult.success && (
            <Banner
              tone="critical"
              title="Baseline Initialization Failed"
            >
              {actionResult.error || actionResult.message || "Failed to initialize catalog snapshots."}
            </Banner>
          )}

          {/* Success Banner */}
          {actionResult?.success && !isSyncing && (
            <div
              style={{
                background: "var(--rv-primary-surface)",
                border: "1px solid var(--rv-primary-border)",
                borderRadius: "var(--rv-radius-md)",
                padding: "18px 20px",
                marginBottom: "24px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                <SparklesIcon size={18} style={{ color: "var(--rv-primary)" }} />
                <strong style={{ color: "var(--rv-primary-text)", fontSize: "15px" }}>
                  {actionResult.isBackground ? "Sync Scheduled in Background!" : "Snapshot Baseline Complete!"}
                </strong>
              </div>
              <p style={{ margin: "0 0 14px", fontSize: "13px", color: "var(--rv-primary-text)", lineHeight: 1.5 }}>
                {actionResult.isBackground
                  ? "Background worker has started syncing your catalog in memory-safe batches. Protection will update automatically."
                  : `${actionResult.count} products are now actively protected against accidental price crashes.`}
              </p>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <Link to="/app" className="rv-btn rv-btn-primary rv-btn-sm">
                  <span>Go to Dashboard</span>
                  <ArrowRightIcon size={13} />
                </Link>
                <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm">
                  Configure Detection Rules
                </Link>
                <Link to="/app/restore-points" className="rv-btn rv-btn-secondary rv-btn-sm">
                  View Restore Points
                </Link>
              </div>
            </div>
          )}

          {/* 3 Step Timeline */}
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "24px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--rv-info-surface)", color: "var(--rv-info)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px", flexShrink: 0 }}>
                1
              </div>
              <div>
                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>Managed Batch Scanning:</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Reads product variants, prices, inventory, and metafields in batches of 50 via GraphQL with automatic throttling backoff.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--rv-info-surface)", color: "var(--rv-info)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px", flexShrink: 0 }}>
                2
              </div>
              <div>
                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>Freeze Pre-Incident Baseline:</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Saves snapshot data to your store&apos;s encrypted database so you have a guaranteed reference point for 1-click rollbacks.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--rv-info-surface)", color: "var(--rv-info)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px", flexShrink: 0 }}>
                3
              </div>
              <div>
                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>Real-Time Webhook Guard:</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  As apps or bulk tools make modifications, Revertly calculates instant diffs to flag suspicious drops and create recoverable incidents.
                </p>
              </div>
            </div>
          </div>

          {/* Trigger Button */}
          <fetcher.Form method="POST">
            <button
              type="submit"
              disabled={isLoading || isSyncing}
              className="rv-btn rv-btn-primary rv-btn-lg"
              style={{ width: "100%" }}
            >
              <RefreshCwIcon size={16} />
              <span>
                {isLoading
                  ? "Starting Sync Queue..."
                  : isSyncing
                  ? "Sync Currently In Progress..."
                  : isProtected
                  ? "Refresh Store Baseline Snapshots"
                  : "Initialize Catalog Monitoring Now"}
              </span>
            </button>
          </fetcher.Form>
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
