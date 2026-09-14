import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { restoreDeletedProduct } from "../monitor.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const field = url.searchParams.get("field") || "";
  const product = url.searchParams.get("product") || "";
  const perPage = 50;

  const where = {
    shop,
    ...(field ? { fieldName: { contains: field } } : {}),
    ...(product ? { productTitle: { contains: product } } : {}),
  };

  const [changes, total, deletedProducts] = await Promise.all([
    prisma.changeEvent.findMany({
      where,
      orderBy: { changedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.changeEvent.count({ where }),
    prisma.productSnapshot.findMany({
      where: { shop, isDeleted: true },
      orderBy: { deletedAt: "desc" },
      take: 20,
    }),
  ]);

  return { changes, total, page, perPage, field, product, deletedProducts };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "restoreDeleted") {
    const productId = formData.get("productId");
    const res = await restoreDeletedProduct(admin, shop, productId);
    if (res.success) {
      return {
        success: true,
        message: `Successfully recreated "${res.title}" as Draft in Shopify!`,
      };
    } else {
      return {
        success: false,
        message: `Restore failed: ${res.error}`,
      };
    }
  }

  return { success: false, message: "Unknown action" };
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function fieldLabel(fieldName) {
  return fieldName
    .replace("variant.", "Variant ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase());
}

export default function Activity() {
  const { changes, total, page, perPage, field, product, deletedProducts } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const totalPages = Math.ceil(total / perPage);

  return (
    <s-page heading="Activity Log" inlineSize="large">
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* ── Deleted Products Watchdog ── */}
      {deletedProducts && deletedProducts.length > 0 && (
        <s-section>
          <s-banner tone="warning" title={`Deleted Products Watchdog (${deletedProducts.length})`}>
            <s-paragraph>
              These products were deleted from your Shopify store. Revertly has preserved their complete snapshots. Click <strong>1-Click Restore</strong> to recreate them in your catalog.
            </s-paragraph>
          </s-banner>
          <s-box paddingBlockStart="300">
            <s-data-table
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Product Title", "Status", "Deleted At", "Recovery Action"]}
              rows={deletedProducts.map((p) => [
                p.title || `Product #${p.productId}`,
                <s-badge key="status" tone="critical">DELETED</s-badge>,
                formatTime(p.deletedAt || p.updatedAt),
                <fetcher.Form method="POST" key={p.productId}>
                  <input type="hidden" name="intent" value="restoreDeleted" />
                  <input type="hidden" name="productId" value={p.productId} />
                  <s-button submit variant="primary">
                    1-Click Restore
                  </s-button>
                </fetcher.Form>,
              ])}
            />
          </s-box>
        </s-section>
      )}

      <s-section heading={`${total} total changes`}>
        {/* Filters */}
        <s-stack direction="inline" align="space-between" blockAlign="center">
          <form method="get">
            <input type="hidden" name="page" value="1" />
            <s-stack direction="inline" gap="base" blockAlign="end">
              <s-text-field
                name="product"
                label="Filter by product"
                value={product}
                placeholder="Product name..."
              />
              <s-text-field
                name="field"
                label="Filter by field"
                value={field}
                placeholder="e.g. price, title..."
              />
              <s-button submit>Filter</s-button>
              {(product || field) && (
                <s-link href="/app/activity">Clear filters</s-link>
              )}
            </s-stack>
          </form>
          <s-link href="/app/rollback-history">View Rollback History →</s-link>
        </s-stack>

        {changes.length === 0 ? (
          <s-box padding="base">
            <s-empty-state heading="No activity yet">
              <s-paragraph>
                Product changes will appear here automatically when they occur.
              </s-paragraph>
            </s-empty-state>
          </s-box>
        ) : (
          <s-data-table
            columnContentTypes={["text", "text", "text", "text", "text"]}
            headings={["Time", "Product", "Field", "Previous Value", "New Value"]}
            rows={changes.map((c) => [
              formatTime(c.changedAt),
              c.productTitle,
              fieldLabel(c.fieldName),
              <span key="old" style={{ color: "#bf0711", textDecoration: "line-through" }}>
                {c.oldValue || "—"}
              </span>,
              <span key="new" style={{ color: "#008060", fontWeight: "600" }}>
                {c.newValue || "—"}
              </span>,
            ])}
          />
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <s-stack direction="inline" gap="base">
            {page > 1 && (
              <s-link url={`/app/activity?page=${page - 1}&field=${field}&product=${product}`}>
                ← Previous
              </s-link>
            )}
            <s-text>
              Page {page} of {totalPages}
            </s-text>
            {page < totalPages && (
              <s-link url={`/app/activity?page=${page + 1}&field=${field}&product=${product}`}>
                Next →
              </s-link>
            )}
          </s-stack>
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
