import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { syncOrdersVault, syncCustomersVault } from "../backup.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
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
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync_all" || intent === "sync_orders") {
    const [ordRes, custRes] = await Promise.allSettled([
      syncOrdersVault(admin, shop, { maxOrders: 100 }),
      syncCustomersVault(admin, shop, { maxCustomers: 100 }),
    ]);

    const orderCount = ordRes.status === "fulfilled" && ordRes.value?.success ? ordRes.value.count : 0;
    const custCount = custRes.status === "fulfilled" && custRes.value?.success ? custRes.value.count : 0;

    return {
      success: true,
      message: `Vault successfully synchronized! Archived ${orderCount} orders and ${custCount} customer profiles.`,
    };
  }

  return { success: false, message: "Unknown action." };
};

function formatTime(date) {
  if (!date) return "Never";
  return new Date(date).toLocaleString();
}

function statusBadge(status) {
  const s = String(status || "").toUpperCase();
  if (s === "PAID" || s === "FULFILLED") return <span className="rv-badge rv-badge-success">{s}</span>;
  if (s === "PENDING" || s === "PARTIALLY_PAID") return <span className="rv-badge rv-badge-warning">{s}</span>;
  if (s === "REFUNDED" || s === "VOIDED") return <span className="rv-badge rv-badge-critical">{s}</span>;
  return <span className="rv-badge rv-badge-neutral">{s || "N/A"}</span>;
}

