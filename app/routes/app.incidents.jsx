import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, Link, useNavigate, useSearchParams, useNavigation } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ShieldCheckIcon,
  ClockIcon,
  SettingsIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  AlertTriangleIcon,
  FilterIcon,
  XIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { PillNav } from "../components/PillNav.jsx";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  // Normalize status casing and validate against accepted database values
  const rawStatus = (url.searchParams.get("status") || "").trim().toUpperCase();
  const validStatuses = ["OPEN", "RESOLVED", "ROLLED_BACK", "IGNORED"];
  const currentStatus = validStatuses.includes(rawStatus) ? rawStatus : "";

  const searchQuery = (url.searchParams.get("q") || "").trim();
  const rawSeverity = (url.searchParams.get("severity") || "").trim().toUpperCase();
  const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const currentSeverity = validSeverities.includes(rawSeverity) ? rawSeverity : "";

  const whereClause = {
    shop,
    ...(currentStatus ? { status: currentStatus } : {}),
    ...(currentSeverity ? { severity: currentSeverity } : {}),
    ...(searchQuery
      ? {
          OR: [
            { name: { contains: searchQuery } },
            { notes: { contains: searchQuery } },
          ],
        }
      : {}),
  };

  const [incidents, totalCount, openCount, resolvedCount, rolledBackCount, ignoredCount] = await Promise.all([
    prisma.incident.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        _count: { select: { changes: true } },
      },
    }),
    prisma.incident.count({ where: { shop } }),
    prisma.incident.count({ where: { shop, status: "OPEN" } }),
    prisma.incident.count({ where: { shop, status: "RESOLVED" } }),
    prisma.incident.count({ where: { shop, status: "ROLLED_BACK" } }),
    prisma.incident.count({ where: { shop, status: "IGNORED" } }),
  ]);

  return {
    incidents,
    currentStatus,
    currentSeverity,
    searchQuery,
    counts: {
      total: totalCount,
      open: openCount,
      resolved: resolvedCount,
      rolledBack: rolledBackCount,
      ignored: ignoredCount,
    },
  };
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");
    const incidentId = parseInt(formData.get("incidentId"), 10);

    if (!incidentId || isNaN(incidentId)) {
      return { success: false, message: "Invalid incident ID." };
    }

    const perm = await checkPermission(shop, session, PERMISSIONS.RESTORE);
    if (!perm.allowed) return { success: false, message: perm.message };

    const incident = await prisma.incident.findFirst({
      where: { id: incidentId, shop },
    });
    if (!incident) return { success: false, message: "Incident not found." };

    if (intent === "resolve") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      await logAudit(shop, session, "INCIDENT_RESOLVE", { incidentId, name: incident.name });
      return { success: true, message: `Incident "${incident.name}" marked as resolved.` };
    }

    if (intent === "ignore") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "IGNORED", resolvedAt: new Date() },
      });
      await logAudit(shop, session, "INCIDENT_IGNORE", { incidentId, name: incident.name });
      return { success: true, message: `Incident "${incident.name}" ignored.` };
    }

    if (intent === "reopen") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "OPEN", resolvedAt: null },
      });
      await logAudit(shop, session, "INCIDENT_REOPEN", { incidentId, name: incident.name });
      return { success: true, message: `Incident "${incident.name}" reopened as Open.` };
    }

    return { success: false, message: "Action failed." };
  } catch (error) {
    console.error("Incidents action error:", error);
    return {
      success: false,
      message: error?.message || "An unexpected error occurred.",
    };
  }
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

