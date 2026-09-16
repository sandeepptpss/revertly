import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, redirect, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rollbackProductFields } from "../monitor.server.js";
import {
  restoreThemeFilesWithSafety,
  restoreCollection,
  restorePage,
  restoreArticle,
  restoreProductMetafields,
  computeDiffLines,
  fetchThemeBackup,
} from "../backup.server.js";
import { checkFeatureAccess } from "../billing.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import { syncRestorePointToCloud } from "../cloudSync.server.js";
import {
  FileCodeIcon,
  BoxIcon,
  DownloadIcon,
  ArrowLeftIcon,
  ExternalLinkIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ShieldCheckIcon,
  CloudUploadIcon,
  GoogleDriveIcon,
  DropboxIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { PillNav } from "../components/PillNav.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";

export const loader = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  if (params.id === "new") {
    return redirect("/app/restore-points");
  }

  const rpId = parseInt(params.id);
  if (isNaN(rpId)) {
    throw new Response("Not Found", { status: 404 });
  }

  const restorePoint = await prisma.restorePoint.findFirst({
    where: { id: rpId, shop },
    include: {
      rollbackJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { results: true },
      },
    },
  });

  if (!restorePoint) throw new Response("Not Found", { status: 404 });

  // Get current snapshots for comparison
  const currentSnapshots = await prisma.productSnapshot.findMany({
    where: { shop },
    select: { productId: true, title: true, snapshotData: true },
  });

  const savedProducts = Array.isArray(restorePoint.snapshotData)
    ? restorePoint.snapshotData
    : [];

  // Find differences
  const currentMap = Object.fromEntries(
    currentSnapshots.map((s) => [s.productId, s.snapshotData]),
  );

  const differences = [];
  for (const saved of savedProducts) {
    const current = currentMap[saved.productId];
    if (!current) continue;

    const fieldDiffs = [];
    const fieldKeys = ["title", "status", "vendor", "tags", "handle"];
    for (const key of fieldKeys) {
      const sv = String(saved.snapshotData?.[key] ?? saved[key] ?? "");
      const cv = String(current[key] ?? "");
      if (sv !== cv) {
        fieldDiffs.push({ field: key, saved: sv, current: cv });
      }
    }

    // Check variants
    const savedVariants = saved.snapshotData?.variants || saved.variants || [];
    const currentVariants = current?.variants || [];
    for (const sv of savedVariants) {
      const cv = currentVariants.find((v) => v.id === sv.id);
      if (!cv) continue;
      for (const vf of ["price", "compareAtPrice", "sku"]) {
        if (String(sv[vf] ?? "") !== String(cv[vf] ?? "")) {
          fieldDiffs.push({
            field: `variant.${vf} (${sv.title || sv.id})`,
            saved: sv[vf] ?? "—",
            current: cv[vf] ?? "—",
          });
        }
      }
    }

    // Check metafields
    const savedMetafields = saved.snapshotData?.metafields || saved.metafields || [];
    const currentMetafields = current?.metafields || [];
    for (const sm of savedMetafields) {
      const cm = currentMetafields.find((m) => m.namespace === sm.namespace && m.key === sm.key);
      if (!cm) {
        fieldDiffs.push({
          field: `metafield.${sm.namespace}.${sm.key}`,
          saved: String(sm.value ?? ""),
          current: "(missing / deleted)",
        });
      } else if (String(cm.value ?? "") !== String(sm.value ?? "")) {
        fieldDiffs.push({
          field: `metafield.${sm.namespace}.${sm.key}`,
          saved: String(sm.value ?? ""),
          current: String(cm.value ?? ""),
        });
      }
    }

    if (fieldDiffs.length > 0) {
      differences.push({
        productId: saved.productId,
        title: saved.snapshotData?.title || saved.title || saved.productId,
        diffs: fieldDiffs,
      });
    }
  }

  const themeData = restorePoint.themeData || null;
  const collectionData = Array.isArray(restorePoint.collectionData) ? restorePoint.collectionData : [];
  const pageData = Array.isArray(restorePoint.pageData) ? restorePoint.pageData : [];
  const menuData = Array.isArray(restorePoint.menuData) ? restorePoint.menuData : [];
  const articleData = restorePoint.articleData || { blogs: [], articles: [] };

  let themeDiffFiles = [];
  if (Array.isArray(themeData?.files) && themeData.files.length > 0) {
    let currentLiveFiles = [];
    try {
      const liveTheme = await fetchThemeBackup(admin);
      currentLiveFiles = Array.isArray(liveTheme?.files) ? liveTheme.files : [];
    } catch (e) {
      console.warn("Could not fetch live theme files for diffing:", e?.message);
    }

    const liveMap = Object.fromEntries(
      currentLiveFiles.map((lf) => [lf.filename || lf.key || "", lf.content || lf.value || ""])
    );

    themeDiffFiles = themeData.files.map((f) => {
      const filename = f?.filename || f?.key || "";
      const content = f?.content || f?.value || "";
      const liveContent = liveMap[filename] ?? "";
      const diff = computeDiffLines(liveContent, content);
      return {
        ...f,
        filename,
        content,
        diff,
      };
    });
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });

  return {
    restorePoint,
    savedCount: savedProducts.length,
    differences,
    lastJob: restorePoint.rollbackJobs[0] || null,
    themeData,
    themeDiffFiles,
    collectionData,
    pageData,
    menuData,
    articleData,
    cloudSyncConfig: {
      connected: Boolean(settings?.cloudSyncConnected),
      provider: settings?.cloudSyncProvider || "NONE",
      folder: settings?.cloudSyncFolder || "Revertly_Backups",
    },
  };
};