export default function DataVault() {
  const { stats, orders, customers, searchOrder, searchCustomer } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSyncing = fetcher.state !== "idle";

  const [activeTab, setActiveTab] = useState("orders");
  const [inspectedOrder, setInspectedOrder] = useState(null);

  return (
    <s-page heading="Orders & Customers Vault" inlineSize="large">

      {/* ── Action Result Banner ── */}
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

      {/* ── Hero Vault Status & Quick Export Actions ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <strong style={{ fontSize: "16px", color: "var(--rv-text)" }}>
              Store Financial &amp; Dispute Vault
            </strong>
            <span className="rv-badge rv-badge-success">Active &amp; Compliant</span>
          </div>
          <p style={{ margin: "0 0 8px", fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Encrypted archive of historical transactions, line item SKUs, and customer records for tax audits and chargeback defense.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
            <span className="rv-badge rv-badge-info">{stats.totalOrders} Archived Orders</span>
            <span className="rv-badge rv-badge-info">{stats.totalCustomers} Customer Profiles</span>
            <span>🕒 Last Vault Sync: {formatTime(stats.lastSync)}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <fetcher.Form method="POST">
            <input type="hidden" name="intent" value="sync_all" />
            <button
              type="submit"
              disabled={isSyncing}
              className="rv-btn rv-btn-primary"
              style={{ fontWeight: 600 }}
            >
              {isSyncing ? "⏳ Syncing..." : "🔄 Sync Vault Now"}
            </button>
          </fetcher.Form>

          <a href="/app/vault/export?type=orders_csv" className="rv-btn rv-btn-secondary" style={{ fontSize: "13px" }}>
            ⬇️ Tax Audit CSV
          </a>
          <a href="/app/vault/export?type=dispute_json" className="rv-btn rv-btn-secondary" style={{ fontSize: "13px" }}>
            ⬇️ Evidence JSON
          </a>
        </div>
      </div>

      {/* ── Segmented Navigation Pills ── */}
      <div className="rv-pills-row">
        <button
          type="button"
          className={`rv-pill ${activeTab === "orders" ? "rv-pill-active" : ""}`}
          onClick={() => setActiveTab("orders")}
        >
          📦 Orders Vault ({orders.length})
        </button>
        <button
          type="button"
          className={`rv-pill ${activeTab === "customers" ? "rv-pill-active" : ""}`}
          onClick={() => setActiveTab("customers")}
        >
          👥 Customers Directory ({customers.length})
        </button>
        <button
          type="button"
          className={`rv-pill ${activeTab === "guide" ? "rv-pill-active" : ""}`}
          onClick={() => setActiveTab("guide")}
        >
          🛡️ Tax &amp; Dispute Protection Guide
        </button>
      </div>

      {/* ── TAB 1: Orders Vault ── */}
      {activeTab === "orders" && (
        <div>
          {/* Filter Bar */}
          <div className="rv-filter-bar">
            <form method="get" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", width: "100%" }}>
              <input
                type="text"
                name="searchOrder"
                defaultValue={searchOrder}
                placeholder="🔍 Search by Order # (#1001), Customer Email, or Name..."
                className="rv-input"
                style={{ flexGrow: 1, minWidth: "260px" }}
              />
              <button type="submit" className="rv-btn rv-btn-primary">
                Search Orders
              </button>
              {searchOrder && (
                <Link to="/app/vault" className="rv-btn rv-btn-subtle">
                  ✕ Clear Search
                </Link>
              )}
            </form>
          </div>

          {/* Inspected Order Snapshot Drawer */}
          {inspectedOrder && (
            <div className="rv-card" style={{ borderLeft: "4px solid #005bd3", background: "#f8fafc", marginBottom: "20px" }}>
              <div className="rv-card-header" style={{ background: "#edf2f7" }}>
                <div>
                  <h4 className="rv-card-title">
                    <span>📦</span> Order Snapshot: {inspectedOrder.orderNumber}
                  </h4>
                  <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                    Customer: {inspectedOrder.customerName} ({inspectedOrder.customerEmail || "No email"})
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setInspectedOrder(null)}
                  className="rv-btn rv-btn-secondary"
                  style={{ fontSize: "12px" }}
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
                <div style={{ border: "1px solid var(--rv-border)", borderRadius: "var(--rv-radius-sm)", background: "#ffffff", padding: "12px 16px", marginBottom: "12px" }}>
                  <strong style={{ fontSize: "13px", display: "block", marginBottom: "8px" }}>Line Items &amp; SKUs:</strong>
                  {(inspectedOrder.orderData?.lineItems?.nodes || []).map((li, idx) => (
                    <div
                      key={li.id || idx}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "6px 0",
                        borderBottom: idx < (inspectedOrder.orderData.lineItems.nodes.length - 1) ? "1px solid #f1f2f3" : "none",
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
            <div className="rv-empty-state">
              <div className="rv-empty-icon-circle">📦</div>
              <div className="rv-empty-title">
                {searchOrder ? "No orders matched your search" : "No orders archived yet"}
              </div>
              <div className="rv-empty-desc">
                {searchOrder
                  ? "Try searching by a different order number, customer email, or full name."
                  : "Click 'Sync Vault Now' above to pull your store's transaction records into the secure encrypted vault."}
              </div>
            </div>
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
                        <div style={{ fontWeight: 500 }}>{ord.customerName || "Customer"}</div>
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
                          className="rv-btn rv-btn-secondary"
                          style={{ fontSize: "12px", padding: "6px 12px" }}
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
              <input
                type="text"
                name="searchCustomer"
                defaultValue={searchCustomer}
                placeholder="🔍 Search by Customer Name, Email, or Phone..."
                className="rv-input"
                style={{ flexGrow: 1, minWidth: "260px" }}
              />
              <button type="submit" className="rv-btn rv-btn-primary">
                Search Customers
              </button>
              {searchCustomer && (
                <Link to="/app/vault" className="rv-btn rv-btn-subtle">
                  ✕ Clear Search
                </Link>
              )}
            </form>
          </div>

          {customers.length === 0 ? (
            <div className="rv-empty-state">
              <div className="rv-empty-icon-circle">👥</div>
              <div className="rv-empty-title">
                {searchCustomer ? "No customer profiles match your search" : "No customers archived yet"}
              </div>
              <div className="rv-empty-desc">
                Sync your vault above to archive buyer profiles and lifetime spending totals.
              </div>
            </div>
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
                        <td>{cust.phone ? <span className="rv-badge rv-badge-neutral">{cust.phone}</span> : "—"}</td>
                        <td style={{ color: "var(--rv-text-subdued)", fontSize: "12px" }}>{addressStr}</td>
                        <td>
                          <span className="rv-badge rv-badge-info">{cust.ordersCount} Orders</span>
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
          <div className="rv-card" style={{ margin: 0 }}>
            <div className="rv-card-header">
              <h4 className="rv-card-title">
                <span>🛡️</span> Defeating Payment Chargebacks
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
                <span>📊</span> Tax Audit Readiness (IRS / GST / VAT)
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
                <span>🔒</span> GDPR &amp; Privacy Compliance
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
