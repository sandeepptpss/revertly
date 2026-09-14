import { useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [
    totalProducts,
    todayChanges,
    openIncidents,
    readyRestorePoints,
    recentChanges,
    recentIncidents,
    totalRollbacks,
  ] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.changeEvent.count({
      where: {
        shop,
        changedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.incident.count({ where: { shop, status: "OPEN" } }),
    prisma.restorePoint.count({ where: { shop, status: "READY" } }),
    prisma.changeEvent.findMany({
      where: { shop },
      orderBy: { changedAt: "desc" },
      take: 8,
    }),
    prisma.incident.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { _count: { select: { changes: true } } },
    }),
    prisma.rollbackJob.count({ where: { shop, status: "COMPLETED" } }),
  ]);

  return {
    stats: { totalProducts, todayChanges, openIncidents, readyRestorePoints, totalRollbacks },
    recentChanges,
    recentIncidents,
    shop,
    isInitialized: totalProducts > 0,
  };
};

function timeAgo(date) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function fieldLabel(fn) {
  return fn
    .replace("variant.", "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase());
}

function severityTone(s) {
  return { CRITICAL: "critical", HIGH: "warning", MEDIUM: "attention", LOW: "success" }[s] || "info";
}

function statusTone(s) {
  return { OPEN: "critical", RESOLVED: "success", IGNORED: "subdued", ROLLED_BACK: "success" }[s] || "info";
}

export default function Dashboard() {
  const { stats, recentChanges, recentIncidents, isInitialized } = useLoaderData();

  return (
    <s-page heading="Dashboard" inlineSize="large">

      {/* ── Onboarding Banner (only when not initialized) ── */}
      {!isInitialized && (
        <s-section>
          <s-banner
            title="Welcome to Revertly!"
            tone="info"
            action={{ content: "Initialize Monitoring", url: "/app/initialize" }}
          >
            <s-paragraph>
              Start monitoring your products in seconds. Click <strong>Initialize Monitoring</strong> to take
              a snapshot of all current products — this gives Revertly a baseline to detect future changes.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      {/* ── Alert: Open Incidents ── */}
      {stats.openIncidents > 0 ? (
        <s-section>
          <s-banner
            title={`${stats.openIncidents} open incident${stats.openIncidents > 1 ? "s" : ""} require your attention`}
            tone="critical"
            action={{ content: "Review Incidents", url: "/app/incidents" }}
          >
            <s-paragraph>
              Suspicious product changes have been detected. Review and rollback if needed.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : isInitialized ? (
        <s-section>
          <s-banner
            title="Catalog Watchdog Active — Store is Protected"
            tone="success"
          >
            <s-paragraph>
              All products are actively protected against accidental price crashes and bulk changes. Zero open incidents.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {/* ── Stats Cards ── */}
      <s-section heading="Overview">
        <s-columns columns="4">
          {/* Monitored Products */}
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="tight">
                <s-text tone="subdued">Monitored Products</s-text>
                <s-heading level="2">
                  {stats.totalProducts.toLocaleString()}
                </s-heading>
                <s-text tone="subdued">
                  {isInitialized ? "Actively tracked" : "Not initialized yet"}
                </s-text>
                {!isInitialized && (
                  <s-link href="/app/initialize">Initialize now →</s-link>
                )}
              </s-stack>
            </s-box>
          </s-card>

          {/* Changes Today */}
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="tight">
                <s-text tone="subdued">Changes Today</s-text>
                <s-heading level="2">
                  {stats.todayChanges.toLocaleString()}
                </s-heading>
                <s-text tone="subdued">
                  {stats.todayChanges === 0 ? "No changes in last 24h" : "In the last 24 hours"}
                </s-text>
                <s-link href="/app/activity">View activity →</s-link>
              </s-stack>
            </s-box>
          </s-card>

          {/* Open Incidents */}
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="tight">
                <s-text tone="subdued">Open Incidents</s-text>
                <s-heading level="2">
                  {stats.openIncidents.toLocaleString()}
                </s-heading>
                <s-text tone={stats.openIncidents > 0 ? "critical" : "subdued"}>
                  {stats.openIncidents > 0 ? "Requires attention" : "All clear"}
                </s-text>
                <s-link href="/app/incidents">View incidents →</s-link>
              </s-stack>
            </s-box>
          </s-card>

          {/* Restore Points */}
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="tight">
                <s-text tone="subdued">Restore Points</s-text>
                <s-heading level="2">
                  {stats.readyRestorePoints.toLocaleString()}
                </s-heading>
                <s-text tone="subdued">
                  {stats.readyRestorePoints === 0 ? "None created yet" : "Ready to restore"}
                </s-text>
                <s-link href="/app/restore-points">
                  {stats.readyRestorePoints === 0 ? "Create one →" : "Manage →"}
                </s-link>
              </s-stack>
            </s-box>
          </s-card>
        </s-columns>
      </s-section>

      {/* ── Two Column Layout: Incidents + Activity ── */}
      <s-section>
        <s-columns columns="2">
          {/* Recent Incidents */}
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" align="space-between">
                  <s-text fontWeight="bold" variant="headingMd">
                    Recent Incidents
                  </s-text>
                  <s-link href="/app/incidents">View all</s-link>
                </s-stack>

                {recentIncidents.length === 0 ? (
                  <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued" background="surface-secondary">
                    <s-stack direction="block" gap="tight" align="center">
                      <s-text variant="bodySm" fontWeight="bold">🛡️ Shield Active &bull; Zero Incidents</s-text>
                      <s-text tone="subdued" variant="bodyXs">
                        Your store is safe! Suspicious price drops and mass updates will be flagged here immediately.
                      </s-text>
                    </s-stack>
                  </s-box>
                ) : (
                  <s-stack direction="block" gap="tight">
                    {recentIncidents.map((inc) => (
                      <s-box
                        key={inc.id}
                        padding="tight"
                        borderWidth="base"
                        borderRadius="base"
                      >
                        <s-stack direction="block" gap="tight">
                          <s-stack direction="inline" align="space-between">
                            <s-text fontWeight="semibold">{inc.name}</s-text>
                            <s-badge tone={statusTone(inc.status)}>
                              {inc.status}
                            </s-badge>
                          </s-stack>
                          <s-stack direction="inline" gap="tight">
                            <s-badge tone={severityTone(inc.severity)}>
                              {inc.severity}
                            </s-badge>
                            <s-text tone="subdued">
                              {inc.affectedCount} product{inc.affectedCount !== 1 ? "s" : ""}
                            </s-text>
                            <s-text tone="subdued">·</s-text>
                            <s-text tone="subdued">{timeAgo(inc.createdAt)}</s-text>
                          </s-stack>
                          {inc.status === "OPEN" && (
                            <s-link href={`/app/incidents/${inc.id}`}>
                              Review &amp; Rollback →
                            </s-link>
                          )}
                        </s-stack>
                      </s-box>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-box>
          </s-card>

          {/* Recent Activity */}
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" align="space-between">
                  <s-text fontWeight="bold" variant="headingMd">
                    Recent Activity
                  </s-text>
                  <s-link href="/app/activity">View all</s-link>
                </s-stack>

                {recentChanges.length === 0 ? (
                  <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued" background="surface-secondary">
                    <s-stack direction="block" gap="tight" align="center">
                      <s-text variant="bodySm" fontWeight="bold">📡 Listening for Updates</s-text>
                      <s-text tone="subdued" variant="bodyXs">
                        Product updates, price changes, and deletions will appear in real time.
                      </s-text>
                    </s-stack>
                  </s-box>
                ) : (
                  <s-stack direction="block" gap="tight">
                    {recentChanges.map((c) => (
                      <s-box
                        key={c.id}
                        padding="tight"
                        borderWidth="base"
                        borderRadius="base"
                      >
                        <s-stack direction="inline" align="space-between">
                          <s-stack direction="block" gap="extraTight">
                            <s-text fontWeight="semibold">{c.productTitle}</s-text>
                            <s-text tone="subdued">
                              {fieldLabel(c.fieldName)}:{" "}
                              <span style={{ textDecoration: "line-through" }}>
                                {c.oldValue || "—"}
                              </span>{" "}
                              → <strong>{c.newValue || "—"}</strong>
                            </s-text>
                          </s-stack>
                          <s-text tone="subdued">{timeAgo(c.changedAt)}</s-text>
                        </s-stack>
                      </s-box>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-box>
          </s-card>
        </s-columns>
      </s-section>

      {/* ── Quick Actions Aside ── */}
      <s-section slot="aside" heading="Quick Actions">
        <s-stack direction="block" gap="tight">
          <s-button url="/app/restore-points" variant="primary" fullWidth>
            + Create Restore Point
          </s-button>
          <s-button url="/app/incidents" fullWidth>
            View Incidents
            {stats.openIncidents > 0 && ` (${stats.openIncidents} open)`}
          </s-button>
          <s-button url="/app/rules" fullWidth>
            Manage Detection Rules
          </s-button>
          <s-button url="/app/activity" fullWidth>
            Browse Activity Log
          </s-button>
          <s-button url="/app/rollback-history" fullWidth>
            Rollback History
          </s-button>
        </s-stack>
      </s-section>

      {/* ── System Status Aside ── */}
      <s-section slot="aside" heading="System Status">
        <s-stack direction="block" gap="tight">
          <s-stack direction="inline" gap="tight">
            <s-badge tone={isInitialized ? "success" : "warning"}>
              {isInitialized ? "Monitoring Active" : "Not Initialized"}
            </s-badge>
          </s-stack>
          <s-stack direction="inline" gap="tight">
            <s-badge tone="success">Webhooks Registered</s-badge>
          </s-stack>
          <s-stack direction="inline" gap="tight">
            <s-badge tone="success">Database Connected</s-badge>
          </s-stack>
          {stats.totalRollbacks > 0 && (
            <s-text tone="subdued">
              {stats.totalRollbacks} successful rollback{stats.totalRollbacks !== 1 ? "s" : ""} completed
            </s-text>
          )}
        </s-stack>
      </s-section>

      {/* ── Getting Started Aside (only when not initialized) ── */}
      {!isInitialized && (
        <s-section slot="aside" heading="Getting Started">
          <s-stack direction="block" gap="tight">
            <s-stack direction="inline" gap="tight">
              <s-text>1.</s-text>
              <s-link href="/app/initialize">Initialize product snapshots</s-link>
            </s-stack>
            <s-stack direction="inline" gap="tight">
              <s-text>2.</s-text>
              <s-link href="/app/rules">Set up detection rules</s-link>
            </s-stack>
            <s-stack direction="inline" gap="tight">
              <s-text>3.</s-text>
              <s-link href="/app/restore-points">Create a restore point</s-link>
            </s-stack>
            <s-stack direction="inline" gap="tight">
              <s-text>4.</s-text>
              <s-link href="/app/settings">Configure alert email</s-link>
            </s-stack>
          </s-stack>
        </s-section>
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
