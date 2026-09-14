import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
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
    const includeArticles = formData.get("includeArticles") !== "0";

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
        includeArticles,
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
    if (s.articles > 0) parts.push(`${s.articles} blog articles`);

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
  const [showCreateForm, setShowCreateForm] = useState(false);

  return (
    <s-page heading="Restore Points" inlineSize="large">

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

      {/* ── Header Summary Bar ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
              Full Store Snapshots &amp; Time Machine
            </strong>
            <span className="rv-badge rv-badge-info">
              {restorePoints.length} Saved Snapshot{restorePoints.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Capture a complete freeze of your Products, Liquid Theme code, Collections, Pages, and Blog Articles. Restore individual components or entire catalogs whenever needed.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="rv-btn rv-btn-primary"
        >
          {showCreateForm ? "✕ Close Form" : "+ Create Restore Point"}
        </button>
      </div>

      {/* ── Create Restore Point Form Card ── */}
      {showCreateForm && (
        <div className="rv-card" style={{ border: "2px solid #008060", marginBottom: "24px" }}>
          <div className="rv-card-header" style={{ background: "var(--rv-primary-surface)" }}>
            <h3 className="rv-card-title" style={{ color: "var(--rv-primary)" }}>
              <span>💾</span> Take New Store Restore Point
            </h3>
            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
              Snapshots take 2-5 seconds
            </span>
          </div>

          <div className="rv-card-body">
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="create" />

              <div className="rv-form-grid" style={{ marginBottom: "16px" }}>
                <div className="rv-form-field">
                  <label className="rv-form-label">Restore Point Name *</label>
                  <input
                    type="text"
                    name="name"
                    required
                    placeholder="e.g. Before Major Redesign & Summer Sale"
                    className="rv-input"
                  />
                  <span className="rv-form-help">A recognizable label for your team or audits.</span>
                </div>

                <div className="rv-form-field">
                  <label className="rv-form-label">Description / Notes (Optional)</label>
                  <input
                    type="text"
                    name="description"
                    placeholder="e.g. Backed up before installing wholesale bulk price app"
                    className="rv-input"
                  />
                  <span className="rv-form-help">Any context on campaigns, apps, or staff changes.</span>
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label className="rv-form-label" style={{ marginBottom: "8px", display: "block" }}>
                  Components Included in this Snapshot:
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  <label className="rv-toggle-row">
                    <input type="checkbox" name="includeProducts" defaultChecked value="1" />
                    <div>
                      <strong style={{ fontSize: "13px" }}>📦 Products &amp; Prices</strong>
                      <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Variants, Metafields &amp; SKUs</div>
                    </div>
                  </label>

                  <label className="rv-toggle-row">
                    <input type="checkbox" name="includeThemes" defaultChecked value="1" />
                    <div>
                      <strong style={{ fontSize: "13px" }}>🎨 Active Theme</strong>
                      <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Liquid, JSON &amp; Assets</div>
                    </div>
                  </label>

                  <label className="rv-toggle-row">
                    <input type="checkbox" name="includeCollections" defaultChecked value="1" />
                    <div>
                      <strong style={{ fontSize: "13px" }}>🗂️ Collections</strong>
                      <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Manual &amp; Smart Rules</div>
                    </div>
                  </label>

                  <label className="rv-toggle-row">
                    <input type="checkbox" name="includePages" defaultChecked value="1" />
                    <div>
                      <strong style={{ fontSize: "13px" }}>📄 Pages &amp; Menus</strong>
                      <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Store Pages &amp; Navigation</div>
                    </div>
                  </label>

                  <label className="rv-toggle-row">
                    <input type="checkbox" name="includeArticles" defaultChecked value="1" />
                    <div>
                      <strong style={{ fontSize: "13px" }}>📝 Blog Articles</strong>
                      <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>Blog Posts &amp; Content</div>
                    </div>
                  </label>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="rv-btn rv-btn-primary"
                  style={{ padding: "10px 20px", fontWeight: 600 }}
                >
                  {isCreating ? "⏳ Capturing Full Store Snapshot..." : "⚡ Capture Restore Point Now"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="rv-btn rv-btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Restore Points List / Empty State ── */}
      {restorePoints.length === 0 ? (
        <div className="rv-empty-state">
          <div className="rv-empty-icon-circle">💾</div>
          <div className="rv-empty-title">No Restore Points Created Yet</div>
          <div className="rv-empty-desc">
            Create snapshot restore points before running bulk discounts, editing theme code, or running third-party CSV syncs. You can revert your entire store with one click.
          </div>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="rv-btn rv-btn-primary"
          >
            + Create Your First Restore Point
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {restorePoints.map((rp) => (
            <div key={rp.id} className="rv-card" style={{ margin: 0 }}>
              <div
                className="rv-card-body"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "16px",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <Link
                      to={`/app/restore-points/${rp.id}`}
                      style={{ fontSize: "16px", fontWeight: 700, color: "var(--rv-text)", textDecoration: "none" }}
                    >
                      {rp.name}
                    </Link>
                    <span
                      className={`rv-badge ${
                        rp.status === "READY"
                          ? "rv-badge-success"
                          : rp.status === "CREATING"
                          ? "rv-badge-warning"
                          : "rv-badge-critical"
                      }`}
                    >
                      {rp.status}
                    </span>
                  </div>

                  {rp.description && (
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                      {rp.description}
                    </p>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                    <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                      🕒 {formatTime(rp.createdAt)}
                    </span>
                    <span style={{ color: "var(--rv-text-subdued)" }}>·</span>
                    <span className="rv-badge rv-badge-info">{rp.productCount} Products</span>
                    {rp.themeCount > 0 && <span className="rv-badge rv-badge-success">1 Theme</span>}
                    {rp.collectionCount > 0 && (
                      <span className="rv-badge rv-badge-info">{rp.collectionCount} Collections</span>
                    )}
                    {rp.pageCount > 0 && (
                      <span className="rv-badge rv-badge-neutral">{rp.pageCount} Pages</span>
                    )}
                    {rp.articleCount > 0 && (
                      <span className="rv-badge rv-badge-success">{rp.articleCount} Articles</span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <Link
                    to={`/app/restore-points/${rp.id}`}
                    className="rv-btn rv-btn-primary"
                    style={{ fontSize: "13px" }}
                  >
                    ⚡ Inspect / Restore
                  </Link>

                  <a
                    href={`/app/restore-points/${rp.id}/export`}
                    className="rv-btn rv-btn-secondary"
                    style={{ fontSize: "13px" }}
                  >
                    ⬇️ JSON
                  </a>

                  <fetcher.Form method="POST" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="rpId" value={rp.id} />
                    <button
                      type="submit"
                      onClick={(e) => {
                        if (!confirm(`Delete restore point "${rp.name}"? This cannot be undone.`)) {
                          e.preventDefault();
                        }
                      }}
                      className="rv-btn rv-btn-subtle"
                      style={{ fontSize: "13px", color: "var(--rv-critical)" }}
                    >
                      Delete
                    </button>
                  </fetcher.Form>
                </div>
              </div>
            </div>
          ))}
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
