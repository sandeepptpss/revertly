import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createMultiResourceRestorePoint } from "../backup.server.js";

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

    const includeProducts = formData.get("includeProducts") !== "0";
    const includeThemes = formData.get("includeThemes") !== "0";
    const includeCollections = formData.get("includeCollections") !== "0";
    const includePages = formData.get("includePages") !== "0";

    const result = await createMultiResourceRestorePoint({
      admin,
      shop,
      name,
      description,
      options: {
        includeProducts,
        includeThemes,
        includeCollections,
        includePages,
        includeMenus: includePages,
      },
    });

    if (!result.success) {
      return { success: false, message: result.message || "Failed to create restore point." };
    }

    const s = result.summary;
    const parts = [];
    if (s.products > 0) parts.push(`${s.products} products`);
    if (s.themes > 0) parts.push(`1 theme`);
    if (s.collections > 0) parts.push(`${s.collections} collections`);
    if (s.pages > 0) parts.push(`${s.pages} pages & menus`);

    return {
      success: true,
      message: `Restore point "${name}" successfully created (${parts.join(", ") || "Full Store"}).`,
    };
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
    <s-page heading="Restore Points" inlineSize="large">
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
          A restore point captures the current state of your store — including <strong>Products, Active Theme (files &amp; settings), Collections (smart rules), and Pages</strong>. You can restore any component at any time.
        </s-paragraph>
        <fetcher.Form method="POST">
          <input type="hidden" name="intent" value="create" />
          <s-form-layout>
            <s-text-field
              name="name"
              label="Name"
              placeholder="e.g. Before Major Redesign &amp; Summer Sale"
              required
            />
            <s-text-field
              name="description"
              label="Description (optional)"
              multiline
              placeholder="Notes about changes, apps installed, or campaign details..."
            />
            <s-button
              submit
              variant="primary"
              {...(isCreating ? { loading: true } : {})}
            >
              Create Full Store Restore Point
            </s-button>
          </s-form-layout>
        </fetcher.Form>
      </s-section>

      {/* Restore Points List */}
      <s-section heading={`${restorePoints.length} restore points`}>
        {restorePoints.length === 0 ? (
          <s-empty-state heading="No restore points">
            <s-paragraph>
              Create restore points before major price changes, theme edits, or app installs so you
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
                      <s-stack direction="inline" gap="tight" align="center">
                        <s-text fontWeight="bold">{rp.name}</s-text>
                        <s-badge
                          tone={
                            rp.status === "READY"
                              ? "success"
                              : rp.status === "CREATING"
                                ? "attention"
                                : "critical"
                          }
                        >
                          {rp.status}
                        </s-badge>
                      </s-stack>
                      {rp.description && (
                        <s-text tone="subdued">{rp.description}</s-text>
                      )}
                      <s-stack direction="inline" gap="tight" align="center">
                        <s-text tone="subdued">{formatTime(rp.createdAt)}</s-text>
                        <s-badge tone="info">{rp.productCount} products</s-badge>
                        {rp.themeCount > 0 && <s-badge tone="success">1 Theme</s-badge>}
                        {rp.collectionCount > 0 && <s-badge tone="info">{rp.collectionCount} Collections</s-badge>}
                        {rp.pageCount > 0 && <s-badge tone="subdued">{rp.pageCount} Pages</s-badge>}
                      </s-stack>
                    </s-stack>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <s-button url={`/app/restore-points/${rp.id}`} variant="primary">
                      Restore / View Details
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
