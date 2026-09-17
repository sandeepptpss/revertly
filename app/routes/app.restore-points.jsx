import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useFetcher, useRouteError, Link, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  createMultiResourceRestorePoint,
  backupTheme,
  backupProducts,
  backupCollections,
  backupPages,
  backupBlogs,
  backupMenus,
  backupMetafields,
} from "../backup.server.js";
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
  UploadIcon,
  FileTextIcon,
  BookOpenIcon,
  LayersIcon,
  DatabaseIcon,
  ZapIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination } from "../components/Pagination.jsx";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [restorePoints, limitInfo, themeAccess, metafieldAccess, settings] = await Promise.all([
    prisma.restorePoint.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        backupType: true,
        productCount: true,
        themeCount: true,
        collectionCount: true,
        pageCount: true,
        menuCount: true,
        articleCount: true,
        metafieldCount: true,
        cloudSyncStatus: true,
        cloudProvider: true,
        createdAt: true,
      },
    }),
    checkRestorePointLimit(shop),
    checkFeatureAccess(shop, "themes"),
    checkFeatureAccess(shop, "metafieldBackup"),
    prisma.appSettings.findUnique({ where: { shop } }),
  ]);

  let themes = [];
  if (themeAccess.allowed) {
    try {
      const themeRes = await admin.graphql(
        `#graphql
        query getThemesList {
          themes(first: 25) {
            nodes {
              id
              name
              role
            }
          }
        }`
      );
      const themeJson = await themeRes.json();
      themes = themeJson.data?.themes?.nodes || [];
    } catch (err) {
      console.warn("Could not fetch themes list:", err?.message || err);
    }
  }

  return {
    restorePoints,
    limitInfo,
    hasThemeAccess: themeAccess.allowed,
    hasMetafieldAccess: metafieldAccess.allowed,
    metafieldPlan: metafieldAccess.plan,
    themes,
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

    if (intent === "create" || intent === "backupFull") {
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
      const metafieldCheck = await checkFeatureAccess(shop, "metafieldBackup");
      const isFull = intent === "backupFull";
      const includeProducts = isFull || formData.get("includeProducts") === "1";
      const includeThemes = themeCheck.allowed && (isFull || formData.get("includeThemes") === "1");
      const includeCollections = isFull || formData.get("includeCollections") === "1";
      const includePages = isFull || formData.get("includePages") === "1";
      const includeArticles = isFull || formData.get("includeArticles") === "1";
      // Menus have always ridden along with pages; they are now selectable on
      // their own, so an explicit tick counts even when pages are unticked.
      const includeMenus = isFull || includePages || formData.get("includeMenus") === "1";
      // Gated capabilities are resolved from the plan, never from the form, so
      // a crafted request cannot switch one on.
      const includeMetafields =
        metafieldCheck.allowed && (isFull || formData.get("includeMetafields") === "1");

      if (!includeProducts && !includeThemes && !includeCollections && !includePages && !includeArticles && !includeMenus && !includeMetafields) {
        return {
          success: false,
          message: "Please select at least one component (Products, Themes, Collections, Pages, Menus, Articles, or Metafields) to include in the restore point.",
        };
      }

      const result = await createMultiResourceRestorePoint({
        admin,
        shop,
        name: isFull ? `Full Store Backup - ${new Date().toLocaleDateString()}` : name,
        description: isFull ? "Comprehensive 1-click snapshot of entire Shopify store data." : description,
        backupType: isFull ? "FULL" : null,
        options: {
          includeProducts,
          includeThemes,
          includeCollections,
          includePages,
          includeMenus,
          includeArticles,
          includeMetafields,
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
      if (s.pages > 0) parts.push(`${s.pages} pages`);
      if (s.menus > 0) parts.push(`${s.menus} navigation menus`);
      if (s.articles > 0) parts.push(`${s.articles} blog articles`);
      if (s.metafields > 0) parts.push(`${s.metafields} metafields`);
      if (s.metafieldDefinitions > 0) parts.push(`${s.metafieldDefinitions} metafield definitions`);

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
        message: `Restore point "${result.restorePoint?.name || name}" successfully captured (${parts.join(", ") || "Full Store"}).`,
      };
    }

    // ── Dedicated Backup Runners ───────────────────────────────────────────────
    if (intent === "backupTheme") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const themeCheck = await checkFeatureAccess(shop, "themes");
      if (!themeCheck.allowed) {
        return { success: false, message: "Theme backups require a Business or Enterprise plan." };
      }

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const themeId = formData.get("themeId") || null;
      const rawName = formData.get("name")?.trim();
      const result = await backupTheme({ admin, shop, themeId, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Theme backup failed." };

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "THEMES", themeId },
        request,
      });

      return { success: true, message: `Full Theme Backup completed successfully.` };
    }

    if (intent === "backupProducts") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const rawName = formData.get("name")?.trim();
      const result = await backupProducts({ admin, shop, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Product backup failed." };

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "PRODUCTS", count: result.summary?.products },
        request,
      });

      return { success: true, message: `Product Catalog Backup completed (${result.summary?.products || 0} products).` };
    }

    if (intent === "backupCollections") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const rawName = formData.get("name")?.trim();
      const result = await backupCollections({ admin, shop, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Collection backup failed." };

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "COLLECTIONS", count: result.summary?.collections },
        request,
      });

      return { success: true, message: `Collection Backup completed (${result.summary?.collections || 0} collections).` };
    }

    if (intent === "backupPages") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const rawName = formData.get("name")?.trim();
      const result = await backupPages({ admin, shop, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Page backup failed." };

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "PAGES", count: result.summary?.pages },
        request,
      });

      return { success: true, message: `Page & Menu Backup completed (${result.summary?.pages || 0} pages & menus).` };
    }

    if (intent === "backupBlogs") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const rawName = formData.get("name")?.trim();
      const result = await backupBlogs({ admin, shop, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Blog backup failed." };

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "BLOGS", count: result.summary?.articles },
        request,
      });

      return { success: true, message: `Blog & Article Backup completed (${result.summary?.articles || 0} articles).` };
    }

    if (intent === "backupMenus") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const rawName = formData.get("name")?.trim();
      const result = await backupMenus({ admin, shop, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Navigation menu backup failed." };

      if ((result.summary?.menus || 0) === 0) {
        return {
          success: true,
          message: "Navigation Menu Backup completed, but no menus were found on this store. Check that the app has navigation permissions.",
        };
      }

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "MENUS", count: result.summary?.menus },
        request,
      });

      return { success: true, message: `Navigation Menu Backup completed (${result.summary?.menus || 0} menus).` };
    }

    if (intent === "backupMetafields") {
      const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const metafieldCheck = await checkFeatureAccess(shop, "metafieldBackup");
      if (!metafieldCheck.allowed) {
        return {
          success: false,
          message: "Metafield backups require a Growth plan or higher. Upgrade in Plans & Billing to capture metafields and their definitions.",
        };
      }

      const limitCheck = await checkRestorePointLimit(shop);
      if (!limitCheck.allowed) {
        return { success: false, message: `Restore Point Limit Reached (${limitCheck.currentCount} / ${limitCheck.limit}). Please upgrade.` };
      }

      const rawName = formData.get("name")?.trim();
      const result = await backupMetafields({ admin, shop, name: rawName });

      if (!result.success) return { success: false, message: result.message || "Metafield backup failed." };

      const values = result.summary?.metafields || 0;
      const defs = result.summary?.metafieldDefinitions || 0;

      if (values === 0 && defs === 0) {
        return {
          success: true,
          message: "Metafield Backup completed, but no metafields or definitions were found on this store yet.",
        };
      }

      await logAudit(shop, perm.actor, "BACKUP_CREATED", {
        resourceType: "RestorePoint",
        resourceId: result.restorePoint?.id,
        details: { type: "METAFIELDS", metafields: values, definitions: defs },
        request,
      });

      // A partial capture is surfaced rather than hidden: a backup the merchant
      // believes is complete when it is not is the worst outcome here.
      const warned = result.summary?.metafieldWarnings > 0
        ? " Some resources could not be read — open the snapshot to review the warnings."
        : "";

      return {
        success: true,
        message: `Metafield Backup completed (${values} metafields, ${defs} definitions).${warned}`,
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

      // Decouple rollback jobs from the deleted restore point to preserve the permanent audit trail
      await prisma.rollbackJob.updateMany({
        where: { restorePointId: rpId },
        data: { restorePointId: null },
      });
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
  const { restorePoints, limitInfo, hasThemeAccess, hasMetafieldAccess, themes = [] } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const activeIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;
  const isAnySubmitting = fetcher.state !== "idle";
  const isFullSubmitting = isAnySubmitting && activeIntent === "backupFull";
  const isThemeSubmitting = isAnySubmitting && activeIntent === "backupTheme";
  const isProductsSubmitting = isAnySubmitting && activeIntent === "backupProducts";
  const isCollectionsSubmitting = isAnySubmitting && activeIntent === "backupCollections";
  const isPagesSubmitting = isAnySubmitting && activeIntent === "backupPages";
  const isBlogsSubmitting = isAnySubmitting && activeIntent === "backupBlogs";
  const isMenusSubmitting = isAnySubmitting && activeIntent === "backupMenus";
  const isMetafieldsSubmitting = isAnySubmitting && activeIntent === "backupMetafields";
  const isCustomSubmitting = isAnySubmitting && activeIntent === "create";
  const [searchParams] = useSearchParams();
  const [showCreateForm, setShowCreateForm] = useState(
    () => searchParams.get("create") === "true",
  );
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [filterType, setFilterType] = useState("ALL");
  const [selectedThemeId, setSelectedThemeId] = useState(
    () => themes.find((t) => t.role === "MAIN")?.id || themes[0]?.id || "",
  );
  const [components, setComponents] = useState({
    products: true,
    themes: Boolean(hasThemeAccess),
    collections: true,
    pages: true,
    menus: true,
    articles: true,
    metafields: Boolean(hasMetafieldAccess),
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

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const filteredRestorePoints = useMemo(() => {
    if (filterType === "ALL") return restorePoints;
    return restorePoints.filter((rp) => (rp.backupType || "FULL") === filterType);
  }, [restorePoints, filterType]);

  const totalItems = filteredRestorePoints.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const validPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (validPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  const paginatedRestorePoints = useMemo(() => {
    return filteredRestorePoints.slice(startIndex, endIndex);
  }, [filteredRestorePoints, startIndex, endIndex]);

  const counts = useMemo(() => {
    return {
      all: restorePoints.length,
      full: restorePoints.filter((r) => (r.backupType || "FULL") === "FULL").length,
      themes: restorePoints.filter((r) => r.backupType === "THEMES").length,
      products: restorePoints.filter((r) => r.backupType === "PRODUCTS").length,
      collections: restorePoints.filter((r) => r.backupType === "COLLECTIONS").length,
      pages: restorePoints.filter((r) => r.backupType === "PAGES").length,
      blogs: restorePoints.filter((r) => r.backupType === "BLOGS").length,
      menus: restorePoints.filter((r) => r.backupType === "MENUS").length,
      metafields: restorePoints.filter((r) => r.backupType === "METAFIELDS").length,
    };
  }, [restorePoints]);

  return (
    <s-page heading="Restore Points" inlineSize="large">
      <HubNav hub="backups" activeTab="restore-points" />

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

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <Link
            to="/app/import-export"
            className="rv-btn rv-btn-secondary rv-btn-lg"
            title="Import & Export backup files"
          >
            <UploadIcon size={16} />
            <span>Import &amp; Export</span>
          </Link>
          <button
            type="button"
            disabled={isLimitReached}
            onClick={() => setShowCreateForm(!showCreateForm)}
            className={`rv-btn rv-btn-lg ${!isLimitReached ? "rv-btn-primary" : "rv-btn-secondary"}`}
          >
            <SaveIcon size={16} />
            <span>{showCreateForm ? "✕ Close Form" : "+ Custom Snapshot"}</span>
          </button>
        </div>
      </div>

      {/* ── 1-Click Backup Hub (6 Core Options) ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <div>
            <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <SparklesIcon size={18} style={{ color: "var(--rv-primary)" }} />
              <span>Instant 1-Click Backup Options</span>
            </h3>
            <p style={{ margin: "3px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Run specialized, single-click backups for specific store resources without affecting other components.
            </p>
          </div>
        </div>

        <div className="rv-card-body">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "14px",
            }}
          >
            {/* 1. Full Store Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isFullSubmitting ? "2px solid var(--rv-primary)" : "1px solid var(--rv-border)",
                background: isFullSubmitting ? "rgba(37, 99, 235, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <SaveIcon size={16} style={{ color: "var(--rv-primary)" }} />
                    <strong style={{ fontSize: "14px" }}>Full Store Backup</strong>
                  </div>
                  {isFullSubmitting && (
                    <span className="rv-badge rv-badge-primary rv-badge-sm" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Complete snapshot of Products, Themes, Collections, Pages, and Blogs.
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupFull" />
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached}
                  className="rv-btn rv-btn-primary rv-btn-sm"
                  style={{ width: "100%" }}
                >
                  {isFullSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Full Store...
                    </span>
                  ) : (
                    "Backup Full Store"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 2. Full Theme Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isThemeSubmitting ? "2px solid #8b5cf6" : "1px solid var(--rv-border)",
                background: isThemeSubmitting ? "rgba(139, 92, 246, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <FileCodeIcon size={16} style={{ color: "#8b5cf6" }} />
                    <strong style={{ fontSize: "14px" }}>Full Theme Backup</strong>
                  </div>
                  {isThemeSubmitting ? (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#ede9fe", color: "#6d28d9", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  ) : (
                    !hasThemeAccess && <span className="rv-badge rv-badge-warning rv-badge-sm">Business+</span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Liquid templates, JSON configs, layouts, and theme assets.
                </p>
                {themes.length > 1 && (
                  <div style={{ marginTop: "8px" }}>
                    <select
                      className="rv-input"
                      style={{ fontSize: "12px", padding: "4px 8px" }}
                      value={selectedThemeId}
                      onChange={(e) => setSelectedThemeId(e.target.value)}
                      disabled={isAnySubmitting}
                    >
                      {themes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} {t.role === "MAIN" ? "(Active)" : `(${t.role})`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupTheme" />
                {selectedThemeId && <input type="hidden" name="themeId" value={selectedThemeId} />}
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached || !hasThemeAccess}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  style={{ width: "100%", borderColor: isThemeSubmitting ? "#8b5cf6" : undefined, color: isThemeSubmitting ? "#6d28d9" : undefined }}
                >
                  {isThemeSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Theme...
                    </span>
                  ) : (
                    "Backup Theme"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 3. Product Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isProductsSubmitting ? "2px solid #0ea5e9" : "1px solid var(--rv-border)",
                background: isProductsSubmitting ? "rgba(14, 165, 233, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <BoxIcon size={16} style={{ color: "#0ea5e9" }} />
                    <strong style={{ fontSize: "14px" }}>Product Backup</strong>
                  </div>
                  {isProductsSubmitting && (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#e0f2fe", color: "#0369a1", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Catalog snapshot: titles, variants, pricing, inventory rules, metafields.
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupProducts" />
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  style={{ width: "100%", borderColor: isProductsSubmitting ? "#0ea5e9" : undefined, color: isProductsSubmitting ? "#0369a1" : undefined }}
                >
                  {isProductsSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Products...
                    </span>
                  ) : (
                    "Backup Products"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 4. Collection Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isCollectionsSubmitting ? "2px solid #10b981" : "1px solid var(--rv-border)",
                background: isCollectionsSubmitting ? "rgba(16, 185, 129, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <LayersIcon size={16} style={{ color: "#10b981" }} />
                    <strong style={{ fontSize: "14px" }}>Collection Backup</strong>
                  </div>
                  {isCollectionsSubmitting && (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#d1fae5", color: "#047857", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Smart condition rules, rule sets, sorting, and manual collections.
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupCollections" />
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  style={{ width: "100%", borderColor: isCollectionsSubmitting ? "#10b981" : undefined, color: isCollectionsSubmitting ? "#047857" : undefined }}
                >
                  {isCollectionsSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Collections...
                    </span>
                  ) : (
                    "Backup Collections"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 5. Page Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isPagesSubmitting ? "2px solid #f59e0b" : "1px solid var(--rv-border)",
                background: isPagesSubmitting ? "rgba(245, 158, 11, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <FileTextIcon size={16} style={{ color: "#f59e0b" }} />
                    <strong style={{ fontSize: "14px" }}>Page Backup</strong>
                  </div>
                  {isPagesSubmitting && (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#fef3c7", color: "#b45309", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Legal policies, About/Contact pages, and navigation menus.
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupPages" />
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  style={{ width: "100%", borderColor: isPagesSubmitting ? "#f59e0b" : undefined, color: isPagesSubmitting ? "#b45309" : undefined }}
                >
                  {isPagesSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Pages...
                    </span>
                  ) : (
                    "Backup Pages"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 6. Blog Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isBlogsSubmitting ? "2px solid #ec4899" : "1px solid var(--rv-border)",
                background: isBlogsSubmitting ? "rgba(236, 72, 153, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <BookOpenIcon size={16} style={{ color: "#ec4899" }} />
                    <strong style={{ fontSize: "14px" }}>Blog Backup</strong>
                  </div>
                  {isBlogsSubmitting && (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#fce7f3", color: "#be185d", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Articles, authors, tags, excerpts, images, and HTML content.
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupBlogs" />
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  style={{ width: "100%", borderColor: isBlogsSubmitting ? "#ec4899" : undefined, color: isBlogsSubmitting ? "#be185d" : undefined }}
                >
                  {isBlogsSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Blogs...
                    </span>
                  ) : (
                    "Backup Blogs"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 7. Navigation Menu Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isMenusSubmitting ? "2px solid #6366f1" : "1px solid var(--rv-border)",
                background: isMenusSubmitting ? "rgba(99, 102, 241, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <ZapIcon size={16} style={{ color: "#6366f1" }} />
                    <strong style={{ fontSize: "14px" }}>Navigation Menu Backup</strong>
                  </div>
                  {isMenusSubmitting && (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#e0e7ff", color: "#4338ca", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Header, footer and custom menus: titles, links, and nested item hierarchy.
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupMenus" />
                <button
                  type="submit"
                  disabled={isAnySubmitting || isLimitReached}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  style={{ width: "100%", borderColor: isMenusSubmitting ? "#6366f1" : undefined, color: isMenusSubmitting ? "#4338ca" : undefined }}
                >
                  {isMenusSubmitting ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <SparklesIcon size={14} className="rv-spin" /> Backing up Menus...
                    </span>
                  ) : (
                    "Backup Menus"
                  )}
                </button>
              </fetcher.Form>
            </div>

            {/* 8. Metafield Backup */}
            <div
              className="rv-toggle-card"
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                border: isMetafieldsSubmitting ? "2px solid #14b8a6" : "1px solid var(--rv-border)",
                background: isMetafieldsSubmitting ? "rgba(20, 184, 166, 0.04)" : undefined,
                transition: "all 0.2s ease",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <DatabaseIcon size={16} style={{ color: "#14b8a6" }} />
                    <strong style={{ fontSize: "14px" }}>Metafield Backup</strong>
                  </div>
                  {isMetafieldsSubmitting ? (
                    <span className="rv-badge rv-badge-sm" style={{ background: "#ccfbf1", color: "#0f766e", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <SparklesIcon size={10} className="rv-spin" /> Running...
                    </span>
                  ) : hasMetafieldAccess ? (
                    <span className="rv-badge rv-badge-success rv-badge-sm">Featured</span>
                  ) : (
                    <span className="rv-badge rv-badge-warning rv-badge-sm">Growth+</span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  {hasMetafieldAccess
                    ? "Shop, product, collection, page, blog and article metafields, plus their definitions."
                    : "Custom metafields and definitions across your store. Requires Growth or higher."}
                </p>
              </div>
              <fetcher.Form method="POST" style={{ marginTop: "12px" }}>
                <input type="hidden" name="intent" value="backupMetafields" />
                {hasMetafieldAccess ? (
                  <button
                    type="submit"
                    disabled={isAnySubmitting || isLimitReached}
                    className="rv-btn rv-btn-secondary rv-btn-sm"
                    style={{ width: "100%", borderColor: isMetafieldsSubmitting ? "#14b8a6" : undefined, color: isMetafieldsSubmitting ? "#0f766e" : undefined }}
                  >
                    {isMetafieldsSubmitting ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <SparklesIcon size={14} className="rv-spin" /> Backing up Metafields...
                      </span>
                    ) : (
                      "Backup Metafields"
                    )}
                  </button>
                ) : (
                  <Link to="/app/plan" className="rv-btn rv-btn-secondary rv-btn-sm" style={{ width: "100%", justifyContent: "center" }}>
                    Upgrade to Unlock
                  </Link>
                )}
              </fetcher.Form>
            </div>
          </div>
        </div>
      </div>

      {/* ── Create Restore Point Form Card ── */}
      {showCreateForm && (
        <div className="rv-card" style={{ border: "2px solid var(--rv-primary)", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-primary-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "var(--rv-primary-text)" }}>
              <SparklesIcon size={18} />
              <span>Capture Custom Store Restore Point</span>
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

                  <div className={`rv-toggle-card ${components.menus ? "rv-toggle-card-active" : ""}`}>
                    <input
                      id="chk-menus"
                      type="checkbox"
                      name="includeMenus"
                      checked={components.menus}
                      onChange={(e) => setComponents((prev) => ({ ...prev, menus: e.target.checked }))}
                      value="1"
                      style={{ marginTop: "3px", cursor: "pointer" }}
                    />
                    <label htmlFor="chk-menus" style={{ cursor: "pointer", flexGrow: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <ZapIcon size={15} style={{ color: "var(--rv-primary)" }} />
                        <strong style={{ fontSize: "13px" }}>Navigation Menus</strong>
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Menu Trees &amp; Links</span>
                    </label>
                  </div>

                  <div
                    className={`rv-toggle-card ${hasMetafieldAccess && components.metafields ? "rv-toggle-card-active" : ""}`}
                    style={{ opacity: hasMetafieldAccess ? 1 : 0.65, cursor: hasMetafieldAccess ? "pointer" : "not-allowed" }}
                  >
                    <input
                      id="chk-metafields"
                      type="checkbox"
                      name="includeMetafields"
                      checked={hasMetafieldAccess && components.metafields}
                      onChange={(e) => hasMetafieldAccess && setComponents((prev) => ({ ...prev, metafields: e.target.checked }))}
                      disabled={!hasMetafieldAccess}
                      value="1"
                      style={{ marginTop: "3px", cursor: hasMetafieldAccess ? "pointer" : "not-allowed" }}
                    />
                    <label htmlFor="chk-metafields" style={{ cursor: hasMetafieldAccess ? "pointer" : "not-allowed", flexGrow: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <DatabaseIcon size={15} style={{ color: "var(--rv-primary)" }} />
                        <strong style={{ fontSize: "13px" }}>Metafields</strong>
                        {hasMetafieldAccess ? (
                          <span className="rv-badge rv-badge-success rv-badge-sm">Featured</span>
                        ) : (
                          <span className="rv-badge rv-badge-warning rv-badge-sm">Growth+</span>
                        )}
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>
                        {hasMetafieldAccess ? "Values & Definitions" : "Requires Growth or higher"}
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px", paddingTop: "8px", borderTop: "1px solid var(--rv-border)" }}>
                <button
                  type="submit"
                  disabled={isAnySubmitting}
                  className="rv-btn rv-btn-primary rv-btn-lg"
                >
                  <SaveIcon size={16} />
                  <span>{isCustomSubmitting ? "Capturing Snapshot..." : "Capture Restore Point Now"}</span>
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

      {/* ── Filter Tabs Bar ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {[
            { id: "ALL", label: `All (${counts.all})` },
            { id: "FULL", label: `Full Store (${counts.full})` },
            { id: "THEMES", label: `Themes (${counts.themes})` },
            { id: "PRODUCTS", label: `Products (${counts.products})` },
            { id: "COLLECTIONS", label: `Collections (${counts.collections})` },
            { id: "PAGES", label: `Pages (${counts.pages})` },
            { id: "BLOGS", label: `Blogs (${counts.blogs})` },
            { id: "MENUS", label: `Menus (${counts.menus})` },
            { id: "METAFIELDS", label: `Metafields (${counts.metafields})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setFilterType(tab.id);
                setCurrentPage(1);
              }}
              className={`rv-btn rv-btn-sm ${filterType === tab.id ? "rv-btn-primary" : "rv-btn-secondary"}`}
              style={{ borderRadius: "20px" }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <Link to="/app/import-export" style={{ fontSize: "13px", fontWeight: 600, color: "var(--rv-primary)", textDecoration: "none", display: "flex", alignItems: "center", gap: "4px" }}>
          <UploadIcon size={14} />
          <span>Go to Import &amp; Export Hub</span>
        </Link>
      </div>

      {/* ── Restore Points List / Empty State ── */}
      {filteredRestorePoints.length === 0 ? (
        <EmptyState
          icon={<SaveIcon size={26} style={{ color: "var(--rv-primary)" }} />}
          title={filterType === "ALL" ? "No Restore Points Created Yet" : `No ${filterType} Backups Found`}
          description={
            filterType === "ALL"
              ? "Create snapshot restore points before running bulk discounts, editing theme code, or running third-party CSV imports. You can revert individual files or your entire catalog with 1 click."
              : `You haven't captured any ${filterType.toLowerCase()} backups yet. Use the 1-click backup options above to capture one now.`
          }
          action={
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="rv-btn rv-btn-primary"
            >
              <SaveIcon size={15} />
              <span>Create Snapshot</span>
            </button>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {paginatedRestorePoints.map((rp) => (
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
                    {rp.backupType && (
                      <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ fontWeight: 600 }}>
                        {rp.backupType === "FULL"
                          ? "Full Store"
                          : rp.backupType === "THEMES"
                          ? "Theme Backup"
                          : rp.backupType === "PRODUCTS"
                          ? "Product Backup"
                          : rp.backupType === "COLLECTIONS"
                          ? "Collection Backup"
                          : rp.backupType === "PAGES"
                          ? "Page Backup"
                          : rp.backupType === "BLOGS"
                          ? "Blog Backup"
                          : rp.backupType === "MENUS"
                          ? "Navigation Menu Backup"
                          : rp.backupType === "METAFIELDS"
                          ? "Metafield Backup"
                          : rp.backupType}
                      </span>
                    )}
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
                    {rp.menuCount > 0 && (
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">{rp.menuCount} Menus</span>
                    )}
                    {rp.articleCount > 0 && (
                      <span className="rv-badge rv-badge-success rv-badge-sm">{rp.articleCount} Articles</span>
                    )}
                    {rp.metafieldCount > 0 && (
                      <span className="rv-badge rv-badge-info rv-badge-sm">{rp.metafieldCount} Metafields</span>
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
                    const isThisSyncing = isAnySubmitting && activeIntent === "syncToCloud" && fetcher.formData?.get("rpId") === String(rp.id);
                    return (
                      <fetcher.Form method="POST" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="syncToCloud" />
                        <input type="hidden" name="rpId" value={rp.id} />
                        <button
                          type="submit"
                          disabled={isAnySubmitting}
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

          {/* ── Pagination Controls ── */}
          <Pagination
            currentPage={validPage}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
            itemLabel="restore points"
          />
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
