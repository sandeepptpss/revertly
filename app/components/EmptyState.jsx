
export function EmptyState({ icon, title, description, action, secondaryAction, className = "" }) {
  return (
    <div className={`rv-empty-state ${className}`}>
      {icon && <div className="rv-empty-icon-circle">{icon}</div>}
      {title && <div className="rv-empty-title">{title}</div>}
      {description && <div className="rv-empty-desc">{description}</div>}
      {(action || secondaryAction) && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
