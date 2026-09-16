import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, Link, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createMultiResourceRestorePoint } from "../backup.server.js";
import { checkRestorePointLimit, checkFeatureAccess } from "../billing.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import { syncRestorePointToCloud } from "../cloudSync.server.js";
import {
  SaveIcon,
  BoxIcon,
  FileCodeIcon,
  ClockIcon,
  DownloadIcon,
  Trash2Icon,
  SparklesIcon,
  ArrowRightIcon,
  CloudUploadIcon,
  GoogleDriveIcon,
  DropboxIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [restorePoints, limitInfo, themeAccess, settings] = await Promise.all([
    // Select only what the list renders. Fetching the row wholesale drags in
    // eight JSON payload columns (full catalog/theme snapshots, megabytes
    // each); MySQL then has to carry them through the ORDER BY filesort and
    // fails with "Out of sort memory" once a store has real backups.
    prisma.restorePoint.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        productCount: true,
        themeCount: true,
        collectionCount: true,
        pageCount: true,
        articleCount: true,
        cloudSyncStatus: true,
        cloudProvider: true,
        createdAt: true,
      },
    }),
    checkRestorePointLimit(shop),
    checkFeatureAccess(shop, "themes"),
    prisma.appSettings.findUnique({ where: { shop } }),
  ]);

  return {
    restorePoints,
    limitInfo,
    hasThemeAccess: themeAccess.allowed,
    cloudSyncConfig: {
      connected: Boolean(settings?.cloudSyncConnected),
      provider: settings?.cloudSyncProvider || "NONE",
      email: settings?.cloudSyncEmail || null,
      folder: settings?.cloudSyncFolder || "Revertly_Backups",
    },
  };
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "create") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return {
          success: false,
          message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}) for your ${limitCheck.plan.toUpperCase()} plan. Please upgrade in Plans & Billing to create more restore points.`,
        };
      }

      const rawName = formData.get("name")?.trim();
      const defaultName = `Snapshot - ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
      const name = (rawName || defaultName).slice(0, 500);
      const description = (formData.get("description") || "").slice(0, 2000);

      const themeCheck = await checkFeatureAccess(shop, "themes");
      const includeProducts = formData.get("includeProducts") === "1";
      const includeThemes = themeCheck.allowed && formData.get("includeThemes") === "1";
      const includeCollections = formData.get("includeCollections") === "1";
      const includePages = formData.get("includePages") === "1";
      const includeArticles = formData.get("includeArticles") === "1";

      if (!includeProducts && !includeThemes && !includeCollections && !includePages && !includeArticles) {
        return {
          success: false,
          message: "Please select at least one component (Products, Themes, Collections, Pages, or Articles) to include in the restore point.",
        };
      }

      const result = await createMultiResourceRestorePoint({
        admin,
        shop,
        name,
        description,
        options: {
          includeProducts,
          includeThemes,
          includeCollections,
          includePages,
          includeMenus: includePages,
          includeArticles,
        },
      });

      if (!result.success) {
        return { success: false, message: result.message || "Failed to create restore point." };
      }

      const s = result.summary || {};
      const parts = [];
      if (s.products > 0) parts.push(`${s.products} products`);
      if (s.themes > 0) parts.push(`1 theme`);
      if (s.collections > 0) parts.push(`${s.collections} collections`);
      if (s.pages > 0) parts.push(`${s.pages} pages & menus`);
      if (s.articles > 0) parts.push(`${s.articles} blog articles`);

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: {
          name,
          summary: result.summary,
        },
        request,
      });

      return {
        success: true,
        message: `Restore point "${name}" successfully captured (${parts.join(", ") || "Full Store"}).`,
      };
    }

    if (intent === "delete") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_DELETE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const rpId = parseInt(formData.get("rpId"), 10);
      if (!rpId || isNaN(rpId)) {
        return { success: false, message: "Invalid restore point ID." };
      }
      const rp = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
        select: { id: true, name: true },
      });
      if (!rp) {
        return { success: false, message: "Restore point not found or access denied." };
      }

      // Rollback jobs reference the restore point, so clear them first or the
      // FK constraint rejects the delete.
      await prisma.rollbackResult.deleteMany({
        where: { rollbackJob: { restorePointId: rpId } },
      });
      await prisma.rollbackJob.deleteMany({ where: { restorePointId: rpId } });
      await prisma.restorePoint.delete({ where: { id: rpId } });

      await logAudit(shop, perm.actor, "BACKUP_DELETED", {
        resourceType: "RestorePoint",
        resourceId: rpId,
        details: { name: rp.name },
        request,
      });

      return { success: true, message: "Restore point deleted." };
    }

    if (intent === "syncToCloud") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const rpId = parseInt(formData.get("rpId"), 10);
      if (!rpId || isNaN(rpId)) {
        return { success: false, message: "Invalid restore point ID." };
      }

      // syncRestorePointToCloud performs the real upload and is itself
      // shop-scoped, so it will refuse another shop's restore point.
      const res = await syncRestorePointToCloud(shop, rpId);
      await logAudit(shop, perm.actor, "BACKUP_CLOUD_SYNC", {
        resourceType: "RestorePoint",
        resourceId: rpId,
        details: { success: res.success, provider: res.provider, error: res.error || null },
        request,
      });

      return res.success
        ? { success: true, message: res.message }
        : { success: false, message: res.error };
    }

    return { success: false, message: "Unknown action." };
  } catch (error) {
    console.error("Restore points action error:", error);
    return {
      success: false,
      message: error?.message || "An unexpected error occurred while processing your request.",
    };
  }
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

