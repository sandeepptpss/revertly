import { useState, useEffect } from "react";
import { ShieldCheckIcon, AlertTriangleIcon, XIcon, CheckCircleIcon } from "./Icons.jsx";

/**
 * Interactive Pre-Restore Visual Impact & Selective Field Modal.
 * Eliminates merchant fear by providing a clear diff breakdown and allowing selective
 * field restoration (preserving live inventory quantities by default).
 */
export default function SafeRestoreModal({
  isOpen,
  onClose,
  onConfirm,
  isSubmitting = false,
  productCount = 0,
  differences = [],
}) {
  // Selective field toggles
  const [restoreTitles, setRestoreTitles] = useState(true);
  const [restoreDescriptions, setRestoreDescriptions] = useState(true);
  const [restorePrices, setRestorePrices] = useState(true);
  const [restoreTags, setRestoreTags] = useState(true);
  const [restoreStatus, setRestoreStatus] = useState(true);
  // Product restores never write inventory (rollbackProductFields has no
  // inventory path), so live stock is always preserved. This used to be a
  // checkbox whose unticked state warned it "may overwrite" stock — a choice
  // that did nothing. It is kept as a constant for the submitted options.
  const preserveInventory = true;
  const [safetyConfirmText, setSafetyConfirmText] = useState("");

  // Reset confirmation input when modal opens or closes
  useEffect(() => {
    if (isOpen) setSafetyConfirmText("");
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && !isSubmitting && onClose) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen) return null;

  // Calculate quick stats from differences
  let totalTitleDiffs = 0;
  let totalPriceDiffs = 0;
  let totalStatusDiffs = 0;

  for (const item of differences) {
    for (const d of item.diffs || []) {
      if (d.field === "title") totalTitleDiffs++;
      else if (d.field?.includes("price")) totalPriceDiffs++;
      else if (d.field === "status") totalStatusDiffs++;
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (onConfirm) {
      onConfirm({
        restoreTitles,
        restoreDescriptions,
        restorePrices,
        restoreTags,
        restoreStatus,
        preserveInventory,
      });
    }
  };

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting && onClose) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: "20px",
        animation: "rvFadeIn 0.15s ease-out",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="safe-restore-modal-title"
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          maxWidth: "560px",
          width: "100%",
          padding: "26px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.08)",
          border: "1px solid #e2e8f0",
          position: "relative",
          animation: "rvModalPop 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {/* Close Button */}
        {onClose && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            disabled={isSubmitting}
            aria-label="Close dialog"
            style={{
              position: "absolute",
              top: "14px",
              right: "14px",
              width: "36px",
              height: "36px",
              border: "1px solid #e2e8f0",
              background: "#ffffff",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              color: "#1e293b",
              borderRadius: "8px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 50,
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            <XIcon size={18} />
          </button>
        )}

        {/* Modal Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "14px", marginBottom: "16px" }}>
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              background: "#eff6ff",
              color: "#2563eb",
              border: "1px solid #bfdbfe",
            }}
          >
            <ShieldCheckIcon size={24} />
          </div>
          <div>
            <h3
              id="safe-restore-modal-title"
              style={{
                margin: "0 0 4px",
                fontSize: "19px",
                fontWeight: 700,
                color: "#0f172a",
              }}
            >
              Safe Restore Preview &amp; Field Selection
            </h3>
            <p style={{ margin: 0, fontSize: "13px", color: "#64748b", lineHeight: 1.45 }}>
              Review the impact on <strong>{productCount} product{productCount !== 1 ? "s" : ""}</strong> before executing. Select exactly which fields you want to overwrite.
            </p>
          </div>
        </div>

        {/* Impact Diff Summary Pill Bar */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: "8px",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "18px",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Products</div>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>{productCount}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Price Diffs</div>
            <div style={{ fontSize: "18px", fontWeight: 700, color: totalPriceDiffs > 0 ? "#dc2626" : "#0f172a" }}>
              {totalPriceDiffs}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Title Diffs</div>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>{totalTitleDiffs}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Status Diffs</div>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>{totalStatusDiffs}</div>
          </div>
        </div>

        {/* Live Inventory Safety Guarantee Card */}
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: "8px",
            padding: "12px 14px",
            marginBottom: "18px",
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
          }}
        >
          <div style={{ marginTop: "1px" }}>
            <CheckCircleIcon size={18} style={{ color: "#16a34a" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: "13.5px", color: "#166534" }}>Live inventory is never changed</div>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#15803d", lineHeight: 1.4 }}>
              Restores don&apos;t touch stock levels, so recent customer sales are never overwritten with older
              inventory counts.
            </p>
          </div>
        </div>

        {/* Selective Field Checkboxes */}
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#334155", marginBottom: "10px" }}>
            Choose Which Fields to Revert:
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px",
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "14px",
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={restoreTitles}
                onChange={(e) => setRestoreTitles(e.target.checked)}
                style={{ accentColor: "#2563eb", width: "15px", height: "15px" }}
              />
              <span>Product Titles</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={restoreDescriptions}
                onChange={(e) => setRestoreDescriptions(e.target.checked)}
                style={{ accentColor: "#2563eb", width: "15px", height: "15px" }}
              />
              <span>HTML Descriptions</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={restorePrices}
                onChange={(e) => setRestorePrices(e.target.checked)}
                style={{ accentColor: "#2563eb", width: "15px", height: "15px" }}
              />
              <span>Prices &amp; Compare-At</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={restoreStatus}
                onChange={(e) => setRestoreStatus(e.target.checked)}
                style={{ accentColor: "#2563eb", width: "15px", height: "15px" }}
              />
              <span>Product Status</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={restoreTags}
                onChange={(e) => setRestoreTags(e.target.checked)}
                style={{ accentColor: "#2563eb", width: "15px", height: "15px" }}
              />
              <span>Tags, Vendor &amp; Type</span>
            </label>
          </div>
        </div>

        {/* Critical Action Safety Lock (Only triggered for bulk restores of 5+ products) */}
        {productCount >= 5 && (
          <div
            style={{
              marginTop: "16px",
              padding: "12px 14px",
              background: "#fff1f2",
              border: "1px solid #fecdd3",
              borderRadius: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
              <AlertTriangleIcon size={16} color="#e11d48" />
              <span style={{ fontSize: "12px", fontWeight: 700, color: "#9f1239", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                Critical Action Safety Lock
              </span>
            </div>
            <p style={{ fontSize: "12px", color: "#881337", margin: "0 0 8px 0", lineHeight: "1.4" }}>
              You are restoring <strong>{productCount} products</strong>. To protect your live store against accidental mass-overwrites, please type <strong>RESTORE</strong> below to confirm:
            </p>
            <input
              type="text"
              placeholder="Type RESTORE to unlock"
              value={safetyConfirmText}
              onChange={(e) => setSafetyConfirmText(e.target.value)}
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "8px 12px",
                fontSize: "13px",
                fontWeight: 600,
                border: "1px solid #fda4af",
                borderRadius: "6px",
                background: "#ffffff",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}

        {/* Modal Action Buttons */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "10px",
            borderTop: "1px solid #f1f5f9",
            paddingTop: "16px",
            marginTop: productCount >= 5 ? "14px" : "0",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rv-btn rv-btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || (productCount >= 5 && safetyConfirmText.trim().toUpperCase() !== "RESTORE")}
            className="rv-btn rv-btn-primary"
            style={{
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              opacity: (productCount >= 5 && safetyConfirmText.trim().toUpperCase() !== "RESTORE") ? 0.5 : 1,
              cursor: (productCount >= 5 && safetyConfirmText.trim().toUpperCase() !== "RESTORE") ? "not-allowed" : "pointer",
            }}
          >
            <ShieldCheckIcon size={16} />
            <span>{isSubmitting ? "Executing Safe Restore..." : `Execute Safe Restore (${productCount})`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
