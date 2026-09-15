import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { syncOrdersVault, syncCustomersVault } from "../backup.server.js";
import { checkVaultAccess } from "../billing.server.js";
import {
  DatabaseIcon,
  SearchIcon,
  RefreshCwIcon,
  DownloadIcon,
  ShieldCheckIcon,
  ClockIcon,
  BoxIcon,
  CheckCircleIcon,
} from "../components/Icons.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { PillNav } from "../components/PillNav.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const vaultAccess = await checkVaultAccess(shop);
  if (!vaultAccess.allowed) {
    return {
      isLocked: true,
      plan: vaultAccess.plan,
      stats: { totalOrders: 0, totalCustomers: 0, lastSync: null },
      orders: [],
      customers: [],
      searchOrder: "",
      searchCustomer: "",
      shop,
    };
  }

  const url = new URL(request.url);
  const searchOrder = url.searchParams.get("searchOrder") || "";
  const searchCustomer = url.searchParams.get("searchCustomer") || "";

  const [totalOrders, totalCustomers, latestOrder, orders, customers] = await Promise.all([
    prisma.orderArchive.count({ where: { shop } }),
    prisma.customerArchive.count({ where: { shop } }),
    prisma.orderArchive.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.orderArchive.findMany({
      where: {
        shop,
        ...(searchOrder
          ? {
            OR: [
              { orderNumber: { contains: searchOrder } },
              { customerEmail: { contains: searchOrder } },
              { customerName: { contains: searchOrder } },
            ],
          }
          : {}),
      },
      orderBy: { processedAt: "desc" },
      take: 50,
    }),
    prisma.customerArchive.findMany({
      where: {
        shop,
        ...(searchCustomer
          ? {
            OR: [
              { email: { contains: searchCustomer } },
              { firstName: { contains: searchCustomer } },
              { lastName: { contains: searchCustomer } },
              { phone: { contains: searchCustomer } },
            ],
          }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return {
    isLocked: false,
    plan: vaultAccess.plan,
    maxOrders: vaultAccess.maxOrders,
    shop,
    stats: {
      totalOrders,
      totalCustomers,
      lastSync: latestOrder?.createdAt || null,
    },
    orders,
    customers,
    searchOrder,
    searchCustomer,
  };
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;

    const vaultAccess = await checkVaultAccess(shop);
    if (!vaultAccess.allowed) {
      return {
        success: false,
        message: `Orders & Customers Vault is not included in the ${vaultAccess.plan.toUpperCase()} plan. Please upgrade to Growth ($24), Business ($49), or Enterprise ($79) to use Data Vault.`,
      };
    }

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "sync_all" || intent === "sync_orders") {
      const targetMax = vaultAccess.maxOrders === Infinity ? 50000 : vaultAccess.maxOrders;

      const [ordRes, custRes] = await Promise.allSettled([
        syncOrdersVault(admin, shop, { maxOrders: targetMax }),
        syncCustomersVault(admin, shop, { maxCustomers: targetMax }),
      ]);

      const orderCount = ordRes.status === "fulfilled" && ordRes.value?.success ? ordRes.value.count : 0;
      const custCount = custRes.status === "fulfilled" && custRes.value?.success ? custRes.value.count : 0;

      return {
        success: true,
        message: `Vault successfully synchronized! Archived ${orderCount} orders and ${custCount} customer profiles. (Plan allowance: ${vaultAccess.maxOrders === Infinity ? "Unlimited" : vaultAccess.maxOrders.toLocaleString()} orders)`,
      };
    }

    return { success: false, message: "Unknown action." };
  } catch (error) {
    console.error("Vault action error:", error);
    return {
      success: false,
      message: error?.message || "An unexpected error occurred during vault synchronization.",
    };
  }
};

function formatTime(date) {
  if (!date) return "Never";
  return new Date(date).toLocaleString();
}

function statusBadge(status) {
  const s = String(status || "").toUpperCase();
  if (s === "PAID" || s === "FULFILLED") return <span className="rv-badge rv-badge-success rv-badge-sm">{s}</span>;
  if (s === "PENDING" || s === "PARTIALLY_PAID") return <span className="rv-badge rv-badge-warning rv-badge-sm">{s}</span>;
  if (s === "REFUNDED" || s === "VOIDED") return <span className="rv-badge rv-badge-critical rv-badge-sm">{s}</span>;
  return <span className="rv-badge rv-badge-neutral rv-badge-sm">{s || "N/A"}</span>;
}

export default function DataVault() {
  const { isLocked, stats, orders, customers, searchOrder, searchCustomer } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSyncing = fetcher.state !== "idle";

  const [activeTab, setActiveTab] = useState("orders");
  const [inspectedOrder, setInspectedOrder] = useState(null);

  if (isLocked) {
    return (
      <s-page heading="Orders & Customers Vault" inlineSize="large">
        <div
          className="rv-card"
          style={{
            textAlign: "center",
            padding: "54px 28px",
            border: "2px solid var(--rv-info)",
            maxWidth: "680px",
            margin: "40px auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "18px" }}>
            <div className="rv-empty-icon-circle" style={{ width: "64px", height: "64px", background: "var(--rv-info-surface)", color: "var(--rv-info)" }}>
              <DatabaseIcon size={32} />
            </div>
          </div>
          <h2 style={{ fontSize: "22px", fontWeight: 800, margin: "0 0 10px", color: "var(--rv-text)" }}>
            Orders &amp; Customers Vault is Locked
          </h2>
          <p style={{ fontSize: "14px", color: "var(--rv-text-subdued)", lineHeight: 1.6, marginBottom: "26px", maxWidth: "520px", marginInline: "auto" }}>
            Data Vault archives customer purchase histories and receipts to safeguard your store against chargeback disputes, fraudulent refunds, and compliance tax inquiries.
          </p>

          <div style={{ background: "var(--rv-surface-subdued)", borderRadius: "var(--rv-radius-md)", border: "1px solid var(--rv-border)", padding: "18px 20px", marginBottom: "28px", textAlign: "left", display: "inline-block", width: "100%", maxWidth: "460px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", marginBottom: "10px", letterSpacing: "0.5px" }}>
              Available in Paid Plans:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleIcon size={16} style={{ color: "var(--rv-primary)" }} />
                <span><strong>Growth ($24/mo):</strong> Up to 2,500 orders &amp; tax export</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleIcon size={16} style={{ color: "var(--rv-primary)" }} />
                <span><strong>Business ($49/mo):</strong> Up to 15,000 orders &amp; dispute evidence</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircleIcon size={16} style={{ color: "var(--rv-primary)" }} />
                <span><strong>Enterprise ($79/mo):</strong> Unlimited historical vault</span>
              </div>
            </div>
          </div>

          <div>
            <Link
              to="/app/plan"
              className="rv-btn rv-btn-primary rv-btn-lg"
              style={{ textDecoration: "none" }}
            >
              <span>Upgrade Plan to Unlock Vault</span>
            </Link>
          </div>
        </div>
      </s-page>
    );
  }

  const tabs = [
    { id: "orders", label: "Orders Vault", count: orders.length },
    { id: "customers", label: "Customers Directory", count: customers.length },
    { id: "guide", label: "Tax & Dispute Guide" },
  ];

  return (
    <s-page heading="Orders & Customers Vault" inlineSize="large">

      {/* ── Action Result Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Vault Synchronized" : "Sync Failed"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Hero Vault Status & Quick Export Actions ── */}
      <div className="rv-hero-banner">
        <div style={{ maxWidth: "680px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "17px", color: "var(--rv-text)", fontWeight: 700 }}>
              Store Financial &amp; Dispute Vault
            </strong>
            <span className="rv-badge rv-badge-success">Active &amp; Encrypted</span>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
            Encrypted archive of historical transactions, line item SKUs, and buyer profiles for tax audits and chargeback defense.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            <span className="rv-badge rv-badge-info rv-badge-sm">{stats.totalOrders.toLocaleString()} Orders</span>
            <span className="rv-badge rv-badge-info rv-badge-sm">{stats.totalCustomers.toLocaleString()} Customers</span>
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <ClockIcon size={13} />
              <span>Last Sync: {formatTime(stats.lastSync)}</span>
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <fetcher.Form method="POST">
            <input type="hidden" name="intent" value="sync_all" />
            <button
              type="submit"
              disabled={isSyncing}
              className="rv-btn rv-btn-primary rv-btn-lg"
            >
              <RefreshCwIcon size={15} />
              <span>{isSyncing ? "Syncing..." : "Sync Vault Now"}</span>
            </button>
          </fetcher.Form>

          <a href="/app/vault/export?type=orders_csv" className="rv-btn rv-btn-secondary rv-btn-sm">
            <DownloadIcon size={14} />
            <span>Tax Audit CSV</span>
          </a>
          <a href="/app/vault/export?type=dispute_json" className="rv-btn rv-btn-secondary rv-btn-sm">
            <DownloadIcon size={14} />
            <span>Evidence JSON</span>
          </a>
        </div>
      </div>

      {/* ── Segmented Navigation Tabs ── */}
      <PillNav items={tabs} activeId={activeTab} onChange={setActiveTab} />

      {/* ── TAB 1: Orders Vault ── */}
      {activeTab === "orders" && (
        <div>
          {/* Filter Bar */}
          <div className="rv-filter-bar">
            <form method="get" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", width: "100%" }}>
              <div className="rv-search-wrapper" style={{ flexGrow: 1, minWidth: "260px" }}>
                <span className="rv-search-icon">
                  <SearchIcon size={15} />
                </span>
                <input
                  type="text"
                  name="searchOrder"
                  defaultValue={searchOrder}
                  placeholder="Search by Order # (#1001), Customer Email, or Name..."
                  className="rv-input rv-input-with-icon"
                  style={{ width: "100%" }}
                />
              </div>
              <button type="submit" className="rv-btn rv-btn-secondary rv-btn-sm">
                Search Orders
              </button>
              {searchOrder && (
                <Link to="/app/vault" className="rv-btn rv-btn-subtle rv-btn-sm">
                  Clear Search
                </Link>
              )}
            </form>
          </div>

          {/* Inspected Order Snapshot Drawer */}
          {inspectedOrder && (
            <div className="rv-card" style={{ borderLeft: "4px solid var(--rv-info)", marginBottom: "20px" }}>
              <div className="rv-card-header" style={{ background: "var(--rv-info-surface)" }}>
                <div>
                  <h4 className="rv-card-title">
                    <BoxIcon size={16} style={{ color: "var(--rv-info)" }} />
                    <span>Order Snapshot: {inspectedOrder.orderNumber}</span>
                  </h4>
                  <p className="rv-card-subtitle">
                    Customer: {inspectedOrder.customerName} ({inspectedOrder.customerEmail || "No email"})
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setInspectedOrder(null)}
                  className="rv-btn rv-btn-secondary rv-btn-sm"
                >
                  ✕ Close Snapshot
                </button>
              </div>

              <div className="rv-card-body">
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "16px" }}>
                  {statusBadge(inspectedOrder.financialStatus)}
                  {statusBadge(inspectedOrder.fulfillmentStatus)}
                  <strong style={{ fontSize: "14px" }}>
                    Total: {inspectedOrder.totalPrice} {inspectedOrder.currency}
                  </strong>
                  <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    Processed: {formatTime(inspectedOrder.processedAt)}
                  </span>
                </div>

                {/* Line Items List */}
                <div style={{ border: "1px solid var(--rv-border)", borderRadius: "var(--rv-radius-sm)", background: "#ffffff", padding: "14px 18px", marginBottom: "12px" }}>
                  <strong style={{ fontSize: "13px", display: "block", marginBottom: "10px" }}>Line Items &amp; SKUs:</strong>
                  {(inspectedOrder.orderData?.lineItems?.nodes || []).map((li, idx) => (
                    <div
                      key={li.id || idx}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 0",
                        borderBottom: idx < (inspectedOrder.orderData.lineItems.nodes.length - 1) ? "1px solid #f1f3f5" : "none",
                        fontSize: "13px",
                      }}
                    >
                      <div>
                        <strong>{li.quantity}x</strong> {li.title} {li.variant?.title ? `(${li.variant.title})` : ""}
                        <span style={{ color: "var(--rv-text-subdued)", marginLeft: "8px", fontSize: "12px" }}>
                          SKU: {li.sku || li.variant?.sku || "None"}
                        </span>
                      </div>
                      <div style={{ fontWeight: 600 }}>
                        {li.originalUnitPriceSet?.shopMoney?.amount || "—"} {li.originalUnitPriceSet?.shopMoney?.currencyCode || ""}
                      </div>
                    </div>
                  ))}
                </div>

                {inspectedOrder.orderData?.shippingAddress && (
                  <p style={{ margin: 0, fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    📍 <strong>Shipping Address:</strong> {[
                      inspectedOrder.orderData.shippingAddress.address1,
                      inspectedOrder.orderData.shippingAddress.city,
                      inspectedOrder.orderData.shippingAddress.province,
                      inspectedOrder.orderData.shippingAddress.country,
                      inspectedOrder.orderData.shippingAddress.zip,
                    ].filter(Boolean).join(", ")}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Orders Table / Empty State */}
          {orders.length === 0 ? (
            <EmptyState
              icon={<DatabaseIcon size={28} style={{ color: "var(--rv-info)" }} />}
              title={searchOrder ? "No orders matched your search" : "No orders archived yet"}
              description={
                searchOrder
                  ? "Try searching by a different order number, customer email, or full name."
                  : "Click 'Sync Vault Now' above to pull your store's transaction records into the secure encrypted vault."
              }
            />
          ) : (
            <div className="rv-table-container">
              <table className="rv-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Date Processed</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Payment</th>
                    <th>Fulfillment</th>
                    <th style={{ textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((ord) => (
                    <tr key={ord.id}>
                      <td style={{ fontWeight: 700 }}>{ord.orderNumber}</td>
                      <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>
                        {formatTime(ord.processedAt)}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{ord.customerName || "Customer"}</div>
                        {ord.customerEmail && (
                          <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)" }}>
                            {ord.customerEmail}
                          </div>
                        )}
                      </td>
                      <td style={{ fontWeight: 700 }}>
                        {ord.totalPrice} {ord.currency}
                      </td>
                      <td>{statusBadge(ord.financialStatus)}</td>
                      <td>{statusBadge(ord.fulfillmentStatus)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          onClick={() => setInspectedOrder(ord)}
                          className="rv-btn rv-btn-secondary rv-btn-sm"
                        >
                          Inspect Snapshot
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB 2: Customers Directory ── */}
      {activeTab === "customers" && (
        <div>
          <div className="rv-filter-bar">
            <form method="get" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", width: "100%" }}>
              <div className="rv-search-wrapper" style={{ flexGrow: 1, minWidth: "260px" }}>
                <span className="rv-search-icon">
                  <SearchIcon size={15} />
                </span>
                <input
                  type="text"
                  name="searchCustomer"
                  defaultValue={searchCustomer}
                  placeholder="Search by Customer Name, Email, or Phone..."
                  className="rv-input rv-input-with-icon"
                  style={{ width: "100%" }}
                />
              </div>
              <button type="submit" className="rv-btn rv-btn-secondary rv-btn-sm">
                Search Customers
              </button>
              {searchCustomer && (
                <Link to="/app/vault" className="rv-btn rv-btn-subtle rv-btn-sm">
                  Clear Search
                </Link>
              )}
            </form>
          </div>

          {customers.length === 0 ? (
            <EmptyState
              icon={<DatabaseIcon size={28} style={{ color: "var(--rv-info)" }} />}
              title={searchCustomer ? "No customer profiles match your search" : "No customers archived yet"}
              description="Sync your vault above to archive buyer profiles and lifetime spending totals."
            />
          ) : (
            <div className="rv-table-container">
              <table className="rv-table">
                <thead>
                  <tr>
                    <th>Customer Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Location</th>
                    <th>Orders Count</th>
                    <th style={{ textAlign: "right" }}>Total Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((cust) => {
                    const addr = cust.customerData?.defaultAddress;
                    const addressStr = addr
                      ? [addr.city, addr.province, addr.country].filter(Boolean).join(", ")
                      : "—";

                    return (
                      <tr key={cust.id}>
                        <td style={{ fontWeight: 600 }}>
                          {[cust.firstName, cust.lastName].filter(Boolean).join(" ") || "Unnamed Buyer"}
                        </td>
                        <td style={{ color: "var(--rv-text-subdued)" }}>{cust.email || "—"}</td>
                        <td>{cust.phone ? <span className="rv-badge rv-badge-neutral rv-badge-sm">{cust.phone}</span> : "—"}</td>
                        <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>{addressStr}</td>
                        <td>
                          <span className="rv-badge rv-badge-info rv-badge-sm">{cust.ordersCount} Orders</span>
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>
                          ${cust.totalSpent || "0.00"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB 3: Protection Guide ── */}
      {activeTab === "guide" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "18px" }}>
          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <h4 className="rv-card-title">
                <ShieldCheckIcon size={18} style={{ color: "var(--rv-primary)" }} />
                <span>Defeating Payment Chargebacks</span>
              </h4>
            </div>
            <div className="rv-card-body">
              <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6, margin: 0 }}>
                When a buyer files a dispute alleging non-receipt or unauthorized transaction with Stripe or PayPal, click <strong>&ldquo;Inspect Snapshot&rdquo;</strong> on the order. You can export the <strong>Evidence JSON</strong> as authoritative proof of delivery destination, variant SKU, and buyer contact details.
              </p>
            </div>
          </div>

          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <h4 className="rv-card-title">
                <DatabaseIcon size={18} style={{ color: "var(--rv-info)" }} />
                <span>Tax Audit Readiness (IRS / GST / VAT)</span>
              </h4>
            </div>
            <div className="rv-card-body">
              <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6, margin: 0 }}>
                Export the <strong>Tax Audit CSV</strong> at the end of each financial period. This file provides clean, unedited financial statuses, net prices, and buyer locations formatted for instant upload to QuickBooks, Xero, or CPA review.
              </p>
            </div>
          </div>

          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <h4 className="rv-card-title">
                <ShieldCheckIcon size={18} style={{ color: "var(--rv-info)" }} />
                <span>GDPR &amp; Privacy Compliance</span>
              </h4>
            </div>
            <div className="rv-card-body">
              <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6, margin: 0 }}>
                Revertly automatically responds to Shopify&apos;s GDPR webhooks. When a customer requests data redaction, personal identities are anonymized while preserving tax totals so your accounting books always balance.
              </p>
            </div>
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
