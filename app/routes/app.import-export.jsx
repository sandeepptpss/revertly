import { useState, useRef, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import { importBackupPayload } from "../backup.server.js";
import { checkFeatureAccess } from "../billing.server.js";
import { detectAndParseCsvArchive } from "../utils/csv-portability.js";
import {
  UploadIcon,
  DownloadIcon,
  SaveIcon,
  BoxIcon,
  FileCodeIcon,
  FileTextIcon,
  BookOpenIcon,
  LayersIcon,
  DatabaseIcon,
  ZapIcon,
  CheckCircleIcon,
  ClockIcon,
  AlertTriangleIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { Pagination, usePagination } from "../components/Pagination.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const restorePoints = await prisma.restorePoint.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      backupType: true,
      productCount: true,
      themeCount: true,
      collectionCount: true,
      pageCount: true,
      menuCount: true,
      articleCount: true,
      metafieldCount: true,
      createdAt: true,
    },
    take: 50,
  });

  const metafieldAccess = await checkFeatureAccess(shop, "metafieldBackup");

  return {
    restorePoints,
    hasMetafieldAccess: metafieldAccess.allowed,
  };
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "import") {
      const mode = formData.get("importMode") || "SAVE_AS_RESTORE_POINT";
      const requiredPerm = mode === "RESTORE_NOW" ? PERMISSIONS.RESTORE : PERMISSIONS.BACKUP_CREATE;
      const perm = await checkPermission(shop, session, requiredPerm);
      if (!perm.allowed) return { success: false, message: perm.message };

      let fileContent = formData.get("backupFileContent");
      const fileField = formData.get("backupFile");
      if (fileField && typeof fileField.text === "function") {
        fileContent = await fileField.text();
      }

      if (!fileContent || typeof fileContent !== "string" || !fileContent.trim()) {
        return { success: false, message: "Please select or upload a valid JSON or CSV backup file." };
      }

      let parsed;
      const trimmed = fileContent.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          parsed = JSON.parse(trimmed);
        } catch (parseErr) {
          return { success: false, message: `Invalid JSON file syntax: ${parseErr.message}` };
        }
      } else {
        try {
          const parsedCsv = detectAndParseCsvArchive(fileContent);
          parsed = {
            name: `Imported CSV Archive (${parsedCsv.type})`,
            backupType: parsedCsv.type,
            ...parsedCsv.data,
          };
        } catch (csvErr) {
          return { success: false, message: `Invalid CSV backup file: ${csvErr.message}` };
        }
      }

      const res = await importBackupPayload({
        admin,
        shop,
        payload: parsed,
        mode,
      });

      if (!res.success) {
        return { success: false, message: res.message };
      }

      if (mode === "RESTORE_NOW") {
        try {
          const lr = res.summary?.liveResults || {};
          const totalLiveRestored =
            (lr.collections || 0) +
            (lr.pages || 0) +
            (lr.menus || 0) +
            (lr.articles || 0) +
            (lr.themeStagingCreated ? 1 : 0);

          const rollbackJob = await prisma.rollbackJob.create({
            data: {
              shop,
              restorePointId: res.restorePoint?.id || null,
              status: "COMPLETED",
              totalProducts: totalLiveRestored || 1,
              processedCount: totalLiveRestored || 1,
              successCount: totalLiveRestored || 1,
              failedCount: 0,
              fieldsToRestore: { resourceType: "IMPORT" },
              createdAt: new Date(),
              completedAt: new Date(),
            },
          });

          const importResults = [];
          if (lr.pages > 0) importResults.push({ productId: "import_pages", productTitle: `Import: ${lr.pages} Pages restored live`, status: "SUCCESS" });
          if (lr.menus > 0) importResults.push({ productId: "import_menus", productTitle: `Import: ${lr.menus} Navigation Menus restored live`, status: "SUCCESS" });
          if (lr.collections > 0) importResults.push({ productId: "import_collections", productTitle: `Import: ${lr.collections} Collections restored live`, status: "SUCCESS" });
          if (lr.articles > 0) importResults.push({ productId: "import_articles", productTitle: `Import: ${lr.articles} Articles restored live`, status: "SUCCESS" });
          if (lr.themeStagingCreated) importResults.push({ productId: "import_theme", productTitle: `Import: Staging Theme created with restored files`, status: "SUCCESS" });

          if (importResults.length === 0) {
            importResults.push({
              productId: "import_archive",
              productTitle: `Imported Archive: Items restored live`,
              status: "SUCCESS",
            });
          }

          await prisma.rollbackResult.createMany({
            data: importResults.map((r) => ({
              rollbackJobId: rollbackJob.id,
              productId: r.productId,
              productTitle: r.productTitle,
              status: r.status,
            })),
          });
        } catch (jobErr) {
          console.error("Failed to record import rollback job:", jobErr);
        }
      }

      await logAudit(shop, perm.actor, "DATA_IMPORTED", {
        resourceType: "Import",
        resourceId: res.restorePoint?.id,
        details: { mode, summary: res.summary },
        request,
      });

      return {
        success: true,
        message: res.message,
        summary: res.summary,
        restorePoint: res.restorePoint,
      };
    }

    return { success: false, message: "Unknown action." };
  } catch (err) {
    console.error("Import action error:", err);
    return { success: false, message: err?.message || "An unexpected error occurred during import." };
  }
};