export default function RestorePoints() {
  const { restorePoints, limitInfo, hasThemeAccess } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isCreating = fetcher.state !== "idle";
  const [searchParams] = useSearchParams();
  const [showCreateForm, setShowCreateForm] = useState(
    () => searchParams.get("create") === "true",
  );
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [components, setComponents] = useState({
    products: true,
    themes: Boolean(hasThemeAccess),
    collections: true,
    pages: true,
    articles: true,
  });

  useEffect(() => {
    if (searchParams.get("create") === "true") {
      setShowCreateForm(true);
    }
  }, [searchParams]);

  const isDeleting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete";

  useEffect(() => {
    if (result?.success) {
      setShowCreateForm(false);
    }
    if (result && !isDeleting) {
      setDeleteTarget(null);
    }
  }, [result, isDeleting]);

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    fetcher.submit(
      { intent: "delete", rpId: String(deleteTarget.id) },
      { method: "POST" }
    );
  };

  const usedCount = Math.max(limitInfo?.currentCount || 0, restorePoints.length);
  const maxLimit = limitInfo?.limit ?? Infinity;
  const isLimitReached = !limitInfo?.allowed;
  const quotaPercent = maxLimit === Infinity ? 0 : Math.min(100, Math.round((usedCount / maxLimit) * 100));

  return (
    <s-page heading="Restore Points" inlineSize="large">

      {/* ── Action Feedback Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Restore Point Action Complete" : "Action Failed"}
          action={
            !result.success && result.message?.includes("Settings") ? (
              <Link to="/app/settings" className="rv-btn rv-btn-secondary rv-btn-sm">
                Go to Settings
              </Link>
            ) : undefined
          }
        >
          {result.message}
        </Banner>
      )}

      {/* ── Limit Warning Banner ── */}
      {isLimitReached && (
        <Banner
          tone="warning"
          title={`Restore Point Limit Reached (${usedCount} / ${maxLimit})`}
          action={
            <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
              Upgrade Plan
            </Link>
          }
        >
          You have reached the maximum allowed restore points for the {limitInfo?.plan?.toUpperCase()} plan. Delete older snapshots or upgrade your plan to capture new restore points.
        </Banner>
      )}

      {/* ── Header Summary Bar with Quota Meter ── */}
      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Full Store Snapshots &amp; Time Machine
            </strong>
            <span className="rv-badge rv-badge-info">
              {maxLimit === Infinity ? "Unlimited Quota" : `${usedCount} / ${maxLimit} Used`}
            </span>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Capture a frozen state of your Products, Liquid Theme code, Collections, Pages, and Blog Articles. Revert individual components or your entire store anytime with 1 click.
          </p>

          {maxLimit !== Infinity && (
            <div style={{ maxWidth: "340px" }}>
              <div className="rv-progress-track">
                <div
                  className="rv-progress-fill"
                  style={{
                    width: `${quotaPercent}%`,
                    background: quotaPercent >= 100 ? "var(--rv-critical)" : quotaPercent >= 80 ? "var(--rv-warning)" : "var(--rv-primary)",
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div>
          <button
            type="button"
            disabled={isLimitReached}
            onClick={() => setShowCreateForm(!showCreateForm)}
            className={`rv-btn rv-btn-lg ${!isLimitReached ? "rv-btn-primary" : "rv-btn-secondary"}`}
          >
            <SaveIcon size={16} />
            <span>{showCreateForm ? "✕ Close Form" : "+ Create Restore Point"}</span>
          </button>
        </div>
      </div>

      {/* ── Create Restore Point Form Card ── */}
      {showCreateForm && (
        <div className="rv-card" style={{ border: "2px solid var(--rv-primary)", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-primary-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "var(--rv-primary-text)" }}>
              <SparklesIcon size={18} />
              <span>Capture New Store Restore Point</span>
            </h3>
            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Estimated time: 2–5 seconds
            </span>
          </div>

          <div className="rv-card-body">
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="create" />

              <div className="rv-form-grid" style={{ marginBottom: "20px" }}>
                <div className="rv-form-field">
                  <label htmlFor="rp-name" className="rv-form-label">Restore Point Name *</label>
                  <input
                    id="rp-name"
                    type="text"
                    name="name"
                    required
                    placeholder="e.g. Before Major Redesign & Summer Sale"
                    className="rv-input"
                    defaultValue={`Snapshot - ${new Date().toLocaleDateString()}`}
                  />
                  <span className="rv-form-help">A clear name for your team or audit records.</span>
                </div>

                <div className="rv-form-field">
                  <label htmlFor="rp-description" className="rv-form-label">Description / Notes (Optional)</label>
                  <input
                    id="rp-description"
                    type="text"
                    name="description"
                    placeholder="e.g. Taken before installing wholesale pricing app"
                    className="rv-input"
                  />
                  <span className="rv-form-help">Any context on campaigns, third-party apps, or staff changes.</span>
                </div>
              </div>

              <div style={{ marginBottom: "22px" }}>
                <div className="rv-form-label" style={{ marginBottom: "10px", display: "block" }}>
                  Components Included in this Snapshot:
                </div>
                <div className="rv-toggle-grid">
                  <div className={`rv-toggle-card ${components.products ? "rv-toggle-card-active" : ""}`}>
                    <input
                      id="chk-products"
                      type="checkbox"
                      name="includeProducts"
                      checked={components.products}
                      onChange={(e) => setComponents((prev) => ({ ...prev, products: e.target.checked }))}
                      value="1"
                      style={{ marginTop: "3px", cursor: "pointer" }}
                    />
                    <label htmlFor="chk-products" style={{ cursor: "pointer", flexGrow: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <BoxIcon size={15} style={{ color: "var(--rv-primary)" }} />
                        <strong style={{ fontSize: "13px" }}>Products &amp; Prices</strong>
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Variants, Metafields &amp; SKUs</span>
                    </label>
                  </div>

                  <div
                    className={`rv-toggle-card ${hasThemeAccess && components.themes ? "rv-toggle-card-active" : ""}`}
                    style={{ opacity: hasThemeAccess ? 1 : 0.65, cursor: hasThemeAccess ? "pointer" : "not-allowed" }}
                  >
                    <input
                      id="chk-themes"
                      type="checkbox"
                      name="includeThemes"
                      checked={hasThemeAccess && components.themes}
                      onChange={(e) => hasThemeAccess && setComponents((prev) => ({ ...prev, themes: e.target.checked }))}
                      disabled={!hasThemeAccess}
                      value="1"
                      style={{ marginTop: "3px", cursor: hasThemeAccess ? "pointer" : "not-allowed" }}
                    />
                    <label htmlFor="chk-themes" style={{ cursor: hasThemeAccess ? "pointer" : "not-allowed", flexGrow: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <FileCodeIcon size={15} style={{ color: "var(--rv-primary)" }} />
                        <strong style={{ fontSize: "13px" }}>Active Theme</strong>
                        {!hasThemeAccess && (
                          <span className="rv-badge rv-badge-warning rv-badge-sm">
                            Business+
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>
                        {hasThemeAccess ? "Liquid, JSON & Assets" : "Requires Business or Enterprise"}
                      </span>
                    </label>
                  </div>

                  <div className={`rv-toggle-card ${components.collections ? "rv-toggle-card-active" : ""}`}>
                    <input
                      id="chk-collections"
                      type="checkbox"
                      name="includeCollections"
                      checked={components.collections}
                      onChange={(e) => setComponents((prev) => ({ ...prev, collections: e.target.checked }))}
                      value="1"
                      style={{ marginTop: "3px", cursor: "pointer" }}
                    />
                    <label htmlFor="chk-collections" style={{ cursor: "pointer", flexGrow: 1 }}>
                      <strong style={{ fontSize: "13px", display: "block" }}>Collections</strong>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Manual &amp; Smart Rules</span>
                    </label>
                  </div>

                  <div className={`rv-toggle-card ${components.pages ? "rv-toggle-card-active" : ""}`}>
                    <input
                      id="chk-pages"
                      type="checkbox"
                      name="includePages"
                      checked={components.pages}
                      onChange={(e) => setComponents((prev) => ({ ...prev, pages: e.target.checked }))}
                      value="1"
                      style={{ marginTop: "3px", cursor: "pointer" }}
                    />
                    <label htmlFor="chk-pages" style={{ cursor: "pointer", flexGrow: 1 }}>
                      <strong style={{ fontSize: "13px", display: "block" }}>Pages &amp; Menus</strong>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Store Pages &amp; Navigation</span>
                    </label>
                  </div>

                  <div className={`rv-toggle-card ${components.articles ? "rv-toggle-card-active" : ""}`}>
                    <input
                      id="chk-articles"
                      type="checkbox"
                      name="includeArticles"
                      checked={components.articles}
                      onChange={(e) => setComponents((prev) => ({ ...prev, articles: e.target.checked }))}
                      value="1"
                      style={{ marginTop: "3px", cursor: "pointer" }}
                    />
                    <label htmlFor="chk-articles" style={{ cursor: "pointer", flexGrow: 1 }}>
                      <strong style={{ fontSize: "13px", display: "block" }}>Blog Articles</strong>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Blog Posts &amp; Content</span>
                    </label>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px", paddingTop: "8px", borderTop: "1px solid var(--rv-border)" }}>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="rv-btn rv-btn-primary rv-btn-lg"
                >
                  <SaveIcon size={16} />
                  <span>{isCreating ? "Capturing Full Store Snapshot..." : "Capture Restore Point Now"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="rv-btn rv-btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Restore Points List / Empty State ── */}
      {restorePoints.length === 0 ? (
        <EmptyState
          icon={<SaveIcon size={26} style={{ color: "var(--rv-primary)" }} />}
          title="No Restore Points Created Yet"
          description="Create snapshot restore points before running bulk discounts, editing theme code, or running third-party CSV imports. You can revert individual files or your entire catalog with 1 click."
          action={
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="rv-btn rv-btn-primary"
            >
              <SaveIcon size={15} />
              <span>Create Your First Restore Point</span>
            </button>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {restorePoints.map((rp) => (
            <div key={rp.id} className="rv-card" style={{ margin: 0 }}>
              <div
                className="rv-card-body"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "18px",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <Link
                      to={`/app/restore-points/${rp.id}`}
                      style={{ fontSize: "16px", fontWeight: 700, color: "var(--rv-text)", textDecoration: "none" }}
                    >
                      {rp.name}
                    </Link>
                    <span
                      className={`rv-badge ${
                        rp.status === "READY"
                          ? "rv-badge-success"
                          : rp.status === "CREATING" || rp.status === "RESTORING"
                          ? "rv-badge-warning"
                          : "rv-badge-critical"
                      }`}
                    >
                      {rp.status}
                    </span>
                  </div>

                  {rp.description && (
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                      {rp.description}
                    </p>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "2px" }}>
                    <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", display: "flex", alignItems: "center", gap: "4px" }}>
                      <ClockIcon size={13} />
                      <span>{formatTime(rp.createdAt)}</span>
                    </span>
                    <span style={{ color: "var(--rv-text-subdued)" }}>·</span>
                    <span className="rv-badge rv-badge-info rv-badge-sm">{rp.productCount} Products</span>
                    {rp.themeCount > 0 && <span className="rv-badge rv-badge-success rv-badge-sm">1 Theme</span>}
                    {rp.collectionCount > 0 && (
                      <span className="rv-badge rv-badge-info rv-badge-sm">{rp.collectionCount} Collections</span>
                    )}
                    {rp.pageCount > 0 && (
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">{rp.pageCount} Pages</span>
                    )}
                    {rp.articleCount > 0 && (
                      <span className="rv-badge rv-badge-success rv-badge-sm">{rp.articleCount} Articles</span>
                    )}
                    <span style={{ color: "var(--rv-text-subdued)" }}>·</span>
                    {rp.cloudSyncStatus === "SYNCED" ? (
                      <span
                        className="rv-badge rv-badge-info rv-badge-sm"
                        style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                      >
                        {rp.cloudProvider === "GOOGLE_DRIVE" ? (
                          <GoogleDriveIcon size={12} style={{ color: "#ea4335" }} />
                        ) : (
                          <DropboxIcon size={12} style={{ color: "#0061fe" }} />
                        )}
                        <span>Synced ({rp.cloudProvider === "GOOGLE_DRIVE" ? "G-Drive" : "Dropbox"})</span>
                      </span>
                    ) : rp.cloudSyncStatus === "FAILED" ? (
                      <span className="rv-badge rv-badge-critical rv-badge-sm">
                        Cloud Sync Failed
                      </span>
                    ) : (
                      <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ color: "var(--rv-text-subdued)" }}>
                        Local Storage
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <Link
                    to={`/app/restore-points/${rp.id}`}
                    className="rv-btn rv-btn-primary rv-btn-sm"
                  >
                    <span>Inspect / Restore</span>
                    <ArrowRightIcon size={13} />
                  </Link>

                  {(() => {
                    const isThisSyncing = isCreating && fetcher.formData?.get("intent") === "syncToCloud" && fetcher.formData?.get("rpId") === String(rp.id);
                    return (
                      <fetcher.Form method="POST" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="syncToCloud" />
                        <input type="hidden" name="rpId" value={rp.id} />
                        <button
                          type="submit"
                          disabled={isCreating}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                          title="Sync this snapshot to Google Drive or Dropbox"
                        >
                          <CloudUploadIcon size={13} className={isThisSyncing ? "rv-spin" : ""} />
                          <span>{isThisSyncing ? "Syncing..." : rp.cloudSyncStatus === "SYNCED" ? "Re-sync Cloud" : "Sync Cloud"}</span>
                        </button>
                      </fetcher.Form>
                    );
                  })()}

                  <a
                    href={`/app/restore-points/${rp.id}/export`}
                    className="rv-btn rv-btn-secondary rv-btn-sm"
                  >
                    <DownloadIcon size={13} />
                    <span>JSON</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => setDeleteTarget(rp)}
                    className="rv-btn rv-btn-subtle rv-btn-sm"
                    style={{ color: "var(--rv-critical)" }}
                  >
                    <Trash2Icon size={13} />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Delete Restore Point"
        message={
          deleteTarget ? (
            <>
              Are you sure you want to permanently delete restore point{" "}
              <strong>&ldquo;{deleteTarget.name}&rdquo;</strong>?
            </>
          ) : null
        }
        dangerNote="This action cannot be undone. All snapshots, product backups, and theme files saved in this restore point will be permanently erased."
        confirmLabel="Delete Restore Point"
        submittingLabel="Deleting..."
        tone="critical"
        isSubmitting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onClose={() => {
          if (!isDeleting) setDeleteTarget(null);
        }}
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
