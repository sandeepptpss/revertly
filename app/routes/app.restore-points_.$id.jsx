import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useFetcher, useRouteError, redirect, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rollbackProductFields } from "../monitor.server.js";
import {
  restoreThemeFilesWithSafety,
  restoreCollection,
  restorePage,
  restoreMenu,
  restoreArticle,
  restoreProductMetafields,
  isReservedNamespace,
  restoreMetafieldBackup,
  METAFIELD_RESTORE_MODES,
  computeDiffLines,
  fetchThemeBackup,
  readThemeFileBody,
} from "../backup.server.js";
import { checkFeatureAccess, checkThemeAccess } from "../billing.server.js";
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
  DatabaseIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { PillNav } from "../components/PillNav.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import SafeRestoreModal from "../components/SafeRestoreModal.jsx";

const cleanId = (val) => String(val || "").replace("gid://shopify/Product/", "").trim();

function toVariantArray(val) {
  if (Array.isArray(val)) return val;
  if (Array.isArray(val?.nodes)) return val.nodes;
  if (Array.isArray(val?.edges)) return val.edges.map((e) => e?.node).filter(Boolean);
  return [];
}

function toMetafieldArray(val) {
  if (Array.isArray(val)) return val;
  if (Array.isArray(val?.nodes)) return val.nodes;
  if (Array.isArray(val?.edges)) return val.edges.map((e) => e?.node).filter(Boolean);
  return [];
}

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
    : Array.isArray(restorePoint.snapshotData?.products)
    ? restorePoint.snapshotData.products
    : [];

  // Find differences
  const currentMap = {};
  for (const s of currentSnapshots) {
    if (s.productId) {
      currentMap[s.productId] = s.snapshotData;
      currentMap[cleanId(s.productId)] = s.snapshotData;
    }
  }

  const differences = [];
  for (const saved of savedProducts) {
    const rawId = saved.productId || saved.id;
    const current = currentMap[rawId] || currentMap[cleanId(rawId)];
    if (!current) continue;

    const fieldDiffs = [];
    const fieldKeys = ["title", "status", "vendor", "tags", "handle", "bodyHtml", "templateSuffix"];
    for (const key of fieldKeys) {
      const sv = String(saved.snapshotData?.[key] ?? saved[key] ?? "");
      const cv = String(current[key] ?? "");
      if (sv !== cv) {
        if (key === "bodyHtml") {
          fieldDiffs.push({
            field: "description",
            saved: sv ? sv.replace(/<[^>]*>/g, "").slice(0, 80) + (sv.length > 80 ? "..." : "") : "(empty)",
            current: cv ? cv.replace(/<[^>]*>/g, "").slice(0, 80) + (cv.length > 80 ? "..." : "") : "(empty)",
          });
        } else if (key === "templateSuffix") {
          fieldDiffs.push({
            field: "template",
            saved: sv || "Default",
            current: cv || "Default",
          });
        } else {
          fieldDiffs.push({ field: key, saved: sv, current: cv });
        }
      }
    }

    // Check variants
    const savedVariants = toVariantArray(saved.snapshotData?.variants ?? saved.variants);
    const currentVariants = toVariantArray(current?.variants);
    for (const sv of savedVariants) {
      const cv = currentVariants.find((v) => v && (v.id === sv.id || cleanId(v.id) === cleanId(sv.id)));
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
    const savedMetafields = toMetafieldArray(saved.snapshotData?.metafields ?? saved.metafields);
    const currentMetafields = toMetafieldArray(current?.metafields);
    for (const sm of savedMetafields) {
      const cm = currentMetafields.find((m) => m && m.namespace === sm.namespace && m.key === sm.key);
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
        productId: rawId,
        title: saved.snapshotData?.title || saved.title || rawId,
        diffs: fieldDiffs,
      });
    }
  }

  const themeData = restorePoint.themeData || null;
  const collectionData = Array.isArray(restorePoint.collectionData) ? restorePoint.collectionData : [];
  const pageData = Array.isArray(restorePoint.pageData) ? restorePoint.pageData : [];
  const menuData = Array.isArray(restorePoint.menuData) ? restorePoint.menuData : [];
  const articleData = restorePoint.articleData || { blogs: [], articles: [] };
  const metafieldData = restorePoint.metafieldData || null;

  let themeDiffFiles = [];
  if (Array.isArray(themeData?.files) && themeData.files.length > 0) {
    let currentLiveFiles = [];
    try {
      const liveTheme = await fetchThemeBackup(admin);
      currentLiveFiles = Array.isArray(liveTheme?.files) ? liveTheme.files : [];
    } catch (e) {
      console.warn("Could not fetch live theme files for diffing:", e?.message);
    }

    // Both sides go through the shared reader: a snapshot that stored files in
    // Shopify's raw `body { content }` shape would otherwise diff as empty, and
    // every file would be reported as wholly rewritten.
    const liveMap = Object.fromEntries(
      currentLiveFiles.map((lf) => [lf.filename || lf.key || "", readThemeFileBody(lf)?.content ?? ""])
    );

    themeDiffFiles = themeData.files.map((f) => {
      const filename = f?.filename || f?.key || "";
      const content = readThemeFileBody(f)?.content ?? "";
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

  // Entitlement is re-read here rather than assumed from the snapshot: a store
  // can capture metafields on Growth and later downgrade, and the snapshot
  // outlives the subscription.
  const metafieldAccess = await checkFeatureAccess(shop, "metafieldBackup");

  return {
    restorePoint,
    hasMetafieldAccess: metafieldAccess.allowed,
    savedCount: savedProducts.length,
    differences,
    lastJob: restorePoint.rollbackJobs[0] || null,
    themeData,
    themeDiffFiles,
    collectionData,
    pageData,
    menuData,
    articleData,
    metafieldData,
    cloudSyncConfig: {
      connected: Boolean(settings?.cloudSyncConnected),
      provider: settings?.cloudSyncProvider || "NONE",
      folder: settings?.cloudSyncFolder || "Revertly_Backups",
    },
  };
};

/**
 * Renders one entry from `restoreMetafieldBackup`'s `summary.errors`.
 *
 * Those entries are objects ({ownerType, namespace, key, reason, message}), so
 * interpolating them straight into a string wrote the literal text
 * "[object Object]" into every RollbackResult row — leaving a merchant with a
 * failed metafield restore and no way to tell which metafield failed or why.
 */
export function formatMetafieldError(err) {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return "Unknown metafield error";

  const target = [err.ownerType, [err.namespace, err.key].filter(Boolean).join(".")]
    .filter(Boolean)
    .join(" ");
  const reason = err.reason ? ` (${err.reason})` : "";
  const message = err.message || "Unknown metafield error";

  return target ? `${target}${reason}: ${message}` : `${message}${reason}`;
}

async function recordRestoreRollbackJob({
  shop,
  restorePointId,
  resourceType,
  totalItems = 0,
  successCount = 0,
  failedCount = 0,
  startTime = new Date(),
  results = [],
}) {
  try {
    const finalStatus =
      failedCount > 0 && successCount > 0
        ? "PARTIAL"
        : failedCount > 0 && successCount === 0
        ? "FAILED"
        : "COMPLETED";

    const job = await prisma.rollbackJob.create({
      data: {
        shop,
        restorePointId,
        status: finalStatus,
        totalProducts: Math.max(totalItems, successCount + failedCount, results?.length || 0, 1),
        processedCount: successCount + failedCount,
        successCount,
        failedCount,
        fieldsToRestore: {
          resourceType,
          durationMs: Math.max(0, new Date().getTime() - new Date(startTime).getTime()),
        },
        createdAt: startTime,
        completedAt: new Date(),
      },
    });

    if (results && results.length > 0) {
      await prisma.rollbackResult.createMany({
        data: results.map((r) => ({
          rollbackJobId: job.id,
          productId: String(r.productId || r.id || "item"),
          productTitle: String(r.productTitle || r.title || r.name || "Item"),
          status: r.status || "SUCCESS",
          errorMessage: r.errorMessage || null,
          restoredFields: r.restoredFields || null,
        })),
      });
    }

    return job;
  } catch (err) {
    console.error("recordRestoreRollbackJob error:", err);
    return null;
  }
}

export const action = async ({ request, params }) => {
  // Tracked outside the try so a throw mid-restore can clear the RESTORING /
  // RUNNING states. Without this both records stay stuck in-flight forever and
  // the restore point can never be used again.
  let inFlightRestore = null;
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
      const themeAccess = await checkThemeAccess(shop);
      if (!themeAccess.allowed) {
        return { success: false, message: "Theme restoration requires a Growth, Business or Enterprise plan." };
      }

      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const themeData = restorePoint?.themeData;
      if (!themeData || !themeData.activeTheme || !themeData.files?.length) {
        return { success: false, message: "No backed-up theme files available in this restore point." };
      }

      const mode = formData.get("mode") || "live";

      // A live restore writes into the captured theme itself. Growth covers
      // the live theme only, so on a capped plan that target has to be the
      // published theme right now — a snapshot of a draft (taken on Business
      // before a downgrade) or of a theme since unpublished is a draft-theme
      // rollback. Restoring to a new draft copy stays available. As with the
      // backup gate, a role that cannot be confirmed is refused, not assumed.
      if (mode !== "draft" && !themeAccess.unlimitedThemes) {
        let role = null;
        try {
          const themeRes = await admin.graphql(
            `#graphql
            query checkRestoreThemeRole($id: ID!) {
              theme(id: $id) {
                id
                role
              }
            }`,
            { variables: { id: themeData.activeTheme.id } },
          );
          role = (await themeRes.json()).data?.theme?.role ?? null;
        } catch (err) {
          console.warn(`[Revertly] Theme role lookup failed for ${shop}: ${err?.message}`);
        }
        if (role !== "MAIN") {
          return {
            success: false,
            message:
              role === null
                ? "We could not confirm this snapshot's theme is your live theme, so nothing was restored. Try again, or use Restore to Draft Theme."
                : "This snapshot is of a theme that is not currently live. Your plan restores your live theme; use Restore to Draft Theme to review it, or upgrade to Business for draft theme rollback.",
          };
        }
      }
      const selectedFilesRaw = formData.get("selectedFiles");
      let selectedFilenames = null;
      if (selectedFilesRaw) {
        try {
          selectedFilenames = JSON.parse(selectedFilesRaw);
        } catch (e) {
          selectedFilenames = selectedFilesRaw.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }

      const appOrigin = new URL(request.url).origin;
      const startTime = new Date();
      const res = await restoreThemeFilesWithSafety({
        admin,
        session,
        shop,
        themeId: themeData.activeTheme.id,
        themeName: themeData.activeTheme.name,
        files: themeData.files,
        selectedFilenames,
        mode,
        appOrigin,
      });

      const filesCount = res.filesRestored || (selectedFilenames ? selectedFilenames.length : themeData.files.length);
      const isSuccess = Boolean(res?.success);
      const targetFiles = selectedFilenames && selectedFilenames.length > 0
        ? themeData.files.filter((f) => selectedFilenames.includes(f.filename))
        : themeData.files;

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "THEMES",
        totalItems: filesCount,
        successCount: isSuccess ? filesCount : 0,
        failedCount: isSuccess ? 0 : filesCount,
        startTime,
        results: (targetFiles || []).map((f) => ({
          productId: f.filename,
          productTitle: `Theme File: ${f.filename}`,
          status: isSuccess ? "SUCCESS" : "FAILED",
          errorMessage: isSuccess ? null : res?.message || "Restore failed",
        })),
      });

      if (res?.success) {
        await logAudit(shop, restorePerm.actor, "THEME_RESTORED", {
          resourceType: "Theme",
          resourceId: themeData.activeTheme.id,
          details: {
            themeName: themeData.activeTheme.name,
            mode,
            filesRestored: filesCount,
          },
          request,
        });
      }

      return res;
    }

    if (intent === "restore_collection") {
      const colIndex = parseInt(formData.get("colIndex"), 10);
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const cols = Array.isArray(restorePoint?.collectionData) ? restorePoint.collectionData : [];
      const target = cols[colIndex];
      if (!target) return { success: false, message: "Collection not found in snapshot." };
      const startTime = new Date();
      const res = await restoreCollection(admin, target);

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "COLLECTIONS",
        totalItems: 1,
        successCount: res.success ? 1 : 0,
        failedCount: res.success ? 0 : 1,
        startTime,
        results: [{
          productId: target.id || String(colIndex),
          productTitle: `Collection: ${target.title}`,
          status: res.success ? "SUCCESS" : "FAILED",
          errorMessage: res.message || res.error || (res.success ? null : "Failed to restore collection"),
        }],
      });

      if (res.success) {
        await logAudit(shop, restorePerm.actor, "COLLECTION_RESTORED", {
          resourceType: "Collection",
          resourceId: target.id || String(colIndex),
          details: { title: target.title, handle: target.handle },
          request,
        });
        return { success: true, message: `Collection "${target.title}" successfully restored.` };
      }
      return res;
    }

    if (intent === "restore_page") {
      const pageIndex = parseInt(formData.get("pageIndex"), 10);
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const pages = Array.isArray(restorePoint?.pageData) ? restorePoint.pageData : [];
      const target = pages[pageIndex];
      if (!target) return { success: false, message: "Page not found in snapshot." };
      const startTime = new Date();
      const res = await restorePage(admin, target);

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "PAGES",
        totalItems: 1,
        successCount: res.success ? 1 : 0,
        failedCount: res.success ? 0 : 1,
        startTime,
        results: [{
          productId: target.id || String(pageIndex),
          productTitle: `Page: ${target.title}`,
          status: res.success ? "SUCCESS" : "FAILED",
          errorMessage: res.message || res.error || (res.success ? null : "Failed to restore page"),
        }],
      });

      if (res.success) {
        await logAudit(shop, restorePerm.actor, "PAGE_RESTORED", {
          resourceType: "Page",
          resourceId: target.id || String(pageIndex),
          details: { title: target.title, handle: target.handle },
          request,
        });
        return { success: true, message: `Page "${target.title}" successfully restored.` };
      }
      return res;
    }

    if (intent === "restore_article") {
      const articleIndex = parseInt(formData.get("articleIndex"), 10);
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const articles = restorePoint?.articleData?.articles || [];
      const target = articles[articleIndex];
      if (!target) return { success: false, message: "Article not found in snapshot." };
      const startTime = new Date();
      const res = await restoreArticle(admin, target);

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "BLOGS",
        totalItems: 1,
        successCount: res?.success ? 1 : 0,
        failedCount: res?.success ? 0 : 1,
        startTime,
        results: [{
          productId: target.id || String(articleIndex),
          productTitle: `Article: ${target.title}`,
          status: res?.success ? "SUCCESS" : "FAILED",
          errorMessage: res?.message || res?.error || (res?.success ? null : "Failed to restore article"),
        }],
      });

      if (res?.success) {
        await logAudit(shop, restorePerm.actor, "ARTICLE_RESTORED", {
          resourceType: "Article",
          resourceId: target.id || String(articleIndex),
          details: { title: target.title },
          request,
        });
      }
      return res;
    }

    if (intent === "restore_all_collections") {
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const cols = Array.isArray(restorePoint?.collectionData) ? restorePoint.collectionData : [];
      if (cols.length === 0) return { success: false, message: "No collections found in snapshot." };
      const startTime = new Date();
      let successCount = 0;
      let failedCount = 0;
      const results = [];
      for (const target of cols) {
        const res = await restoreCollection(admin, target);
        if (res.success) {
          successCount++;
        } else {
          failedCount++;
        }
        results.push({
          productId: target.id || target.handle || "collection",
          productTitle: `Collection: ${target.title}`,
          status: res.success ? "SUCCESS" : "FAILED",
          errorMessage: res.message || res.error || null,
        });
      }

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "COLLECTIONS",
        totalItems: cols.length,
        successCount,
        failedCount,
        startTime,
        results,
      });

      await logAudit(shop, restorePerm.actor, "COLLECTIONS_BULK_RESTORED", {
        resourceType: "Collection",
        resourceId: String(rpId),
        details: { total: cols.length, successCount, failedCount },
        request,
      });

      if (failedCount === 0) {
        return {
          success: true,
          message: `All ${successCount} collections successfully restored.`,
        };
      } else if (successCount > 0) {
        return {
          success: false,
          isPartial: true,
          message: `Restored ${successCount} collections, but ${failedCount} collection(s) failed.`,
        };
      } else {
        return {
          success: false,
          message: `Failed to restore collections (${failedCount} failed).`,
        };
      }
    }

    if (intent === "restore_all_pages") {
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const pages = Array.isArray(restorePoint?.pageData) ? restorePoint.pageData : [];
      if (pages.length === 0) return { success: false, message: "No pages found in snapshot." };
      const startTime = new Date();
      let successCount = 0;
      let failedCount = 0;
      const results = [];
      for (const target of pages) {
        const res = await restorePage(admin, target);
        if (res.success) {
          successCount++;
        } else {
          failedCount++;
        }
        results.push({
          productId: target.id || target.handle || "page",
          productTitle: `Page: ${target.title}`,
          status: res.success ? "SUCCESS" : "FAILED",
          errorMessage: res.message || res.error || null,
        });
      }

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "PAGES",
        totalItems: pages.length,
        successCount,
        failedCount,
        startTime,
        results,
      });

      await logAudit(shop, restorePerm.actor, "PAGES_BULK_RESTORED", {
        resourceType: "Page",
        resourceId: String(rpId),
        details: { total: pages.length, successCount, failedCount },
        request,
      });

      if (failedCount === 0) {
        return {
          success: true,
          message: `All ${successCount} pages successfully restored.`,
        };
      } else if (successCount > 0) {
        return {
          success: false,
          isPartial: true,
          message: `Restored ${successCount} pages, but ${failedCount} page(s) failed.`,
        };
      } else {
        return {
          success: false,
          message: `Failed to restore pages (${failedCount} failed).`,
        };
      }
    }

    if (intent === "restore_menu") {
      const menuIndex = parseInt(formData.get("menuIndex"), 10);
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const menus = Array.isArray(restorePoint?.menuData) ? restorePoint.menuData : [];
      const target = menus[menuIndex];
      if (!target) return { success: false, message: "Navigation menu not found in snapshot." };
      const startTime = new Date();
      const res = await restoreMenu(admin, target);

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "MENUS",
        totalItems: 1,
        successCount: res.success ? 1 : 0,
        failedCount: res.success ? 0 : 1,
        startTime,
        results: [{
          productId: target.id || String(menuIndex),
          productTitle: `Menu: ${target.title}`,
          status: res.success ? "SUCCESS" : "FAILED",
          errorMessage: res.message || res.error || (res.success ? null : "Failed to restore menu"),
        }],
      });

      if (res.success) {
        await logAudit(shop, restorePerm.actor, "MENU_RESTORED", {
          resourceType: "Menu",
          resourceId: target.id || String(menuIndex),
          details: { title: target.title, handle: target.handle },
          request,
        });
        return { success: true, message: `Navigation menu "${target.title}" successfully restored.` };
      }
      return res;
    }

    if (intent === "restore_all_menus") {
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const menus = Array.isArray(restorePoint?.menuData) ? restorePoint.menuData : [];
      if (menus.length === 0) return { success: false, message: "No navigation menus found in snapshot." };
      const startTime = new Date();
      let successCount = 0;
      let failedCount = 0;
      const results = [];
      for (const target of menus) {
        const res = await restoreMenu(admin, target);
        if (res.success) {
          successCount++;
        } else {
          failedCount++;
        }
        results.push({
          productId: target.id || target.handle || "menu",
          productTitle: `Menu: ${target.title}`,
          status: res.success ? "SUCCESS" : "FAILED",
          errorMessage: res.message || res.error || null,
        });
      }

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "MENUS",
        totalItems: menus.length,
        successCount,
        failedCount,
        startTime,
        results,
      });

      await logAudit(shop, restorePerm.actor, "MENUS_BULK_RESTORED", {
        resourceType: "Menu",
        resourceId: String(rpId),
        details: { total: menus.length, successCount, failedCount },
        request,
      });

      if (failedCount === 0) {
        return {
          success: true,
          message: `All ${successCount} navigation menus successfully restored to Shopify.`,
        };
      } else if (successCount > 0) {
        return {
          success: false,
          isPartial: true,
          message: `Restored ${successCount} menus, but ${failedCount} menu(s) failed. Check details in Rollback History.`,
        };
      } else {
        return {
          success: false,
          message: `Failed to restore navigation menus (${failedCount} failed).`,
        };
      }
    }

    if (intent === "restore_metafields" || intent === "restore_metafield_definitions") {
      // Entitlement is enforced at restore time as well as at backup time —
      // a downgraded store must not be able to replay a Growth-era snapshot.
      const metafieldAccess = await checkFeatureAccess(shop, "metafieldBackup");
      if (!metafieldAccess.allowed) {
        return {
          success: false,
          message: "Metafield restore requires a Growth plan or higher. Upgrade in Plans & Billing to restore metafields.",
        };
      }

      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const metafieldData = restorePoint?.metafieldData || null;
      if (!metafieldData) {
        return { success: false, message: "No metafield backup found in this snapshot." };
      }

      const requestedMode = formData.get("metafieldMode");
      const mode = METAFIELD_RESTORE_MODES.includes(requestedMode) ? requestedMode : "SKIP_EXISTING";
      const definitionsOnly = intent === "restore_metafield_definitions";
      const startTime = new Date();

      const res = await restoreMetafieldBackup(admin, shop, metafieldData, {
        mode,
        includeDefinitions: true,
        includeValues: !definitionsOnly,
      });

      const writtenCount =
        (res.summary?.metafieldsWritten || 0) +
        (res.summary?.definitionsUpdated || 0) +
        (res.summary?.definitionsCreated || 0);
      const failCount = (res.summary?.failed || 0) + (res.summary?.definitionsFailed || 0);
      const results = [];
      if (res.summary?.definitionsUpdated > 0 || res.summary?.definitionsCreated > 0) {
        results.push({
          productId: "metafield_definitions",
          productTitle: `Metafield Definitions (${(res.summary?.definitionsCreated || 0) + (res.summary?.definitionsUpdated || 0)} applied)`,
          status: "SUCCESS",
        });
      }
      if (res.summary?.metafieldsWritten > 0) {
        results.push({
          productId: "metafield_values",
          productTitle: `Metafield Values (${res.summary.metafieldsWritten} values restored)`,
          status: "SUCCESS",
        });
      }
      if (res.summary?.errors?.length > 0) {
        res.summary.errors.slice(0, 20).forEach((e, idx) => {
          const detail = formatMetafieldError(e);
          results.push({
            productId: `metafield_err_${idx}`,
            productTitle: `Metafield Notice: ${detail.slice(0, 120)}`,
            status: "FAILED",
            errorMessage: detail,
          });
        });
      }

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "METAFIELDS",
        totalItems: writtenCount + failCount || 1,
        successCount: writtenCount,
        failedCount: failCount,
        startTime,
        results,
      });

      await logAudit(shop, restorePerm.actor, "METAFIELDS_RESTORED", {
        resourceType: "Metafield",
        resourceId: String(rpId),
        details: { mode, definitionsOnly, summary: res.summary },
        request,
      });

      return res;
    }

    if (intent === "restore_all_articles") {
      const restorePoint = await prisma.restorePoint.findFirst({
        where: { id: rpId, shop },
      });
      const articles = restorePoint?.articleData?.articles || [];
      if (articles.length === 0) return { success: false, message: "No articles found in snapshot." };
      const startTime = new Date();
      let successCount = 0;
      let failedCount = 0;
      const results = [];
      for (const target of articles) {
        const res = await restoreArticle(admin, target);
        if (res?.success) {
          successCount++;
        } else {
          failedCount++;
        }
        results.push({
          productId: target.id || String(target.title),
          productTitle: `Article: ${target.title}`,
          status: res?.success ? "SUCCESS" : "FAILED",
          errorMessage: res?.message || res?.error || null,
        });
      }

      await recordRestoreRollbackJob({
        shop,
        restorePointId: rpId,
        resourceType: "BLOGS",
        totalItems: articles.length,
        successCount,
        failedCount,
        startTime,
        results,
      });

      await logAudit(shop, restorePerm.actor, "ARTICLES_BULK_RESTORED", {
        resourceType: "Article",
        resourceId: String(rpId),
        details: { total: articles.length, successCount, failedCount },
        request,
      });

      if (failedCount === 0) {
        return {
          success: true,
          message: `All ${successCount} articles successfully restored.`,
        };
      } else if (successCount > 0) {
        return {
          success: false,
          isPartial: true,
          message: `Restored ${successCount} articles, but ${failedCount} article(s) failed.`,
        };
      } else {
        return {
          success: false,
          message: `Failed to restore articles (${failedCount} failed).`,
        };
      }
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

    const cleanId = (val) => String(val || "").replace("gid://shopify/Product/", "").trim();

    let targetProducts = allSavedProducts;
    if (intent === "restore_single_product") {
      const targetProductId = cleanId(formData.get("productId"));
      targetProducts = allSavedProducts.filter(
        (s) => cleanId(s.productId || s.id || s.snapshotData?.id) === targetProductId
      );
      if (targetProducts.length === 0) {
        return { success: false, message: `Product #${targetProductId} not found in restore point snapshot.` };
      }
    } else if (intent === "restore_selected_products") {
      const selectedRaw = formData.get("selectedProductIds") || "";
      const selectedIds = new Set(selectedRaw.split(",").map(cleanId).filter(Boolean));
      targetProducts = allSavedProducts.filter((s) =>
        selectedIds.has(cleanId(s.productId || s.id || s.snapshotData?.id))
      );
      if (targetProducts.length === 0) {
        return { success: false, message: "No matching products found for selection." };
      }
    }

    // Selective field restoration options
    const restoreTitles = formData.get("restoreTitles") !== "false";
    const restoreDescriptions = formData.get("restoreDescriptions") !== "false";
    const restorePrices = formData.get("restorePrices") !== "false";
    const restoreTags = formData.get("restoreTags") !== "false";
    const restoreStatus = formData.get("restoreStatus") !== "false";

    // Get current snapshots
    const currentSnapshots = await prisma.productSnapshot.findMany({
      where: { shop },
      select: { productId: true, snapshotData: true },
    });
    const currentMap = {};
    for (const s of currentSnapshots) {
      if (s.productId) {
        currentMap[s.productId] = s.snapshotData;
        currentMap[cleanId(s.productId)] = s.snapshotData;
        currentMap[`gid://shopify/Product/${cleanId(s.productId)}`] = s.snapshotData;
      }
    }

    const job = await prisma.rollbackJob.create({
      data: {
        shop,
        restorePointId: rpId,
        status: "RUNNING",
        totalProducts: targetProducts.length,
        fieldsToRestore: {
          resourceType: "PRODUCTS",
          restoreTitles,
          restoreDescriptions,
          restorePrices,
          restoreTags,
          restoreStatus,
        },
      },
    });

    await prisma.restorePoint.update({
      where: { id: rpId },
      data: { status: "RESTORING" },
    });
    inFlightRestore = { restorePointId: rpId, jobId: job.id };

    let successCount = 0;
    let failedCount = 0;

    for (const saved of targetProducts) {
      const rawProductId = saved.productId || saved.id || saved.snapshotData?.id;
      const productId = cleanId(rawProductId);
      const savedSnap = saved.snapshotData || saved;
      const current = currentMap[productId] || currentMap[rawProductId] || currentMap[`gid://shopify/Product/${productId}`];
      if (!current) {
        await prisma.rollbackResult.create({
          data: {
            rollbackJobId: job.id,
            productId,
            productTitle: savedSnap.title || productId,
            status: "FAILED",
            errorMessage: "Product not found in current catalog baseline",
          },
        });
        failedCount++;
        continue;
      }

      const mockEvents = [];
      const fieldKeys = ["title", "status", "vendor", "tags", "handle", "bodyHtml", "templateSuffix"];
      for (const key of fieldKeys) {
        if (!restoreTitles && key === "title") continue;
        if (!restoreDescriptions && (key === "bodyHtml" || key === "descriptionHtml")) continue;
        if (!restoreStatus && key === "status") continue;
        if (!restoreTags && (key === "tags" || key === "vendor" || key === "handle")) continue;

        const sv = String(savedSnap[key] ?? "");
        const cv = String(current[key] ?? "");
        if (sv !== cv) {
          mockEvents.push({ fieldName: key, oldValue: sv, newValue: cv, variantId: null });
        }
      }

      const savedVariants = toVariantArray(savedSnap.variants);
      const currentVariants = toVariantArray(current.variants);
      for (const sv of savedVariants) {
        const cv = currentVariants.find((v) => v && (v.id === sv.id || cleanId(v.id) === cleanId(sv.id)));
        if (!cv) continue;
        const numId = String(sv.id || "").replace("gid://shopify/ProductVariant/", "");
        for (const vf of ["price", "compareAtPrice", "sku"]) {
          if (!restorePrices && (vf === "price" || vf === "compareAtPrice")) continue;
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

      // Metafields are restored separately from the field rollback below, so
      // a product whose only difference is a metafield must not be skipped
      // here — that diff is shown on the page and has to be restorable.
      const savedMf = toMetafieldArray(savedSnap.metafields);
      const metafieldKey = (list) =>
        JSON.stringify(
          list
            .filter((m) => m?.namespace && !isReservedNamespace(m.namespace))
            .map((m) => [`${m?.namespace}.${m?.key}`, String(m?.value ?? "")])
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      const metafieldsDiffer =
        savedMf.length > 0 && metafieldKey(savedMf) !== metafieldKey(toMetafieldArray(current.metafields));

      if (mockEvents.length === 0 && !metafieldsDiffer) {
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

      const result =
        tempIds.length > 0
          ? await rollbackProductFields(admin, shop, productId, tempIds)
          : { success: true, restoredFields: {} };

      // A metafield write that fails fails the product: it used to be logged
      // and dropped, so the history said SUCCESS for a value never written.
      if (metafieldsDiffer) {
        let mfRes;
        try {
          mfRes = await restoreProductMetafields(admin, productId, savedMf);
        } catch (mfErr) {
          mfRes = { success: false, message: mfErr?.message };
        }
        if (mfRes?.success) {
          result.restoredFields = { ...(result.restoredFields || {}), metafields: mfRes.count ?? savedMf.length };
        } else {
          const mfError = `Metafields not restored: ${mfRes?.message || "unknown error"}`;
          result.success = false;
          result.error = result.error ? `${result.error}; ${mfError}` : mfError;
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

    // A restore where nothing succeeded is a failure, however cleanly the loop
    // ran — reporting success would tell a merchant their store was rolled
    // back when not a single product changed.
    const anySucceeded = successCount > 0;

    if (intent === "restore_single_product") {
      return anySucceeded
        ? { success: true, message: "Product successfully restored to snapshot state." }
        : {
            success: false,
            message: "Product could not be restored. See rollback history for details.",
          };
    }

    return {
      success: anySucceeded,
      message: anySucceeded
        ? `Restored ${successCount} products successfully (${failedCount} failed).`
        : `No products could be restored (${failedCount} failed). See rollback history for details.`,
    };
  } catch (error) {
    console.error("Restore point detail action error:", error);
    if (inFlightRestore) {
      await prisma.restorePoint
        .update({ where: { id: inFlightRestore.restorePointId }, data: { status: "READY" } })
        .catch(() => {});
      await prisma.rollbackJob
        .update({
          where: { id: inFlightRestore.jobId },
          data: { status: "FAILED", completedAt: new Date() },
        })
        .catch(() => {});
    }
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
    menuData = [],
    articleData,
    metafieldData = null,
    hasMetafieldAccess = false,
  } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isRestoring = fetcher.state !== "idle";

  // fetcher.formData is gone once the action returns, so remember what was
  // submitted: the "restore completed" panel is for restores only, not for a
  // cloud sync or any other action that also returns success.
  const [submittedIntent, setSubmittedIntent] = useState(null);
  useEffect(() => {
    const intent = fetcher.formData?.get("intent");
    if (intent) setSubmittedIntent(String(intent));
  }, [fetcher.formData]);

  const filesList = themeDiffFiles?.length > 0 ? themeDiffFiles : (themeData?.files || []);

  const metafieldOwners = Array.isArray(metafieldData?.owners) ? metafieldData.owners : [];
  const metafieldValueCount = metafieldData?.counts?.metafields || 0;
  const metafieldDefinitionCount = metafieldData?.counts?.definitions || 0;
  // A snapshot with definitions but no values is still worth a tab — the
  // definitions alone are recoverable configuration.
  const metafieldTotal = metafieldValueCount + metafieldDefinitionCount;
  const metafieldWarnings = Array.isArray(metafieldData?.warnings) ? metafieldData.warnings : [];

  const [selectedFiles, setSelectedFiles] = useState(
    () => filesList.map((f) => f.filename)
  );
  const [expandedFile, setExpandedFile] = useState(null);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [showLiveRestoreModal, setShowLiveRestoreModal] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [safeRestoreTarget, setSafeRestoreTarget] = useState(null);
  // The safe mode is the default and stays the default: an accidental restore
  // must never be able to overwrite live metafield values.
  const [metafieldMode, setMetafieldMode] = useState("SKIP_EXISTING");

  const [downloadingZip, setDownloadingZip] = useState(false);
  const [downloadingJson, setDownloadingJson] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const handleDownload = async (format) => {
    const isZip = format === "zip";
    if (isZip) {
      setDownloadingZip(true);
    } else {
      setDownloadingJson(true);
    }
    setDownloadError("");

    try {
      const url = `/app/restore-points/${restorePoint.id}/export${isZip ? "?format=zip" : ""}`;
      // fetch() within Shopify App Bridge automatically attaches Authorization: Bearer <session-token>
      const res = await fetch(url);
      if (!res.ok) {
        let reason = "";
        try {
          reason = (await res.text()).trim();
        } catch {
          reason = "";
        }
        if (reason.startsWith("<") || reason.length > 300) reason = "";
        throw new Error(reason || `Export request failed with status ${res.status}`);
      }

      const contentType = res.headers.get("Content-Type") || "";
      const blob = await res.blob();

      // Guard against HTML redirect/bounce responses
      if (contentType.includes("text/html")) {
        const text = await blob.text();
        if (text.includes("app-bridge") || text.includes("<html") || text.includes("<script")) {
          throw new Error("Authentication session expired or unauthorized. Please refresh the page and try again.");
        }
      }

      // Extract exact filename from Content-Disposition header if exposed
      const cleanThemeName = (restorePoint.themeData?.activeTheme?.name || "theme").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
      const dateStr = new Date(restorePoint.createdAt).toISOString().split("T")[0];
      let fallbackFilename = isZip
        ? `shopify-theme-${cleanThemeName}-rp${restorePoint.id}-${dateStr}.zip`
        : `revertly-backup-rp${restorePoint.id}-${dateStr}.json`;
      let filename = fallbackFilename;
      const disposition = res.headers.get("Content-Disposition");
      if (disposition && disposition.includes("filename=")) {
        const matches = disposition.match(/filename="?([^"]+)"?/);
        if (matches && matches[1]) {
          filename = matches[1].replace(/['"]/g, "").trim();
        }
      }

      // Trigger standard browser download of verified blob without navigating iframe
      const blobUrl = window.URL.createObjectURL(blob);
      const tempLink = document.createElement("a");
      tempLink.href = blobUrl;
      tempLink.setAttribute("download", filename);
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error("Export download error:", err);
      setDownloadError(`Export download failed: ${err?.message || "Unknown error"}`);
    } finally {
      if (isZip) {
        setDownloadingZip(false);
      } else {
        setDownloadingJson(false);
      }
    }
  };

  // Modern Theme (OS 2.0 & Horizon) category filters and live search
  const [themeFilterCategory, setThemeFilterCategory] = useState("ALL");
  const [themeSearchQuery, setThemeSearchQuery] = useState("");

  const filteredThemeFiles = useMemo(() => {
    return filesList.filter((f) => {
      const filename = (f?.filename || "").toLowerCase();
      if (themeSearchQuery.trim()) {
        const q = themeSearchQuery.trim().toLowerCase();
        if (!filename.includes(q)) return false;
      }
      if (themeFilterCategory === "CHANGED") {
        return f.diff && !f.diff.isIdentical;
      }
      if (themeFilterCategory === "TEMPLATES") {
        return filename.startsWith("templates/");
      }
      if (themeFilterCategory === "SECTIONS_BLOCKS") {
        return filename.startsWith("sections/") || filename.startsWith("blocks/");
      }
      if (themeFilterCategory === "CONFIG") {
        return filename.startsWith("config/");
      }
      if (themeFilterCategory === "LAYOUT") {
        return filename.startsWith("layout/");
      }
      if (themeFilterCategory === "SNIPPETS_ASSETS") {
        return (
          filename.startsWith("snippets/") ||
          filename.startsWith("assets/") ||
          filename.startsWith("locales/")
        );
      }
      return true;
    });
  }, [filesList, themeFilterCategory, themeSearchQuery]);

  const themeCategoryCounts = useMemo(() => {
    return {
      all: filesList.length,
      changed: filesList.filter((f) => f.diff && !f.diff.isIdentical).length,
      templates: filesList.filter((f) => (f?.filename || "").startsWith("templates/")).length,
      sectionsBlocks: filesList.filter(
        (f) => (f?.filename || "").startsWith("sections/") || (f?.filename || "").startsWith("blocks/")
      ).length,
      config: filesList.filter((f) => (f?.filename || "").startsWith("config/")).length,
      layout: filesList.filter((f) => (f?.filename || "").startsWith("layout/")).length,
      snippetsAssets: filesList.filter(
        (f) =>
          (f?.filename || "").startsWith("snippets/") ||
          (f?.filename || "").startsWith("assets/") ||
          (f?.filename || "").startsWith("locales/")
      ).length,
    };
  }, [filesList]);

  useEffect(() => {
    if (result && !isRestoring) {
      setShowLiveRestoreModal(false);
      setConfirmDialog(null);
      setSafeRestoreTarget(null);
    }
  }, [result, isRestoring]);

  const [activeTab, setActiveTab] = useState(() => {
    const type = restorePoint.backupType;
    if (type === "THEMES" && themeData?.activeTheme) return "theme";
    if (type === "COLLECTIONS" && collectionData.length > 0) return "collections";
    if (type === "PAGES" && (pageData.length > 0 || menuData.length > 0)) return "pages";
    if (type === "BLOGS" && (articleData?.articles?.length > 0 || articleData?.blogs?.length > 0)) return "articles";
    if (type === "MENUS" && menuData.length > 0) return "pages";
    if (type === "METAFIELDS") return "metafields";
    if (differences.length > 0) return "products";
    if (themeData?.activeTheme) return "theme";
    if (savedCount > 0) return "products";
    if (collectionData.length > 0) return "collections";
    if (pageData.length > 0 || menuData.length > 0) return "pages";
    if (articleData?.articles?.length > 0) return "articles";
    if (metafieldTotal > 0 || type === "METAFIELDS") return "metafields";
    return "products";
  });

  const isMetafieldBackup = restorePoint.backupType === "METAFIELDS";
  const shouldShowProductsTab =
    savedCount > 0 ||
    differences.length > 0 ||
    ["FULL", "PRODUCTS"].includes(restorePoint.backupType) ||
    (!themeData?.activeTheme &&
      collectionData.length === 0 &&
      pageData.length === 0 &&
      menuData.length === 0 &&
      (!articleData?.articles || articleData.articles.length === 0) &&
      metafieldTotal === 0 &&
      !isMetafieldBackup);

  const tabs = [
    ...(themeData?.activeTheme ? [{ id: "theme", label: "Theme Code", count: filesList.length }] : []),
    ...(shouldShowProductsTab ? [{ id: "products", label: "Products", count: differences.length }] : []),
    ...(collectionData.length > 0 ? [{ id: "collections", label: "Collections", count: collectionData.length }] : []),
    ...(pageData.length > 0 || menuData.length > 0
      ? [{
          id: "pages",
          label:
            pageData.length > 0 && menuData.length > 0
              ? "Pages & Menus"
              : menuData.length > 0
              ? "Navigation Menus"
              : "Pages",
          count: pageData.length + menuData.length,
        }]
      : []),
    ...((articleData?.articles?.length > 0 || articleData?.blogs?.length > 0)
      ? [{ id: "articles", label: "Articles", count: articleData.articles?.length || 0 }]
      : []),
    ...(isMetafieldBackup || metafieldTotal > 0
      ? [{ id: "metafields", label: "Metafields", count: metafieldValueCount }]
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
                  : restorePoint.status === "CREATING" || restorePoint.status === "RESTORING"
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
            {menuData.length > 0 && (
              <span className="rv-badge rv-badge-neutral rv-badge-sm">{menuData.length} Menus</span>
            )}
            {articleData?.articles?.length > 0 && (
              <span className="rv-badge rv-badge-success rv-badge-sm">{articleData.articles.length} Articles</span>
            )}
            {metafieldValueCount > 0 && (
              <span className="rv-badge rv-badge-info rv-badge-sm">{metafieldValueCount} Metafields</span>
            )}
            {metafieldDefinitionCount > 0 && (
              <span className="rv-badge rv-badge-neutral rv-badge-sm">{metafieldDefinitionCount} Definitions</span>
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
            ) : restorePoint.cloudSyncStatus === "FAILED" ? (
              <span className="rv-badge rv-badge-critical rv-badge-sm">
                Cloud Sync Failed
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
          {(() => {
            const isCloudSyncing = isRestoring && fetcher.formData?.get("intent") === "syncToCloud";
            return (
              <fetcher.Form method="POST" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="syncToCloud" />
                <button
                  type="submit"
                  disabled={isRestoring}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                  title="Sync snapshot to connected Google Drive / Dropbox"
                >
                  <CloudUploadIcon size={14} className={isCloudSyncing ? "rv-spin" : ""} />
                  <span>{isCloudSyncing ? "Syncing..." : restorePoint.cloudSyncStatus === "SYNCED" ? "Re-sync Cloud" : "Push to Cloud"}</span>
                </button>
              </fetcher.Form>
            );
          })()}

          {themeData?.files?.length > 0 && (
            <button
              type="button"
              onClick={() => handleDownload("zip")}
              disabled={downloadingZip}
              className="rv-btn rv-btn-primary rv-btn-sm"
              title="Download standard Shopify theme (.zip) ready to upload in Shopify Admin > Online Store > Themes"
            >
              <DownloadIcon size={14} className={downloadingZip ? "rv-spin" : ""} />
              <span>{downloadingZip ? "Downloading ZIP..." : "Download Theme (.zip)"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => handleDownload("json")}
            disabled={downloadingJson}
            className="rv-btn rv-btn-secondary rv-btn-sm"
            title="Download offline backup (.json)"
          >
            <DownloadIcon size={14} className={downloadingJson ? "rv-spin" : ""} />
            <span>{downloadingJson ? "Downloading JSON..." : "Download Offline Backup (.json)"}</span>
          </button>
          <Link to="/app/restore-points" className="rv-btn rv-btn-subtle rv-btn-sm">
            <ArrowLeftIcon size={14} />
            <span>All Restore Points</span>
          </Link>
        </div>
      </div>

      {downloadError && (
        <div style={{ marginBottom: "16px" }}>
          <Banner
            tone="critical"
            title="Export Download Failed"
            onDismiss={() => setDownloadError("")}
          >
            {downloadError}
          </Banner>
        </div>
      )}

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
          tone={result.success ? "success" : result.isPartial ? "warning" : "critical"}
          title={
            result.success
              ? "Operation Succeeded"
              : result.isPartial
              ? "Partial Restoration Completed"
              : "Operation Warning"
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>{result.message}</div>
            {result.message?.includes("Theme API exemption") && (
              <div
                style={{
                  background: "rgba(255, 255, 255, 0.85)",
                  padding: "12px 14px",
                  borderRadius: "8px",
                  border: "1px solid rgba(0, 0, 0, 0.08)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  marginTop: "4px",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--rv-text-main, #202223)" }}>
                  Instant 1-Click Recovery Solution:
                </div>
                <div style={{ fontSize: "12px", color: "var(--rv-text-subdued, #6d7175)", lineHeight: 1.5 }}>
                  1. Click <b>Download Theme as .ZIP</b> below to get your complete theme archive.
                  <br />
                  2. In your Shopify Admin, navigate to <b>Online Store &gt; Themes</b>.
                  <br />
                  3. Under <i>Theme library</i>, click <b>Add theme &gt; Upload zip file</b>. Your theme will be restored completely!
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "4px" }}>
                  <button
                    type="button"
                    onClick={() => handleDownload("zip")}
                    disabled={downloadingZip}
                    className="rv-btn rv-btn-primary rv-btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    <DownloadIcon size={14} className={downloadingZip ? "rv-spin" : ""} />
                    <span>{downloadingZip ? "Downloading ZIP..." : "Download Theme as .ZIP (Ready to Upload)"}</span>
                  </button>
                  <a
                    href="https://docs.google.com/forms/d/e/1FAIpQLSfZTB1vxFC5d1-GPdqYunWRGUoDcOheHQzfK2RoEFEHrknt5g/viewform"
                    target="_blank"
                    rel="noreferrer"
                    className="rv-btn rv-btn-secondary rv-btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    <ExternalLinkIcon size={14} />
                    <span>Submit Shopify Partner Exemption Form</span>
                  </a>
                </div>
              </div>
            )}
          </div>
        </Banner>
      )}

      {/* ── Post-Restore Delight & 5-Star Review Trigger ── */}
      {((result?.success && !result?.isPartial && result?.message &&
        submittedIntent?.startsWith("restore") && !result?.draftThemeName) ||
        (!result && lastJob?.status === "COMPLETED" && lastJob.successCount > 0)) && (
        <div
          style={{
            background: "linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 50%, #eff6ff 100%)",
            border: "1px solid #bbf7d0",
            borderRadius: "10px",
            padding: "16px 20px",
            marginBottom: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "14px",
            boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <CheckCircleIcon size={24} style={{ color: "#16a34a" }} />
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: "#166534", marginBottom: "2px" }}>
                Store Restore Completed Successfully
              </div>
              <div style={{ fontSize: "13px", color: "#15803d" }}>
                Did Revertly save the day? If this backup saved your store data or restored lost revenue, taking 30 seconds to support our indie team with a review means the world to us.
              </div>
            </div>
          </div>
          <a
            href="https://apps.shopify.com/revertly"
            target="_blank"
            rel="noreferrer"
            className="rv-btn"
            style={{
              background: "#16a34a",
              color: "#ffffff",
              border: "1px solid #15803d",
              fontWeight: 600,
              fontSize: "13px",
              padding: "8px 16px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              textDecoration: "none",
              borderRadius: "6px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            <span>Write an App Store Review</span>
            <ExternalLinkIcon size={13} />
          </a>
        </div>
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
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
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

              {/* ── Top-Right Theme Restore Actions ── */}
              {(() => {
                const isDraftRestoring = isRestoring && fetcher.formData?.get("intent") === "restore_theme" && fetcher.formData?.get("mode") === "draft";
                return (
                  <fetcher.Form method="POST" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="restore_theme" />
                    <input type="hidden" name="mode" value="draft" />
                    <input type="hidden" name="selectedFiles" value={JSON.stringify(selectedFiles)} />
                    <button
                      type="submit"
                      disabled={selectedFiles.length === 0 || isRestoring}
                      className="rv-btn rv-btn-primary rv-btn-sm"
                      title="Safely restore to an unpublished draft preview theme (leaves live storefront untouched)"
                    >
                      <ShieldCheckIcon size={14} className={isDraftRestoring ? "rv-spin" : ""} />
                      <span>{isDraftRestoring ? "Creating Draft..." : `Safe Restore to Draft (${selectedFiles.length})`}</span>
                    </button>
                  </fetcher.Form>
                );
              })()}

              <button
                type="button"
                disabled={selectedFiles.length === 0 || isRestoring}
                className="rv-btn rv-btn-secondary rv-btn-sm"
                style={{ color: "var(--rv-critical)", borderColor: "rgba(224, 49, 49, 0.35)" }}
                onClick={() => setShowLiveRestoreModal(true)}
                title="Directly restore into your active live theme"
              >
                <span>Instant Restore to Live</span>
              </button>
            </div>
          </div>

          <div className="rv-card-body">
            {/* Theme Files Filter & Search Toolbar (Theme 2.0 & Horizon support) */}
            <div
              style={{
                marginBottom: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                padding: "12px 14px",
                background: "var(--rv-surface-subdued, #f6f6f7)",
                borderRadius: "var(--rv-radius-sm, 6px)",
                border: "1px solid var(--rv-border, #e1e3e5)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={() => setThemeFilterCategory("ALL")}
                    className={`rv-btn rv-btn-sm ${themeFilterCategory === "ALL" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                  >
                    All ({themeCategoryCounts.all})
                  </button>
                  {themeCategoryCounts.changed > 0 && (
                    <button
                      type="button"
                      onClick={() => setThemeFilterCategory("CHANGED")}
                      className={`rv-btn rv-btn-sm ${themeFilterCategory === "CHANGED" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                    >
                      Modified ({themeCategoryCounts.changed})
                    </button>
                  )}
                  {themeCategoryCounts.templates > 0 && (
                    <button
                      type="button"
                      onClick={() => setThemeFilterCategory("TEMPLATES")}
                      className={`rv-btn rv-btn-sm ${themeFilterCategory === "TEMPLATES" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                    >
                      Templates ({themeCategoryCounts.templates})
                    </button>
                  )}
                  {themeCategoryCounts.sectionsBlocks > 0 && (
                    <button
                      type="button"
                      onClick={() => setThemeFilterCategory("SECTIONS_BLOCKS")}
                      className={`rv-btn rv-btn-sm ${themeFilterCategory === "SECTIONS_BLOCKS" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                    >
                      Sections &amp; Blocks ({themeCategoryCounts.sectionsBlocks})
                    </button>
                  )}
                  {themeCategoryCounts.config > 0 && (
                    <button
                      type="button"
                      onClick={() => setThemeFilterCategory("CONFIG")}
                      className={`rv-btn rv-btn-sm ${themeFilterCategory === "CONFIG" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                    >
                      Config ({themeCategoryCounts.config})
                    </button>
                  )}
                  {themeCategoryCounts.layout > 0 && (
                    <button
                      type="button"
                      onClick={() => setThemeFilterCategory("LAYOUT")}
                      className={`rv-btn rv-btn-sm ${themeFilterCategory === "LAYOUT" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                    >
                      Layout ({themeCategoryCounts.layout})
                    </button>
                  )}
                  {themeCategoryCounts.snippetsAssets > 0 && (
                    <button
                      type="button"
                      onClick={() => setThemeFilterCategory("SNIPPETS_ASSETS")}
                      className={`rv-btn rv-btn-sm ${themeFilterCategory === "SNIPPETS_ASSETS" ? "rv-btn-primary" : "rv-btn-secondary"}`}
                    >
                      Snippets &amp; Assets ({themeCategoryCounts.snippetsAssets})
                    </button>
                  )}
                </div>

                <div style={{ flex: "1 1 200px", maxWidth: "320px" }}>
                  <input
                    type="text"
                    placeholder="Search file name..."
                    value={themeSearchQuery}
                    onChange={(e) => setThemeSearchQuery(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      fontSize: "13px",
                      border: "1px solid var(--rv-border, #ccc)",
                      borderRadius: "var(--rv-radius-sm, 4px)",
                      outline: "none",
                    }}
                  />
                </div>
              </div>
            </div>

            {filteredThemeFiles.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--rv-text-subdued)", fontSize: "13px" }}>
                No theme files match the selected filter{themeSearchQuery ? ` or search query "${themeSearchQuery}"` : ""}.
                <div style={{ marginTop: "10px" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setThemeFilterCategory("ALL");
                      setThemeSearchQuery("");
                    }}
                    className="rv-btn rv-btn-secondary rv-btn-sm"
                  >
                    Reset Filter &amp; Search
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
                {filteredThemeFiles.map((f) => {
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
                          <span>Red = Lines Removed in Backup &nbsp;|&nbsp; Green = Backup Lines Restored</span>
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
          )}

            {/* Dual Safe Theme Restore Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", paddingTop: "14px", borderTop: "1px solid var(--rv-border)" }}>
              {(() => {
                const isDraftRestoring = isRestoring && fetcher.formData?.get("intent") === "restore_theme" && fetcher.formData?.get("mode") === "draft";
                return (
                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="restore_theme" />
                    <input type="hidden" name="mode" value="draft" />
                    <input type="hidden" name="selectedFiles" value={JSON.stringify(selectedFiles)} />
                    <button
                      type="submit"
                      disabled={selectedFiles.length === 0 || isRestoring}
                      className="rv-btn rv-btn-primary rv-btn-lg"
                    >
                      <ShieldCheckIcon size={16} className={isDraftRestoring ? "rv-spin" : ""} />
                      <span>{isDraftRestoring ? "Creating Draft Theme..." : "Safe Restore to Draft Theme (Preview First)"}</span>
                    </button>
                  </fetcher.Form>
                );
              })()}

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
                    <button
                      type="button"
                      disabled={isRestoring}
                      onClick={() => {
                        setSafeRestoreTarget({
                          mode: "selected",
                          count: selectedProductIds.length,
                          selectedProductIds: selectedProductIds,
                          diffs: differences.filter((d) => selectedProductIds.includes(d.productId)),
                        });
                      }}
                      className="rv-btn rv-btn-primary rv-btn-lg"
                      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      <ShieldCheckIcon size={16} />
                      <span>{isRestoring && fetcher.formData?.get("intent") === "restore_selected_products" ? "Restoring..." : `Safe Restore Selected (${selectedProductIds.length})`}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isRestoring}
                    onClick={() => {
                      setSafeRestoreTarget({
                        mode: "all",
                        count: differences.length,
                        selectedProductIds: [],
                        diffs: differences,
                      });
                    }}
                    className="rv-btn rv-btn-critical rv-btn-lg"
                    style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    <ShieldCheckIcon size={16} />
                    <span>{isRestoring && fetcher.formData?.get("intent") === "restore" ? "Restoring products..." : `Safe Restore All (${differences.length}) Products`}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {savedCount === 0 ? (
            <EmptyState
              icon={<BoxIcon size={28} style={{ color: "var(--rv-text-subdued)" }} />}
              title="No Products Captured in this Restore Point"
              description={`This snapshot was captured as a dedicated ${restorePoint.backupType || "Resource"} backup and does not include product catalog snapshots.`}
            />
          ) : differences.length === 0 ? (
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

                    <button
                      type="button"
                      disabled={isRestoring}
                      onClick={() => {
                        const targetDiff = differences.find((x) => String(x.productId) === String(d.productId));
                        setSafeRestoreTarget({
                          mode: "single",
                          count: 1,
                          selectedProductIds: [String(d.productId)],
                          diffs: targetDiff ? [targetDiff] : [],
                        });
                      }}
                      className="rv-btn rv-btn-secondary rv-btn-sm"
                      title="Safe restore only this product with field options"
                      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      <ShieldCheckIcon size={14} />
                      <span>Safe Restore Product</span>
                    </button>
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
          <div className="rv-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h3 className="rv-card-title">
                <span>Protected Smart Collections ({collectionData.length})</span>
              </h3>
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                Rule-based smart collections and rule sets preserved in this snapshot.
              </p>
            </div>
            <button
              type="button"
              disabled={isRestoring}
              onClick={() => {
                setConfirmDialog({
                  title: `Restore All ${collectionData.length} Collections`,
                  message: `Are you sure you want to restore all ${collectionData.length} smart collections to their snapshot state in Shopify?`,
                  dangerNote: "Existing collections will be updated or recreated if missing.",
                  confirmLabel: `Restore All (${collectionData.length}) Collections`,
                  tone: "primary",
                  onConfirm: () => {
                    fetcher.submit({ intent: "restore_all_collections" }, { method: "POST" });
                  },
                });
              }}
              className="rv-btn rv-btn-primary rv-btn-md"
            >
              <span>{isRestoring && fetcher.formData?.get("intent") === "restore_all_collections" ? "Restoring All..." : `Restore All (${collectionData.length}) Collections`}</span>
            </button>
          </div>
          <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Collection Title</th>
                  <th>Handle</th>
                  <th>Image &amp; Description</th>
                  <th>Smart Rules Preserved</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {collectionData.map((col, idx) => {
                  const descText = (col.descriptionHtml || "").replace(/<[^>]*>/g, "").trim();
                  return (
                    <tr key={col.id || idx}>
                      <td style={{ fontWeight: 600 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          {col.image?.url && (
                            <img
                              src={col.image.url}
                              alt={col.image.altText || col.title}
                              style={{ width: "28px", height: "28px", objectFit: "cover", borderRadius: "4px", border: "1px solid var(--rv-border-subdued)" }}
                            />
                          )}
                          <span>{col.title}</span>
                        </div>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)" }}>/{col.handle}</td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <span style={{ fontSize: "12px", color: descText ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                            {descText ? (descText.length > 50 ? descText.slice(0, 50) + "..." : descText) : "No description"}
                          </span>
                          {col.image?.url && (
                            <span className="rv-badge rv-badge-success rv-badge-sm" style={{ width: "fit-content" }}>
                              Image Preserved
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="rv-badge rv-badge-info rv-badge-sm">
                          {col.ruleSet?.rules?.length || 0} smart rules
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          disabled={isRestoring}
                          onClick={() => {
                            setConfirmDialog({
                              title: `Restore Collection: "${col.title}"`,
                              message: `Are you sure you want to recreate or update collection "${col.title}" in Shopify?`,
                              dangerNote: "Any manually removed conditions, description, or image changes will be restored.",
                              confirmLabel: "Restore Collection",
                              tone: "primary",
                              onConfirm: () => {
                                fetcher.submit({ intent: "restore_collection", colIndex: String(idx) }, { method: "POST" });
                              },
                            });
                          }}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                        >
                          <span>Recreate / Restore</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Pages Backup Section ── */}
      {activeTab === "pages" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {pageData.length > 0 && (
            <div className="rv-card">
              <div className="rv-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                <div>
                  <h3 className="rv-card-title">
                    <span>Protected Content Pages ({pageData.length})</span>
                  </h3>
                  <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                    Pages, handles, and content preserved in this snapshot.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isRestoring}
                  onClick={() => {
                    setConfirmDialog({
                      title: `Restore All ${pageData.length} Pages`,
                      message: `Are you sure you want to restore all ${pageData.length} pages to their snapshot state in Shopify?`,
                      dangerNote: "Page content and metadata will be updated in Shopify.",
                      confirmLabel: `Restore All (${pageData.length}) Pages`,
                      tone: "primary",
                      onConfirm: () => {
                        fetcher.submit({ intent: "restore_all_pages" }, { method: "POST" });
                      },
                    });
                  }}
                  className="rv-btn rv-btn-primary rv-btn-md"
                >
                  <span>{isRestoring && fetcher.formData?.get("intent") === "restore_all_pages" ? "Restoring All..." : `Restore All (${pageData.length}) Pages`}</span>
                </button>
              </div>
              <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
                <table className="rv-table">
                  <thead>
                    <tr>
                      <th>Page Title</th>
                      <th>Handle</th>
                      <th>Assigned Template</th>
                      <th>Snapshot Content</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageData.map((p, idx) => {
                      const plainText = (p.body || p.bodyHtml || "").replace(/<[^>]*>/g, "").trim();
                      const hasContent = Boolean(plainText || p.body || p.bodyHtml);

                      return (
                        <tr key={p.id || idx}>
                          <td style={{ fontWeight: 600 }}>{p.title}</td>
                          <td style={{ color: "var(--rv-text-subdued)" }}>/{p.handle}</td>
                          <td>
                            <span className={`rv-badge rv-badge-sm ${p.templateSuffix ? "rv-badge-info" : "rv-badge-neutral"}`}>
                              {p.templateSuffix ? p.templateSuffix : "Default page"}
                            </span>
                          </td>
                          <td>
                            {hasContent ? (
                              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <span className="rv-badge rv-badge-success rv-badge-sm">
                                  Saved ({plainText.length} chars)
                                </span>
                                <span
                                  style={{
                                    maxWidth: "260px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    fontSize: "12px",
                                    color: "var(--rv-text-subdued)",
                                  }}
                                  title={plainText}
                                >
                                  {plainText || "HTML content"}
                                </span>
                              </div>
                            ) : (
                              <span className="rv-badge rv-badge-neutral rv-badge-sm" style={{ opacity: 0.7 }}>
                                Empty (No Content in Snapshot)
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              type="button"
                              disabled={isRestoring}
                              onClick={() => {
                                setConfirmDialog({
                                  title: `Restore Page: "${p.title}"`,
                                  message: `Are you sure you want to restore content page "${p.title}" in Shopify?`,
                                  dangerNote: hasContent
                                    ? "Page content and settings will be restored to their snapshot state."
                                    : "Warning: This snapshot has empty content for this page.",
                                  confirmLabel: "Restore Page",
                                  tone: "primary",
                                  onConfirm: () => {
                                    fetcher.submit({ intent: "restore_page", pageIndex: String(idx) }, { method: "POST" });
                                  },
                                });
                              }}
                              className="rv-btn rv-btn-secondary rv-btn-sm"
                            >
                              <span>Restore Page</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {menuData.length > 0 && (
            <div className="rv-card">
              <div className="rv-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                <div>
                  <h3 className="rv-card-title">
                    <span>Protected Navigation Menus ({menuData.length})</span>
                  </h3>
                  <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                    Navigation menus, handles, and link structures preserved in this snapshot.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isRestoring}
                  onClick={() => {
                    setConfirmDialog({
                      title: `Restore All ${menuData.length} Navigation Menus`,
                      message: `Are you sure you want to restore all ${menuData.length} navigation menus to their snapshot state in Shopify?`,
                      dangerNote: "Existing menu items and links will be updated or recreated in Shopify.",
                      confirmLabel: `Restore All (${menuData.length}) Menus`,
                      tone: "primary",
                      onConfirm: () => {
                        fetcher.submit({ intent: "restore_all_menus" }, { method: "POST" });
                      },
                    });
                  }}
                  className="rv-btn rv-btn-primary rv-btn-md"
                >
                  <span>{isRestoring && fetcher.formData?.get("intent") === "restore_all_menus" ? "Restoring All..." : `Restore All (${menuData.length}) Menus`}</span>
                </button>
              </div>
              <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
                <table className="rv-table">
                  <thead>
                    <tr>
                      <th>Menu Title</th>
                      <th>Handle</th>
                      <th>Items Count</th>
                      <th>Hierarchy Preview</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {menuData.map((m, idx) => {
                      const items = Array.isArray(m.items) ? m.items : [];
                      const itemTitles = items.map((it) => it.title).filter(Boolean);
                      const previewStr = itemTitles.slice(0, 5).join(" · ") + (itemTitles.length > 5 ? ` +${itemTitles.length - 5} more` : "");

                      return (
                        <tr key={m.id || idx}>
                          <td style={{ fontWeight: 600 }}>{m.title}</td>
                          <td style={{ color: "var(--rv-text-subdued)" }}>{m.handle || "default"}</td>
                          <td>
                            <span className="rv-badge rv-badge-info rv-badge-sm">
                              {items.length} items
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {previewStr || "Empty menu"}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              type="button"
                              disabled={isRestoring}
                              onClick={() => {
                                setConfirmDialog({
                                  title: `Restore Navigation Menu: "${m.title}"`,
                                  message: `Are you sure you want to recreate or update menu "${m.title}" in Shopify?`,
                                  dangerNote: "Menu hierarchy and links will be updated in Shopify.",
                                  confirmLabel: "Restore Menu",
                                  tone: "primary",
                                  onConfirm: () => {
                                    fetcher.submit({ intent: "restore_menu", menuIndex: String(idx) }, { method: "POST" });
                                  },
                                });
                              }}
                              className="rv-btn rv-btn-secondary rv-btn-sm"
                            >
                              <span>Restore Menu</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Blogs & Articles Backup Section ── */}
      {activeTab === "articles" && (
        <div className="rv-card">
          <div className="rv-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h3 className="rv-card-title">
                <span>Protected Blog Articles ({articleData?.articles?.length || 0})</span>
              </h3>
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                Blog articles and published content preserved in this snapshot.
              </p>
            </div>
            {articleData?.articles?.length > 0 && (
              <button
                type="button"
                disabled={isRestoring}
                onClick={() => {
                  setConfirmDialog({
                    title: `Restore All ${articleData.articles.length} Articles`,
                    message: `Are you sure you want to restore all ${articleData.articles.length} blog articles to their snapshot state in Shopify?`,
                    dangerNote: "Article titles, body HTML, and publish status will be updated.",
                    confirmLabel: `Restore All (${articleData.articles.length}) Articles`,
                    tone: "primary",
                    onConfirm: () => {
                      fetcher.submit({ intent: "restore_all_articles" }, { method: "POST" });
                    },
                  });
                }}
                className="rv-btn rv-btn-primary rv-btn-md"
              >
                <span>{isRestoring && fetcher.formData?.get("intent") === "restore_all_articles" ? "Restoring All..." : `Restore All (${articleData.articles.length}) Articles`}</span>
              </button>
            )}
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
                    <th>Template</th>
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
                      <td>
                        <span className={`rv-badge rv-badge-sm ${art.templateSuffix ? "rv-badge-info" : "rv-badge-neutral"}`}>
                          {art.templateSuffix ? art.templateSuffix : "Default"}
                        </span>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)" }}>{art.blogTitle || "Blog"}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          disabled={isRestoring}
                          onClick={() => {
                            setConfirmDialog({
                              title: `Restore Blog Article: "${art.title}"`,
                              message: `Are you sure you want to restore blog article "${art.title}" in Shopify?`,
                              dangerNote: "Article content will be updated to the snapshot version.",
                              confirmLabel: "Restore Article",
                              tone: "primary",
                              onConfirm: () => {
                                fetcher.submit({ intent: "restore_article", articleIndex: String(idx) }, { method: "POST" });
                              },
                            });
                          }}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                        >
                          <span>Restore Article</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Metafields Section ── */}
      {activeTab === "metafields" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          {!hasMetafieldAccess && (
            <Banner
              tone="warning"
              title="Metafield restore requires a Growth plan"
              action={
                <Link to="/app/plan" className="rv-btn rv-btn-primary rv-btn-sm">
                  Upgrade Plan
                </Link>
              }
            >
              This snapshot&apos;s metafields are safely stored and can still be exported, but restoring them to your
              live store requires a Growth plan or higher.
            </Banner>
          )}

          {metafieldWarnings.length > 0 && (
            <Banner tone="warning" title="This metafield capture was incomplete">
              <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "12px" }}>
                {metafieldWarnings.slice(0, 5).map((w, idx) => (
                  <li key={idx}>
                    {w.ownerType ? `${w.ownerType}: ` : ""}
                    {w.message}
                  </li>
                ))}
              </ul>
            </Banner>
          )}

          {/* Restore controls */}
          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <div>
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <DatabaseIcon size={18} style={{ color: "#14b8a6" }} />
                  <span>
                    Protected Metafields ({metafieldValueCount} values, {metafieldDefinitionCount} definitions)
                  </span>
                </h3>
                <p style={{ margin: "3px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Captured across {metafieldOwners.length} resources. Restoring never deletes metafields added since
                  this snapshot — it only puts saved values back.
                </p>
              </div>
            </div>

            <div className="rv-card-body">
              <div
                style={{
                  marginBottom: "16px",
                  padding: "14px 16px",
                  borderRadius: "8px",
                  background: "var(--rv-surface-subdued)",
                  border: "1px solid var(--rv-border)",
                }}
              >
                <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>
                  How should existing metafields be treated?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {[
                    {
                      id: "SKIP_EXISTING",
                      title: "Only restore what is missing (Recommended)",
                      desc: "Writes a value only where nothing is currently stored. Brings back deleted metafields and cannot overwrite anything on your live store.",
                    },
                    {
                      id: "RESTORE_CHANGED",
                      title: "Restore values that have changed",
                      desc: "Overwrites live values that differ from this snapshot. Values edited while the restore runs are reported as conflicts rather than silently replaced.",
                    },
                    {
                      id: "FORCE",
                      title: "Overwrite everything from this snapshot",
                      desc: "Replaces every captured metafield value unconditionally. Use only when the snapshot is known to be the correct state.",
                    },
                  ].map((opt) => (
                    <label
                      key={opt.id}
                      htmlFor={`mf-mode-${opt.id}`}
                      style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}
                    >
                      <input
                        id={`mf-mode-${opt.id}`}
                        type="radio"
                        name="metafield_mode_select"
                        checked={metafieldMode === opt.id}
                        onChange={() => setMetafieldMode(opt.id)}
                        disabled={!hasMetafieldAccess || isRestoring}
                        style={{ marginTop: "3px" }}
                      />
                      <div>
                        <strong style={{ fontSize: "13px", color: opt.id === "FORCE" ? "var(--rv-critical)" : undefined }}>
                          {opt.title}
                        </strong>
                        <span style={{ display: "block", fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                          {opt.desc}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={!hasMetafieldAccess || isRestoring || metafieldValueCount === 0}
                  className="rv-btn rv-btn-primary"
                  onClick={() =>
                    setConfirmDialog({
                      title: "Restore Metafields",
                      message: (
                        <>
                          Restore <strong>{metafieldValueCount}</strong> metafield values across{" "}
                          <strong>{metafieldOwners.length}</strong> resources, plus{" "}
                          <strong>{metafieldDefinitionCount}</strong> definitions?
                        </>
                      ),
                      dangerNote:
                        metafieldMode === "FORCE"
                          ? "Overwrite mode replaces every captured value on your live store, including values edited since this snapshot was taken."
                          : metafieldMode === "RESTORE_CHANGED"
                          ? "Values that differ from this snapshot will be replaced. Resources that no longer exist are skipped, never recreated."
                          : "Only missing metafields will be written. Nothing currently stored on your live store will be changed.",
                      confirmLabel: "Restore Metafields",
                      tone: metafieldMode === "SKIP_EXISTING" ? "primary" : "critical",
                      onConfirm: () =>
                        fetcher.submit(
                          { intent: "restore_metafields", metafieldMode },
                          { method: "POST" }
                        ),
                    })
                  }
                >
                  {isRestoring && fetcher.formData?.get("intent") === "restore_metafields"
                    ? "Restoring Metafields..."
                    : `Restore All Metafields (${metafieldValueCount})`}
                </button>

                <button
                  type="button"
                  disabled={!hasMetafieldAccess || isRestoring || metafieldDefinitionCount === 0}
                  className="rv-btn rv-btn-secondary"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "restore_metafield_definitions", metafieldMode },
                      { method: "POST" }
                    )
                  }
                >
                  {isRestoring && fetcher.formData?.get("intent") === "restore_metafield_definitions"
                    ? "Restoring Definitions..."
                    : `Restore Definitions Only (${metafieldDefinitionCount})`}
                </button>
              </div>
            </div>
          </div>

          {/* Definitions table */}
          {metafieldDefinitionCount > 0 && (
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title">
                  <span>Metafield Definitions ({metafieldDefinitionCount})</span>
                </h3>
              </div>
              <div className="rv-card-body" style={{ overflowX: "auto" }}>
                <table className="rv-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>Namespace &amp; Key</th>
                      <th>Name</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(metafieldData?.definitions || {}).flatMap(([ownerType, defs]) =>
                      (defs || []).map((def, idx) => (
                        <tr key={`${ownerType}-${def.namespace}-${def.key}-${idx}`}>
                          <td>
                            <span className="rv-badge rv-badge-neutral rv-badge-sm">{ownerType}</span>
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: "12px" }}>
                            {def.namespace}.{def.key}
                          </td>
                          <td style={{ fontSize: "13px" }}>{def.name || "—"}</td>
                          <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{def.type || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Owners table */}
          {metafieldOwners.length > 0 ? (
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title">
                  <span>Resources with Metafields ({metafieldOwners.length})</span>
                </h3>
              </div>
              <div className="rv-card-body" style={{ overflowX: "auto" }}>
                <table className="rv-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Resource</th>
                      <th>Handle</th>
                      <th style={{ textAlign: "right" }}>Metafields</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metafieldOwners.slice(0, 200).map((owner, idx) => (
                      <tr key={`${owner.ownerType}-${owner.handle}-${idx}`}>
                        <td>
                          <span className="rv-badge rv-badge-neutral rv-badge-sm">{owner.ownerType}</span>
                        </td>
                        <td style={{ fontSize: "13px" }}>
                          {owner.title || owner.handle || "—"}
                          {owner.truncated && (
                            <span className="rv-badge rv-badge-warning rv-badge-sm" style={{ marginLeft: "6px" }}>
                              Partial
                            </span>
                          )}
                        </td>
                        <td style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                          {owner.parentHandle ? `${owner.parentHandle}/` : ""}
                          {owner.handle || "—"}
                        </td>
                        <td style={{ textAlign: "right", fontSize: "13px" }}>{owner.metafields?.length || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {metafieldOwners.length > 200 && (
                  <p style={{ margin: "10px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    Showing the first 200 of {metafieldOwners.length} resources. All of them are included in a restore
                    and in any export.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<DatabaseIcon size={26} style={{ color: "#14b8a6" }} />}
              title="No Metafield Values in This Snapshot"
              description={
                metafieldDefinitionCount > 0
                  ? "This snapshot captured metafield definitions but no resource carried a value at the time. You can still restore the definitions above."
                  : "This snapshot did not capture any metafields. Run a Metafield Backup from Restore Points to create one."
              }
            />
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

      {/* ── Interactive Safe Restore Modal ── */}
      {safeRestoreTarget && (
        <SafeRestoreModal
          isOpen={Boolean(safeRestoreTarget)}
          productCount={safeRestoreTarget.count}
          differences={safeRestoreTarget.diffs}
          isSubmitting={isRestoring}
          onClose={() => {
            if (!isRestoring) setSafeRestoreTarget(null);
          }}
          onConfirm={(options) => {
            const formDataPayload = {
              restoreTitles: String(options.restoreTitles),
              restoreDescriptions: String(options.restoreDescriptions),
              restorePrices: String(options.restorePrices),
              restoreTags: String(options.restoreTags),
              restoreStatus: String(options.restoreStatus),
              preserveInventory: String(options.preserveInventory),
            };

            if (safeRestoreTarget.mode === "single") {
              fetcher.submit(
                {
                  intent: "restore_single_product",
                  productId: safeRestoreTarget.selectedProductIds[0],
                  ...formDataPayload,
                },
                { method: "POST" }
              );
            } else if (safeRestoreTarget.mode === "selected") {
              fetcher.submit(
                {
                  intent: "restore_selected_products",
                  selectedProductIds: safeRestoreTarget.selectedProductIds.join(","),
                  ...formDataPayload,
                },
                { method: "POST" }
              );
            } else {
              fetcher.submit(
                {
                  intent: "restore",
                  ...formDataPayload,
                },
                { method: "POST" }
              );
            }
          }}
        />
      )}

      {/* ── Action Confirmation Modal ── */}
      {confirmDialog && (
        <ConfirmModal
          isOpen={Boolean(confirmDialog)}
          title={confirmDialog?.title || "Confirm Action"}
          message={confirmDialog?.message}
          dangerNote={confirmDialog?.dangerNote}
          confirmLabel={confirmDialog?.confirmLabel || "Confirm"}
          submittingLabel="Restoring..."
          tone={confirmDialog?.tone || "primary"}
          isSubmitting={isRestoring}
          onConfirm={() => {
            if (confirmDialog?.onConfirm) confirmDialog.onConfirm();
          }}
          onClose={() => {
            if (!isRestoring) setConfirmDialog(null);
          }}
        />
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
