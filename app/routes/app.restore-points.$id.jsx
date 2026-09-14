import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { rollbackProductFields } from "../monitor.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const rpId = parseInt(params.id);

  const restorePoint = await prisma.restorePoint.findFirst({
    where: { id: rpId, shop },
    include: {
      rollbackJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { results: true },
      },
    },
  });

  if (!restorePoint) throw new Response("Not Found", { status: 404 });

  // Get current snapshots for comparison
  const currentSnapshots = await prisma.productSnapshot.findMany({
    where: { shop },
    select: { productId: true, title: true, snapshotData: true },
  });

  const savedProducts = Array.isArray(restorePoint.snapshotData)
    ? restorePoint.snapshotData
    : [];

  // Find differences
  const currentMap = Object.fromEntries(
    currentSnapshots.map((s) => [s.productId, s.snapshotData]),
  );

  const differences = [];
  for (const saved of savedProducts) {
    const current = currentMap[saved.productId];
    if (!current) continue;

    const fieldDiffs = [];
    const fieldKeys = ["title", "status", "vendor", "tags", "handle"];
    for (const key of fieldKeys) {
      const sv = String(saved.snapshotData?.[key] ?? saved[key] ?? "");
      const cv = String(current[key] ?? "");
      if (sv !== cv) {
        fieldDiffs.push({ field: key, saved: sv, current: cv });
      }
    }

    // Check variants
    const savedVariants = saved.snapshotData?.variants || saved.variants || [];
    const currentVariants = current?.variants || [];
    for (const sv of savedVariants) {
      const cv = currentVariants.find((v) => v.id === sv.id);
      if (!cv) continue;
      for (const vf of ["price", "compareAtPrice", "sku"]) {
        if (String(sv[vf] ?? "") !== String(cv[vf] ?? "")) {
          fieldDiffs.push({
            field: `variant.${vf} (${sv.title || sv.id})`,
            saved: sv[vf] ?? "—",
            current: cv[vf] ?? "—",
          });
        }
      }
    }

    if (fieldDiffs.length > 0) {
      differences.push({
        productId: saved.productId,
        title: saved.snapshotData?.title || saved.title || saved.productId,
        diffs: fieldDiffs,
      });
    }
  }

  return {
    restorePoint,
    savedCount: savedProducts.length,
    differences,
    lastJob: restorePoint.rollbackJobs[0] || null,
  };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const rpId = parseInt(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "restore") return { success: false };

  const restorePoint = await prisma.restorePoint.findFirst({
    where: { id: rpId, shop },
  });
  if (!restorePoint) return { success: false, message: "Restore point not found." };

  const savedProducts = Array.isArray(restorePoint.snapshotData)
    ? restorePoint.snapshotData
    : [];

  // Get current snapshots
  const currentSnapshots = await prisma.productSnapshot.findMany({
    where: { shop },
    select: { productId: true, snapshotData: true },
  });
  const currentMap = Object.fromEntries(
    currentSnapshots.map((s) => [s.productId, s.snapshotData]),
  );

  const job = await prisma.rollbackJob.create({
    data: {
      shop,
      restorePointId: rpId,
      status: "RUNNING",
      totalProducts: savedProducts.length,
    },
  });

  await prisma.restorePoint.update({
    where: { id: rpId },
    data: { status: "RESTORING" },
  });

  let successCount = 0;
  let failedCount = 0;

  for (const saved of savedProducts) {
    const productId = saved.productId;
    const savedSnap = saved.snapshotData || saved;
    const current = currentMap[productId];
    if (!current) continue;

    // Build field-level change events in memory for rollback
    const mockEvents = [];
    const fieldKeys = ["title", "status", "vendor", "tags"];
    for (const key of fieldKeys) {
      const sv = String(savedSnap[key] ?? "");
      const cv = String(current[key] ?? "");
      if (sv !== cv) {
        mockEvents.push({ fieldName: key, oldValue: sv, newValue: cv, variantId: null });
      }
    }

    const savedVariants = savedSnap.variants || [];
    const currentVariants = current.variants || [];
    for (const sv of savedVariants) {
      const cv = currentVariants.find((v) => v.id === sv.id);
      if (!cv) continue;
      const numId = sv.id.replace("gid://shopify/ProductVariant/", "");
      for (const vf of ["price", "compareAtPrice", "sku"]) {
        if (String(sv[vf] ?? "") !== String(cv[vf] ?? "")) {
          mockEvents.push({
            fieldName: `variant.${vf}`,
            oldValue: String(sv[vf] ?? ""),
            newValue: String(cv[vf] ?? ""),
            variantId: numId,
          });
        }
      }
    }

    if (mockEvents.length === 0) {
      await prisma.rollbackResult.create({
        data: {
          rollbackJobId: job.id,
          productId,
          productTitle: savedSnap.title || productId,
          status: "SKIPPED",
        },
      });
      continue;
    }

    // Save temp change events, rollback, then delete them. Create each
    // individually to capture its real ID directly — re-querying by a
    // recent timestamp window risks sweeping up (and later deleting) a
    // genuine concurrent change event for the same product.
    const tempIds = [];
    for (const e of mockEvents) {
      const created = await prisma.changeEvent.create({
        data: {
          shop,
          productId,
          productTitle: savedSnap.title || productId,
          fieldName: e.fieldName,
          variantId: e.variantId,
          oldValue: e.oldValue,
          newValue: e.newValue,
        },
        select: { id: true },
      });
      tempIds.push(created.id);
    }

    const result = await rollbackProductFields(admin, shop, productId, tempIds);

    // Clean up temp events
    await prisma.changeEvent.deleteMany({ where: { id: { in: tempIds } } });

    await prisma.rollbackResult.create({
      data: {
        rollbackJobId: job.id,
        productId,
        productTitle: savedSnap.title || productId,
        status: result.success ? "SUCCESS" : "FAILED",
        errorMessage: result.error || null,
        restoredFields: result.restoredFields || {},
      },
    });

    if (result.success) successCount++;
    else failedCount++;
  }

  const finalStatus =
    failedCount === 0 ? "COMPLETED" : successCount === 0 ? "FAILED" : "PARTIAL";

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

  await prisma.restorePoint.update({
    where: { id: rpId },
    data: { status: "READY" },
  });

  return {
    success: true,
    message: `Restore ${finalStatus.toLowerCase()}: ${successCount} succeeded, ${failedCount} failed.`,
  };
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

