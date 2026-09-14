import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { buildSnapshot } from "../monitor.server.js";
import { createMultiResourceRestorePoint } from "../backup.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useFetcher, useLoaderData, useRouteError } from "react-router";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const count = await prisma.productSnapshot.count({ where: { shop } });
  return { shop, count };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let cursor = null;
  let totalSaved = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `#graphql
      query getProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title status vendor productType tags handle bodyHtml publishedAt
              metafields(first: 50) {
                edges {
                  node {
                    id namespace key value type
                  }
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id title price compareAtPrice sku
                    inventoryQuantity weight weightUnit barcode
                  }
                }
              }
            }
          }
        }
      }`;

    const resp = await admin.graphql(query, {
      variables: { cursor },
    });
    const json = await resp.json();
    const products = json.data?.products;
    if (!products) break;

    const edges = products.edges || [];
    hasNextPage = products.pageInfo?.hasNextPage || false;
    cursor = products.pageInfo?.endCursor || null;

    for (const { node: product } of edges) {
      const snapshot = buildSnapshot(product);
      const numericId = product.id.replace("gid://shopify/Product/", "");

      await prisma.productSnapshot.upsert({
        where: { shop_productId: { shop, productId: numericId } },
        create: {
          shop,
          productId: numericId,
          title: product.title || "",
          status: product.status || "ACTIVE",
          vendor: product.vendor || "",
          productType: product.productType || "",
          tags: Array.isArray(product.tags) ? product.tags.join(", ") : product.tags || "",
          bodyHtml: product.bodyHtml || "",
          handle: product.handle || "",
          publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
          snapshotData: snapshot,
        },
        update: {
          title: product.title || "",
          status: product.status || "ACTIVE",
          snapshotData: snapshot,
        },
      });
      totalSaved++;
    }
  }

  // Auto-create initial Full Store Baseline if no restore points exist yet
  let initialRpCreated = false;
  const existingRp = await prisma.restorePoint.findFirst({ where: { shop } });
  if (!existingRp) {
    try {
      await createMultiResourceRestorePoint({
        admin,
        shop,
        name: "Initial Store Setup Baseline",
        description: "Initial baseline snapshot capturing Products, Active Theme, and Collections.",
        options: {
          includeProducts: true,
          includeThemes: true,
          includeCollections: true,
          includePages: true,
          includeMenus: true,
        },
      });
      initialRpCreated = true;
    } catch (rpErr) {
      console.warn("Initial baseline restore point creation warning:", rpErr?.message || rpErr);
    }
  }

  return { success: true, count: totalSaved, initialRpCreated };
};

export default function InitialSnapshot() {
  const { count } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isLoading = fetcher.state !== "idle";

  return (
    <s-page
      heading="Initialize Product Snapshots"
      backAction={{ url: "/app", label: "Dashboard" }}
      inlineSize="large"
    >
      <s-section>
        <s-card>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-text variant="headingMd" fontWeight="bold">Store Baseline Setup</s-text>
              <s-paragraph>
                Before monitoring begins, Revertly takes an initial snapshot of your
                products and store assets. This establishes a baseline to detect unauthorized price drops, mass tag edits, and accidental deletions.
              </s-paragraph>
              
              <s-box padding="tight" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack direction="inline" gap="tight" align-items="center">
                  <s-badge tone={count > 0 ? "success" : "attention"}>
                    {count > 0 ? "Monitoring Active" : "Setup Required"}
                  </s-badge>
                  <s-text>
                    Currently tracking <strong>{result?.count ?? count}</strong> product snapshots in your baseline.
                  </s-text>
                </s-stack>
              </s-box>

              {result?.success && (
                <s-banner tone="success">
                  <s-stack direction="block" gap="tight">
                    <s-text fontWeight="bold">🎉 Snapshot Baseline Complete!</s-text>
                    <s-paragraph>
                      {result.count} products are now actively monitored
                      {result.initialRpCreated
                        ? ", and your first Full Store Baseline (Theme, Collections & Products) has been secured in Restore Points!"
                        : "."}
                    </s-paragraph>
                    <s-stack direction="inline" gap="tight">
                      <s-button url="/app" variant="primary">
                        Go to Dashboard →
                      </s-button>
                      <s-button url="/app/rules" variant="secondary">
                        Configure Detection Rules
                      </s-button>
                      <s-button url="/app/restore-points" variant="secondary">
                        View Restore Points
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-banner>
              )}

              <fetcher.Form method="POST">
                <s-button
                  submit
                  variant={result?.success ? "secondary" : "primary"}
                  {...(isLoading ? { loading: true } : {})}
                >
                  {count > 0 ? "Refresh Product Snapshots" : "Initialize Monitoring"}
                </s-button>
              </fetcher.Form>
            </s-stack>
          </s-box>
        </s-card>
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
