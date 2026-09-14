import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rollbackProductFields } from "../monitor.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const incidentId = parseInt(params.id);

  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, shop },
    include: {
      changes: { orderBy: { changedAt: "desc" } },
      triggeredRule: true,
      rollbackJobs: {
        orderBy: { createdAt: "desc" },
        include: { results: true },
      },
    },
  });

  if (!incident) throw new Response("Not Found", { status: 404 });

  // Group changes by product for rollback preview
  const byProduct = {};
  for (const c of incident.changes) {
    if (!byProduct[c.productId]) {
      byProduct[c.productId] = { title: c.productTitle, changes: [] };
    }
    byProduct[c.productId].changes.push(c);
  }

  return { incident, byProduct };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const incidentId = parseInt(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "resolve") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return { success: true, message: "Incident resolved." };
  }

  if (intent === "ignore") {
    await prisma.incident.update({
      where: { id: incidentId },
      data: { status: "IGNORED", resolvedAt: new Date() },
    });
    return { success: true, message: "Incident ignored." };
  }

  if (intent === "rollback") {
    // Get all change events for this incident
    const changes = await prisma.changeEvent.findMany({
      where: { incidentId, shop },
    });

    // Group by productId
    const byProduct = {};
    for (const c of changes) {
      if (!byProduct[c.productId]) byProduct[c.productId] = [];
      byProduct[c.productId].push(c.id);
    }

    // Create rollback job
    const job = await prisma.rollbackJob.create({
      data: {
        shop,
        incidentId,
        status: "RUNNING",
        totalProducts: Object.keys(byProduct).length,
      },
    });

    // Process each product
    let successCount = 0;
    let failedCount = 0;

    for (const [productId, eventIds] of Object.entries(byProduct)) {
      const result = await rollbackProductFields(admin, shop, productId, eventIds);

      await prisma.rollbackResult.create({
        data: {
          rollbackJobId: job.id,
          productId,
          productTitle:
            changes.find((c) => c.productId === productId)?.productTitle ||
            productId,
          status: result.success ? "SUCCESS" : "FAILED",
          errorMessage: result.error || null,
          restoredFields: result.restoredFields || {},
        },
      });

      if (result.success) successCount++;
      else failedCount++;
    }

    // Update job status
    const finalStatus =
      failedCount === 0
        ? "COMPLETED"
        : successCount === 0
          ? "FAILED"
          : "PARTIAL";

    await prisma.rollbackJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        processedCount: successCount + failedCount,
        successCount,
        failedCount,
        completedAt: new Date(),
      },
    });

    // Mark incident as rolled back
    if (finalStatus !== "FAILED") {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { status: "ROLLED_BACK", resolvedAt: new Date() },
      });
    }

    return {
      success: true,
      message: `Rollback ${finalStatus.toLowerCase()}: ${successCount} succeeded, ${failedCount} failed.`,
      jobId: job.id,
    };
  }

  return { success: false };
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function fieldLabel(fn) {
  return fn.replace("variant.", "Variant ").replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

export default function IncidentDetail() {
  const { incident, byProduct } = useLoaderData();
  const fetcher = useFetcher();
  const isRolling = fetcher.state !== "idle";
  const result = fetcher.data;

  const canRollback = incident.status === "OPEN";

  return (
    <s-page
      heading={incident.name}
      backAction={{ url: "/app/incidents", label: "Incidents" }}
      inlineSize="large"
    >
      {/* Status Bar */}
      <s-section>
        <s-stack direction="inline" gap="loose">
          <s-badge
            tone={
              {
                CRITICAL: "critical",
                HIGH: "warning",
                MEDIUM: "attention",
                LOW: "success",
              }[incident.severity] || "info"
            }
          >
            {incident.severity}
          </s-badge>
          <s-badge
            tone={
              {
                OPEN: "critical",
                RESOLVED: "success",
                IGNORED: "subdued",
                ROLLED_BACK: "success",
              }[incident.status] || "info"
            }
          >
            {incident.status}
          </s-badge>
          <s-text tone="subdued">
            Detected: {formatTime(incident.createdAt)}
          </s-text>
          <s-text tone="subdued">
            {incident.affectedCount} product
            {incident.affectedCount !== 1 ? "s" : ""} affected
          </s-text>
        </s-stack>
      </s-section>

      {/* Result banner */}
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* ── Emergency Action Bar ── */}
      {canRollback && (
        <s-section>
          <s-card>
            <s-box padding="base">
              <s-stack direction="inline" align="space-between" align-items="center" wrap>
                <s-stack direction="block" gap="extraTight">
                  <s-text fontWeight="bold">Action Required: Incident is Open</s-text>
                  <s-text tone="subdued">
                    Review the {incident.affectedCount} affected product{incident.affectedCount !== 1 ? "s" : ""} below or execute an instant rollback to restore previous catalog values.
                  </s-text>
                </s-stack>
                <s-stack direction="inline" gap="tight" align-items="center">
                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="rollback" />
                    <s-button
                      submit
                      variant="primary"
                      tone="critical"
                      {...(isRolling ? { loading: true } : {})}
                    >
                      ⚡ Confirm Rollback ({Object.keys(byProduct).length} Products)
                    </s-button>
                  </fetcher.Form>
                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="resolve" />
                    <s-button submit tone="success" variant="secondary">
                      Mark Resolved
                    </s-button>
                  </fetcher.Form>
                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="ignore" />
                    <s-button submit variant="tertiary">
                      Ignore
                    </s-button>
                  </fetcher.Form>
                </s-stack>
              </s-stack>
            </s-box>
          </s-card>
        </s-section>
      )}

      {/* Rollback Preview */}
      <s-section heading="Affected Products &amp; Changes">
        <s-paragraph>
          The following products and fields will be restored to their previous values.
        </s-paragraph>
        {Object.entries(byProduct).map(([productId, data]) => (
          <s-card key={productId}>
            <s-box padding="base">
              <s-stack direction="block" gap="tight">
                <s-text fontWeight="bold">{data.title}</s-text>
                <s-data-table
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Field", "Previous Value", "New Value", "Changed At"]}
                  rows={data.changes.map((c) => [
                    fieldLabel(c.fieldName),
                    c.oldValue || "—",
                    c.newValue || "—",
                    formatTime(c.changedAt),
                  ])}
                />
              </s-stack>
            </s-box>
          </s-card>
        ))}
      </s-section>

      {/* Rollback Jobs */}
      {incident.rollbackJobs.length > 0 && (
        <s-section heading="Rollback History">
          {incident.rollbackJobs.map((job) => (
            <s-card key={job.id}>
              <s-box padding="base">
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" gap="base">
                    <s-badge
                      tone={
                        job.status === "COMPLETED"
                          ? "success"
                          : job.status === "FAILED"
                            ? "critical"
                            : "attention"
                      }
                    >
                      {job.status}
                    </s-badge>
                    <s-text tone="subdued">{formatTime(job.createdAt)}</s-text>
                    <s-text>
                      {job.successCount}/{job.totalProducts} succeeded
                    </s-text>
                  </s-stack>
                  {job.results.map((r) => (
                    <s-stack key={r.id} direction="inline" gap="base">
                      <s-badge tone={r.status === "SUCCESS" ? "success" : "critical"}>
                        {r.status}
                      </s-badge>
                      <s-text>{r.productTitle}</s-text>
                      {r.errorMessage && (
                        <s-text tone="critical">{r.errorMessage}</s-text>
                      )}
                    </s-stack>
                  ))}
                </s-stack>
              </s-box>
            </s-card>
          ))}
        </s-section>
      )}

      {/* Actions */}
      {canRollback && (
        <s-section>
          <s-stack direction="inline" gap="base">
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="rollback" />
              <s-button
                submit
                variant="primary"
                tone="critical"
                {...(isRolling ? { loading: true } : {})}
              >
                Confirm Rollback ({Object.keys(byProduct).length} products)
              </s-button>
            </fetcher.Form>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="resolve" />
              <s-button submit tone="success">
                Mark Resolved
              </s-button>
            </fetcher.Form>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="ignore" />
              <s-button submit variant="secondary">
                Ignore
              </s-button>
            </fetcher.Form>
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
