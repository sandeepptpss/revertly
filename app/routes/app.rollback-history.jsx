import { useLoaderData, useRouteError } from "react-router";
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

export default function RollbackHistory() {
  const { jobs } = useLoaderData();

  return (
    <s-page
      heading="Rollback History"
      backAction={{ url: "/app", label: "Dashboard" }}
      inlineSize="large"
    >
      <s-section heading={`${jobs.length} rollback jobs`}>
        {jobs.length === 0 ? (
          <s-empty-state heading="No rollbacks yet">
            <s-paragraph>
              Rollback jobs will appear here after you roll back an incident or restore
              point.
            </s-paragraph>
          </s-empty-state>
        ) : (
          jobs.map((job) => (
            <s-card key={job.id}>
              <s-box padding="base">
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" align="space-between">
                    <s-stack direction="block" gap="tight">
                      <s-stack direction="inline" gap="tight">
                        <s-badge
                          tone={
                            {
                              COMPLETED: "success",
                              FAILED: "critical",
                              PARTIAL: "warning",
                              RUNNING: "attention",
                              PENDING: "subdued",
                            }[job.status] || "info"
                          }
                        >
                          {job.status}
                        </s-badge>
                        {job.incident && (
                          <s-link url={`/app/incidents/${job.incident.id}`}>
                            Incident: {job.incident.name}
                          </s-link>
                        )}
                        {job.restorePoint && (
                          <s-link url={`/app/restore-points/${job.restorePoint.id}`}>
                            Restore Point: {job.restorePoint.name}
                          </s-link>
                        )}
                      </s-stack>
                      <s-text tone="subdued">{formatTime(job.createdAt)}</s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="base">
                      <s-text>
                        {job.successCount}/{job.totalProducts} succeeded
                      </s-text>
                      {job.failedCount > 0 && (
                        <s-badge tone="critical">{job.failedCount} failed</s-badge>
                      )}
                      <s-text tone="subdued">
                        Duration: {duration(job.createdAt, job.completedAt)}
                      </s-text>
                    </s-stack>
                  </s-stack>

                  {/* Results */}
                  {job.results.length > 0 && (
                    <s-collapsible>
                      <s-collapsible-activator>
                        View {job.results.length} product results
                      </s-collapsible-activator>
                      <s-collapsible-panel>
                        <s-data-table
                          columnContentTypes={["text", "text", "text"]}
                          headings={["Product", "Status", "Error"]}
                          rows={job.results.map((r) => [
                            r.productTitle,
                            r.status,
                            r.errorMessage || "—",
                          ])}
                        />
                      </s-collapsible-panel>
                    </s-collapsible>
                  )}
                </s-stack>
              </s-box>
            </s-card>
          ))
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
