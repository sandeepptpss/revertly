import { useState, useMemo } from "react";
import { useLoaderData, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  HistoryIcon,
  ClockIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  BoxIcon,
  FileCodeIcon,
  DatabaseIcon,
  UploadIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  SearchIcon,
} from "../components/Icons.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination, usePagination } from "../components/Pagination.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const jobs = await prisma.rollbackJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: {
      incident: { select: { id: true, name: true } },
      restorePoint: { select: { id: true, name: true, backupType: true } },
      results: { orderBy: { createdAt: "asc" } },
    },
  });

  return { jobs };
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function duration(start, end) {
  if (!end) return "—";
  const ms = new Date(end) - new Date(start);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getResourceMeta(job) {
  const customType = job.fieldsToRestore?.resourceType;
  if (customType) {
    switch (customType.toUpperCase()) {
      case "THEMES":
        return { label: "Theme Code", icon: FileCodeIcon, badgeTone: "rv-badge-info", noun: "files" };
      case "PAGES":
        return { label: "Pages", icon: FileCodeIcon, badgeTone: "rv-badge-neutral", noun: "pages" };
      case "COLLECTIONS":
        return { label: "Collections", icon: BoxIcon, badgeTone: "rv-badge-info", noun: "collections" };
      case "MENUS":
        return { label: "Navigation Menus", icon: BoxIcon, badgeTone: "rv-badge-neutral", noun: "menus" };
      case "BLOGS":
      case "ARTICLES":
        return { label: "Blog Articles", icon: FileCodeIcon, badgeTone: "rv-badge-success", noun: "articles" };
      case "METAFIELDS":
        return { label: "Metafields", icon: DatabaseIcon, badgeTone: "rv-badge-success", noun: "metafield items" };
      case "IMPORT":
        return { label: "CSV Import", icon: UploadIcon, badgeTone: "rv-badge-warning", noun: "imported items" };
      case "INCIDENT":
        return { label: "Incident Rollback", icon: HistoryIcon, badgeTone: "rv-badge-critical", noun: "products" };
      case "PRODUCTS":
        return { label: "Products", icon: BoxIcon, badgeTone: "rv-badge-info", noun: "products" };
      default:
        break;
    }
  }

  if (job.incident) {
    return { label: "Incident Rollback", icon: HistoryIcon, badgeTone: "rv-badge-critical", noun: "products" };
  }

  if (job.restorePoint?.backupType) {
    const bt = job.restorePoint.backupType.toUpperCase();
    if (bt === "THEMES") return { label: "Theme Code", icon: FileCodeIcon, badgeTone: "rv-badge-info", noun: "files" };
    if (bt === "PAGES") return { label: "Pages", icon: FileCodeIcon, badgeTone: "rv-badge-neutral", noun: "pages" };
    if (bt === "COLLECTIONS") return { label: "Collections", icon: BoxIcon, badgeTone: "rv-badge-info", noun: "collections" };
    if (bt === "MENUS") return { label: "Navigation Menus", icon: BoxIcon, badgeTone: "rv-badge-neutral", noun: "menus" };
    if (bt === "BLOGS" || bt === "ARTICLES") return { label: "Blog Articles", icon: FileCodeIcon, badgeTone: "rv-badge-success", noun: "articles" };
    if (bt === "METAFIELDS") return { label: "Metafields", icon: DatabaseIcon, badgeTone: "rv-badge-success", noun: "metafield items" };
    if (bt === "PRODUCTS") return { label: "Products", icon: BoxIcon, badgeTone: "rv-badge-info", noun: "products" };
  }

  return { label: "Products", icon: BoxIcon, badgeTone: "rv-badge-info", noun: "products" };
}

function JobCard({ job }) {
  const [expanded, setExpanded] = useState(false);
  const resourceMeta = getResourceMeta(job);
  const ResourceIcon = resourceMeta.icon;

  const statusTone = {
    COMPLETED: "rv-badge-success",
    FAILED: "rv-badge-critical",
    PARTIAL: "rv-badge-warning",
    RUNNING: "rv-badge-info",
    PENDING: "rv-badge-neutral",
  }[job.status] || "rv-badge-neutral";

  return (
    <div className="rv-card" style={{ margin: 0 }}>
      <div className="rv-card-body">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", marginBottom: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span className={`rv-badge ${statusTone}`}>
              {job.status}
            </span>
            <span className={`rv-badge ${resourceMeta.badgeTone}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <ResourceIcon size={12} />
              <span>{resourceMeta.label}</span>
            </span>

            {job.incident && (
              <Link
                to={`/app/incidents/${job.incident.id}`}
                style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", textDecoration: "none" }}
              >
                Incident: {job.incident.name}
              </Link>
            )}
            {job.restorePoint ? (
              <Link
                to={`/app/restore-points/${job.restorePoint.id}`}
                style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", textDecoration: "none" }}
              >
                Restore Point: {job.restorePoint.name}
              </Link>
            ) : !job.incident ? (
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--rv-text-subdued)" }}>
                {job.fieldsToRestore?.resourceType === "IMPORT" ? "Live Import Archive" : "Restored from Snapshot"}
              </span>
            ) : null}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            <span>
              <strong>{job.successCount}</strong> of {job.totalProducts} {resourceMeta.noun} restored
            </span>
            {job.failedCount > 0 && (
              <span className="rv-badge rv-badge-critical rv-badge-sm">{job.failedCount} failed</span>
            )}
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <ClockIcon size={13} />
              <span>{duration(job.createdAt, job.completedAt)}</span>
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
          <span>Executed: {formatTime(job.createdAt)}</span>
          {job.results.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="rv-btn rv-btn-subtle rv-btn-sm"
            >
              {expanded ? (
                <>
                  <span>Hide Details</span>
                  <ChevronUpIcon size={14} />
                </>
              ) : (
                <>
                  <span>View {job.results.length} Restored {resourceMeta.noun}</span>
                  <ChevronDownIcon size={14} />
                </>
              )}
            </button>
          )}
        </div>

        {/* Restored Items Table */}
        {expanded && job.results.length > 0 && (
          <div className="rv-table-container" style={{ marginTop: "14px", border: "1px solid var(--rv-border)" }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Resource / Item</th>
                  <th style={{ width: "120px" }}>Outcome</th>
                  <th>Details / Status</th>
                </tr>
              </thead>
              <tbody>
                {job.results.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <ResourceIcon size={14} style={{ color: "var(--rv-text-subdued)", flexShrink: 0 }} />
                        <span>{r.productTitle}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`rv-badge rv-badge-sm ${r.status === "SUCCESS" ? "rv-badge-success" : "rv-badge-critical"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ color: r.errorMessage ? "var(--rv-critical)" : "var(--rv-text-subdued)", fontSize: "12px" }}>
                      {r.errorMessage || "Safely restored to live store"}
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

export default function RollbackHistory() {
  const { jobs } = useLoaderData();
  const [filterType, setFilterType] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const tabCounts = useMemo(() => {
    const counts = { ALL: jobs.length };
    for (const job of jobs) {
      const typeKey = (job.fieldsToRestore?.resourceType || job.restorePoint?.backupType || (job.incident ? "INCIDENT" : "PRODUCTS")).toUpperCase();
      counts[typeKey] = (counts[typeKey] || 0) + 1;
      if (typeKey === "ARTICLES") counts["BLOGS"] = (counts["BLOGS"] || 0) + 1;
    }
    return counts;
  }, [jobs]);

  const availableTabs = useMemo(() => {
    const allCandidates = [
      { id: "ALL", label: `All (${jobs.length})` },
      { id: "PRODUCTS", label: `Products (${tabCounts.PRODUCTS || 0})` },
      { id: "THEMES", label: `Theme Code (${tabCounts.THEMES || 0})` },
      { id: "PAGES", label: `Pages (${tabCounts.PAGES || 0})` },
      { id: "COLLECTIONS", label: `Collections (${tabCounts.COLLECTIONS || 0})` },
      { id: "MENUS", label: `Menus (${tabCounts.MENUS || 0})` },
      { id: "BLOGS", label: `Blog Articles (${tabCounts.BLOGS || 0})` },
      { id: "METAFIELDS", label: `Metafields (${tabCounts.METAFIELDS || 0})` },
      { id: "IMPORT", label: `CSV Import (${tabCounts.IMPORT || 0})` },
      { id: "INCIDENT", label: `Incident Rollback (${tabCounts.INCIDENT || 0})` },
    ];
    return allCandidates.filter((t) => t.id === "ALL" || (tabCounts[t.id] && tabCounts[t.id] > 0));
  }, [jobs.length, tabCounts]);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (filterType !== "ALL") {
        const typeKey = (job.fieldsToRestore?.resourceType || job.restorePoint?.backupType || (job.incident ? "INCIDENT" : "PRODUCTS")).toUpperCase();
        if (filterType === "PRODUCTS" && typeKey !== "PRODUCTS") return false;
        if (filterType === "THEMES" && typeKey !== "THEMES") return false;
        if (filterType === "PAGES" && typeKey !== "PAGES") return false;
        if (filterType === "COLLECTIONS" && typeKey !== "COLLECTIONS") return false;
        if (filterType === "MENUS" && typeKey !== "MENUS") return false;
        if (filterType === "BLOGS" && !["BLOGS", "ARTICLES"].includes(typeKey)) return false;
        if (filterType === "METAFIELDS" && typeKey !== "METAFIELDS") return false;
        if (filterType === "IMPORT" && typeKey !== "IMPORT") return false;
        if (filterType === "INCIDENT" && typeKey !== "INCIDENT") return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = job.incident?.name?.toLowerCase().includes(q) || job.restorePoint?.name?.toLowerCase().includes(q);
        const matchResult = job.results.some((r) => r.productTitle.toLowerCase().includes(q));
        if (!matchTitle && !matchResult) return false;
      }

      return true;
    });
  }, [jobs, filterType, searchQuery]);

  const {
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    paginatedItems: pagedJobs,
    totalItems: totalJobs,
  } = usePagination(filteredJobs, 10);

  return (
    <s-page
      heading="Rollback History"
      backAction={{ url: "/app", label: "Dashboard" }}
      inlineSize="large"
    >
      <HubNav hub="backups" activeTab="rollback-history" />

      {/* ── Top Header Hero ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Audit Trail of Reverted Catalogs &amp; Restorations
            </strong>
            <span className="rv-badge rv-badge-info">
              {jobs.length} Execution{jobs.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Every rollback action triggered from Incidents or Restore Points (Products, Themes, Pages, Collections, Metafields, Imports) is permanently logged here with execution duration and item-by-item results.
          </p>
        </div>

        <Link to="/app" className="rv-btn rv-btn-secondary rv-btn-sm">
          <ArrowLeftIcon size={14} />
          <span>Back to Dashboard</span>
        </Link>
      </div>

      {/* ── Search & Resource Filter Bar ── */}
      {jobs.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            {availableTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setFilterType(tab.id);
                  setCurrentPage(1);
                }}
                className={`rv-btn rv-btn-sm ${filterType === tab.id ? "rv-btn-primary" : "rv-btn-subtle"}`}
              >
                {tab.label}
              </button>
            ))}
          </div>


          <div style={{ position: "relative", minWidth: "240px" }}>
            <SearchIcon size={14} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--rv-text-subdued)" }} />
            <input
              type="text"
              placeholder="Search execution or item..."
              className="rv-input"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              style={{ paddingLeft: "32px", fontSize: "13px" }}
            />
          </div>
        </div>
      )}

      {/* ── Job List / Empty State ── */}
      {jobs.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon size={28} style={{ color: "var(--rv-info)" }} />}
          title="No Rollbacks Executed Yet"
          description="When you execute a 1-click rollback on an incident or restore from a saved restore point, complete audit records and execution timings will appear here."
          action={
            <Link to="/app/restore-points" className="rv-btn rv-btn-secondary">
              View Restore Points
            </Link>
          }
        />
      ) : filteredJobs.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon size={28} style={{ color: "var(--rv-text-subdued)" }} />}
          title="No Matching Executions Found"
          description="Try adjusting your filter or search query to find previous rollback records."
          action={
            <button
              type="button"
              onClick={() => {
                setFilterType("ALL");
                setSearchQuery("");
              }}
              className="rv-btn rv-btn-secondary"
            >
              Reset Filters
            </button>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {pagedJobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}

          <Pagination
            currentPage={currentPage}
            totalItems={totalJobs}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
            itemLabel="rollbacks"
          />
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
