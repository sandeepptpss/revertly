import { Link } from "react-router";
import {
  SaveIcon,
  HistoryIcon,
  DatabaseIcon,
  AlertTriangleIcon,
  ClockIcon,
  FilterIcon,
  ZapIcon,
  ShieldCheckIcon,
  SettingsIcon,
  UsersIcon,
} from "./Icons.jsx";

const HUB_CONFIG = {
  backups: {
    hubTitle: "Backups & Recovery",
    tabs: [
      { id: "restore-points", label: "Restore Points", to: "/app/restore-points", icon: SaveIcon },
      { id: "rollback-history", label: "Rollback History", to: "/app/rollback-history", icon: HistoryIcon },
      { id: "vault", label: "Data Vault", to: "/app/vault", icon: DatabaseIcon },
    ],
  },
  protection: {
    hubTitle: "Store Protection & Health",
    tabs: [
      { id: "incidents", label: "Incidents", to: "/app/incidents", icon: AlertTriangleIcon },
      { id: "activity", label: "Activity Feed", to: "/app/activity", icon: ClockIcon },
      { id: "rules", label: "Protection Rules", to: "/app/rules", icon: FilterIcon },
      { id: "monitoring", label: "Store & App Monitoring", to: "/app/monitoring", icon: ZapIcon },
      { id: "qa", label: "QA & Backup Health", to: "/app/qa", icon: ShieldCheckIcon },
    ],
  },
  settings: {
    hubTitle: "Settings & Team",
    tabs: [
      { id: "settings", label: "App Settings", to: "/app/settings", icon: SettingsIcon },
      { id: "team", label: "Team & Permissions", to: "/app/team", icon: UsersIcon },
    ],
  },
};

export function HubNav({ hub, activeTab }) {
  const config = HUB_CONFIG[hub];
  if (!config) return null;

  return (
    <nav className="rv-hub-nav-container" aria-label={`${config.hubTitle} Navigation`}>
      <div className="rv-hub-nav-track">
        {config.tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          const Icon = tab.icon;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              className={`rv-hub-tab ${isActive ? "rv-hub-tab-active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              {Icon && <Icon size={15} className="rv-hub-tab-icon" />}
              <span className="rv-hub-tab-label">{tab.label}</span>
              {tab.badge && <span className="rv-hub-tab-badge">{tab.badge}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default HubNav;