export const action = async ({ request, params }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;
    const rpId = parseInt(params.id, 10);
    if (!rpId || isNaN(rpId)) {
      return { success: false, message: "Invalid restore point ID." };
    }
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "syncToCloud") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      // Performs a real upload and reports the real outcome.
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

    // Every remaining intent mutates live store data, so all of them require
    // the restore permission before any work begins.
    const restorePerm = await checkPermission(shop, session, PERMISSIONS.RESTORE);
    if (!restorePerm.allowed) {
      return { success: false, message: restorePerm.message };
    }

    if (intent === "restore_theme") {
      const themeAccess = await checkFeatureAccess(shop, "themes");
      if (!themeAccess.allowed) {
        return { success: false, message: "Theme restoration requires a Business or Enterprise plan." };
      }

      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const themeData = restorePoint?.themeData;
      if (!themeData || !themeData.activeTheme || !themeData.files?.length) {
        return { success: false, message: "No backed-up theme files available in this restore point." };
      }

      const mode = formData.get("mode") || "live";
      const selectedFilesRaw = formData.get("selectedFiles");
      let selectedFilenames = null;
      if (selectedFilesRaw) {
        try {
          selectedFilenames = JSON.parse(selectedFilesRaw);
        } catch (e) {
          selectedFilenames = selectedFilesRaw.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }

      const res = await restoreThemeFilesWithSafety({
        admin,
        shop,
        themeId: themeData.activeTheme.id,
        themeName: themeData.activeTheme.name,
        files: themeData.files,
        selectedFilenames,
        mode,
      });
      return res;
    }

    if (intent === "restore_collection") {
      const colIndex = parseInt(formData.get("colIndex"));
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const cols = Array.isArray(restorePoint?.collectionData) ? restorePoint.collectionData : [];
      const target = cols[colIndex];
      if (!target) return { success: false, message: "Collection not found in snapshot." };
      const res = await restoreCollection(admin, target);
      return res.success ? { success: true, message: `Collection "${target.title}" successfully restored.` } : res;
    }

    if (intent === "restore_page") {
      const pageIndex = parseInt(formData.get("pageIndex"));
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const pages = Array.isArray(restorePoint?.pageData) ? restorePoint.pageData : [];
      const target = pages[pageIndex];
      if (!target) return { success: false, message: "Page not found in snapshot." };
      const res = await restorePage(admin, target);
      return res.success ? { success: true, message: `Page "${target.title}" successfully restored.` } : res;
    }

    if (intent === "restore_article") {
      const articleIndex = parseInt(formData.get("articleIndex"));
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const articles = restorePoint?.articleData?.articles || [];
      const target = articles[articleIndex];
      if (!target) return { success: false, message: "Article not found in snapshot." };
      const res = await restoreArticle(admin, target);
      return res;
    }

    if (
      intent !== "restore" &&
      intent !== "restore_single_product" &&
      intent !== "restore_selected_products"
    ) {
      return { success: false };
    }

    const restorePoint = await prisma.restorePoint.findFirst({
      where: { id: rpId, shop },
    });
    if (!restorePoint) return { success: false, message: "Restore point not found." };

    const allSavedProducts = Array.isArray(restorePoint.snapshotData)
      ? restorePoint.snapshotData
      : [];

    let targetProducts = allSavedProducts;
    if (intent === "restore_single_product") {
      const targetProductId = String(formData.get("productId") || "").trim();
      targetProducts = allSavedProducts.filter((s) => String(s.productId) === targetProductId);
      if (targetProducts.length === 0) {
        return { success: false, message: `Product #${targetProductId} not found in restore point snapshot.` };
      }
    } else if (intent === "restore_selected_products") {
      const selectedRaw = formData.get("selectedProductIds") || "";
      const selectedIds = selectedRaw.split(",").map((s) => s.trim()).filter(Boolean);
      targetProducts = allSavedProducts.filter((s) => selectedIds.includes(String(s.productId)));
      if (targetProducts.length === 0) {
        return { success: false, message: "No matching products found for selection." };
      }
    }

    // Get current snapshots
    const currentSnapshots = await prisma.productSnapshot.findMany({
      where: { shop },
      select: { productId: true, snapshotData: true },
    });
    const currentMap = Object.fromEntries(
      currentSnapshots.map((s) => [s.productId, s.snapshotData]),
    );

    const job = await prisma.rollbackJob.create({
      data: {
        shop,
        restorePointId: rpId,
        status: "RUNNING",
        totalProducts: targetProducts.length,
      },
    });

    await prisma.restorePoint.update({
      where: { id: rpId },
      data: { status: "RESTORING" },
    });

    let successCount = 0;
    let failedCount = 0;

    for (const saved of targetProducts) {
      const productId = saved.productId;
      const savedSnap = saved.snapshotData || saved;
      const current = currentMap[productId];
      if (!current) continue;

      const mockEvents = [];
      const fieldKeys = ["title", "status", "vendor", "tags"];
      for (const key of fieldKeys) {
        const sv = String(savedSnap[key] ?? "");
        const cv = String(current[key] ?? "");
        if (sv !== cv) {
          mockEvents.push({ fieldName: key, oldValue: sv, newValue: cv, variantId: null });
        }
      }

      const savedVariants = savedSnap.variants || [];
      const currentVariants = current.variants || [];
      for (const sv of savedVariants) {
        const cv = currentVariants.find((v) => v.id === sv.id);
        if (!cv) continue;
        const numId = sv.id.replace("gid://shopify/ProductVariant/", "");
        for (const vf of ["price", "compareAtPrice", "sku"]) {
          if (String(sv[vf] ?? "") !== String(cv[vf] ?? "")) {
            mockEvents.push({
              fieldName: `variant.${vf}`,
              oldValue: String(sv[vf] ?? ""),
              newValue: String(cv[vf] ?? ""),
              variantId: numId,
            });
          }
        }
      }

      if (mockEvents.length === 0) {
        await prisma.rollbackResult.create({
          data: {
            rollbackJobId: job.id,
            productId,
            productTitle: savedSnap.title || productId,
            status: "SKIPPED",
          },
        });
        continue;
      }

      const tempIds = [];
      for (const e of mockEvents) {
        const created = await prisma.changeEvent.create({
          data: {
            shop,
            productId,
            productTitle: savedSnap.title || productId,
            fieldName: e.fieldName,
            variantId: e.variantId,
            oldValue: e.oldValue,
            newValue: e.newValue,
          },
          select: { id: true },
        });
        tempIds.push(created.id);
      }

      const result = await rollbackProductFields(admin, shop, productId, tempIds);

      // Restore metafields if present
      if (Array.isArray(savedSnap.metafields) && savedSnap.metafields.length > 0) {
        try {
          await restoreProductMetafields(admin, productId, savedSnap.metafields);
        } catch (mfErr) {
          console.warn(`Product metafield restore warning (${productId}):`, mfErr?.message);
        }
      }

      await prisma.changeEvent.deleteMany({ where: { id: { in: tempIds } } });

      await prisma.rollbackResult.create({
        data: {
          rollbackJobId: job.id,
          productId,
          productTitle: savedSnap.title || productId,
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

    await prisma.restorePoint.update({
      where: { id: rpId },
      data: { status: "READY" },
    });

    await logAudit(
      shop,
      restorePerm.actor,
      intent === "restore_single_product" ? "PRODUCT_RESTORE_INDIVIDUAL" : "PRODUCT_RESTORE_BULK",
      {
        resourceType: "Product",
        resourceId: rpId,
        details: {
          restorePointId: rpId,
          mode: intent,
          targetCount: targetProducts.length,
          successCount,
          failedCount,
        },
        request,
      },
    );

    const successLabel = intent === "restore_single_product"
      ? `Product successfully restored to snapshot state.`
      : `Restored ${successCount} products successfully (${failedCount} failed).`;

    return {
      success: true,
      message: successLabel,
    };
  } catch (error) {
    console.error("Restore point detail action error:", error);
    return {
      success: false,
      message: error?.message || "An unexpected error occurred during restoration.",
    };
  }
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

export default function RestorePointDetail() {
  const {
    restorePoint,
    savedCount,
    differences,
    lastJob,
    themeData,
    themeDiffFiles,
    collectionData,
    pageData,
    articleData,
  } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isRestoring = fetcher.state !== "idle";

  const filesList = themeDiffFiles?.length > 0 ? themeDiffFiles : (themeData?.files || []);

  const [selectedFiles, setSelectedFiles] = useState(
    () => filesList.map((f) => f.filename)
  );
  const [expandedFile, setExpandedFile] = useState(null);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [showLiveRestoreModal, setShowLiveRestoreModal] = useState(false);

  useEffect(() => {
    if (result && !isRestoring) {
      setShowLiveRestoreModal(false);
    }
  }, [result, isRestoring]);

  const [activeTab, setActiveTab] = useState(() => {
    if (differences.length > 0) return "products";
    if (themeData?.activeTheme) return "theme";
    return "products";
  });

  const tabs = [
    ...(themeData?.activeTheme ? [{ id: "theme", label: "Theme Code", count: filesList.length }] : []),
    { id: "products", label: "Products", count: differences.length },
    ...(collectionData.length > 0 ? [{ id: "collections", label: "Collections", count: collectionData.length }] : []),
    ...(pageData.length > 0 ? [{ id: "pages", label: "Pages & Menus", count: pageData.length }] : []),
    ...((articleData?.articles?.length > 0 || articleData?.blogs?.length > 0)
      ? [{ id: "articles", label: "Articles", count: articleData.articles?.length || 0 }]
      : []),
    ...(lastJob ? [{ id: "history", label: "History" }] : []),
  ];

  const toggleSelectAll = () => {
    if (selectedFiles.length === filesList.length) {
      setSelectedFiles([]);
    } else {
      setSelectedFiles(filesList.map((f) => f.filename));
    }
  };

  return (
    <s-page
      heading={restorePoint.name}
      backAction={{ url: "/app/restore-points", label: "Restore Points" }}
      inlineSize="large"
    >
      {/* ── Top Header Hero Banner ── */}
      <div className="rv-hero-banner" style={{ padding: "18px 22px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
            <span
              className={`rv-badge ${
                restorePoint.status === "READY"
                  ? "rv-badge-success"
                  : restorePoint.status === "CREATING"
                  ? "rv-badge-warning"
                  : "rv-badge-critical"
              }`}
            >
              {restorePoint.status}
            </span>
            <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", display: "flex", alignItems: "center", gap: "4px" }}>
              <ClockIcon size={14} />
              <span>Captured: {formatTime(restorePoint.createdAt)}</span>
            </span>
            <span className="rv-badge rv-badge-info rv-badge-sm">{savedCount} Products</span>
            {themeData?.activeTheme && (
              <span className="rv-badge rv-badge-success rv-badge-sm">Theme: {themeData.activeTheme.name}</span>
            )}
            {collectionData.length > 0 && (
              <span className="rv-badge rv-badge-info rv-badge-sm">{collectionData.length} Collections</span>
            )}
            {pageData.length > 0 && (
              <span className="rv-badge rv-badge-neutral rv-badge-sm">{pageData.length} Pages</span>
            )}
            {articleData?.articles?.length > 0 && (
              <span className="rv-badge rv-badge-success rv-badge-sm">{articleData.articles.length} Articles</span>
            )}
            {restorePoint.cloudSyncStatus === "SYNCED" ? (
              <span className="rv-badge rv-badge-info rv-badge-sm" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                {restorePoint.cloudProvider === "GOOGLE_DRIVE" ? (
                  <GoogleDriveIcon size={12} style={{ color: "#ea4335" }} />
                ) : (
                  <DropboxIcon size={12} style={{ color: "#0061fe" }} />
                )}
                <span>Synced to {restorePoint.cloudProvider === "GOOGLE_DRIVE" ? "Google Drive" : "Dropbox"}</span>
              </span>
            ) : (
              <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ color: "var(--rv-text-subdued)" }}>
                Local Storage Only
              </span>
            )}
          </div>
          {restorePoint.description && (
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
              {restorePoint.description}
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <fetcher.Form method="POST" style={{ display: "inline" }}>
            <input type="hidden" name="intent" value="syncToCloud" />
            <button
              type="submit"
              disabled={isRestoring}
              className="rv-btn rv-btn-secondary rv-btn-sm"
              title="Sync snapshot to connected Google Drive / Dropbox"
            >
              <CloudUploadIcon size={14} />
              <span>{restorePoint.cloudSyncStatus === "SYNCED" ? "Re-sync Cloud" : "Push to Cloud"}</span>
            </button>
          </fetcher.Form>

          <a
            href={`/app/restore-points/${restorePoint.id}/export`}
            className="rv-btn rv-btn-secondary rv-btn-sm"
          >
            <DownloadIcon size={14} />
            <span>Download Offline Backup (.json)</span>
          </a>
          <Link to="/app/restore-points" className="rv-btn rv-btn-subtle rv-btn-sm">
            <ArrowLeftIcon size={14} />
            <span>All Restore Points</span>
          </Link>
        </div>
      </div>

      {/* ── Segmented Navigation Tabs ── */}
      <PillNav items={tabs} activeId={activeTab} onChange={setActiveTab} />

      {/* ── Draft Staging Preview Banner ── */}
      {result?.isDraft && result?.previewUrl && (
        <Banner
          tone="success"
          title={`Draft Staging Theme Created: "${result.draftThemeName}"`}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <a
                href={result.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="rv-btn rv-btn-primary rv-btn-sm"
              >
                <span>Storefront Preview</span>
                <ExternalLinkIcon size={13} />
              </a>
              {result.editorUrl && (
                <a
                  href={result.editorUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                >
                  <span>Theme Customizer</span>
                  <ExternalLinkIcon size={13} />
                </a>
              )}
            </div>
          }
        >
          Your backed-up theme files were safely deployed into an <strong>unpublished draft theme</strong> ({result.filesRestored} files restored). Your live storefront is 100% untouched.
        </Banner>
      )}

      {/* ── Live Safety Snapshot Banner ── */}
      {result?.isLive && result?.safetyRpId && (
        <Banner
          tone="info"
          title="Live Theme Restored Successfully"
          action={
            <Link
              to={`/app/restore-points/${result.safetyRpId}`}
              className="rv-btn rv-btn-secondary rv-btn-sm"
            >
              View Safety Backup
            </Link>
          }
        >
          Live storefront theme files have been restored. Safety snapshot #{result.safetyRpId} was automatically captured prior to changes for 1-click undo.
        </Banner>
      )}

      {/* ── Generic Message Banner ── */}
      {result?.message && !result?.isDraft && !result?.isLive && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Operation Succeeded" : "Operation Warning"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Active Theme Backup & Diff Section ── */}
      {activeTab === "theme" && themeData?.activeTheme && (
        <div className="rv-card">
          <div className="rv-card-header">
            <div>
              <h3 className="rv-card-title">
                <FileCodeIcon size={18} style={{ color: "var(--rv-info)" }} />
                <span>Theme: {themeData.activeTheme.name}</span>
              </h3>
              <p className="rv-card-subtitle">
                {themeData.files?.length || 0} critical theme files &amp; settings backed up ({themeData.activeTheme.role} role).
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                {selectedFiles.length} of {themeData.files?.length || 0} files selected
              </span>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="rv-btn rv-btn-secondary rv-btn-sm"
              >
                {selectedFiles.length === (themeData?.files?.length || 0) ? "Deselect All" : "Select All"}
              </button>
            </div>
          </div>

          <div className="rv-card-body">
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
              {filesList.map((f) => {
                const isSelected = selectedFiles.includes(f.filename);
                const isExpanded = expandedFile === f.filename;
                const sizeKb = f.size ? Math.round((f.size / 1024) * 10) / 10 : 0;
                const hasDiff = f.diff && !f.diff.isIdentical;

                return (
                  <div
                    key={f.filename}
                    style={{
                      border: "1px solid var(--rv-border)",
                      borderRadius: "var(--rv-radius-sm)",
                      padding: "12px 16px",
                      background: isSelected ? "#ffffff" : "#fafbfb",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <input
                          type="checkbox"
                          id={`file-${f.filename}`}
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedFiles([...selectedFiles, f.filename]);
                            } else {
                              setSelectedFiles(selectedFiles.filter((name) => name !== f.filename));
                            }
                          }}
                        />
                        <label
                          htmlFor={`file-${f.filename}`}
                          style={{ cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: "13px" }}
                        >
                          <strong>{f.filename}</strong>
                          {sizeKb > 0 && <span style={{ color: "var(--rv-text-subdued)", marginLeft: "6px" }}>({sizeKb} KB)</span>}
                        </label>

                        {f.diff?.isIdentical ? (
                          <span className="rv-badge rv-badge-neutral rv-badge-sm">
                            ✓ Identical to Live
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: "4px" }}>
                            {f.diff?.additions > 0 && (
                              <span className="rv-badge rv-badge-success rv-badge-sm">
                                +{f.diff.additions}
                              </span>
                            )}
                            {f.diff?.deletions > 0 && (
                              <span className="rv-badge rv-badge-critical rv-badge-sm">
                                -{f.diff.deletions}
                              </span>
                            )}
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => setExpandedFile(isExpanded ? null : f.filename)}
                        className="rv-btn rv-btn-subtle rv-btn-sm"
                      >
                        {isExpanded ? (
                          <>
                            <span>Hide Diff</span>
                            <ChevronUpIcon size={14} />
                          </>
                        ) : (
                          <>
                            <span>View Diff</span>
                            <ChevronDownIcon size={14} />
                          </>
                        )}
                      </button>
                    </div>

                    {isExpanded && (
                      <div
                        style={{
                          border: "1px solid var(--rv-border)",
                          borderRadius: "var(--rv-radius-sm)",
                          overflow: "hidden",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                          fontSize: "12px",
                          lineHeight: "20px",
                          background: "#ffffff",
                          marginTop: "12px",
                        }}
                      >
                        <div
                          style={{
                            background: "#f8fafc",
                            padding: "8px 14px",
                            borderBottom: "1px solid var(--rv-border)",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: "11px",
                            color: "var(--rv-text-subdued)",
                            fontWeight: "600",
                          }}
                        >
                          <span>🔴 Red = Lines Removed in Backup &nbsp;|&nbsp; 🟢 Green = Backup Lines Restored</span>
                          <span>
                            {hasDiff ? (
                              <span>
                                <span style={{ color: "#166534", marginRight: "8px" }}>+{f.diff.additions} additions</span>
                                <span style={{ color: "#991b1b" }}>-{f.diff.deletions} deletions</span>
                              </span>
                            ) : (
                              <span>100% In Sync with Live Theme</span>
                            )}
                          </span>
                        </div>

                        <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                          {f.diff?.lines?.length > 0 ? (
                            f.diff.lines.map((line, lIdx) => {
                              const isAdded = line.type === "added";
                              const isRemoved = line.type === "removed";
                              const isInfo = line.type === "info";
                              return (
                                <div
                                  key={lIdx}
                                  style={{
                                    display: "flex",
                                    background: isAdded ? "#f0fdf4" : isRemoved ? "#fef2f2" : isInfo ? "#f8fafc" : "#ffffff",
                                    color: isAdded ? "#166534" : isRemoved ? "#991b1b" : isInfo ? "#64748b" : "#1e293b",
                                    borderBottom: "1px solid #f1f3f5",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: "44px",
                                      paddingRight: "8px",
                                      textAlign: "right",
                                      color: "#94a3b8",
                                      userSelect: "none",
                                      background: isAdded ? "#dcfce7" : isRemoved ? "#fee2e2" : "#f8fafc",
                                      borderRight: "1px solid var(--rv-border)",
                                      flexShrink: 0,
                                      fontSize: "11px",
                                    }}
                                  >
                                    {isRemoved ? line.oldLineNum : isAdded ? line.newLineNum : line.oldLineNum || line.newLineNum || " "}
                                  </div>
                                  <div style={{ width: "24px", textAlign: "center", fontWeight: "bold", userSelect: "none", flexShrink: 0 }}>
                                    {isAdded ? "+" : isRemoved ? "-" : " "}
                                  </div>
                                  <div style={{ paddingLeft: "6px", whiteSpace: "pre-wrap", wordBreak: "break-all", flexGrow: 1 }}>
                                    {line.content || " "}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div style={{ padding: "14px", color: "var(--rv-text-subdued)" }}>No content differences recorded.</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Dual Safe Theme Restore Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", paddingTop: "14px", borderTop: "1px solid var(--rv-border)" }}>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="restore_theme" />
                <input type="hidden" name="mode" value="draft" />
                <input type="hidden" name="selectedFiles" value={JSON.stringify(selectedFiles)} />
                <button
                  type="submit"
                  disabled={selectedFiles.length === 0 || isRestoring}
                  className="rv-btn rv-btn-primary rv-btn-lg"
                >
                  <ShieldCheckIcon size={16} />
                  <span>Restore to Draft Theme (Safe Preview First)</span>
                </button>
              </fetcher.Form>

              <button
                type="button"
                disabled={selectedFiles.length === 0 || isRestoring}
                className="rv-btn rv-btn-secondary rv-btn-lg"
                style={{ color: "var(--rv-critical)" }}
                onClick={() => setShowLiveRestoreModal(true)}
              >
                <span>Instant Restore to Live Theme</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Products Differences & Rollback Section ── */}
      {activeTab === "products" && (
        <div>
          {differences.length > 0 && (
            <div
              className="rv-card"
              style={{
                borderLeft: "4px solid var(--rv-critical)",
                marginBottom: "20px",
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
                    Catalog Drift Detected: {differences.length} Product{differences.length !== 1 ? "s" : ""} Differ from Snapshot
                  </strong>
                  <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                    These products were modified since this snapshot was taken. Rollback will safely restore only modified field values.
                  </p>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  {selectedProductIds.length > 0 && (
                    <fetcher.Form method="POST" style={{ margin: 0 }}>
                      <input type="hidden" name="intent" value="restore_selected_products" />
                      <input type="hidden" name="selectedProductIds" value={selectedProductIds.join(",")} />
                      <button
                        type="submit"
                        disabled={isRestoring}
                        className="rv-btn rv-btn-primary rv-btn-lg"
                      >
                        <span>{isRestoring ? "Restoring..." : `Restore Selected (${selectedProductIds.length})`}</span>
                      </button>
                    </fetcher.Form>
                  )}
                  <fetcher.Form method="POST" style={{ margin: 0 }}>
                    <input type="hidden" name="intent" value="restore" />
                    <button
                      type="submit"
                      disabled={isRestoring}
                      className="rv-btn rv-btn-critical rv-btn-lg"
                    >
                      <span>{isRestoring ? "Restoring products..." : `Restore All (${differences.length}) Products`}</span>
                    </button>
                  </fetcher.Form>
                </div>
              </div>
            </div>
          )}

          {differences.length === 0 ? (
            <EmptyState
              icon={<CheckCircleIcon size={28} style={{ color: "var(--rv-primary)" }} />}
              title="100% In Sync with Restore Point"
              description="All products in your live catalog match this restore point. No price drops or discrepancy diffs detected."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 2px" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    checked={differences.length > 0 && selectedProductIds.length === differences.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedProductIds(differences.map((d) => d.productId));
                      } else {
                        setSelectedProductIds([]);
                      }
                    }}
                    style={{ width: "16px", height: "16px", cursor: "pointer" }}
                  />
                  <span>Select All Differing Products ({differences.length})</span>
                </label>
                {selectedProductIds.length > 0 && (
                  <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    {selectedProductIds.length} of {differences.length} selected
                  </span>
                )}
              </div>

              {differences.map((d) => (
                <div key={d.productId} className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <input
                        type="checkbox"
                        checked={selectedProductIds.includes(d.productId)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedProductIds((prev) => [...prev, d.productId]);
                          } else {
                            setSelectedProductIds((prev) => prev.filter((id) => id !== d.productId));
                          }
                        }}
                        style={{ width: "16px", height: "16px", cursor: "pointer" }}
                      />
                      <h4 className="rv-card-title" style={{ margin: 0 }}>
                        <BoxIcon size={16} style={{ color: "var(--rv-info)" }} />
                        <span>{d.title}</span>
                      </h4>
                      <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        Product #{d.productId}
                      </span>
                    </div>

                    <fetcher.Form method="POST" style={{ margin: 0 }}>
                      <input type="hidden" name="intent" value="restore_single_product" />
                      <input type="hidden" name="productId" value={d.productId} />
                      <button
                        type="submit"
                        disabled={isRestoring}
                        className="rv-btn rv-btn-secondary rv-btn-sm"
                        title="Restore only this product to snapshot state"
                      >
                        <span>1-Click Restore Product</span>
                      </button>
                    </fetcher.Form>
                  </div>
                  <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
                    <table className="rv-table">
                      <thead>
                        <tr>
                          <th style={{ width: "220px" }}>Field</th>
                          <th>Saved in Snapshot (Target Value)</th>
                          <th style={{ width: "24px" }}></th>
                          <th>Current Live Store Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.diffs.map((df, dfIdx) => (
                          <tr key={dfIdx}>
                            <td style={{ fontWeight: 600 }}>
                              <span className="rv-badge rv-badge-neutral rv-badge-sm">{df.field}</span>
                            </td>
                            <td>
                              <span className="rv-diff-new">{String(df.saved)}</span>
                            </td>
                            <td style={{ color: "var(--rv-text-subdued)", textAlign: "center" }}>→</td>
                            <td>
                              <span className="rv-diff-old">{String(df.current)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Collections Backup Section ── */}
      {activeTab === "collections" && collectionData.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>Protected Collections ({collectionData.length})</span>
            </h3>
          </div>
          <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Collection Title</th>
                  <th>Handle</th>
                  <th>Smart Rules Preserved</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {collectionData.map((col, idx) => (
                  <tr key={col.id || idx}>
                    <td style={{ fontWeight: 600 }}>{col.title}</td>
                    <td style={{ color: "var(--rv-text-subdued)" }}>/{col.handle}</td>
                    <td>
                      <span className="rv-badge rv-badge-info rv-badge-sm">
                        {col.ruleSet?.rules?.length || 0} smart rules
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <fetcher.Form method="POST" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="restore_collection" />
                        <input type="hidden" name="colIndex" value={idx} />
                        <button type="submit" className="rv-btn rv-btn-secondary rv-btn-sm">
                          Recreate / Restore
                        </button>
                      </fetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Pages Backup Section ── */}
      {activeTab === "pages" && pageData.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>Protected Content Pages ({pageData.length})</span>
            </h3>
          </div>
          <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Page Title</th>
                  <th>Handle</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pageData.map((p, idx) => (
                  <tr key={p.id || idx}>
                    <td style={{ fontWeight: 600 }}>{p.title}</td>
                    <td style={{ color: "var(--rv-text-subdued)" }}>/{p.handle}</td>
                    <td style={{ textAlign: "right" }}>
                      <fetcher.Form method="POST" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="restore_page" />
                        <input type="hidden" name="pageIndex" value={idx} />
                        <button type="submit" className="rv-btn rv-btn-secondary rv-btn-sm">
                          Restore Page
                        </button>
                      </fetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Blogs & Articles Backup Section ── */}
      {activeTab === "articles" && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>Protected Blog Articles ({articleData?.articles?.length || 0})</span>
            </h3>
          </div>
          {(!articleData?.articles || articleData.articles.length === 0) ? (
            <EmptyState
              title="No blog articles in this restore point"
              description="Published blog articles will appear here automatically in future snapshots."
            />
          ) : (
            <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
              <table className="rv-table">
                <thead>
                  <tr>
                    <th>Article Title</th>
                    <th>Status</th>
                    <th>Blog</th>
                    <th style={{ textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {articleData.articles.map((art, idx) => (
                    <tr key={art.id || idx}>
                      <td style={{ fontWeight: 600 }}>{art.title}</td>
                      <td>
                        <span className={`rv-badge rv-badge-sm ${art.isPublished ? "rv-badge-success" : "rv-badge-neutral"}`}>
                          {art.isPublished ? "Published" : "Draft"}
                        </span>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)" }}>{art.blogTitle || "Blog"}</td>
                      <td style={{ textAlign: "right" }}>
                        <fetcher.Form method="POST" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="restore_article" />
                          <input type="hidden" name="articleIndex" value={idx} />
                          <button type="submit" className="rv-btn rv-btn-secondary rv-btn-sm">
                            Restore Article
                          </button>
                        </fetcher.Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Restore History Section ── */}
      {activeTab === "history" && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <ClockIcon size={18} />
              <span>Restore Operations Run</span>
            </h3>
          </div>
          <div className="rv-card-body">
            {lastJob ? (
              <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                <span className={`rv-badge ${lastJob.status === "COMPLETED" ? "rv-badge-success" : "rv-badge-critical"}`}>
                  {lastJob.status}
                </span>
                <span style={{ fontSize: "14px", fontWeight: 600 }}>
                  {lastJob.successCount} of {lastJob.totalProducts} products restored
                </span>
                <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Executed: {formatTime(lastJob.createdAt)}
                </span>
              </div>
            ) : (
              <EmptyState
                title="No operations executed yet"
                description="No restore operations have been performed from this restore point yet."
              />
            )}
          </div>
        </div>
      )}

      {/* ── Live Theme Restore Confirmation Modal ── */}
      <ConfirmModal
        isOpen={showLiveRestoreModal}
        title="Restore Directly to Live Storefront"
        message="Are you sure you want to restore the selected theme files directly to your live storefront theme?"
        dangerNote="A safety backup will automatically be captured before changes are applied, allowing you to rollback if needed."
        confirmLabel="Confirm Live Restore"
        submittingLabel="Restoring..."
        tone="critical"
        isSubmitting={isRestoring}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "restore_theme",
              mode: "live",
              selectedFiles: JSON.stringify(selectedFiles),
            },
            { method: "POST" }
          );
        }}
        onClose={() => {
          if (!isRestoring) setShowLiveRestoreModal(false);
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
