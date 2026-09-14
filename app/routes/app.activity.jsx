import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
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
  const isRestoring = fetcher.state !== "idle";
  const totalPages = Math.ceil(total / perPage);

  return (
    <s-page heading="Activity Log" inlineSize="large">
      
      {/* ── Action Feedback Toast / Banner ── */}
      {result?.message && (
        <div
          style={{
            background: result.success ? "var(--rv-primary-surface)" : "var(--rv-critical-surface)",
            border: `1px solid ${result.success ? "var(--rv-primary-border)" : "var(--rv-critical-border)"}`,
            color: result.success ? "var(--rv-primary)" : "var(--rv-critical)",
            padding: "14px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>{result.success ? "✅" : "⚠️"}</span>
          <span>{result.message}</span>
        </div>
      )}

      {/* ── Deleted Products Watchdog ── */}
      {deletedProducts && deletedProducts.length > 0 && (
        <div className="rv-card" style={{ borderLeft: "4px solid #d97706", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "#fffbeb" }}>
            <h3 className="rv-card-title" style={{ color: "#92400e" }}>
              <span>🗑️</span> Deleted Products Watchdog ({deletedProducts.length} Recoverable)
            </h3>
            <span className="rv-badge rv-badge-warning">Vault Preserved</span>
          </div>
          <div className="rv-card-body" style={{ padding: 0 }}>
            <p style={{ margin: "16px 20px 12px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
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
                      <td style={{ fontWeight: 600 }}>{p.title || `Product #${p.productId}`}</td>
                      <td>
                        <span className="rv-badge rv-badge-critical">DELETED</span>
                      </td>
                      <td style={{ color: "var(--rv-text-subdued)" }}>
                        {formatTime(p.deletedAt || p.updatedAt)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <fetcher.Form method="POST" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="restoreDeleted" />
                          <input type="hidden" name="productId" value={p.productId} />
                          <button
                            type="submit"
                            className="rv-btn rv-btn-primary"
                            disabled={isRestoring}
                            style={{ fontSize: "12px", padding: "6px 12px" }}
                          >
                            {isRestoring ? "Restoring..." : "⚡ 1-Click Restore"}
                          </button>
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
        <form method="get" style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <input type="hidden" name="page" value="1" />
          <div className="rv-input-group">
            <input
              type="text"
              name="product"
              defaultValue={product}
              placeholder="🔍 Search product title..."
              className="rv-input"
            />
            <input
              type="text"
              name="field"
              defaultValue={field}
              placeholder="Filter by field (e.g. price)..."
              className="rv-input"
            />
            <button type="submit" className="rv-btn rv-btn-primary">
              Filter Changes
            </button>
            {(product || field) && (
              <Link to="/app/activity" className="rv-btn rv-btn-subtle">
                ✕ Clear Filters
              </Link>
            )}
          </div>
        </form>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", fontWeight: 500 }}>
            {total.toLocaleString()} total changes
          </span>
          <Link to="/app/rollback-history" className="rv-btn rv-btn-secondary" style={{ fontSize: "12px" }}>
            ⏪ View Rollback History →
          </Link>
        </div>
      </div>

      {/* ── Activity Table / Empty State ── */}
      {changes.length === 0 ? (
        <div className="rv-empty-state">
          <div className="rv-empty-icon-circle">📋</div>
          <div className="rv-empty-title">
            {product || field ? "No matching changes found" : "No catalog activity logged yet"}
          </div>
          <div className="rv-empty-desc">
            {product || field
              ? "Try adjusting or clearing your search filters to view recorded product changes."
              : "As products, prices, variants, and tags are updated in your Shopify admin or via bulk apps, audit records will appear here in real time."}
          </div>
          {product || field ? (
            <Link to="/app/activity" className="rv-btn rv-btn-secondary">
              Clear All Filters
            </Link>
          ) : (
            <Link to="/app/initialize" className="rv-btn rv-btn-primary">
              Verify Monitoring Baseline
            </Link>
          )}
        </div>
      ) : (
        <div className="rv-table-container">
          <table className="rv-table">
            <thead>
              <tr>
                <th style={{ width: "180px" }}>Timestamp</th>
                <th>Product</th>
                <th style={{ width: "140px" }}>Field</th>
                <th>Previous Value</th>
                <th style={{ width: "20px" }}></th>
                <th>New Value</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id}>
                  <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                    {formatTime(c.changedAt)}
                  </td>
                  <td style={{ fontWeight: 600, color: "var(--rv-text)" }}>
                    {c.productTitle}
                  </td>
                  <td>
                    <span className="rv-badge rv-badge-neutral">
                      {fieldLabel(c.fieldName)}
                    </span>
                  </td>
                  <td>
                    <span className="rv-diff-old">{c.oldValue || "—"}</span>
                  </td>
                  <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px", textAlign: "center" }}>
                    →
                  </td>
                  <td>
                    <span className="rv-diff-new">{c.newValue || "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination Bar ── */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "20px",
            padding: "12px 16px",
            background: "var(--rv-surface)",
            border: "1px solid var(--rv-border)",
            borderRadius: "var(--rv-radius-md)",
          }}
        >
          <div style={{ fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> ({total} total records)
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {page > 1 && (
              <Link
                to={`/app/activity?page=${page - 1}&field=${field}&product=${product}`}
                className="rv-btn rv-btn-secondary"
                style={{ fontSize: "12px", padding: "6px 12px" }}
              >
                ← Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                to={`/app/activity?page=${page + 1}&field=${field}&product=${product}`}
                className="rv-btn rv-btn-secondary"
                style={{ fontSize: "12px", padding: "6px 12px" }}
              >
                Next →
              </Link>
            )}
          </div>
        </div>
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