export default function Incidents() {
  const { incidents, currentStatus, currentSeverity, searchQuery, counts } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const [searchInput, setSearchInput] = useState(searchQuery || "");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const result = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";
  const isNavigating = navigation.state !== "idle";

  // Sync search input when url param changes
  useEffect(() => {
    setSearchInput(searchQuery || "");
  }, [searchQuery]);

  // Turn off manual refresh spinner when navigation finishes
  useEffect(() => {
    if (!isNavigating && isRefreshing) {
      setIsRefreshing(false);
    }
  }, [isNavigating, isRefreshing]);

  // Auto-refresh interval (every 30 seconds) to detect real-time incident updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && !isSubmitting && !isNavigating) {
        navigate(`.?${searchParams.toString()}`, { replace: true });
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [searchParams, isSubmitting, isNavigating, navigate]);

  const handleManualRefresh = () => {
    setIsRefreshing(true);
    navigate(`.?${searchParams.toString()}`, { replace: true });
  };

  const handleAction = (intent, incidentId) => {
    fetcher.submit({ intent, incidentId: String(incidentId) }, { method: "POST" });
  };

  const handleStatusChange = (statusId) => {
    const next = new URLSearchParams(searchParams);
    if (statusId) {
      next.set("status", statusId);
    } else {
      next.delete("status");
    }
    navigate(`.?${next.toString()}`);
  };

  const handleSeverityChange = (e) => {
    const sev = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (sev) {
      next.set("severity", sev);
    } else {
      next.delete("severity");
    }
    navigate(`.?${next.toString()}`);
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      next.set("q", searchInput.trim());
    } else {
      next.delete("q");
    }
    navigate(`.?${next.toString()}`);
  };

  const handleClearFilters = () => {
    setSearchInput("");
    navigate("/app/incidents");
  };

  const statuses = [
    { id: "", label: "All Incidents", count: counts?.total ?? 0 },
    { id: "OPEN", label: "Open", count: counts?.open ?? 0 },
    { id: "RESOLVED", label: "Resolved", count: counts?.resolved ?? 0 },
    { id: "ROLLED_BACK", label: "Rolled Back", count: counts?.rolledBack ?? 0 },
    { id: "IGNORED", label: "Ignored", count: counts?.ignored ?? 0 },
  ];

  const hasActiveFilters = Boolean(currentStatus || currentSeverity || searchQuery);

  return (
    <s-page heading="Incidents" inlineSize="large">

      {/* ── Action Feedback Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Incident Updated" : "Update Failed"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Incidents Toolbar: Unified Status Tabs + Search & Filters ── */}
      <div
        className="rv-card"
        style={{
          padding: 0,
          marginBottom: "16px",
          border: "1px solid var(--rv-border)",
          boxShadow: "var(--rv-shadow-sm)",
          overflow: "hidden",
        }}
      >
        {/* Top Row: Status Tabs & Action Buttons */}
        <div
          style={{
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
            background: "var(--rv-surface)",
            borderBottom: "1px solid var(--rv-border-subdued, #e5e7eb)",
          }}
        >
          <PillNav
            items={statuses}
            activeId={currentStatus}
            onChange={handleStatusChange}
            isLinks={false}
          />

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={isNavigating || isRefreshing}
              className="rv-btn rv-btn-secondary rv-btn-sm"
              title="Refresh latest incident status"
            >
              <RefreshCwIcon size={13} className={isRefreshing || isNavigating ? "rv-spin" : ""} />
              <span>{isRefreshing || isNavigating ? "Refreshing..." : "Refresh"}</span>
            </button>

            <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm">
              <SettingsIcon size={14} />
              <span>Configure Rules</span>
            </Link>
          </div>
        </div>

        {/* Bottom Row: Search & Severity Filters */}
        <div
          style={{
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
            background: "var(--rv-surface-subdued, #f9fafb)",
          }}
        >
          <form
            onSubmit={handleSearchSubmit}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flex: "1 1 280px",
              maxWidth: "460px",
            }}
          >
            <div className="rv-search-wrapper" style={{ flexGrow: 1, width: "100%", position: "relative" }}>
              <span className="rv-search-icon">
                <SearchIcon size={14} />
              </span>
              <input
                type="text"
                placeholder="Search incident name or details..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="rv-input rv-input-with-icon"
                style={{
                  height: "34px",
                  fontSize: "13px",
                  paddingRight: searchInput ? "32px" : "12px",
                }}
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    const next = new URLSearchParams(searchParams);
                    next.delete("q");
                    navigate(`.?${next.toString()}`);
                  }}
                  style={{
                    position: "absolute",
                    right: "8px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "4px",
                    color: "var(--rv-text-subdued)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                  }}
                  title="Clear search"
                >
                  <XIcon size={13} />
                </button>
              )}
            </div>
            <button
              type="submit"
              className="rv-btn rv-btn-secondary rv-btn-sm"
              style={{ height: "34px", flexShrink: 0, padding: "0 14px" }}
            >
              Filter
            </button>
          </form>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)", fontWeight: 500 }}>
                Severity:
              </span>
              <select
                value={currentSeverity}
                onChange={handleSeverityChange}
                className="rv-select"
                style={{
                  height: "34px",
                  fontSize: "12px",
                  padding: "0 28px 0 10px",
                  width: "auto",
                  minWidth: "130px",
                }}
              >
                <option value="">All Severities</option>
                <option value="CRITICAL">Critical</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </select>
            </div>

            <span
              style={{
                fontSize: "12px",
                color: "var(--rv-text-subdued)",
                fontWeight: 600,
                padding: "4px 8px",
                background: "var(--rv-surface)",
                border: "1px solid var(--rv-border-subdued, #e5e7eb)",
                borderRadius: "var(--rv-radius-sm)",
                lineHeight: 1,
              }}
            >
              {incidents.length} incident{incidents.length !== 1 ? "s" : ""} shown
            </span>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="rv-btn rv-btn-subtle rv-btn-sm"
                style={{ fontSize: "12px", height: "34px", gap: "4px" }}
                title="Reset all filters"
              >
                <XIcon size={12} />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Incidents List / Empty State ── */}
      {incidents.length === 0 ? (
        <EmptyState
          icon={<ShieldCheckIcon size={28} style={{ color: "var(--rv-primary)" }} />}
          title={
            counts.total === 0
              ? "All Clear — Zero Incidents Detected"
              : hasActiveFilters
              ? "No Incidents Match Your Filter"
              : `No ${currentStatus.toLowerCase().replace(/_/g, " ")} incidents`
          }
          description={
            counts.total === 0
              ? "Revertly monitors your catalog 24/7. When unauthorized bulk changes, price crashes, or rule violations occur, they will be quarantined here for 1-click rollback."
              : hasActiveFilters
              ? "Try resetting filters or adjusting search keywords to find other incidents."
              : `There are currently no incidents matching the "${currentStatus.toLowerCase().replace(/_/g, " ")}" status.`
          }
          action={
            counts.total === 0 ? (
              <Link to="/app/rules" className="rv-btn rv-btn-primary">
                Review Detection Rules
              </Link>
            ) : hasActiveFilters ? (
              <button
                type="button"
                onClick={handleClearFilters}
                className="rv-btn rv-btn-primary"
              >
                View All Incidents
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleStatusChange("")}
                className="rv-btn rv-btn-secondary"
              >
                View All Incidents
              </button>
            )
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {incidents.map((inc) => {
            const isCritical = inc.severity === "CRITICAL";
            const isOpen = inc.status === "OPEN";

            const isThisResolving =
              isSubmitting &&
              fetcher.formData?.get("incidentId") === String(inc.id) &&
              fetcher.formData?.get("intent") === "resolve";
            const isThisIgnoring =
              isSubmitting &&
              fetcher.formData?.get("incidentId") === String(inc.id) &&
              fetcher.formData?.get("intent") === "ignore";
            const isThisReopening =
              isSubmitting &&
              fetcher.formData?.get("incidentId") === String(inc.id) &&
              fetcher.formData?.get("intent") === "reopen";

            return (
              <div
                key={inc.id}
                className="rv-card"
                style={{
                  borderLeft: `4px solid ${
                    isCritical
                      ? "var(--rv-critical)"
                      : isOpen
                      ? "var(--rv-warning)"
                      : inc.status === "RESOLVED"
                      ? "var(--rv-primary)"
                      : "var(--rv-border)"
                  }`,
                  margin: 0,
                }}
              >
                <div
                  className="rv-card-body"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "16px",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <Link
                        to={`/app/incidents/${inc.id}`}
                        style={{ fontSize: "15px", fontWeight: 700, color: "var(--rv-text)", textDecoration: "none" }}
                      >
                        {inc.name}
                      </Link>
                      <span
                        className={`rv-badge rv-badge-sm ${
                          inc.severity === "CRITICAL"
                            ? "rv-badge-critical"
                            : inc.severity === "HIGH"
                            ? "rv-badge-warning"
                            : "rv-badge-info"
                        }`}
                      >
                        {inc.severity}
                      </span>
                      <span
                        className={`rv-badge rv-badge-sm ${
                          inc.status === "OPEN"
                            ? "rv-badge-critical"
                            : inc.status === "RESOLVED"
                            ? "rv-badge-success"
                            : inc.status === "ROLLED_BACK"
                            ? "rv-badge-info"
                            : "rv-badge-neutral"
                        }`}
                      >
                        {inc.status}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "var(--rv-text-subdued)", flexWrap: "wrap" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <ClockIcon size={13} />
                        <span>Detected: {formatTime(inc.createdAt)}</span>
                      </span>
                      {inc.resolvedAt && (
                        <>
                          <span>·</span>
                          <span>Completed: {formatTime(inc.resolvedAt)}</span>
                        </>
                      )}
                      <span>·</span>
                      <span><strong>{inc.affectedCount}</strong> product{inc.affectedCount !== 1 ? "s" : ""} affected</span>
                      <span>·</span>
                      <span><strong>{inc._count?.changes ?? 0}</strong> recorded field changes</span>
                    </div>

                    {inc.notes && (
                      <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        {inc.notes}
                      </p>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    {isOpen ? (
                      <>
                        <Link
                          to={`/app/incidents/${inc.id}`}
                          className="rv-btn rv-btn-critical rv-btn-sm"
                        >
                          <span>Review &amp; Rollback</span>
                          <ArrowRightIcon size={13} />
                        </Link>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => handleAction("resolve", inc.id)}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                          style={{ color: "var(--rv-primary)" }}
                        >
                          <CheckCircleIcon size={13} className={isThisResolving ? "rv-spin" : ""} />
                          <span>{isThisResolving ? "Resolving..." : "Resolve"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => handleAction("ignore", inc.id)}
                          className="rv-btn rv-btn-subtle rv-btn-sm"
                        >
                          <span>{isThisIgnoring ? "Ignoring..." : "Ignore"}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <Link
                          to={`/app/incidents/${inc.id}`}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                        >
                          <span>Inspect Details</span>
                          <ArrowRightIcon size={13} />
                        </Link>
                        {(inc.status === "RESOLVED" || inc.status === "IGNORED") && (
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={() => handleAction("reopen", inc.id)}
                            className="rv-btn rv-btn-subtle rv-btn-sm"
                            title="Reopen incident back to Open status"
                          >
                            <RefreshCwIcon size={13} className={isThisReopening ? "rv-spin" : ""} />
                            <span>{isThisReopening ? "Reopening..." : "Reopen"}</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return {
    ...boundary.headers(headersArgs),
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };
};
