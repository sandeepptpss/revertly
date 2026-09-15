import { Link } from "react-router";

export function PillNav({ items, activeId, onChange, isLinks = false }) {
  return (
    <div className="rv-pills-row">
      {items.map((item) => {
        const isActive = item.id === activeId;
        const pillContent = (
          <>
            {item.icon && <span>{item.icon}</span>}
            <span>{item.label}</span>
            {item.count !== undefined && item.count !== null && (
              <span className="rv-pill-badge">{item.count}</span>
            )}
          </>
        );

        if (isLinks && item.to) {
          return (
            <Link
              key={item.id}
              to={item.to}
              className={`rv-pill ${isActive ? "rv-pill-active" : ""}`}
            >
              {pillContent}
            </Link>
          );
        }

        return (
          <button
            key={item.id}
            type="button"
            className={`rv-pill ${isActive ? "rv-pill-active" : ""}`}
            onClick={() => onChange && onChange(item.id)}
          >
            {pillContent}
          </button>
        );
      })}
    </div>
  );
}
