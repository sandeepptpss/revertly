import { useState } from "react";
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
      {/* ── Top Header Hero Banner ── */}
      <div className="rv-hero-banner" style={{ padding: "16px 20px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
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
            <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>
              🕒 Created: {formatTime(restorePoint.createdAt)}
            </span>
            <span className="rv-badge rv-badge-info">{savedCount} Products</span>
            {themeData?.activeTheme && (
              <span className="rv-badge rv-badge-success">Theme: {themeData.activeTheme.name}</span>
            )}
            {collectionData.length > 0 && (
              <span className="rv-badge rv-badge-info">{collectionData.length} Collections</span>
            )}
            {pageData.length > 0 && (
              <span className="rv-badge rv-badge-neutral">{pageData.length} Pages</span>
            )}
            {articleData?.articles?.length > 0 && (
              <span className="rv-badge rv-badge-success">{articleData.articles.length} Articles</span>
            )}
          </div>
          {restorePoint.description && (
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
              {restorePoint.description}
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <a
            href={`/app/restore-points/${restorePoint.id}/export`}
            className="rv-btn rv-btn-secondary"
            style={{ fontSize: "13px" }}
          >
            ⬇️ Download Offline Backup (.json)
          </a>
          <Link to="/app/restore-points" className="rv-btn rv-btn-subtle" style={{ fontSize: "13px" }}>
            ← All Restore Points
          </Link>
        </div>
      </div>

      {/* ── Navigation Pills ── */}
      <div className="rv-pills-row">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`rv-pill ${activeTab === tab.id ? "rv-pill-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Draft Staging Preview Banner ── */}
      {result?.isDraft && result?.previewUrl && (
        <div
          style={{
            background: "var(--rv-primary-surface)",
            border: "1px solid var(--rv-primary-border)",
            borderRadius: "var(--rv-radius-md)",
            padding: "16px 20px",
            marginBottom: "20px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <span style={{ fontSize: "18px" }}>🎉</span>
            <strong style={{ color: "var(--rv-primary)", fontSize: "15px" }}>
              Draft Staging Theme Created: &ldquo;{result.draftThemeName}&rdquo;
            </strong>
          </div>
          <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--rv-text)" }}>
            Your backed-up theme files were safely deployed into an <strong>unpublished draft theme</strong> ({result.filesRestored} files restored). Your live storefront is 100% untouched!
          </p>
          <div style={{ display: "flex", gap: "10px" }}>
            <a
              href={result.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rv-btn rv-btn-primary"
              style={{ fontSize: "13px" }}
            >
              Open Storefront Preview ↗
            </a>
            {result.editorUrl && (
              <a
                href={result.editorUrl}
                target="_blank"
                rel="noreferrer"
                className="rv-btn rv-btn-secondary"
                style={{ fontSize: "13px" }}
              >
                Open in Theme Customizer ↗
              </a>
            )}
          </div>
        </div>
      )}

      {/* ── Live Safety Snapshot Banner ── */}
      {result?.isLive && result?.safetyRpId && (
        <div
          style={{
            background: "var(--rv-info-surface)",
            border: "1px solid var(--rv-info-border)",
            borderRadius: "var(--rv-radius-md)",
            padding: "14px 18px",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "13px", color: "#0045a1" }}>
            🛡️ Live theme restored. Safety snapshot #{result.safetyRpId} was automatically saved before making changes.
          </span>
          <Link
            to={`/app/restore-points/${result.safetyRpId}`}
            className="rv-btn rv-btn-secondary"
            style={{ fontSize: "12px" }}
          >
            View Snapshot / 1-Click Undo
          </Link>
        </div>
      )}

      {/* ── Generic Message Banner ── */}
      {result?.message && !result?.isDraft && !result?.isLive && (
        <div
          style={{
            background: result.success ? "var(--rv-primary-surface)" : "var(--rv-critical-surface)",
            border: `1px solid ${result.success ? "var(--rv-primary-border)" : "var(--rv-critical-border)"}`,
            color: result.success ? "var(--rv-primary)" : "var(--rv-critical)",
            padding: "14px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>{result.success ? "✅" : "⚠️"}</span>
          <span>{result.message}</span>
        </div>
      )}

      {/* ── Active Theme Backup & Restore Section ── */}
      {activeTab === "theme" && themeData?.activeTheme && (
        <div className="rv-card">
          <div className="rv-card-header">
            <div>
              <h3 className="rv-card-title">
                <span>🎨</span> {themeData.activeTheme.name}
              </h3>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                {themeData.files?.length || 0} critical theme files &amp; settings backed up ({themeData.activeTheme.role} theme).
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                {selectedFiles.length} of {themeData.files?.length || 0} files selected
              </span>
              <button type="button" onClick={toggleSelectAll} className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
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
                      padding: "12px 14px",
                      background: isSelected ? "#fcfdfd" : "#fafbfb",
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
                          style={{ cursor: "pointer", fontFamily: "monospace", fontSize: "13px" }}
                        >
                          <strong>{f.filename}</strong>
                          {sizeKb > 0 ? ` (${sizeKb} KB)` : ""}
                        </label>

                        {f.diff?.isIdentical ? (
                          <span className="rv-badge rv-badge-neutral" style={{ fontSize: "11px" }}>
                            ✓ Identical to Live
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: "4px" }}>
                            {f.diff?.additions > 0 && (
                              <span className="rv-badge rv-badge-success" style={{ fontSize: "11px" }}>
                                +{f.diff.additions}
                              </span>
                            )}
                            {f.diff?.deletions > 0 && (
                              <span className="rv-badge rv-badge-critical" style={{ fontSize: "11px" }}>
                                -{f.diff.deletions}
                              </span>
                            )}
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => setExpandedFile(isExpanded ? null : f.filename)}
                        className="rv-btn rv-btn-subtle"
                        style={{ fontSize: "12px" }}
                      >
                        {isExpanded ? "Hide Code Diff ▲" : "View Code Diff ▼"}
                      </button>
                    </div>

                    {isExpanded && (
                      <div
                        style={{
                          border: "1px solid #d0d7de",
                          borderRadius: "6px",
                          overflow: "hidden",
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          fontSize: "12px",
                          lineHeight: "20px",
                          background: "#ffffff",
                          marginTop: "10px",
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
                          <span>🔴 Red = Lines Removed &nbsp;|&nbsp; 🟢 Green = Backup Lines Restored</span>
                          <span>
                            {hasDiff ? (
                              <span>
                                <span style={{ color: "#1a7f37", marginRight: "8px" }}>+{f.diff.additions} additions</span>
                                <span style={{ color: "#cf222e" }}>-{f.diff.deletions} deletions</span>
                              </span>
                            ) : (
                              <span>100% In Sync with Live</span>
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
                                    background: isAdded ? "#e6ffec" : isRemoved ? "#ffebe9" : isInfo ? "#f6f8fa" : "#ffffff",
                                    color: isAdded ? "#1a7f37" : isRemoved ? "#cf222e" : isInfo ? "#57606a" : "#24292f",
                                    borderBottom: "1px solid #f0f2f5",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: "42px",
                                      paddingRight: "8px",
                                      textAlign: "right",
                                      color: "#8c959f",
                                      userSelect: "none",
                                      background: isAdded ? "#ccffd8" : isRemoved ? "#ffd7d5" : "#f6f8fa",
                                      borderRight: "1px solid #d0d7de",
                                      flexShrink: 0,
                                      fontSize: "11px",
                                    }}
                                  >
                                    {isRemoved ? line.oldLineNum : isAdded ? line.newLineNum : line.oldLineNum || line.newLineNum || " "}
                                  </div>
                                  <div style={{ width: "22px", textAlign: "center", fontWeight: "bold", userSelect: "none", flexShrink: 0 }}>
                                    {isAdded ? "+" : isRemoved ? "-" : " "}
                                  </div>
                                  <div style={{ paddingLeft: "4px", whiteSpace: "pre-wrap", wordBreak: "break-all", flexGrow: 1 }}>
                                    {line.content || " "}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div style={{ padding: "12px", color: "#57606a" }}>No content diff available.</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Dual Safe Theme Restore Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", paddingTop: "12px", borderTop: "1px solid var(--rv-border)" }}>
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="restore_theme" />
                <input type="hidden" name="mode" value="draft" />
                <input type="hidden" name="selectedFiles" value={JSON.stringify(selectedFiles)} />
                <button
                  type="submit"
                  disabled={selectedFiles.length === 0 || isRestoring}
                  className="rv-btn rv-btn-primary"
                  style={{ fontWeight: 600 }}
                >
                  🛡️ Restore to Draft Theme (Safe Preview First)
                </button>
              </fetcher.Form>

              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="restore_theme" />
                <input type="hidden" name="mode" value="live" />
                <input type="hidden" name="selectedFiles" value={JSON.stringify(selectedFiles)} />
                <button
                  type="submit"
                  disabled={selectedFiles.length === 0 || isRestoring}
                  className="rv-btn rv-btn-secondary"
                  style={{ color: "var(--rv-critical)" }}
                  onClick={(e) => {
                    if (!confirm("Restore directly to live storefront? A safety backup will be captured first.")) {
                      e.preventDefault();
                    }
                  }}
                >
                  ⚡ Instant Restore to Live Theme
                </button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      )}

      {/* ── Collections Backup Section ── */}
      {activeTab === "collections" && collectionData.length > 0 && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>🗂️</span> Protected Collections ({collectionData.length})
            </h3>
          </div>
          <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Collection Title</th>
                  <th>Handle</th>
                  <th>Rules Preserved</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {collectionData.map((col, idx) => (
                  <tr key={col.id || idx}>
                    <td style={{ fontWeight: 600 }}>{col.title}</td>
                    <td style={{ color: "var(--rv-text-subdued)" }}>/{col.handle}</td>
                    <td>
                      <span className="rv-badge rv-badge-info">
                        {col.ruleSet?.rules?.length || 0} smart rules
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <fetcher.Form method="POST" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="restore_collection" />
                        <input type="hidden" name="colIndex" value={idx} />
                        <button type="submit" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px", padding: "6px 12px" }}>
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
              <span>📄</span> Protected Content Pages ({pageData.length})
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
                        <button type="submit" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px", padding: "6px 12px" }}>
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
              <span>📝</span> Protected Blog Articles ({articleData?.articles?.length || 0})
            </h3>
          </div>
          {(!articleData?.articles || articleData.articles.length === 0) ? (
            <div className="rv-empty-state" style={{ border: "none" }}>
              <div className="rv-empty-icon-circle">📝</div>
              <div className="rv-empty-title">No blog articles in this restore point</div>
              <div className="rv-empty-desc">Published articles will appear here automatically in future restore points.</div>
            </div>
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
                        <span className={`rv-badge ${art.isPublished ? "rv-badge-success" : "rv-badge-neutral"}`}>
                          {art.isPublished ? "Published" : "Draft"}
                        </span>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)" }}>{art.blogTitle || "Blog"}</td>
                      <td style={{ textAlign: "right" }}>
                        <fetcher.Form method="POST" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="restore_article" />
                          <input type="hidden" name="articleIndex" value={idx} />
                          <button type="submit" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px", padding: "6px 12px" }}>
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

      {/* ── Products Differences & Rollback ── */}
      {activeTab === "products" && (
        <div>
          {differences.length > 0 && (
            <div
              className="rv-card"
              style={{
                borderLeft: "4px solid var(--rv-critical)",
                background: "#fffaf9",
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
                    Catalog Drift Detected: {differences.length} Products Differ
                  </strong>
                  <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                    These products were modified since this snapshot was taken. Reverting will restore only modified fields.
                  </p>
                </div>
                <fetcher.Form method="POST">
                  <input type="hidden" name="intent" value="restore" />
                  <button
                    type="submit"
                    disabled={isRestoring}
                    className="rv-btn rv-btn-critical"
                    style={{ fontWeight: 600 }}
                  >
                    {isRestoring ? "Restoring products..." : `⚡ Restore ${differences.length} Products to Snapshot`}
                  </button>
                </fetcher.Form>
              </div>
            </div>
          )}

          {differences.length === 0 ? (
            <div className="rv-empty-state">
              <div className="rv-empty-icon-circle" style={{ background: "#e8f5e9", color: "#16a34a" }}>
                ✓
              </div>
              <div className="rv-empty-title">100% In Sync with Restore Point</div>
              <div className="rv-empty-desc">
                All products in your catalog match this restore point. No price drops or discrepancy diffs detected.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {differences.map((d) => (
                <div key={d.productId} className="rv-card" style={{ margin: 0 }}>
                  <div className="rv-card-header" style={{ background: "#fafbfb" }}>
                    <h4 className="rv-card-title">
                      <span>📦</span> {d.title}
                    </h4>
                    <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                      Product #{d.productId}
                    </span>
                  </div>
                  <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
                    <table className="rv-table">
                      <thead>
                        <tr>
                          <th style={{ width: "200px" }}>Field</th>
                          <th>Saved in Restore Point (Target)</th>
                          <th style={{ width: "20px" }}></th>
                          <th>Current Live Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.diffs.map((df, dfIdx) => (
                          <tr key={dfIdx}>
                            <td style={{ fontWeight: 600 }}>{df.field}</td>
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

      {/* ── Restore History ── */}
      {activeTab === "history" && (
        <div className="rv-card">
          <div className="rv-card-header">
            <h3 className="rv-card-title">
              <span>🕒</span> Restore Operations Run
            </h3>
          </div>
          <div className="rv-card-body">
            {lastJob ? (
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span className={`rv-badge ${lastJob.status === "COMPLETED" ? "rv-badge-success" : "rv-badge-critical"}`}>
                  {lastJob.status}
                </span>
                <span style={{ fontSize: "13px", fontWeight: 600 }}>
                  {lastJob.successCount}/{lastJob.totalProducts} products restored
                </span>
                <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Executed: {formatTime(lastJob.createdAt)}
                </span>
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                No restore operations have been run from this restore point yet.
              </p>
            )}
          </div>
        </div>
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
