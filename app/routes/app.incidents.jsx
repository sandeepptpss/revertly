import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const incidentId = parseInt(formData.get("incidentId"));

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
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function severityTone(severity) {
  const map = {
    CRITICAL: "critical",
    HIGH: "warning",
    MEDIUM: "attention",
    LOW: "success",
  };
  return map[severity] || "info";
}

function statusTone(status) {
  const map = {
    OPEN: "critical",
    RESOLVED: "success",
    IGNORED: "subdued",
    ROLLED_BACK: "success",
  };
  return map[status] || "info";
}

export default function Incidents() {
  const { incidents, currentStatus } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;

  const handleAction = (intent, incidentId) => {
    fetcher.submit({ intent, incidentId: String(incidentId) }, { method: "POST" });
  };

  const statuses = [
    { id: "", label: "All Incidents" },
    { id: "OPEN", label: "Open" },
    { id: "RESOLVED", label: "Resolved" },
    { id: "ROLLED_BACK", label: "Rolled Back" },
    { id: "IGNORED", label: "Ignored" },
  ];

  return (
    <s-page heading="Incidents" inlineSize="large">
      {/* Action feedback banner */}
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* Status filter tabs */}
      <s-section>
        <s-stack direction="inline" gap="tight" wrap>
          {statuses.map((s) => (
            <s-button
              key={s.id || "all"}
              url={`/app/incidents${s.id ? `?status=${s.id}` : ""}`}
              variant={s.id === currentStatus ? "primary" : "secondary"}
            >
              {s.label}
            </s-button>
          ))}
        </s-stack>
      </s-section>

      <s-section heading={`${incidents.length} incidents`}>
        {incidents.length === 0 ? (
          <s-empty-state heading="No incidents">
            <s-paragraph>
              Incidents are created when suspicious or bulk product changes are
              detected. Your store is safe!
            </s-paragraph>
          </s-empty-state>
        ) : (
          <s-resource-list>
            {incidents.map((inc) => (
              <s-resource-item key={inc.id} id={String(inc.id)}>
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" align="space-between">
                    <s-text fontWeight="bold">{inc.name}</s-text>
                    <s-stack direction="inline" gap="tight">
                      <s-badge tone={severityTone(inc.severity)}>
                        {inc.severity}
                      </s-badge>
                      <s-badge tone={statusTone(inc.status)}>
                        {inc.status}
                      </s-badge>
                    </s-stack>
                  </s-stack>
                  <s-stack direction="inline" gap="loose">
                    <s-text tone="subdued">
                      {formatTime(inc.createdAt)}
                    </s-text>
                    <s-text tone="subdued">
                      {inc.affectedCount} product
                      {inc.affectedCount !== 1 ? "s" : ""} affected
                    </s-text>
                    <s-text tone="subdued">
                      {inc._count.changes} change events
                    </s-text>
                  </s-stack>
                  {inc.status === "OPEN" && (
                    <s-stack direction="inline" gap="tight">
                      <s-button
                        url={`/app/incidents/${inc.id}`}
                        variant="primary"
                      >
                        Review &amp; Rollback
                      </s-button>
                      <s-button
                        onClick={() => handleAction("resolve", inc.id)}
                        variant="secondary"
                        tone="success"
                      >
                        Resolve
                      </s-button>
                      <s-button
                        onClick={() => handleAction("ignore", inc.id)}
                        variant="secondary"
                      >
                        Ignore
                      </s-button>
                    </s-stack>
                  )}
                  {inc.status !== "OPEN" && (
                    <s-link url={`/app/incidents/${inc.id}`}>
                      View details
                    </s-link>
                  )}
                </s-stack>
              </s-resource-item>
            ))}
          </s-resource-list>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