export default function RestorePointDetail() {
  const { restorePoint, savedCount, differences, lastJob } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isRestoring = fetcher.state !== "idle";

  return (
    <s-page
      heading={restorePoint.name}
      backAction={{ url: "/app/restore-points", label: "Restore Points" }}
    >
      <s-section>
        <s-stack direction="inline" gap="loose">
          <s-badge tone={restorePoint.status === "READY" ? "success" : "attention"}>
            {restorePoint.status}
          </s-badge>
          <s-text tone="subdued">Created: {formatTime(restorePoint.createdAt)}</s-text>
          <s-text tone="subdued">{savedCount} products saved</s-text>
        </s-stack>
        {restorePoint.description && (
          <s-paragraph>{restorePoint.description}</s-paragraph>
        )}
      </s-section>

      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* Differences */}
      <s-section
        heading={`${differences.length} products differ from restore point`}
      >
        {differences.length === 0 ? (
          <s-banner tone="success">
            All products match this restore point. No changes detected.
          </s-banner>
        ) : (
          differences.map((d) => (
            <s-card key={d.productId}>
              <s-box padding="base">
                <s-stack direction="block" gap="tight">
                  <s-text fontWeight="bold">{d.title}</s-text>
                  <s-data-table
                    columnContentTypes={["text", "text", "text"]}
                    headings={["Field", "Saved (Restore Point)", "Current"]}
                    rows={d.diffs.map((df) => [df.field, String(df.saved), String(df.current)])}
                  />
                </s-stack>
              </s-box>
            </s-card>
          ))
        )}
      </s-section>

      {/* Last rollback job */}
      {lastJob && (
        <s-section heading="Last Restore Job">
          <s-card>
            <s-box padding="base">
              <s-stack direction="inline" gap="base">
                <s-badge
                  tone={
                    lastJob.status === "COMPLETED"
                      ? "success"
                      : lastJob.status === "FAILED"
                        ? "critical"
                        : "attention"
                  }
                >
                  {lastJob.status}
                </s-badge>
                <s-text>
                  {lastJob.successCount}/{lastJob.totalProducts} products restored
                </s-text>
                <s-text tone="subdued">{formatTime(lastJob.createdAt)}</s-text>
              </s-stack>
            </s-box>
          </s-card>
        </s-section>
      )}

      {/* Restore Action */}
      {differences.length > 0 && (
        <s-section>
          <fetcher.Form method="POST">
            <input type="hidden" name="intent" value="restore" />
            <s-stack direction="inline" gap="base">
              <s-button
                submit
                variant="primary"
                tone="critical"
                {...(isRestoring ? { loading: true } : {})}
              >
                Restore {differences.length} Products to This Point
              </s-button>
            </s-stack>
          </fetcher.Form>
          <s-paragraph>
            <s-text tone="subdued">
              Only changed fields will be restored. Unaffected fields remain unchanged.
            </s-text>
          </s-paragraph>
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
