import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { buildSnapshot } from "../monitor.server.js";
import { createMultiResourceRestorePoint } from "../backup.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useFetcher, useLoaderData, useRouteError, Link } from "react-router";
import { getEffectiveLimits } from "../billing.server.js";
import {
  ShieldCheckIcon,
  RefreshCwIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  SparklesIcon,
  CheckCircleIcon,
  ClockIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const count = await prisma.productSnapshot.count({ where: { shop } });
  return { shop, count };
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;

    const settings = await prisma.appSettings.findUnique({ where: { shop } });
    const limits = await getEffectiveLimits(shop, settings);

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
                      inventoryQuantity barcode
                      inventoryItem {
                        measurement {
                          weight {
                            value
                            unit
                          }
                        }
                      }
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
        if (limits.products !== Infinity && totalSaved >= limits.products) {
          hasNextPage = false;
          break;
        }

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
  } catch (error) {
    console.error("Initialize action error:", error);
    return {
      success: false,
      error: error?.message || "An unexpected error occurred while scanning catalog.",
    };
  }
};

export default function InitialSnapshot() {
  const { count } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isLoading = fetcher.state !== "idle";

  const totalMonitored = result?.count ?? count;
  const isProtected = totalMonitored > 0;

  return (
    <s-page
      heading="Initialize Product Snapshots"
      backAction={{ url: "/app", label: "Dashboard" }}
      inlineSize="large"
    >
      {/* ── Hero Status ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Store Catalog Baseline Snapshot
            </strong>
            <span className={`rv-badge ${isProtected ? "rv-badge-success" : "rv-badge-warning"}`}>
              {isProtected ? "Monitoring Active" : "Setup Required"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Before Revertly can detect price crashes, CSV bulk errors, or mass tag changes, an initial catalog baseline is required.
          </p>
        </div>

        <Link to="/app" className="rv-btn rv-btn-secondary rv-btn-sm">
          <ArrowLeftIcon size={14} />
          <span>Back to Dashboard</span>
        </Link>
      </div>

      {/* ── Baseline Setup Wizard Card ── */}
      <div className="rv-card" style={{ marginBottom: "24px" }}>
        <div className="rv-card-header">
          <h3 className="rv-card-title">
            <ShieldCheckIcon size={18} style={{ color: "var(--rv-primary)" }} />
            <span>Catalog Protection Wizard</span>
          </h3>
          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            High-speed GraphQL batching
          </span>
        </div>

        <div className="rv-card-body">
          {/* Status highlight callout */}
          <div
            style={{
              padding: "16px 20px",
              borderRadius: "var(--rv-radius-md)",
              background: isProtected ? "var(--rv-primary-surface)" : "var(--rv-warning-surface)",
              border: `1px solid ${isProtected ? "var(--rv-primary-border)" : "var(--rv-warning-border)"}`,
              marginBottom: "20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                className="rv-stat-icon-wrapper"
                style={{
                  background: isProtected ? "#dcfce7" : "#fef3c7",
                  color: isProtected ? "#166534" : "#b45309",
                }}
              >
                {isProtected ? <CheckCircleIcon size={20} /> : <ClockIcon size={20} />}
              </div>
              <div>
                <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
                  {isProtected
                    ? `${totalMonitored.toLocaleString()} Products Guarded in Catalog Baseline`
                    : "No baseline snapshots captured yet"}
                </strong>
                <p style={{ margin: "3px 0 0", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
                  {isProtected
                    ? "Real-time webhooks compare future updates against these frozen records."
                    : "Click below to scan your Shopify catalog and secure your initial snapshot."}
                </p>
              </div>
            </div>
          </div>

          {/* Error Banner */}
          {result && !result.success && (
            <Banner
              tone="critical"
              title="Baseline Initialization Failed"
            >
              {result.error || result.message || "Failed to initialize catalog snapshots."}
            </Banner>
          )}

          {/* Success Banner */}
          {result?.success && (
            <div
              style={{
                background: "var(--rv-primary-surface)",
                border: "1px solid var(--rv-primary-border)",
                borderRadius: "var(--rv-radius-md)",
                padding: "18px 20px",
                marginBottom: "24px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                <SparklesIcon size={18} style={{ color: "var(--rv-primary)" }} />
                <strong style={{ color: "var(--rv-primary-text)", fontSize: "15px" }}>
                  Snapshot Baseline Complete!
                </strong>
              </div>
              <p style={{ margin: "0 0 14px", fontSize: "13px", color: "var(--rv-primary-text)", lineHeight: 1.5 }}>
                {result.count} products are now actively protected against accidental price crashes
                {result.initialRpCreated
                  ? ", and your first Full Store Baseline (Theme, Collections & Products) has been created in Restore Points!"
                  : "."}
              </p>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <Link to="/app" className="rv-btn rv-btn-primary rv-btn-sm">
                  <span>Go to Dashboard</span>
                  <ArrowRightIcon size={13} />
                </Link>
                <Link to="/app/rules" className="rv-btn rv-btn-secondary rv-btn-sm">
                  Configure Detection Rules
                </Link>
                <Link to="/app/restore-points" className="rv-btn rv-btn-secondary rv-btn-sm">
                  View Restore Points
                </Link>
              </div>
            </div>
          )}

          {/* 3 Step Timeline */}
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "24px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--rv-info-surface)", color: "var(--rv-info)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px", flexShrink: 0 }}>
                1
              </div>
              <div>
                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>Scan Catalog Details:</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Reads all product variants, prices, inventory quantities, SKUs, and custom metafields via Shopify Admin GraphQL.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--rv-info-surface)", color: "var(--rv-info)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px", flexShrink: 0 }}>
                2
              </div>
              <div>
                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>Freeze Pre-Incident Baseline:</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  Saves snapshot data to your store&apos;s encrypted database so you have a guaranteed reference point for 1-click rollbacks.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--rv-info-surface)", color: "var(--rv-info)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px", flexShrink: 0 }}>
                3
              </div>
              <div>
                <strong style={{ fontSize: "13px", color: "var(--rv-text)" }}>Real-Time Webhook Guard:</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                  As apps or bulk tools make modifications, Revertly calculates instant diffs to flag suspicious drops and create recoverable incidents.
                </p>
              </div>
            </div>
          </div>

          {/* Trigger Button */}
          <fetcher.Form method="POST">
            <button
              type="submit"
              disabled={isLoading}
              className="rv-btn rv-btn-primary rv-btn-lg"
              style={{ width: "100%" }}
            >
              <RefreshCwIcon size={16} />
              <span>
                {isLoading
                  ? "Scanning Store & Building Snapshot..."
                  : isProtected
                  ? "Refresh Store Baseline Snapshots"
                  : "Initialize Catalog Monitoring Now"}
              </span>
            </button>
          </fetcher.Form>
        </div>
      </div>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
