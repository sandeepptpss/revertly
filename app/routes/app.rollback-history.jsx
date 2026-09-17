import { useState } from "react";
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
      restorePoint: { select: { id: true, name: true } },
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

function JobCard({ job }) {
  const [expanded, setExpanded] = useState(false);

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
            {job.incident && (
              <Link
                to={`/app/incidents/${job.incident.id}`}
                style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", textDecoration: "none" }}
              >
                Incident: {job.incident.name}
              </Link>
            )}
            {job.restorePoint && (
              <Link
                to={`/app/restore-points/${job.restorePoint.id}`}
                style={{ fontSize: "14px", fontWeight: 600, color: "var(--rv-text)", textDecoration: "none" }}
              >
                Restore Point: {job.restorePoint.name}
              </Link>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            <span>
              <strong>{job.successCount}</strong> of {job.totalProducts} restored
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
                  <span>View {job.results.length} Product Results</span>
                  <ChevronDownIcon size={14} />
                </>
              )}
            </button>
          )}
        </div>

        {/* Product Results Table */}
        {expanded && job.results.length > 0 && (
          <div className="rv-table-container" style={{ marginTop: "14px", border: "1px solid var(--rv-border)" }}>
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Product Title</th>
                  <th style={{ width: "120px" }}>Outcome</th>
                  <th>Error / Message</th>
                </tr>
              </thead>
              <tbody>
                {job.results.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <BoxIcon size={15} style={{ color: "var(--rv-text-subdued)" }} />
                        <span>{r.productTitle}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`rv-badge rv-badge-sm ${r.status === "SUCCESS" ? "rv-badge-success" : "rv-badge-critical"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ color: r.errorMessage ? "var(--rv-critical)" : "var(--rv-text-subdued)", fontSize: "12px" }}>
                      {r.errorMessage || "All modified fields safely restored"}
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
  const {
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    paginatedItems: pagedJobs,
    totalItems: totalJobs,
  } = usePagination(jobs, 10);

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
              Audit Trail of Reverted Catalogs
            </strong>
            <span className="rv-badge rv-badge-info">
              {jobs.length} Execution{jobs.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Every rollback action triggered from Incidents or Restore Points is permanently logged here with execution duration and product-by-product results.
          </p>
        </div>

        <Link to="/app" className="rv-btn rv-btn-secondary rv-btn-sm">
          <ArrowLeftIcon size={14} />
          <span>Back to Dashboard</span>
        </Link>
      </div>

      {/* ── Job List / Empty State ── */}
      {jobs.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon size={28} style={{ color: "var(--rv-info)" }} />}
          title="No Rollbacks Executed Yet"
          description="When you execute a 1-click rollback on an incident or restore from a saved restore point, complete audit records and execution timings will appear here."
          action={
            <Link to="/app/incidents" className="rv-btn rv-btn-secondary">
              View Open Incidents
            </Link>
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
