import { useEffect } from "react";
import { AlertTriangleIcon, Trash2Icon, XIcon } from "./Icons.jsx";

/**
 * Reusable in-app confirmation modal dialog.
 * Replaces browser-native confirm()/alert() popups with a styled, accessible modal.
 */
export default function ConfirmModal({
  isOpen,
  title = "Confirm Action",
  message,
  dangerNote,
  confirmLabel = "Delete",
  submittingLabel = "Deleting...",
  cancelLabel = "Cancel",
  tone = "critical", // "critical" | "warning" | "primary"
  isSubmitting = false,
  onConfirm,
  onClose,
}) {
  // Listen for Escape key to close modal
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

  const isCritical = tone === "critical";
  const isWarning = tone === "warning";

  const confirmBtnClass = isCritical
    ? "rv-btn rv-btn-critical"
    : isWarning
    ? "rv-btn rv-btn-primary"
    : "rv-btn rv-btn-primary";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting && onClose) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: "20px",
        animation: "rvFadeIn 0.15s ease-out",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "var(--rv-radius-md, 10px)",
          maxWidth: "480px",
          width: "100%",
          padding: "24px",
          boxShadow: "var(--rv-shadow-lg, 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1))",
          border: "1px solid var(--rv-border, #e1e3e5)",
          position: "relative",
          animation: "rvModalPop 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Close Button */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            style={{
              position: "absolute",
              top: "16px",
              right: "16px",
              border: "none",
              background: "transparent",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              color: "var(--rv-text-subdued, #6d7175)",
              padding: "4px",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <XIcon size={18} />
          </button>
        )}

        {/* Modal Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "14px", marginBottom: "16px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              background: isCritical
                ? "var(--rv-critical-surface, #fef2f2)"
                : "var(--rv-surface-subdued, #f8fafc)",
              color: isCritical
                ? "var(--rv-critical, #dc2626)"
                : "var(--rv-primary, #2563eb)",
              border: isCritical
                ? "1px solid var(--rv-critical-border, #fecaca)"
                : "1px solid var(--rv-border, #e2e8f0)",
            }}
          >
            {isCritical ? <Trash2Icon size={20} /> : <AlertTriangleIcon size={20} />}
          </div>
          <div>
            <h3
              id="confirm-modal-title"
              style={{
                margin: "0 0 6px",
                fontSize: "18px",
                fontWeight: 700,
                color: "var(--rv-text, #1e293b)",
              }}
            >
              {title}
            </h3>
            {message && (
              <div
                style={{
                  fontSize: "14px",
                  color: "var(--rv-text, #334155)",
                  lineHeight: 1.5,
                }}
              >
                {message}
              </div>
            )}
          </div>
        </div>

        {/* Caution / Danger Note Box */}
        {dangerNote && (
          <div
            style={{
              background: isCritical
                ? "var(--rv-critical-surface, #fff5f5)"
                : "var(--rv-surface-subdued, #f8fafc)",
              border: isCritical
                ? "1px solid var(--rv-critical-border, #fed7d7)"
                : "1px solid var(--rv-border, #e2e8f0)",
              borderRadius: "var(--rv-radius-sm, 6px)",
              padding: "12px 14px",
              fontSize: "13px",
              color: isCritical
                ? "var(--rv-critical-text, #c53030)"
                : "var(--rv-text-subdued, #475569)",
              marginBottom: "20px",
              lineHeight: 1.45,
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
            }}
          >
            <span style={{ fontSize: "15px", lineHeight: 1 }}>⚠️</span>
            <div>{dangerNote}</div>
          </div>
        )}

        {/* Modal Action Buttons */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "10px",
            marginTop: "20px",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rv-btn rv-btn-secondary"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className={confirmBtnClass}
            style={{ fontWeight: 600 }}
          >
            {isSubmitting ? submittingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
