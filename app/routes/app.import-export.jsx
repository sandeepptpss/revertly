import { useState, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import { importBackupPayload } from "../backup.server.js";
import {
  UploadIcon,
  DownloadIcon,
  SaveIcon,
  BoxIcon,
  FileCodeIcon,
  FileTextIcon,
  BookOpenIcon,
  LayersIcon,
  CheckCircleIcon,
  ClockIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";

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
      articleCount: true,
      createdAt: true,
    },
    take: 25,
  });

  return {
    restorePoints,
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

      const jsonString = formData.get("backupFileContent");

      if (!jsonString || typeof jsonString !== "string" || !jsonString.trim()) {
        return { success: false, message: "Please select or upload a valid JSON backup file." };
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch (parseErr) {
        return { success: false, message: `Invalid JSON file syntax: ${parseErr.message}` };
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
  const { restorePoints } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isImporting = fetcher.state !== "idle";

  const [activeTab, setActiveTab] = useState("export"); // "export" | "import"
  const [selectedRpId, setSelectedRpId] = useState("");
  const [filePayload, setFilePayload] = useState(null);
  const [fileStats, setFileStats] = useState(null);
  const [fileError, setFileError] = useState("");
  const [importMode, setImportMode] = useState("SAVE_AS_RESTORE_POINT");

  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError("");

    if (!file.name.endsWith(".json")) {
      setFileError("Only .json backup files are supported for import.");
      setFilePayload(null);
      setFileStats(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        const parsed = JSON.parse(text);

        const storeAssets = parsed.storeAssets || {};
        const prods = Array.isArray(storeAssets.products)
          ? storeAssets.products
          : Array.isArray(parsed.products)
          ? parsed.products
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
        const arts =
          storeAssets.blogsAndArticles?.articles ||
          parsed.blogsAndArticles?.articles ||
          parsed.articles ||
          [];

        setFilePayload(text);
        setFileStats({
          fileName: file.name,
          fileSize: (file.size / 1024).toFixed(1) + " KB",
          sourceShop: parsed.shop || "External Store",
          exportedAt: parsed.exportedAt || parsed.createdAt || "Unknown Date",
          schema: parsed._schema || "Standard JSON",
          productsCount: prods.length,
          themeFilesCount: theme?.files?.length || 0,
          collectionsCount: cols.length,
          pagesCount: pgs.length,
          articlesCount: arts.length,
        });
      } catch (err) {
        setFileError(`Failed to parse file as valid JSON: ${err.message}`);
        setFilePayload(null);
        setFileStats(null);
      }
    };
    reader.readAsText(file);
  };

  const getExportUrl = (type) => {
    const base = `/app/export?type=${type}`;
    if (selectedRpId) return `${base}&rpId=${selectedRpId}`;
    return base;
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
            Export your entire store catalog, theme templates, and content into offline JSON/CSV files, or upload external Revertly backup archives to restore your store anytime.
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
          <div className="rv-card">
            <div className="rv-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "14px" }}>
              <div>
                <strong style={{ fontSize: "14px", display: "block" }}>Export Data Source</strong>
                <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Choose whether to download the latest live state or a historical snapshot point in time.
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <label htmlFor="rp-select" style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>Snapshot:</label>
                <select
                  id="rp-select"
                  className="rv-input"
                  style={{ minWidth: "280px" }}
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
                <span className="rv-badge rv-badge-success">JSON</span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  The definitive backup archive. Bundles Products, Liquid Themes, Collections, Pages, Navigation Menus, and Blog Articles into an encrypted portable JSON file.
                </p>
                <a
                  href={getExportUrl("full_json")}
                  className="rv-btn rv-btn-primary rv-btn-lg"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={16} />
                  <span>Download Complete Backup (.json)</span>
                </a>
              </div>
            </div>

            {/* 2. Product Catalog (CSV & JSON) */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <BoxIcon size={18} style={{ color: "#0ea5e9" }} />
                  <span>Products Catalog</span>
                </h3>
                <span className="rv-badge rv-badge-info">CSV &amp; JSON</span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export your product catalog with variant pricing, inventory policies, tags, and metafields. Available in spreadsheet-friendly CSV or developer JSON.
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <a
                    href={getExportUrl("products_csv")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>CSV Spreadsheet</span>
                  </a>
                  <a
                    href={getExportUrl("products_json")}
                    className="rv-btn rv-btn-secondary"
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <DownloadIcon size={14} />
                    <span>JSON Raw</span>
                  </a>
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
                <span className="rv-badge rv-badge-neutral">JSON</span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all theme layouts, Liquid template files, settings_data.json, and sections. Perfect for sharing with developers or auditing template modifications.
                </p>
                <a
                  href={getExportUrl("themes_json")}
                  className="rv-btn rv-btn-secondary"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={14} />
                  <span>Download Themes Backup (.json)</span>
                </a>
              </div>
            </div>

            {/* 4. Collections */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <LayersIcon size={18} style={{ color: "#10b981" }} />
                  <span>Collections (Smart &amp; Manual)</span>
                </h3>
                <span className="rv-badge rv-badge-neutral">JSON</span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all smart collection condition rules, rule sets, sorting priorities, and custom collection memberships.
                </p>
                <a
                  href={getExportUrl("collections_json")}
                  className="rv-btn rv-btn-secondary"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={14} />
                  <span>Download Collections (.json)</span>
                </a>
              </div>
            </div>

            {/* 5. Pages & Menus */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <FileTextIcon size={18} style={{ color: "#f59e0b" }} />
                  <span>Pages &amp; Navigation Menus</span>
                </h3>
                <span className="rv-badge rv-badge-neutral">JSON</span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all content pages (Terms, Privacy, About, Landing pages) and online store navigation menu trees.
                </p>
                <a
                  href={getExportUrl("pages_json")}
                  className="rv-btn rv-btn-secondary"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={14} />
                  <span>Download Pages (.json)</span>
                </a>
              </div>
            </div>

            {/* 6. Blogs & Articles */}
            <div className="rv-card" style={{ margin: 0 }}>
              <div className="rv-card-header">
                <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <BookOpenIcon size={18} style={{ color: "#ec4899" }} />
                  <span>Blogs &amp; Articles</span>
                </h3>
                <span className="rv-badge rv-badge-neutral">JSON</span>
              </div>
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: "calc(100% - 60px)" }}>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                  Export all published and draft blog articles, tags, authors, summaries, and HTML article bodies for safe archiving.
                </p>
                <a
                  href={getExportUrl("blogs_json")}
                  className="rv-btn rv-btn-secondary"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
                >
                  <DownloadIcon size={14} />
                  <span>Download Blogs (.json)</span>
                </a>
              </div>
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
                <span>Upload Revertly Backup Archive (.json)</span>
              </h3>
            </div>

            <div className="rv-card-body">
              {fileError && (
                <Banner tone="critical" title="File Validation Error">
                  {fileError}
                </Banner>
              )}

              <button
                type="button"
                style={{
                  width: "100%",
                  border: "2px dashed var(--rv-border)",
                  borderRadius: "12px",
                  padding: "32px 20px",
                  textAlign: "center",
                  background: "var(--rv-surface-subdued)",
                  cursor: "pointer",
                  transition: "border-color 0.2s",
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
                <div style={{ display: "inline-flex", padding: "12px", borderRadius: "50%", background: "var(--rv-primary-surface)", color: "var(--rv-primary)", marginBottom: "12px" }}>
                  <UploadIcon size={28} />
                </div>
                <h4 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: 600, color: "var(--rv-text)" }}>
                  Click to choose file or drag &amp; drop here
                </h4>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                  Upload a previously exported Revertly backup file (.json) to inspect and restore.
                </p>
              </button>

              {/* Verified File Inspector */}
              {fileStats && (
                <div style={{ marginTop: "24px", padding: "16px", borderRadius: "8px", background: "var(--rv-surface)", border: "1px solid var(--rv-border)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <CheckCircleIcon size={18} style={{ color: "var(--rv-success)" }} />
                      <strong style={{ fontSize: "15px" }}>{fileStats.fileName}</strong>
                      <span className="rv-badge rv-badge-success rv-badge-sm">Validated Archive</span>
                    </div>
                    <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                      Size: {fileStats.fileSize} · Schema: {fileStats.schema}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                      gap: "10px",
                      marginBottom: "20px",
                    }}
                  >
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Products</span>
                      <strong style={{ fontSize: "16px" }}>{fileStats.productsCount}</strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Theme Files</span>
                      <strong style={{ fontSize: "16px" }}>{fileStats.themeFilesCount}</strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Collections</span>
                      <strong style={{ fontSize: "16px" }}>{fileStats.collectionsCount}</strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Pages</span>
                      <strong style={{ fontSize: "16px" }}>{fileStats.pagesCount}</strong>
                    </div>
                    <div style={{ padding: "10px", borderRadius: "6px", background: "var(--rv-surface-subdued)", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", display: "block" }}>Articles</span>
                      <strong style={{ fontSize: "16px" }}>{fileStats.articlesCount}</strong>
                    </div>
                  </div>

                  {/* Mode Selector */}
                  <div style={{ marginBottom: "20px", padding: "14px", borderRadius: "8px", background: "var(--rv-surface-subdued)" }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "8px" }}>
                      Select How to Handle This Imported Backup:
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
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
                          <span style={{ display: "block", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            Saves the archive securely into your Restore Points list. You can inspect diffs and selectively restore items anytime.
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
                          <span style={{ display: "block", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            Immediately restores Collections, Pages, and Articles into Shopify, and creates a staging theme.
                          </span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Submission Form */}
                  <fetcher.Form method="POST">
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
                            ? "Importing &amp; Validating..."
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