export default function ImportExportHub() {
  const { restorePoints, hasMetafieldAccess = false } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isImporting = fetcher.state !== "idle";

  const {
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    paginatedItems: pagedRestorePoints,
    totalItems: totalRp,
  } = usePagination(restorePoints, 10);

  const [activeTab, setActiveTab] = useState("export"); // "export" | "import"
  const [selectedRpId, setSelectedRpId] = useState("");
  const [filePayload, setFilePayload] = useState(null);
  const [fileStats, setFileStats] = useState(null);
  const [fileError, setFileError] = useState("");
  const [importMode, setImportMode] = useState("SAVE_AS_RESTORE_POINT");
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef(null);

  // Clear loaded file when import succeeds
  useEffect(() => {
    if (result?.success) {
      setFilePayload(null);
      setFileStats(null);
      setFileError("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [result]);

  const selectedRp = restorePoints.find((rp) => String(rp.id) === String(selectedRpId)) || null;

  const processFile = (file) => {
    if (!file) return;
    setFileError("");

    const lowerName = file.name.toLowerCase();
    const isJson = lowerName.endsWith(".json");
    const isCsv = lowerName.endsWith(".csv");

    if (!isJson && !isCsv) {
      setFileError("Only .json backup archives and .csv spreadsheet files are supported for import.");
      setFilePayload(null);
      setFileStats(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;

      if (isCsv) {
        try {
          const parsedCsv = detectAndParseCsvArchive(text);
          const sum = parsedCsv.summary;
          const totalItems =
            sum.products + sum.themes + sum.collections + sum.pages + sum.menus + sum.articles +
            (sum.metafields || 0);

          if (totalItems === 0) {
            setFileError("This CSV file contains no recognizable store assets. Please select a valid Revertly backup CSV file.");
            setFilePayload(null);
            setFileStats(null);
            return;
          }

          setFilePayload(text);
          setFileStats({
            fileName: file.name,
            fileSize: (file.size / 1024).toFixed(1) + " KB",
            sourceShop: "Imported CSV Spreadsheet",
            exportedAt: "Offline CSV File",
            schema: `Revertly CSV (${parsedCsv.type})`,
            fileFormat: "CSV",
            productsCount: sum.products,
            themeFilesCount: sum.themes,
            collectionsCount: sum.collections,
            pagesCount: sum.pages,
            menusCount: sum.menus,
            articlesCount: sum.articles,
            metafieldsCount: sum.metafields || 0,
            definitionsCount: 0,
            // CSV carries metafield values only; definitions need the JSON
            // archive, and the merchant should know before they import.
            metafieldsValuesOnly: (sum.metafields || 0) > 0,
          });
        } catch (err) {
          setFileError(`Failed to parse file as valid CSV: ${err.message}`);
          setFilePayload(null);
          setFileStats(null);
        }
        return;
      }

      try {
        const parsed = JSON.parse(text);

        const storeAssets = parsed.storeAssets || {};
        const prods = Array.isArray(storeAssets.products)
          ? storeAssets.products
          : Array.isArray(parsed.products)
          ? parsed.products
          : Array.isArray(parsed)
          ? parsed
          : [];
        const theme = storeAssets.theme || parsed.theme || null;
        const cols = Array.isArray(storeAssets.collections)
          ? storeAssets.collections
          : Array.isArray(parsed.collections)
          ? parsed.collections
          : [];
        const pgs = Array.isArray(storeAssets.pages)
          ? storeAssets.pages
          : Array.isArray(parsed.pages)
          ? parsed.pages
          : [];
        const menus = Array.isArray(storeAssets.menus)
          ? storeAssets.menus
          : Array.isArray(parsed.menus)
          ? parsed.menus
          : [];
        const arts =
          storeAssets.blogsAndArticles?.articles ||
          parsed.blogsAndArticles?.articles ||
          parsed.articles ||
          [];

        // Accepts the asset key from a full archive, the top-level key from a
        // standalone metafields export, and the raw column name.
        const metafieldDoc = storeAssets.metafields || parsed.metafields || parsed.metafieldData || null;
        const metafieldCount = metafieldDoc?.counts?.metafields || 0;
        const definitionCount = metafieldDoc?.counts?.definitions || 0;

        const themeFilesCount = theme?.files?.length || (theme?.activeTheme ? 1 : 0);
        const totalItems =
          prods.length + themeFilesCount + cols.length + pgs.length + menus.length + arts.length +
          metafieldCount + definitionCount;

        if (totalItems === 0) {
          setFileError("This JSON file contains no recognizable store assets (Products, Themes, Collections, Pages, Menus, Articles, or Metafields). Please select a valid Revertly backup archive.");
          setFilePayload(null);
          setFileStats(null);
          return;
        }

        setFilePayload(text);
        setFileStats({
          fileName: file.name,
          fileSize: (file.size / 1024).toFixed(1) + " KB",
          sourceShop: parsed.shop || "External Store",
          exportedAt: parsed.exportedAt || parsed.createdAt || "Unknown Date",
          schema: parsed._schema || "Standard JSON",
          fileFormat: "JSON",
          productsCount: prods.length,
          themeFilesCount,
          collectionsCount: cols.length,
          pagesCount: pgs.length,
          menusCount: menus.length,
          articlesCount: arts.length,
          metafieldsCount: metafieldCount,
          definitionsCount: definitionCount,
          metafieldsValuesOnly: false,
        });
      } catch (err) {
        setFileError(`Failed to parse file as valid JSON: ${err.message}`);
        setFilePayload(null);
        setFileStats(null);
      }
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    processFile(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    processFile(file);
  };

  const [downloadingType, setDownloadingType] = useState(null);
  const [downloadError, setDownloadError] = useState("");

  const getExportUrl = (type) => {
    const base = `/app/export?type=${type}`;
    if (selectedRpId) return `${base}&rpId=${selectedRpId}`;
    return base;
  };

  const handleDownload = async (type, fallbackFilename) => {
    try {
      setDownloadingType(type);
      setDownloadError("");
      const url = getExportUrl(type);

      // fetch() within Shopify App Bridge automatically attaches Authorization: Bearer <session-token>
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Export request failed with status ${res.status}`);
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
      let filename = fallbackFilename;
      const disposition = res.headers.get("Content-Disposition");
      if (disposition && disposition.includes("filename=")) {
        const matches = disposition.match(/filename="?([^"]+)"?/);
        if (matches && matches[1]) {
          filename = matches[1].replace(/['"]/g, "").trim();
        }
      }

      // Trigger standard browser download of the verified binary/text blob
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
      setDownloadingType(null);
    }
  };

  return (
    <s-page heading="Import &amp; Export Hub" inlineSize="large">

      {/* ── Action Feedback Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Import Operation Succeeded" : "Import Failed"}
          action={
            result.success && result.restorePoint ? (
              <Link to={`/app/restore-points/${result.restorePoint.id}`} className="rv-btn rv-btn-primary rv-btn-sm">
                Inspect Imported Restore Point
              </Link>
            ) : undefined
          }
        >
          {result.message}
        </Banner>
      )}

      {/* ── Hero Banner ── */}
      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Universal Backup Data Portability &amp; Recovery
            </strong>
            <span className="rv-badge rv-badge-success">Encrypted &amp; Verified</span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Export your entire store catalog, theme templates, navigation menus, metafields, and content into offline JSON/CSV files, or upload external Revertly backup archives to restore your store anytime.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Link to="/app/restore-points" className="rv-btn rv-btn-secondary rv-btn-lg">
            <ClockIcon size={16} />
            <span>View Restore Points</span>
          </Link>
        </div>
      </div>

      {/* ── Tab Switcher ── */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        <button
          type="button"
          onClick={() => setActiveTab("export")}
          className={`rv-btn ${activeTab === "export" ? "rv-btn-primary" : "rv-btn-secondary"}`}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 18px", borderRadius: "20px" }}
        >
          <DownloadIcon size={16} />
          <span style={{ fontWeight: 600 }}>Export Store Data (Download)</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("import")}
          className={`rv-btn ${activeTab === "import" ? "rv-btn-primary" : "rv-btn-secondary"}`}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 18px", borderRadius: "20px" }}
        >
          <UploadIcon size={16} />
          <span style={{ fontWeight: 600 }}>Import Backup Archive (Upload)</span>
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* 1. EXPORT SECTION                                                    */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "export" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Source Selector Bar */}
          {downloadError && (
            <Banner tone="critical" title="Export Download Error">
              {downloadError}
            </Banner>
          )}

          <div className="rv-card">
            <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "14px" }}>
                <div>
                  <strong style={{ fontSize: "14px", display: "block" }}>Export Data Source</strong>
                  <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    Choose whether to download the latest live store state or a historical snapshot point in time.
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <label htmlFor="rp-select" style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>Snapshot:</label>
                  <select
                    id="rp-select"
                    className="rv-input"
                    style={{ minWidth: "300px" }}
                    value={selectedRpId}
                    onChange={(e) => setSelectedRpId(e.target.value)}
                  >
                    <option value="">Latest Live Store Data (Current)</option>
                    {restorePoints.map((rp) => (
                      <option key={rp.id} value={rp.id}>
                        #{rp.id} - {rp.name} ({new Date(rp.createdAt).toLocaleDateString()})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Contextual Snapshot Details */}
              {selectedRp ? (
                <div style={{ padding: "12px 16px", background: "var(--rv-surface-subdued)", borderRadius: "8px", border: "1px solid var(--rv-border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span className="rv-badge rv-badge-info">Snapshot #{selectedRp.id}</span>
                    <strong style={{ fontSize: "13px" }}>{selectedRp.name}</strong>
                    <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                      Captured {new Date(selectedRp.createdAt).toLocaleString()} ({selectedRp.backupType})
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", fontSize: "11px" }}>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.productCount} Products</span>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.themeCount} Themes</span>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.collectionCount} Collections</span>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.pageCount} Pages</span>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.menuCount || 0} Menus</span>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.articleCount || 0} Articles</span>
                    <span className="rv-badge rv-badge-neutral">{selectedRp.metafieldCount || 0} Metafields</span>
                  </div>
                </div>
              ) : (
                <div style={{ padding: "10px 14px", background: "var(--rv-primary-surface)", borderRadius: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="rv-badge rv-badge-success">Live Store Active</span>
                  <span style={{ fontSize: "12px", color: "var(--rv-text)" }}>
                    Exports will be generated directly from your live active Shopify store data.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Export Options Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "16px",
            }}
          >
            {/* 1. Complete Disaster Recovery Backup */}
            <div className="rv-card" style={{ border: "2px solid var(--rv-primary)", margin: 0 }}>
              <div className="rv-card-header" style={{ background: "var(--rv-primary-surface)" }}>
                <h3 className="rv-card-title" style={{ color: "var(--rv-primary-text)", display: "flex", alignItems: "center", gap: "8px" }}>
                  <SaveIcon size={18} />
                  <span>Complete Store Disaster Recovery Archive</span>
                </h3>
                <span className="rv-badge rv-badge-success">
                  {selectedRp ? `Snapshot #${selectedRp.id} JSON` : "Live JSON"}
                </span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  The definitive backup archive. Bundles Products, Liquid Themes, Collections, Pages, Navigation Menus, Blog Articles, and Metafields into an encrypted portable JSON file.
                </p>
                <button
                  type="button"
                  disabled={downloadingType === "full_json"}
                  onClick={() =>
                    handleDownload(
                      "full_json",
                      selectedRp ? `revertly-backup-rp${selectedRp.id}.json` : "revertly-live-backup.json"
                    )
                  }
                  className="rv-btn rv-btn-primary rv-btn-lg"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={16} />
                  <span>
                    {downloadingType === "full_json"
                      ? "Downloading..."
                      : selectedRp
                      ? `Download Snapshot #${selectedRp.id} Archive (.json)`
                      : "Download Complete Live Backup (.json)"}
                  </span>
                </button>
              </div>
            </div>

            {/* 2. Product Catalog (CSV & JSON) */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <BoxIcon size={18} style={{ color: "#0ea5e9" }} />
                  <span>Products Catalog</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${selectedRp.productCount > 0 ? "rv-badge-info" : "rv-badge-neutral"}`}>
                    {selectedRp.productCount} in snapshot
                  </span>
                ) : (
                  <span className="rv-badge rv-badge-info">CSV &amp; JSON</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export your product catalog with variant pricing, inventory policies, tags, and metafields. Available in spreadsheet-friendly CSV or developer JSON.
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    disabled={downloadingType === "products_csv"}
                    onClick={() => handleDownload("products_csv", "revertly-products.csv")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "products_csv" ? "Downloading..." : "CSV Spreadsheet"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingType === "products_json"}
                    onClick={() => handleDownload("products_json", "revertly-products.json")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "products_json" ? "Downloading..." : "JSON Raw"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 3. Themes Backup */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <FileCodeIcon size={18} style={{ color: "#8b5cf6" }} />
                  <span>Themes &amp; Liquid Templates</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${selectedRp.themeCount > 0 ? "rv-badge-success" : "rv-badge-neutral"}`}>
                    {selectedRp.themeCount > 0 ? "1 theme saved" : "0 in snapshot"}
                  </span>
                ) : (
                  <span className="rv-badge rv-badge-neutral">JSON</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all theme layouts, Liquid template files, settings_data.json, and sections. Perfect for sharing with developers or auditing template modifications.
                </p>
                <button
                  type="button"
                  disabled={downloadingType === "themes_json"}
                  onClick={() => handleDownload("themes_json", "revertly-themes.json")}
                  className="rv-btn rv-btn-secondary"
                  style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={14} />
                  <span>{downloadingType === "themes_json" ? "Downloading..." : "Download Themes Backup (.json)"}</span>
                </button>
              </div>
            </div>

            {/* 4. Collections */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <LayersIcon size={18} style={{ color: "#10b981" }} />
                  <span>Collections (Smart &amp; Manual)</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${selectedRp.collectionCount > 0 ? "rv-badge-info" : "rv-badge-neutral"}`}>
                    {selectedRp.collectionCount} in snapshot
                  </span>
                ) : (
                  <span className="rv-badge rv-badge-info">CSV &amp; JSON</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all smart collection condition rules, rule sets, sorting priorities, and custom collection memberships.
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    disabled={downloadingType === "collections_csv"}
                    onClick={() => handleDownload("collections_csv", "revertly-collections.csv")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "collections_csv" ? "Downloading..." : "CSV Spreadsheet"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingType === "collections_json"}
                    onClick={() => handleDownload("collections_json", "revertly-collections.json")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "collections_json" ? "Downloading..." : "JSON Raw"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 5. Pages & Menus */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <FileTextIcon size={18} style={{ color: "#f59e0b" }} />
                  <span>Pages &amp; Navigation Menus</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${selectedRp.pageCount > 0 ? "rv-badge-info" : "rv-badge-neutral"}`}>
                    {selectedRp.pageCount} pages, {selectedRp.menuCount || 0} menus
                  </span>
                ) : (
                  <span className="rv-badge rv-badge-info">CSV &amp; JSON</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all content pages (Terms, Privacy, About, Landing pages) and online store navigation menu trees.
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    disabled={downloadingType === "pages_csv"}
                    onClick={() => handleDownload("pages_csv", "revertly-pages-menus.csv")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "pages_csv" ? "Downloading..." : "CSV Spreadsheet"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingType === "pages_json"}
                    onClick={() => handleDownload("pages_json", "revertly-pages-menus.json")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "pages_json" ? "Downloading..." : "JSON Raw"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 6. Blogs & Articles */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <BookOpenIcon size={18} style={{ color: "#ec4899" }} />
                  <span>Blogs &amp; Articles</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${(selectedRp.articleCount || 0) > 0 ? "rv-badge-info" : "rv-badge-neutral"}`}>
                    {selectedRp.articleCount || 0} articles
                  </span>
                ) : (
                  <span className="rv-badge rv-badge-info">CSV &amp; JSON</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all published and draft blog articles, tags, authors, summaries, and HTML article bodies for safe archiving.
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    disabled={downloadingType === "blogs_csv"}
                    onClick={() => handleDownload("blogs_csv", "revertly-blogs-articles.csv")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "blogs_csv" ? "Downloading..." : "CSV Spreadsheet"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingType === "blogs_json"}
                    onClick={() => handleDownload("blogs_json", "revertly-blogs-articles.json")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "blogs_json" ? "Downloading..." : "JSON Raw"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 7. Navigation Menus (Standalone) */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <ZapIcon size={18} style={{ color: "#6366f1" }} />
                  <span>Navigation Menus</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${(selectedRp.menuCount || 0) > 0 ? "rv-badge-info" : "rv-badge-neutral"}`}>
                    {selectedRp.menuCount || 0} menus
                  </span>
                ) : (
                  <span className="rv-badge rv-badge-info">CSV &amp; JSON</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export header, footer and custom menus on their own — titles, links, and the full nested item
                  hierarchy — without the pages they normally ship with.
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    disabled={downloadingType === "menus_csv"}
                    onClick={() => handleDownload("menus_csv", "revertly-menus.csv")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "menus_csv" ? "Downloading..." : "CSV Spreadsheet"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingType === "menus_json"}
                    onClick={() => handleDownload("menus_json", "revertly-menus.json")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>{downloadingType === "menus_json" ? "Downloading..." : "JSON Raw"}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 8. Metafields */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <DatabaseIcon size={18} style={{ color: "#14b8a6" }} />
                  <span>Metafields &amp; Definitions</span>
                </h3>
                {selectedRp ? (
                  <span className={`rv-badge ${(selectedRp.metafieldCount || 0) > 0 ? "rv-badge-info" : "rv-badge-neutral"}`}>
                    {selectedRp.metafieldCount || 0} metafields
                  </span>
                ) : hasMetafieldAccess ? (
                  <span className="rv-badge rv-badge-success">Featured</span>
                ) : (
                  <span className="rv-badge rv-badge-warning">Growth+</span>
                )}
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export shop, product, collection, page, blog and article metafields. JSON carries the metafield
                  definitions too; CSV is a values-only spreadsheet.
                </p>
                {!selectedRp && !hasMetafieldAccess ? (
                  <Link
                    to="/app/plan"
                    className="rv-btn rv-btn-secondary"
                    style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <span>Upgrade to Export Metafields</span>
                  </Link>
                ) : (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      disabled={downloadingType === "metafields_csv"}
                      onClick={() => handleDownload("metafields_csv", "revertly-metafields.csv")}
                      className="rv-btn rv-btn-secondary"
                      style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                    >
                      <DownloadIcon size={14} />
                      <span>{downloadingType === "metafields_csv" ? "Downloading..." : "CSV Values"}</span>
                    </button>
                    <button
                      type="button"
                      disabled={downloadingType === "metafields_json"}
                      onClick={() => handleDownload("metafields_json", "revertly-metafields.json")}
                      className="rv-btn rv-btn-secondary"
                      style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                    >
                      <DownloadIcon size={14} />
                      <span>{downloadingType === "metafields_json" ? "Downloading..." : "JSON Full"}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Available Backups Table with Pagination */}
          <div className="rv-card" style={{ marginTop: "12px", border: "1px solid var(--rv-border)" }}>
            <div className="rv-card-header">
              <h3 className="rv-card-title">
                <ClockIcon size={18} />
                <span>Available Backups for Export ({restorePoints.length})</span>
              </h3>
            </div>
            <div className="rv-card-body">
              {restorePoints.length === 0 ? (
                <div style={{ textAlign: "center", padding: "16px", color: "var(--rv-text-subdued)", fontSize: "13px" }}>
                  No snapshots captured yet. Backups will appear here once created.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="rv-table" style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        <th>Snapshot Name</th>
                        <th>Created Date</th>
                        <th>Type</th>
                        <th>Contents</th>
                        <th style={{ textAlign: "right" }}>Selection</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRestorePoints.map((rp) => (
                        <tr key={rp.id}>
                          <td>
                            <strong>#{rp.id}</strong> - {rp.name}
                          </td>
                          <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>
                            {new Date(rp.createdAt).toLocaleDateString()}
                          </td>
                          <td>
                            <span className="rv-badge rv-badge-sm rv-badge-info">{rp.backupType || "FULL"}</span>
                          </td>
                          <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            {rp.productCount} products · {rp.themeCount} themes · {rp.menuCount || 0} menus ·{" "}
                            {rp.metafieldCount || 0} metafields
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              type="button"
                              onClick={() => setSelectedRpId(String(rp.id))}
                              className={`rv-btn rv-btn-sm ${selectedRpId === String(rp.id) ? "rv-btn-primary" : "rv-btn-secondary"}`}
                            >
                              {selectedRpId === String(rp.id) ? "Selected" : "Select for Export"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Pagination
                currentPage={currentPage}
                totalItems={totalRp}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={setPageSize}
                itemLabel="backups"
              />
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* 2. IMPORT SECTION                                                    */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "import" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* File Upload & Dropzone Card */}
          <div className="rv-card">
            <div className="rv-card-header">
              <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <UploadIcon size={18} style={{ color: "var(--rv-primary)" }} />
                <span>Upload Revertly Backup Archive (.json or .csv)</span>
              </h3>
            </div>

            <div className="rv-card-body">
              {fileError && (
                <Banner tone="critical" title="File Validation Error">
                  {fileError}
                </Banner>
              )}

              {/* Interactive Drag & Drop Area */}
              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: "100%",
                  border: isDragging ? "2px dashed var(--rv-primary)" : "2px dashed var(--rv-border)",
                  borderRadius: "12px",
                  padding: "36px 20px",
                  textAlign: "center",
                  background: isDragging ? "var(--rv-primary-surface)" : "var(--rv-surface-subdued)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  outline: "none",
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.csv,text/csv,application/json"
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
                <div style={{ display: "inline-flex", padding: "14px", borderRadius: "50%", background: isDragging ? "var(--rv-primary)" : "var(--rv-primary-surface)", color: isDragging ? "#fff" : "var(--rv-primary)", marginBottom: "14px", transition: "all 0.2s ease" }}>
                  <UploadIcon size={28} />
                </div>
                <h4 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: 600, color: "var(--rv-text)" }}>
                  {isDragging ? "Drop your Revertly backup JSON or CSV file here..." : "Click to choose file or drag & drop here"}
                </h4>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                  Upload a previously exported Revertly backup file (.json or .csv) to inspect, stage, or restore.
                </p>
              </div>

              {/* Verified File Inspector */}
              {fileStats && (
                <div style={{ marginTop: "24px", padding: "18px", borderRadius: "8px", background: "var(--rv-surface)", border: "1px solid var(--rv-border)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <CheckCircleIcon size={18} style={{ color: "var(--rv-success)" }} />
                      <strong style={{ fontSize: "15px" }}>{fileStats.fileName}</strong>
                      <span className="rv-badge rv-badge-success rv-badge-sm">
                        {fileStats.fileFormat === "CSV" ? "Validated CSV Archive" : "Validated Archive"}
                      </span>
                    </div>
                    <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                      Size: {fileStats.fileSize} · Source: {fileStats.sourceShop} · Schema: {fileStats.schema}
                    </span>
                  </div>

                  {/* Complete 6-Asset Counter Grid */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
                      gap: "10px",
                      marginBottom: "20px",
                    }}
                  >
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Products</span>
                      <strong style={{ fontSize: "16px", color: fileStats.productsCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.productsCount}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Theme Files</span>
                      <strong style={{ fontSize: "16px", color: fileStats.themeFilesCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.themeFilesCount}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Collections</span>
                      <strong style={{ fontSize: "16px", color: fileStats.collectionsCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.collectionsCount}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Pages</span>
                      <strong style={{ fontSize: "16px", color: fileStats.pagesCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.pagesCount}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Menus</span>
                      <strong style={{ fontSize: "16px", color: fileStats.menusCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.menusCount}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Articles</span>
                      <strong style={{ fontSize: "16px", color: fileStats.articlesCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.articlesCount}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Metafields</span>
                      <strong style={{ fontSize: "16px", color: fileStats.metafieldsCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.metafieldsCount || 0}
                      </strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Definitions</span>
                      <strong style={{ fontSize: "16px", color: fileStats.definitionsCount > 0 ? "var(--rv-text)" : "var(--rv-text-subdued)" }}>
                        {fileStats.definitionsCount || 0}
                      </strong>
                    </div>
                  </div>

                  {fileStats.metafieldsValuesOnly && (
                    <div style={{ marginBottom: "16px", padding: "10px 14px", borderRadius: "6px", background: "#eff6ff", color: "#1e40af", display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                      <AlertTriangleIcon size={16} />
                      <span>
                        This CSV carries metafield <strong>values</strong> only. Metafield definitions are not part of
                        the CSV format — import the JSON archive if you need them.
                      </span>
                    </div>
                  )}

                  {/* Mode Selector */}
                  <div style={{ marginBottom: "20px", padding: "16px", borderRadius: "8px", background: "var(--rv-surface-subdued)", border: "1px solid var(--rv-border)" }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "10px" }}>
                      Select How to Handle This Imported Backup:
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      <label htmlFor="mode-save" style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                        <input
                          id="mode-save"
                          type="radio"
                          name="mode_select"
                          checked={importMode === "SAVE_AS_RESTORE_POINT"}
                          onChange={() => setImportMode("SAVE_AS_RESTORE_POINT")}
                          style={{ marginTop: "3px" }}
                        />
                        <div>
                          <strong style={{ fontSize: "13px" }}>Stage as Restore Point (Zero Risk / Recommended)</strong>
                          <span style={{ display: "block", fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                            Saves the archive securely into your Restore Points list without modifying your live store. You can inspect diffs, audit items, and selectively restore anytime.
                          </span>
                        </div>
                      </label>

                      <label htmlFor="mode-restore" style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                        <input
                          id="mode-restore"
                          type="radio"
                          name="mode_select"
                          checked={importMode === "RESTORE_NOW"}
                          onChange={() => setImportMode("RESTORE_NOW")}
                          style={{ marginTop: "3px" }}
                        />
                        <div>
                          <strong style={{ fontSize: "13px", color: "var(--rv-primary)" }}>Direct Live Restore (Immediate Action)</strong>
                          <span style={{ display: "block", fontSize: "12px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                            Immediately restores Collections, Pages, Menus, and Articles into Shopify, creates a preview staging theme, and syncs product snapshots. Metafields are restored in safe mode: only values missing from your live store are written, so nothing currently set is overwritten.
                          </span>
                        </div>
                      </label>
                    </div>

                    {importMode === "RESTORE_NOW" && (
                      <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "6px", background: "#fef3c7", color: "#92400e", display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                        <AlertTriangleIcon size={16} />
                        <span>Direct Live Restore modifies active store resources in Shopify. Ensure you have reviewed the file stats before proceeding.</span>
                      </div>
                    )}
                  </div>

                  {/* Submission Form */}
                  <fetcher.Form method="POST" encType="multipart/form-data">
                    <input type="hidden" name="intent" value="import" />
                    <input type="hidden" name="importMode" value={importMode} />
                    <input type="hidden" name="backupFileContent" value={filePayload} />

                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <button
                        type="submit"
                        disabled={isImporting}
                        className="rv-btn rv-btn-primary rv-btn-lg"
                      >
                        <UploadIcon size={16} />
                        <span>
                          {isImporting
                            ? "Importing &amp; Processing..."
                            : importMode === "RESTORE_NOW"
                            ? "Execute Live Restore"
                            : "Save to Restore Points"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setFilePayload(null);
                          setFileStats(null);
                          setFileError("");
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        className="rv-btn rv-btn-secondary"
                      >
                        Clear File
                      </button>
                    </div>
                  </fetcher.Form>
                </div>
              )}
            </div>
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
