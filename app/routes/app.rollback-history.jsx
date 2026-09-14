import { useState } from "react";
import { useLoaderData, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

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
              <strong>{job.successCount}</strong> / {job.totalProducts} restored
            </span>
            {job.failedCount > 0 && (
              <span className="rv-badge rv-badge-critical">{job.failedCount} failed</span>
            )}
            <span>⏱️ {duration(job.createdAt, job.completedAt)}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
          <span>🕒 Executed: {formatTime(job.createdAt)}</span>
          {job.results.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="rv-btn rv-btn-subtle"
              style={{ fontSize: "12px", padding: "4px 8px" }}
            >
              {expanded ? "Hide Product Results ▲" : `View ${job.results.length} Product Results ▼`}
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
                  <th>Outcome</th>
                  <th>Error / Message</th>
                </tr>
              </thead>
              <tbody>
                {job.results.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.productTitle}</td>
                    <td>
                      <span className={`rv-badge ${r.status === "SUCCESS" ? "rv-badge-success" : "rv-badge-critical"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ color: r.errorMessage ? "var(--rv-critical)" : "var(--rv-text-subdued)" }}>
                      {r.errorMessage || "Field values successfully restored"}
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

  return (
    <s-page
      heading="Rollback History"
      backAction={{ url: "/app", label: "Dashboard" }}
      inlineSize="large"
    >
      {/* ── Top Header Hero ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
              Audit Trail of Reverted Catalogs
            </strong>
            <span className="rv-badge rv-badge-info">
              {jobs.length} Execution{jobs.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Every rollback action triggered from Incidents or Restore Points is logged here with execution duration and product-by-product results.
          </p>
        </div>

        <Link to="/app" className="rv-btn rv-btn-secondary" style={{ fontSize: "13px" }}>
          ← Back to Dashboard
        </Link>
      </div>

      {/* ── Job List / Empty State ── */}
      {jobs.length === 0 ? (
        <div className="rv-empty-state">
          <div className="rv-empty-icon-circle">⏪</div>
          <div className="rv-empty-title">No Rollbacks Executed Yet</div>
          <div className="rv-empty-desc">
            When you execute a 1-click rollback on an incident or restore from a saved restore point, complete execution records and timings will appear here.
          </div>
          <Link to="/app/incidents" className="rv-btn rv-btn-secondary">
            View Open Incidents
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
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
