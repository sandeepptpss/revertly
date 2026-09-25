import { useFetcher } from "react-router";
import { Banner } from "./Banner.jsx";
import { CloudIcon, DownloadIcon, RefreshCwIcon } from "./Icons.jsx";

const PROVIDER_LABELS = { GOOGLE_DRIVE: "Google Drive", DROPBOX: "Dropbox" };

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lists the backup archives in the store's connected Drive or Dropbox folder
 * and imports one as a restore point, which can then be restored like any
 * other. Talks to /api/cloud-sync (session-authenticated, BACKUP_CREATE, and
 * plan-gated on cloudSync server side).
 *
 * The folder is only read when the merchant asks, so opening Backups &
 * Recovery never waits on a third-party API.
 */
export function CloudArchiveBrowser({ provider, folder }) {
  const listFetcher = useFetcher();
  const importFetcher = useFetcher();

  const listing = listFetcher.state !== "idle";
  const importingId = importFetcher.state !== "idle" ? importFetcher.formData?.get("fileId") : null;
  const files = listFetcher.data?.success ? listFetcher.data.files || [] : null;
  const listError = listFetcher.data && !listFetcher.data.success ? listFetcher.data.error : null;
  const importResult = importFetcher.data;
  const providerLabel = PROVIDER_LABELS[provider] || "your cloud";

  const browse = () => listFetcher.submit({ intent: "list" }, { method: "POST", action: "/api/cloud-sync" });

  return (
    <div className="rv-card" style={{ marginBottom: "20px" }}>
      <div className="rv-card-header">
        <h3 className="rv-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <CloudIcon size={18} />
          <span>Restore from {providerLabel}</span>
        </h3>
        <button type="button" onClick={browse} disabled={listing} className="rv-btn rv-btn-secondary rv-btn-sm">
          <RefreshCwIcon size={14} />
          <span>{listing ? "Reading folder..." : files ? "Refresh" : "Browse cloud archives"}</span>
        </button>
      </div>
      <div className="rv-card-body">
        {importResult?.message || importResult?.error ? (
          <Banner tone={importResult.success ? "success" : "critical"}>
            {importResult.success
              ? `${importResult.message}. Open it below to restore.`
              : importResult.error}
          </Banner>
        ) : null}
        {listError && <Banner tone="critical">{listError}</Banner>}

        {!files ? (
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Bring back any archive stored in your <strong>{folder}</strong> folder on {providerLabel}. It is imported
            as a restore point, so you can review it and restore it like any other backup.
          </p>
        ) : files.length === 0 ? (
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            No archives found in <strong>{folder}</strong> yet. Use Sync Cloud on a restore point to upload one.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="rv-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Archive</th>
                  <th>Saved</th>
                  <th>Size</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {files.slice(0, 25).map((file) => (
                  <tr key={file.id}>
                    <td style={{ wordBreak: "break-all" }}>{file.name}</td>
                    <td style={{ whiteSpace: "nowrap", fontSize: "12px" }}>
                      {file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap", fontSize: "12px" }}>{formatSize(file.size)}</td>
                    <td style={{ textAlign: "right" }}>
                      <importFetcher.Form method="POST" action="/api/cloud-sync">
                        <input type="hidden" name="intent" value="import" />
                        <input type="hidden" name="fileId" value={file.id} />
                        <button type="submit" disabled={Boolean(importingId)} className="rv-btn rv-btn-primary rv-btn-sm">
                          <DownloadIcon size={14} />
                          <span>{importingId === file.id ? "Importing..." : "Import as restore point"}</span>
                        </button>
                      </importFetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
