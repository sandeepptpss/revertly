import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, redirect } from "react-router";
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
  if (themeData?.files?.length) {
    let currentLiveFiles = [];
    try {
      const liveTheme = await fetchThemeBackup(admin);
      currentLiveFiles = liveTheme?.files || [];
    } catch (e) {
      console.warn("Could not fetch live theme files for diffing:", e?.message);
    }

    const liveMap = Object.fromEntries(
      currentLiveFiles.map((lf) => [lf.filename, lf.content])
    );

    themeDiffFiles = themeData.files.map((f) => {
      const liveContent = liveMap[f.filename] ?? "";
      const diff = computeDiffLines(liveContent, f.content || "");
      return {
        ...f,
        diff,
      };
    });
  }

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
  };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const rpId = parseInt(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "restore_theme") {
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

  if (intent !== "restore") return { success: false };

  const restorePoint = await prisma.restorePoint.findFirst({
    where: { id: rpId, shop },
  });
  if (!restorePoint) return { success: false, message: "Restore point not found." };

  const savedProducts = Array.isArray(restorePoint.snapshotData)
    ? restorePoint.snapshotData
    : [];

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
      totalProducts: savedProducts.length,
    },
  });

  await prisma.restorePoint.update({
    where: { id: rpId },
    data: { status: "RESTORING" },
  });

  let successCount = 0;
  let failedCount = 0;

  for (const saved of savedProducts) {
    const productId = saved.productId;
    const savedSnap = saved.snapshotData || saved;
    const current = currentMap[productId];
    if (!current) continue;

    // Build field-level change events in memory for rollback
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

    // Save temp change events, rollback, then delete them. Create each
    // individually to capture its real ID directly — re-querying by a
    // recent timestamp window risks sweeping up (and later deleting) a
    // genuine concurrent change event for the same product.
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

    // Restore metafields if present in snapshot
    if (Array.isArray(savedSnap.metafields) && savedSnap.metafields.length > 0) {
      try {
        await restoreProductMetafields(admin, productId, savedSnap.metafields);
      } catch (mfErr) {
        console.warn(`Product metafield restore warning (${productId}):`, mfErr?.message);
      }
    }

    // Clean up temp events
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

  return {
    success: true,
    message: `Restore ${finalStatus.toLowerCase()}: ${successCount} succeeded, ${failedCount} failed.`,
  };
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

  const [activeTab, setActiveTab] = useState(() => {
    if (differences.length > 0) return "products";
    if (themeData?.activeTheme) return "theme";
    return "products";
  });

  const tabs = [
    ...(themeData?.activeTheme ? [{ id: "theme", label: `🎨 Theme (${filesList.length})` }] : []),
    { id: "products", label: `📦 Products (${differences.length} diff${differences.length === 1 ? "" : "s"})` },
    ...(collectionData.length > 0 ? [{ id: "collections", label: `🗂️ Collections (${collectionData.length})` }] : []),
    ...(pageData.length > 0 ? [{ id: "pages", label: `📄 Pages & Menus (${pageData.length})` }] : []),
    ...((articleData?.articles?.length > 0 || articleData?.blogs?.length > 0)
      ? [{ id: "articles", label: `📝 Blogs & Articles (${articleData.articles?.length || 0})` }]
      : []),
    ...(lastJob ? [{ id: "history", label: "🕒 History" }] : []),
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
      <s-section>
        <s-stack direction="block" gap="tight">
          <s-stack direction="inline" align="space-between" align-items="center" wrap>
            <s-stack direction="inline" gap="base" align="center" wrap>
              <s-badge tone={restorePoint.status === "READY" ? "success" : "attention"}>
                {restorePoint.status}
              </s-badge>
              <s-text tone="subdued">Created: {formatTime(restorePoint.createdAt)}</s-text>
              <s-badge tone="info">{savedCount} Products</s-badge>
              {themeData?.activeTheme && (
                <s-badge tone="success">Theme: {themeData.activeTheme.name}</s-badge>
              )}
              {collectionData.length > 0 && (
                <s-badge tone="info">{collectionData.length} Collections</s-badge>
              )}
              {pageData.length > 0 && (
                <s-badge tone="subdued">{pageData.length} Pages</s-badge>
              )}
              {articleData?.articles?.length > 0 && (
                <s-badge tone="success">{articleData.articles.length} Articles</s-badge>
              )}
            </s-stack>
            <s-button
              url={`/app/restore-points/${restorePoint.id}/export`}
              variant="secondary"
            >
              ⬇️ Download Offline Backup (.json)
            </s-button>
          </s-stack>
          {restorePoint.description && (
            <s-paragraph>{restorePoint.description}</s-paragraph>
          )}
        </s-stack>
      </s-section>

      {/* ── Navigation Tabs ── */}
      <s-section>
        <s-stack direction="inline" gap="tight" wrap>
          {tabs.map((tab) => (
            <s-button
              key={tab.id}
              variant={activeTab === tab.id ? "primary" : "secondary"}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </s-button>
          ))}
        </s-stack>
      </s-section>

      {/* ── Draft Staging Preview Banner ── */}
      {result?.isDraft && result?.previewUrl && (
        <s-section>
          <s-banner tone="success">
            <s-stack direction="block" gap="tight">
              <s-text fontWeight="bold">
                🎉 Draft Staging Theme Created: &ldquo;{result.draftThemeName}&rdquo;
              </s-text>
              <s-paragraph>
                Your backed-up theme files were safely deployed into an <strong>unpublished draft theme</strong> ({result.filesRestored} files restored). Your live storefront is 100% untouched! You can preview it now:
              </s-paragraph>
              <s-stack direction="inline" gap="base" align="center">
                <s-button url={result.previewUrl} target="_blank" variant="primary">
                  Open Storefront Preview ↗
                </s-button>
                {result.editorUrl && (
                  <s-button url={result.editorUrl} target="_blank" variant="secondary">
                    Open in Theme Customizer ↗
                  </s-button>
                )}
              </s-stack>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {/* ── Live Safety Snapshot Banner ── */}
      {result?.isLive && result?.safetyRpId && (
        <s-section>
          <s-banner tone="info">
            <s-stack direction="inline" align="space-between" align-items="center">
              <s-text>
                🛡️ Live theme restored. Safety snapshot #{result.safetyRpId} was automatically saved before making changes.
              </s-text>
              <s-button url={`/app/restore-points/${result.safetyRpId}`} variant="secondary">
                View Snapshot / 1-Click Undo
              </s-button>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {result?.message && !result?.isDraft && !result?.isLive && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* ── Active Theme Backup & Restore Section ── */}
      {activeTab === "theme" && themeData?.activeTheme && (
        <s-section heading="Theme Backup &amp; Code Protection">
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" align="space-between" align-items="center">
                  <s-stack direction="block" gap="tight">
                    <s-stack direction="inline" gap="tight" align="center">
                      <s-text fontWeight="bold">
                        {themeData.activeTheme.name}
                      </s-text>
                      <s-badge tone="success">{themeData.activeTheme.role}</s-badge>
                    </s-stack>
                    <s-text tone="subdued">
                      {themeData.files?.length || 0} critical theme files &amp; settings backed up.
                    </s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="tight" align="center">
                    <s-text tone="subdued">
                      {selectedFiles.length} of {themeData.files?.length || 0} files selected
                    </s-text>
                    <s-button variant="tertiary" onClick={toggleSelectAll}>
                      {selectedFiles.length === (themeData?.files?.length || 0)
                        ? "Deselect All"
                        : "Select All"}
                    </s-button>
                  </s-stack>
                </s-stack>

                {/* File-by-file Checklist & Visual Red/Green Diff Inspector */}
                <s-stack direction="block" gap="tight">
                  <s-text fontWeight="semibold">
                    Protected Files (Inspect Line Diff &amp; Cherry-Pick):
                  </s-text>
                  {filesList.map((f) => {
                    const isSelected = selectedFiles.includes(f.filename);
                    const isExpanded = expandedFile === f.filename;
                    const sizeKb = f.size ? Math.round((f.size / 1024) * 10) / 10 : 0;
                    const hasDiff = f.diff && !f.diff.isIdentical;
                    return (
                      <s-card key={f.filename}>
                        <s-box padding="tight">
                          <s-stack direction="block" gap="tight">
                            <s-stack direction="inline" align="space-between" align-items="center">
                              <s-stack direction="inline" gap="tight" align="center">
                                <input
                                  type="checkbox"
                                  id={`file-${f.filename}`}
                                  checked={isSelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedFiles([...selectedFiles, f.filename]);
                                    } else {
                                      setSelectedFiles(
                                        selectedFiles.filter((name) => name !== f.filename)
                                      );
                                    }
                                  }}
                                />
                                <label
                                  htmlFor={`file-${f.filename}`}
                                  style={{
                                    cursor: "pointer",
                                    fontFamily: "monospace",
                                    fontSize: "13px",
                                  }}
                                >
                                  <strong>{f.filename}</strong>
                                  {sizeKb > 0 ? ` (${sizeKb} KB)` : ""}
                                </label>

                                {f.diff?.isIdentical ? (
                                  <span
                                    style={{
                                      color: "#57606a",
                                      background: "#f1f3f5",
                                      border: "1px solid #d0d7de",
                                      padding: "1px 7px",
                                      borderRadius: "10px",
                                      fontSize: "11px",
                                      fontWeight: "600",
                                    }}
                                  >
                                    ✓ Identical to Live
                                  </span>
                                ) : (
                                  <span style={{ display: "inline-flex", gap: "4px" }}>
                                    {f.diff?.additions > 0 && (
                                      <span
                                        style={{
                                          color: "#1a7f37",
                                          background: "#dafbe1",
                                          border: "1px solid #aceebb",
                                          padding: "1px 6px",
                                          borderRadius: "10px",
                                          fontSize: "11px",
                                          fontWeight: "700",
                                        }}
                                      >
                                        +{f.diff.additions}
                                      </span>
                                    )}
                                    {f.diff?.deletions > 0 && (
                                      <span
                                        style={{
                                          color: "#cf222e",
                                          background: "#ffebe9",
                                          border: "1px solid #ffc1ba",
                                          padding: "1px 6px",
                                          borderRadius: "10px",
                                          fontSize: "11px",
                                          fontWeight: "700",
                                        }}
                                      >
                                        -{f.diff.deletions}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </s-stack>

                              <s-button
                                variant="tertiary"
                                onClick={() => setExpandedFile(isExpanded ? null : f.filename)}
                              >
                                {isExpanded ? "Hide Code Diff ▲" : "View Code Diff ▼"}
                              </s-button>
                            </s-stack>

                            {/* ── Visual Red/Green Line Diff Viewer ── */}
                            {isExpanded && (
                              <div
                                style={{
                                  border: "1px solid #d0d7de",
                                  borderRadius: "6px",
                                  overflow: "hidden",
                                  fontFamily:
                                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                                  fontSize: "12px",
                                  lineHeight: "20px",
                                  background: "#ffffff",
                                  marginTop: "6px",
                                }}
                              >
                                <div
                                  style={{
                                    background: "#f6f8fa",
                                    padding: "6px 12px",
                                    borderBottom: "1px solid #d0d7de",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    fontSize: "11px",
                                    color: "#57606a",
                                    fontWeight: "600",
                                  }}
                                >
                                  <span>
                                    🔴 Red = Lines Removed from Live Theme &nbsp;|&nbsp; 🟢 Green = Backup Lines Restored
                                  </span>
                                  <span>
                                    {hasDiff ? (
                                      <span>
                                        <span style={{ color: "#1a7f37", marginRight: "8px" }}>
                                          +{f.diff.additions} additions
                                        </span>
                                        <span style={{ color: "#cf222e" }}>
                                          -{f.diff.deletions} deletions
                                        </span>
                                      </span>
                                    ) : (
                                      <span style={{ color: "#57606a" }}>100% In Sync with Live</span>
                                    )}
                                  </span>
                                </div>

                                <div style={{ maxHeight: "280px", overflowY: "auto" }}>
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
                                            background: isAdded
                                              ? "#e6ffec"
                                              : isRemoved
                                                ? "#ffebe9"
                                                : isInfo
                                                  ? "#f6f8fa"
                                                  : "#ffffff",
                                            color: isAdded
                                              ? "#1a7f37"
                                              : isRemoved
                                                ? "#cf222e"
                                                : isInfo
                                                  ? "#57606a"
                                                  : "#24292f",
                                            borderBottom: "1px solid #f0f2f5",
                                          }}
                                        >
                                          {/* Line number gutter */}
                                          <div
                                            style={{
                                              width: "42px",
                                              paddingRight: "8px",
                                              textAlign: "right",
                                              color: "#8c959f",
                                              userSelect: "none",
                                              background: isAdded
                                                ? "#ccffd8"
                                                : isRemoved
                                                  ? "#ffd7d5"
                                                  : "#f6f8fa",
                                              borderRight: "1px solid #d0d7de",
                                              flexShrink: 0,
                                              fontSize: "11px",
                                            }}
                                          >
                                            {isRemoved
                                              ? line.oldLineNum
                                              : isAdded
                                                ? line.newLineNum
                                                : line.oldLineNum || line.newLineNum || " "}
                                          </div>

                                          {/* Diff Prefix Marker (+ / -) */}
                                          <div
                                            style={{
                                              width: "22px",
                                              textAlign: "center",
                                              fontWeight: "bold",
                                              userSelect: "none",
                                              color: isAdded
                                                ? "#1a7f37"
                                                : isRemoved
                                                  ? "#cf222e"
                                                  : "#8c959f",
                                              flexShrink: 0,
                                            }}
                                          >
                                            {isAdded ? "+" : isRemoved ? "-" : " "}
                                          </div>

                                          {/* Code Content */}
                                          <div
                                            style={{
                                              paddingLeft: "4px",
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-all",
                                              flexGrow: 1,
                                            }}
                                          >
                                            {line.content || " "}
                                          </div>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <div style={{ padding: "12px", color: "#57606a" }}>
                                      No content diff available.
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </s-stack>
                        </s-box>
                      </s-card>
                    );
                  })}
                </s-stack>

                {/* Dual Action Buttons */}
                <s-stack direction="inline" gap="base" align="center">
                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="restore_theme" />
                    <input type="hidden" name="mode" value="draft" />
                    <input
                      type="hidden"
                      name="selectedFiles"
                      value={JSON.stringify(selectedFiles)}
                    />
                    <s-button
                      submit
                      variant="primary"
                      disabled={selectedFiles.length === 0}
                      {...(isRestoring ? { loading: true } : {})}
                    >
                      🛡️ Restore to Draft Theme (Preview First)
                    </s-button>
                  </fetcher.Form>

                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="restore_theme" />
                    <input type="hidden" name="mode" value="live" />
                    <input
                      type="hidden"
                      name="selectedFiles"
                      value={JSON.stringify(selectedFiles)}
                    />
                    <s-button
                      submit
                      variant="secondary"
                      tone="critical"
                      disabled={selectedFiles.length === 0}
                      {...(isRestoring ? { loading: true } : {})}
                    >
                      ⚡ Instant Restore to Live Theme
                    </s-button>
                  </fetcher.Form>
                </s-stack>

                <s-text tone="subdued" variant="bodySm">
                  💡 <strong>Pro Tip:</strong> Select <strong>&ldquo;Restore to Draft Theme&rdquo;</strong> to safely preview your storefront without risking live store downtime. If restoring directly to live, Revertly will automatically capture a safety snapshot first.
                </s-text>
              </s-stack>
            </s-box>
          </s-card>
        </s-section>
      )}

      {/* ── Collections Backup Section ── */}
      {activeTab === "collections" && collectionData.length > 0 && (
        <s-section heading={`${collectionData.length} Collections Protected`}>
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  All automated smart rules and custom collection settings are preserved. If a collection is accidentally deleted or rules are broken, you can restore it below.
                </s-paragraph>
                <s-resource-list>
                  {collectionData.map((col, idx) => (
                    <s-resource-item key={col.id || idx} id={String(col.id || idx)}>
                      <s-stack direction="inline" align="space-between" align-items="center">
                        <s-stack direction="block" gap="tight">
                          <s-text fontWeight="bold">{col.title}</s-text>
                          <s-text tone="subdued">
                            Handle: /{col.handle} · {col.ruleSet?.rules?.length || 0} smart rules
                          </s-text>
                        </s-stack>
                        <fetcher.Form method="POST">
                          <input type="hidden" name="intent" value="restore_collection" />
                          <input type="hidden" name="colIndex" value={idx} />
                          <s-button submit variant="secondary">
                            Recreate / Restore
                          </s-button>
                        </fetcher.Form>
                      </s-stack>
                    </s-resource-item>
                  ))}
                </s-resource-list>
              </s-stack>
            </s-box>
          </s-card>
        </s-section>
      )}

      {/* ── Content Pages Backup Section ── */}
      {activeTab === "pages" && pageData.length > 0 && (
        <s-section heading={`${pageData.length} Content Pages Protected`}>
          <s-card>
            <s-box padding="base">
              <s-resource-list>
                {pageData.map((p, idx) => (
                  <s-resource-item key={p.id || idx} id={String(p.id || idx)}>
                    <s-stack direction="inline" align="space-between" align-items="center">
                      <s-stack direction="block" gap="tight">
                        <s-text fontWeight="bold">{p.title}</s-text>
                        <s-text tone="subdued">Handle: /{p.handle}</s-text>
                      </s-stack>
                      <fetcher.Form method="POST">
                        <input type="hidden" name="intent" value="restore_page" />
                        <input type="hidden" name="pageIndex" value={idx} />
                        <s-button submit variant="secondary">
                          Restore Page
                        </s-button>
                      </fetcher.Form>
                    </s-stack>
                  </s-resource-item>
                ))}
              </s-resource-list>
            </s-box>
          </s-card>
        </s-section>
      )}

      {/* ── Blogs & Articles Backup Section ── */}
      {activeTab === "articles" && (
        <s-section heading={`${articleData?.articles?.length || 0} Blog Articles Protected`}>
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Protect your store&apos;s SEO rankings, buying guides, and blog content. If an article is accidentally deleted or modified, you can restore it with 1 click.
                </s-paragraph>
                {(!articleData?.articles || articleData.articles.length === 0) ? (
                  <s-empty-state heading="No blog articles found in this restore point">
                    <s-paragraph>Articles published in your Shopify store will appear here in future backups.</s-paragraph>
                  </s-empty-state>
                ) : (
                  <s-resource-list>
                    {articleData.articles.map((art, idx) => (
                      <s-resource-item key={art.id || idx} id={String(art.id || idx)}>
                        <s-stack direction="inline" align="space-between" align-items="center">
                          <s-stack direction="block" gap="tight">
                            <s-stack direction="inline" gap="tight" align="center">
                              <s-text fontWeight="bold">{art.title}</s-text>
                              {art.isPublished ? (
                                <s-badge tone="success">Published</s-badge>
                              ) : (
                                <s-badge tone="subdued">Draft</s-badge>
                              )}
                              {art.blogTitle && <s-badge tone="info">Blog: {art.blogTitle}</s-badge>}
                            </s-stack>
                            <s-text tone="subdued">
                              Handle: /{art.handle} {art.tags?.length > 0 ? `· Tags: ${Array.isArray(art.tags) ? art.tags.join(", ") : art.tags}` : ""}
                            </s-text>
                          </s-stack>
                          <fetcher.Form method="POST">
                            <input type="hidden" name="intent" value="restore_article" />
                            <input type="hidden" name="articleIndex" value={idx} />
                            <s-button submit variant="secondary" {...(isRestoring ? { loading: true } : {})}>
                              Restore Article
                            </s-button>
                          </fetcher.Form>
                        </s-stack>
                      </s-resource-item>
                    ))}
                  </s-resource-list>
                )}
              </s-stack>
            </s-box>
          </s-card>
        </s-section>
      )}

      {/* ── Products Differences & Rollback ── */}
      {activeTab === "products" && (
        <>
          {differences.length > 0 && (
            <s-section>
              <s-card>
                <s-box padding="base">
                  <s-stack direction="inline" align="space-between" align-items="center">
                    <s-stack direction="block" gap="extraTight">
                      <s-text fontWeight="bold">Catalog Differences Detected</s-text>
                      <s-text tone="subdued">
                        {differences.length} product{differences.length !== 1 ? "s differ" : " differs"} from this restore point.
                      </s-text>
                    </s-stack>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="restore" />
                      <s-button
                        submit
                        variant="primary"
                        tone="critical"
                        {...(isRestoring ? { loading: true } : {})}
                      >
                        ⚡ Restore {differences.length} Products to Snapshot
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
                </s-box>
              </s-card>
            </s-section>
          )}

          <s-section
            heading={`${differences.length} products differ from restore point`}
          >
            {differences.length === 0 ? (
              <s-banner tone="success">
                All products match this restore point. No product changes detected.
              </s-banner>
            ) : (
              differences.map((d) => (
                <s-card key={d.productId}>
                  <s-box padding="base">
                    <s-stack direction="block" gap="tight">
                      <s-text fontWeight="bold">{d.title}</s-text>
                      <s-data-table
                        columnContentTypes={["text", "text", "text"]}
                        headings={["Field", "Saved (Restore Point)", "Current"]}
                        rows={d.diffs.map((df) => [df.field, String(df.saved), String(df.current)])}
                      />
                    </s-stack>
                  </s-box>
                </s-card>
              ))
            )}
          </s-section>

          {differences.length > 0 && (
            <s-section>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="restore" />
                <s-stack direction="inline" gap="base">
                  <s-button
                    submit
                    variant="primary"
                    tone="critical"
                    {...(isRestoring ? { loading: true } : {})}
                  >
                    Restore {differences.length} Products to This Point
                  </s-button>
                </s-stack>
              </fetcher.Form>
              <s-paragraph>
                <s-text tone="subdued">
                  Only changed product fields will be restored. Unaffected fields remain unchanged.
                </s-text>
              </s-paragraph>
            </s-section>
          )}
        </>
      )}

      {/* ── Restore History ── */}
      {activeTab === "history" && (
        <s-section heading="Restore History">
          {lastJob ? (
            <s-card>
              <s-box padding="base">
                <s-stack direction="inline" gap="base" align="center">
                  <s-badge
                    tone={
                      lastJob.status === "COMPLETED"
                        ? "success"
                        : lastJob.status === "FAILED"
                          ? "critical"
                          : "attention"
                    }
                  >
                    {lastJob.status}
                  </s-badge>
                  <s-text>
                    {lastJob.successCount}/{lastJob.totalProducts} products restored
                  </s-text>
                  <s-text tone="subdued">{formatTime(lastJob.createdAt)}</s-text>
                </s-stack>
              </s-box>
            </s-card>
          ) : (
            <s-card>
              <s-box padding="base">
                <s-text tone="subdued">No restore operations have been run from this restore point yet.</s-text>
              </s-box>
            </s-card>
          )}
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
