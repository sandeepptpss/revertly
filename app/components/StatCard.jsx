import { Link } from "react-router";
import { ArrowRightIcon } from "./Icons.jsx";

export function StatCard({
  label,
  value,
  subtext,
  icon,
  iconTone = "emerald",
  linkTo,
  linkLabel,
}) {
  const iconToneClass = {
    emerald: "rv-stat-icon-emerald",
    blue: "rv-stat-icon-blue",
    amber: "rv-stat-icon-amber",
    rose: "rv-stat-icon-rose",
    purple: "rv-stat-icon-purple",
  }[iconTone] || "rv-stat-icon-blue";

  return (
    <div className="rv-stat-card">
      <div>
        <div className="rv-stat-card-top">
          <span className="rv-stat-label">{label}</span>
          {icon && (
            <div className={`rv-stat-icon-wrapper ${iconToneClass}`}>
              {icon}
            </div>
          )}
        </div>
        <div className="rv-stat-number">{value}</div>
        {subtext && <div className="rv-stat-subtext">{subtext}</div>}
      </div>

      {linkTo && (
        <Link to={linkTo} className="rv-stat-link">
          <span>{linkLabel || "View details"}</span>
          <ArrowRightIcon size={14} />
        </Link>
      )}
    </div>
  );
}
