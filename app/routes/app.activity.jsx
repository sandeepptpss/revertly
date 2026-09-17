import { useLoaderData, useFetcher, useRouteError, Link, useNavigate } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { restoreDeletedProduct } from "../monitor.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ClockIcon,
  Trash2Icon,
  RefreshCwIcon,
  SearchIcon,
  BoxIcon,
  FilterIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { HubNav } from "../components/HubNav.jsx";
import { Pagination } from "../components/Pagination.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const field = (url.searchParams.get("field") || "").trim();
  const product = (url.searchParams.get("product") || "").trim();
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

  return { changes, total, page, perPage, field, product, deletedProducts, shop };
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "restoreDeleted") {
      const perm = await checkPermission(shop, session, PERMISSIONS.RESTORE);
      if (!perm.allowed) return { success: false, message: perm.message };

      const productId = formData.get("productId");
      const res = await restoreDeletedProduct(admin, shop, productId);
      if (res.success) {
        await logAudit(shop, session, "PRODUCT_RESTORE", {
          productId,
          title: res.title,
        });
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
  } catch (error) {
    console.error("Activity action error:", error);
    return {
      success: false,
      message: error?.message || "An unexpected error occurred while restoring product.",
    };
  }
};

function formatTime(date) {
  return new Date(date).toLocaleString();
}

function fieldLabel(fieldName) {
  if (!fieldName) return "Field";
  const clean = fieldName.startsWith("variant.")
    ? fieldName.replace("variant.", "")
    : fieldName.startsWith("metafield.")
    ? fieldName.replace("metafield.", "Metafield: ")
    : fieldName;
  if (clean === "bodyHtml") return "Description";
  if (clean === "compareAtPrice") return "Compare-at Price";
  if (clean === "inventoryQuantity") return "Inventory";
  const formatted = clean
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
  return fieldName.startsWith("variant.") ? `Variant ${formatted}` : formatted;
}

