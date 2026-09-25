import { Link, useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { runQaSuite } from "../qa.server.js";
import { checkFeatureAccess } from "../billing.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import {
  ShieldCheckIcon,
  RefreshCwIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  HistoryIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination, usePagination } from "../components/Pagination.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [latest, history, access] = await Promise.all([
    prisma.qaTestRun.findFirst({ where: { shop }, orderBy: { testedAt: "desc" } }),
    prisma.qaTestRun.findMany({ where: { shop }, orderBy: { testedAt: "desc" }, take: 20 }),
    checkFeatureAccess(shop, "qaSuites"),
  ]);

  // Past runs stay visible after a downgrade; only new runs need the plan.
  return { latest, history, locked: !access.allowed };
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    // Running diagnostics is a read-heavy operation but writes a QaTestRun, so
    // require at least backup-create level access.
    const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
    if (!perm.allowed) return { success: false, message: perm.message };

    const access = await checkFeatureAccess(shop, "qaSuites");
    if (!access.allowed) {
      return {
        success: false,
        message: "Automated QA & Backup Health is included from the Starter plan. Upgrade on Plans & Billing to run health checks.",
      };
    }

    const res = await runQaSuite(shop);

    await logAudit(shop, perm.actor, "QA_SUITE_RUN", {
      resourceType: "QaTestRun",
      resourceId: res.run.id,
      details: { healthScore: res.healthScore, status: res.status },
      request,
    });

    return {
      success: true,
      message: `Health check complete — score ${res.healthScore}/100. ${res.summary}`,
    };
  } catch (error) {
    console.error("QA action error:", error);
    return { success: false, message: error?.message || "Could not run the health check." };
  }
};

const STATUS_TONE = { PASS: "rv-badge-success", WARN: "rv-badge-warning", FAIL: "rv-badge-critical" };
const STATUS_ICON = { PASS: CheckCircleIcon, WARN: AlertTriangleIcon, FAIL: AlertCircleIcon };

function scoreColor(score) {
  if (score >= 90) return "var(--rv-success)";
  if (score >= 70) return "var(--rv-warning)";
  return "var(--rv-critical)";
}

export default function QaDiagnostics() {
  const { latest, history, locked } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  const checks = Array.isArray(latest?.testResults) ? latest.testResults : [];

  const {
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize,
    paginatedItems: pagedHistory,
    totalItems: totalHistory,
  } = usePagination(history, 10);

  return (
    <s-page heading="Automated QA & Backup Health" inlineSize="large">
      <HubNav hub="protection" activeTab="qa" />
      {result?.message && (
        <Banner tone={result.success ? "success" : "critical"}>{result.message}</Banner>
      )}

      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Automated QA &amp; Backup Health
            </strong>
            {locked && <span className="rv-badge rv-badge-neutral">Starter plan</span>}
            {latest && (
              <span
                className="rv-badge"
                style={{ background: scoreColor(latest.healthScore), color: "#fff" }}
              >
                Health {latest.healthScore}/100
              </span>
            )}
          </div>
          <p style={{ margin: "0 0 10px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            These checks read live data and can genuinely fail. They verify your baseline exists,
            your newest backup is actually readable and restorable, the scheduler is running, and
            your offsite sync credentials still work. The suite runs nightly and on demand.
            {locked && " Included from the Starter plan."}
          </p>
          {latest && (
            <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Last run {new Date(latest.testedAt).toLocaleString()} — {latest.summary}
            </p>
          )}
        </div>

        <div>
          {locked ? (
            <Link to="/app/plan" className="rv-btn rv-btn-lg rv-btn-primary">
              View Plans &amp; Billing →
            </Link>
          ) : (
            <fetcher.Form method="POST">
              <button type="submit" disabled={busy} className="rv-btn rv-btn-lg rv-btn-primary">
                <RefreshCwIcon size={16} />
                <span>{busy ? "Running…" : "Run Health Check"}</span>
              </button>
            </fetcher.Form>
          )}
        </div>
      </div>

      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <ShieldCheckIcon size={18} />
            <span>Latest Results</span>
          </h3>
        </div>
        <div className="rv-card-body">
          {checks.length === 0 ? (
            <EmptyState title="No health check has run yet">
              Click &ldquo;Run Health Check&rdquo; to test your backup pipeline end to end.
            </EmptyState>
          ) : (
            checks.map((c) => {
              const Icon = STATUS_ICON[c.status] || AlertCircleIcon;
              return (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    gap: "12px",
                    padding: "12px 0",
                    borderBottom: "1px solid var(--rv-border)",
                  }}
                >
                  <div style={{ flexShrink: 0, marginTop: "2px" }}>
                    <Icon size={18} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "14px" }}>{c.label}</strong>
                      <span className={`rv-badge ${STATUS_TONE[c.status] || "rv-badge-neutral"}`}>{c.status}</span>
                    </div>
                    <div style={{ fontSize: "13px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                      {c.message}
                    </div>
                    {c.remediation && c.status !== "PASS" && (
                      <div style={{ fontSize: "12px", marginTop: "4px", color: "var(--rv-text)" }}>
                        <strong>Fix:</strong> {c.remediation}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="rv-card">
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <HistoryIcon size={18} />
            <span>Health History</span>
          </h3>
        </div>
        <div className="rv-card-body">
          {history.length === 0 ? (
            <EmptyState title="No history yet">Run the suite to start tracking health over time.</EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="rv-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Score</th>
                    <th>Status</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedHistory.map((h) => (
                    <tr key={h.id}>
                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>{new Date(h.testedAt).toLocaleString()}</td>
                      <td style={{ fontWeight: 700, color: scoreColor(h.healthScore) }}>{h.healthScore}</td>
                      <td>
                        <span className={`rv-badge ${
                          h.status === "PASSED" ? "rv-badge-success" : h.status === "WARNING" ? "rv-badge-warning" : "rv-badge-critical"
                        }`}>
                          {h.status}
                        </span>
                      </td>
                      <td style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>{h.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            currentPage={currentPage}
            totalItems={totalHistory}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
            itemLabel="test runs"
          />
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
