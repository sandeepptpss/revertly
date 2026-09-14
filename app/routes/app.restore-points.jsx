import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const restorePoints = await prisma.restorePoint.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  return { restorePoints };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const name = formData.get("name");
    const description = formData.get("description") || "";

    // Create restore point record
    const rp = await prisma.restorePoint.create({
      data: {
        shop,
        name,
        description,
        status: "CREATING",
      },
    });

    // Fetch all product snapshots
    const snapshots = await prisma.productSnapshot.findMany({
      where: { shop },
      select: { productId: true, snapshotData: true, title: true },
    });

    await prisma.restorePoint.update({
      where: { id: rp.id },
      data: {
        status: "READY",
        productCount: snapshots.length,
        snapshotData: snapshots,
      },
    });

    return { success: true, message: `Restore point "${name}" created with ${snapshots.length} products.` };
  }

  if (intent === "delete") {
    const rpId = parseInt(formData.get("rpId"));
    const rp = await prisma.restorePoint.findUnique({ where: { id: rpId } });
    if (rp && rp.shop === shop) {
      await prisma.restorePoint.delete({ where: { id: rpId } });
    }
    return { success: true, message: "Restore point deleted." };
  }

  return { success: false };
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

export default function RestorePoints() {
  const { restorePoints } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isCreating = fetcher.state !== "idle";

  return (
    <s-page heading="Restore Points">
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* Create Restore Point */}
      <s-section heading="Create New Restore Point">
        <s-paragraph>
          A restore point captures the current state of all monitored products. You can
          restore to this point at any time in the future.
        </s-paragraph>
        <fetcher.Form method="POST">
          <input type="hidden" name="intent" value="create" />
          <s-form-layout>
            <s-text-field
              name="name"
              label="Name"
              placeholder="e.g. Before Summer Sale Pricing"
              required
            />
            <s-text-field
              name="description"
              label="Description (optional)"
              multiline
              placeholder="Notes about this restore point..."
            />
            <s-button
              submit
              variant="primary"
              {...(isCreating ? { loading: true } : {})}
            >
              Create Restore Point
            </s-button>
          </s-form-layout>
        </fetcher.Form>
      </s-section>

      {/* Restore Points List */}
      <s-section heading={`${restorePoints.length} restore points`}>
        {restorePoints.length === 0 ? (
          <s-empty-state heading="No restore points">
            <s-paragraph>
              Create restore points before major price changes or bulk updates so you
              can recover quickly if something goes wrong.
            </s-paragraph>
          </s-empty-state>
        ) : (
          <s-resource-list>
            {restorePoints.map((rp) => (
              <s-resource-item key={rp.id} id={String(rp.id)}>
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" align="space-between">
                    <s-stack direction="block" gap="tight">
                      <s-text fontWeight="bold">{rp.name}</s-text>
                      {rp.description && (
                        <s-text tone="subdued">{rp.description}</s-text>
                      )}
                      <s-text tone="subdued">
                        {formatTime(rp.createdAt)} · {rp.productCount} products
                      </s-text>
                    </s-stack>
                    <s-badge
                      tone={
                        rp.status === "READY"
                          ? "success"
                          : rp.status === "CREATING"
                            ? "attention"
                            : "subdued"
                      }
                    >
                      {rp.status}
                    </s-badge>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <s-button url={`/app/restore-points/${rp.id}`} variant="primary">
                      Restore From This Point
                    </s-button>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="rpId" value={rp.id} />
                      <s-button submit tone="critical" variant="tertiary">
                        Delete
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
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
