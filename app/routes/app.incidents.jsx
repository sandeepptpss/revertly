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

  if (intent === "resolve") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return { success: true, action: "resolved" };
  }

  if (intent === "ignore") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "IGNORED", resolvedAt: new Date() },
    });
    return { success: true, action: "ignored" };
  }

  return { success: false };
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

  const handleAction = (intent, incidentId) => {
    fetcher.submit({ intent, incidentId: String(incidentId) }, { method: "POST" });
  };

  const statuses = ["", "OPEN", "RESOLVED", "IGNORED", "ROLLED_BACK"];

  return (
    <s-page heading="Incidents">
      {/* Status filter tabs */}
      <s-section>
        <s-stack direction="inline" gap="tight">
          {statuses.map((s) => (
            <s-link
              key={s || "all"}
              url={`/app/incidents${s ? `?status=${s}` : ""}`}
            >
              <s-badge tone={s === currentStatus ? "info" : undefined}>
                {s || "All"}
              </s-badge>
            </s-link>
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