export default function Activity() {
  const { changes, total, page, perPage, field, product, deletedProducts, shop } = useLoaderData();
  const navigate = useNavigate();
  const cleanShop = (shop || "").replace(".myshopify.com", "");
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isRestoring = fetcher.state !== "idle";

  return (
    <s-page heading="Activity Log" inlineSize="large">
      <HubNav hub="protection" activeTab="activity" />
      
      {/* ── Action Feedback Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Recovery Complete" : "Recovery Error"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Deleted Products Watchdog (Recycle Bin) ── */}
      {deletedProducts && deletedProducts.length > 0 && (
        <div className="rv-card" style={{ borderLeft: "4px solid var(--rv-warning)", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-warning-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "var(--rv-warning-text)" }}>
              <Trash2Icon size={18} />
              <span>Deleted Products Watchdog ({deletedProducts.length} Recoverable)</span>
            </h3>
            <span className="rv-badge rv-badge-warning rv-badge-sm">Vault Preserved</span>
          </div>
          <div className="rv-card-body" style={{ padding: 0 }}>
            <p style={{ margin: "16px 22px 14px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
              These products were deleted from your Shopify store. Revertly has preserved their complete snapshots in memory. Click <strong>1-Click Restore</strong> to recreate them in your catalog as Drafts.
            </p>
            <div className="rv-table-container" style={{ border: "none", borderRadius: 0 }}>
              <table className="rv-table">
                <thead>
                  <tr>
                    <th>Product Title</th>
                    <th>Status</th>
                    <th>Deleted At</th>
                    <th style={{ textAlign: "right" }}>Recovery Action</th>
                  </tr>
                </thead>
                <tbody>
                  {deletedProducts.map((p) => (
                    <tr key={p.productId}>
                      <td style={{ fontWeight: 600 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <BoxIcon size={16} style={{ color: "var(--rv-text-subdued)" }} />
                          <span>{p.title || `Product #${p.productId}`}</span>
                        </div>
                      </td>
                      <td>
                        <span className="rv-badge rv-badge-critical rv-badge-sm">DELETED</span>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                        {formatTime(p.deletedAt || p.updatedAt)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <fetcher.Form method="POST" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="restoreDeleted" />
                          <input type="hidden" name="productId" value={p.productId} />
                          {(() => {
                            const isThisRestoring = isRestoring && fetcher.formData?.get("productId") === String(p.productId);
                            return (
                              <button
                                type="submit"
                                disabled={isRestoring}
                                className="rv-btn rv-btn-primary rv-btn-sm"
                              >
                                <RefreshCwIcon size={13} className={isThisRestoring ? "rv-spin" : ""} />
                                <span>{isThisRestoring ? "Restoring..." : "1-Click Restore to Shopify"}</span>
                              </button>
                            );
                          })()}
                        </fetcher.Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Search & Filter Toolbar ── */}
      <div className="rv-filter-bar">
        <form method="get" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", width: "100%" }}>
          <div className="rv-search-wrapper" style={{ flexGrow: 1, maxWidth: "300px", minWidth: "180px" }}>
            <span className="rv-search-icon">
              <SearchIcon size={15} />
            </span>
            <input
              type="text"
              name="product"
              placeholder="Search product title..."
              defaultValue={product}
              className="rv-input rv-input-with-icon"
              style={{ width: "100%" }}
            />
          </div>

          <select
            name="field"
            defaultValue={field}
            className="rv-select"
            style={{ width: "auto", minWidth: "170px", maxWidth: "230px" }}
          >
            <option value="">All Field Types</option>
            <option value="price">Price Changes</option>
            <option value="compareAtPrice">Compare At Price</option>
            <option value="inventory">Inventory Changes</option>
            <option value="title">Product Title</option>
            <option value="bodyHtml">Product Description</option>
            <option value="status">Status Changes</option>
            <option value="vendor">Vendor</option>
            <option value="tags">Tags</option>
            <option value="sku">SKU Changes</option>
            <option value="metafield">Metafields</option>
          </select>

          <button type="submit" className="rv-btn rv-btn-secondary rv-btn-sm">
            <FilterIcon size={13} />
            <span>Apply Filters</span>
          </button>

          {(field || product) && (
            <Link to="/app/activity" className="rv-btn rv-btn-subtle rv-btn-sm">
              Clear Filters
            </Link>
          )}

          <div style={{ marginLeft: "auto", fontSize: "13px", color: "var(--rv-text-subdued)", fontWeight: 500 }}>
            {total.toLocaleString()} change event{total !== 1 ? "s" : ""}
          </div>
        </form>
      </div>

      {/* ── Activity Table / Empty State ── */}
      {changes.length === 0 ? (
        <EmptyState
          icon={<ClockIcon size={28} style={{ color: "var(--rv-info)" }} />}
          title={field || product ? "No matching activity records" : "No Activity Logged Yet"}
          description={
            field || product
              ? "Try adjusting your search query or field filter to find historical change records."
              : "Revertly monitors your catalog in real-time. Edits to product prices, inventory, titles, and tags will stream here automatically."
          }
          action={
            (field || product) && (
              <Link to="/app/activity" className="rv-btn rv-btn-secondary">
                Reset Filter
              </Link>
            )
          }
        />
      ) : (
        <div className="rv-table-container">
          <table className="rv-table">
            <thead>
              <tr>
                <th>Product Title</th>
                <th style={{ width: "180px" }}>Field Changed</th>
                <th>Previous Value</th>
                <th style={{ width: "24px" }}></th>
                <th>New Value</th>
                <th style={{ width: "180px" }}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => {
                const productAdminUrl = cleanShop && c.productId ? `https://admin.shopify.com/store/${cleanShop}/products/${c.productId}` : null;
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <BoxIcon size={15} style={{ color: "var(--rv-text-subdued)", flexShrink: 0 }} />
                        {productAdminUrl ? (
                          <a
                            href={productAdminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: "var(--rv-text)",
                              textDecoration: "none",
                              maxWidth: "260px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              display: "inline-block",
                            }}
                            title={`Open ${c.productTitle} in Shopify Admin`}
                          >
                            {c.productTitle}
                          </a>
                        ) : (
                          <span style={{ maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {c.productTitle}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="rv-badge rv-badge-neutral rv-badge-sm">
                        {fieldLabel(c.fieldName)}
                      </span>
                    </td>
                    <td>
                      <span className="rv-diff-old" title={c.oldValue || "—"}>{c.oldValue || "—"}</span>
                    </td>
                    <td style={{ color: "var(--rv-text-subdued)", textAlign: "center" }}>→</td>
                    <td>
                      <span className="rv-diff-new" title={c.newValue || "—"}>{c.newValue || "—"}</span>
                    </td>
                    <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px", whiteSpace: "nowrap" }}>
                      {formatTime(c.changedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination Controls ── */}
      <Pagination
        currentPage={page}
        totalItems={total}
        pageSize={perPage}
        onPageChange={(newPage) => {
          navigate(
            `/app/activity?page=${newPage}${field ? `&field=${encodeURIComponent(field)}` : ""}${product ? `&product=${encodeURIComponent(product)}` : ""}`
          );
        }}
        itemLabel="records"
      />

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
