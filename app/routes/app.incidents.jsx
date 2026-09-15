import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ShieldCheckIcon,
  ClockIcon,
  SettingsIcon,
  ArrowRightIcon,
  CheckCircleIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { PillNav } from "../components/PillNav.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";

  const incidents = await prisma.incident.findMany({
    where: {
      shop,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { changes: true } },
    },
  });

  return { incidents, currentStatus: status };
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

    const incident = await prisma.incident.findFirst({
      where: { id: incidentId, shop },
    });
    if (!incident) return { success: false, message: "Incident not found." };

    if (intent === "resolve") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      return { success: true, message: "Incident marked as resolved." };
    }

    if (intent === "ignore") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "IGNORED", resolvedAt: new Date() },
      });
      return { success: true, message: "Incident ignored." };
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
  const { incidents, currentStatus } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;

  const handleAction = (intent, incidentId) => {
    fetcher.submit({ intent, incidentId: String(incidentId) }, { method: "POST" });
  };

  const statuses = [
    { id: "", label: "All Incidents", to: "/app/incidents" },
    { id: "OPEN", label: "Open", to: "/app/incidents?status=OPEN" },
    { id: "RESOLVED", label: "Resolved", to: "/app/incidents?status=RESOLVED" },
    { id: "ROLLED_BACK", label: "Rolled Back", to: "/app/incidents?status=ROLLED_BACK" },
    { id: "IGNORED", label: "Ignored", to: "/app/incidents?status=IGNORED" },
  ];

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

      {/* ── Filter Toolbar & Navigation ── */}
      <div className="rv-filter-bar">
        <PillNav
          items={statuses}
          activeId={currentStatus}
          isLinks={true}
        />

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", fontWeight: 500 }}>
            {incidents.length} incident{incidents.length !== 1 ? "s" : ""}
          </span>
          <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm">
            <SettingsIcon size={14} />
            <span>Configure Rules</span>
          </Link>
        </div>
      </div>

      {/* ── Incidents List / Empty State ── */}
      {incidents.length === 0 ? (
        <EmptyState
          icon={<ShieldCheckIcon size={28} style={{ color: "var(--rv-primary)" }} />}
          title={currentStatus ? `No ${currentStatus.toLowerCase()} incidents` : "All Clear — Zero Incidents Detected"}
          description={
            currentStatus
              ? `There are currently no incidents matching the "${currentStatus}" status.`
              : "Revertly monitors your catalog 24/7. When unauthorized bulk changes, price crashes, or rule violations occur, they will be quarantined here for 1-click rollback."
          }
          action={
            currentStatus ? (
              <Link to="/app/incidents" className="rv-btn rv-btn-secondary">
                View All Incidents
              </Link>
            ) : (
              <Link to="/app/rules" className="rv-btn rv-btn-primary">
                Review Detection Rules
              </Link>
            )
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {incidents.map((inc) => {
            const isCritical = inc.severity === "CRITICAL";
            const isOpen = inc.status === "OPEN";

            return (
              <div
                key={inc.id}
                className="rv-card"
                style={{
                  borderLeft: `4px solid ${
                    isCritical ? "var(--rv-critical)" : isOpen ? "var(--rv-warning)" : "var(--rv-border)"
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
                      <span>·</span>
                      <span><strong>{inc.affectedCount}</strong> product{inc.affectedCount !== 1 ? "s" : ""} affected</span>
                      <span>·</span>
                      <span><strong>{inc._count.changes}</strong> recorded field changes</span>
                    </div>
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
                          onClick={() => handleAction("resolve", inc.id)}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                          style={{ color: "var(--rv-primary)" }}
                        >
                          <CheckCircleIcon size={13} />
                          <span>Resolve</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAction("ignore", inc.id)}
                          className="rv-btn rv-btn-subtle rv-btn-sm"
                        >
                          Ignore
                        </button>
                      </>
                    ) : (
                      <Link
                        to={`/app/incidents/${inc.id}`}
                        className="rv-btn rv-btn-secondary rv-btn-sm"
                      >
                        <span>Inspect Details</span>
                        <ArrowRightIcon size={13} />
                      </Link>
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
  return boundary.headers(headersArgs);
};
