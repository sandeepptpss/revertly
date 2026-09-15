import { CheckCircleIcon, AlertTriangleIcon, AlertCircleIcon } from "./Icons.jsx";

export function Banner({ tone = "info", title, children, action, onDismiss, className = "" }) {
  const toneClass = {
    success: "rv-banner-success",
    critical: "rv-banner-critical",
    warning: "rv-banner-warning",
    info: "rv-banner-info",
  }[tone] || "rv-banner-info";

  const IconComponent = {
    success: CheckCircleIcon,
    critical: AlertCircleIcon,
    warning: AlertTriangleIcon,
    info: AlertCircleIcon,
  }[tone] || AlertCircleIcon;

  return (
    <div className={`rv-banner ${toneClass} ${className}`}>
      <div className="rv-banner-icon">
        <IconComponent size={20} />
      </div>
      <div className="rv-banner-body">
        {title && <div className="rv-banner-title">{title}</div>}
        <div>{children}</div>
      </div>
      {action && <div>{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss banner"
          style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: "4px", display: "flex", alignItems: "center" }}
        >
          <span aria-hidden="true" style={{ fontSize: "18px", lineHeight: 1 }}>&times;</span>
        </button>
      )}
    </div>
  );
}
