import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
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

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "PAID" || s === "FULFILLED") return "success";
  if (s === "PENDING" || s === "PARTIALLY_PAID") return "attention";
  if (s === "REFUNDED" || s === "VOIDED") return "critical";
  return "info";
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
      {result?.message && (
        <s-section>
          <s-banner tone={result.success ? "success" : "critical"}>
            {result.message}
          </s-banner>
        </s-section>
      )}

      {/* ── Top Overview Banner & Quick Actions ── */}
      <s-section>
        <s-card>
          <s-box padding="base">
            <s-stack direction="inline" align="space-between" align-items="center" wrap>
              <s-stack direction="block" gap="extraTight">
                <s-stack direction="inline" gap="tight" align="center">
                  <s-text variant="headingMd" fontWeight="bold">Store Financial &amp; Dispute Vault</s-text>
                  <s-badge tone="success">Active &amp; Compliant</s-badge>
                </s-stack>
                <s-text tone="subdued">
                  Encrypted archive of historical transactions, line item SKUs, and buyer records for tax audits and chargeback defense.
                </s-text>
                <s-stack direction="inline" gap="base" align="center">
                  <s-badge tone="info">{stats.totalOrders} Archived Orders</s-badge>
                  <s-badge tone="info">{stats.totalCustomers} Customer Profiles</s-badge>
                  <s-text tone="subdued" variant="bodySm">
                    Last Vault Sync: {formatTime(stats.lastSync)}
                  </s-text>
                </s-stack>
              </s-stack>

              <s-stack direction="inline" gap="tight" align-items="center">
                <fetcher.Form method="POST">
                  <input type="hidden" name="intent" value="sync_all" />
                  <s-button
                    submit
                    variant="primary"
                    {...(isSyncing ? { loading: true } : {})}
                  >
                    🔄 Sync Orders &amp; Customers
                  </s-button>
                </fetcher.Form>

                <s-button href="/app/vault/export?type=orders_csv" variant="secondary">
                  ⬇️ Export Tax CSV
                </s-button>
                <s-button href="/app/vault/export?type=dispute_json" variant="secondary">
                  ⬇️ Full Evidence JSON
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        </s-card>
      </s-section>

      {/* ── Segmented Tabs ── */}
      <s-section>
        <s-stack direction="inline" gap="tight" wrap>
          <s-button
            variant={activeTab === "orders" ? "primary" : "secondary"}
            onClick={() => setActiveTab("orders")}
          >
            📦 Orders Vault ({orders.length})
          </s-button>
          <s-button
            variant={activeTab === "customers" ? "primary" : "secondary"}
            onClick={() => setActiveTab("customers")}
          >
            👥 Customers Directory ({customers.length})
          </s-button>
          <s-button
            variant={activeTab === "guide" ? "primary" : "secondary"}
            onClick={() => setActiveTab("guide")}
          >
            🛡️ Tax &amp; Dispute Protection Guide
          </s-button>
        </s-stack>
      </s-section>

      {/* ── TAB 1: Orders Vault ── */}
      {activeTab === "orders" && (
        <s-section heading="Archived Orders">
          {/* Filter Bar */}
          <s-card>
            <s-box padding="base">
              <form method="get">
                <s-stack direction="inline" gap="base" align-items="end">
                  <s-text-field
                    name="searchOrder"
                    label="Search Orders"
                    defaultValue={searchOrder}
                    placeholder="Search by Order # (#1001), Customer Email, or Name..."
                  />
                  <s-button submit variant="secondary">Search</s-button>
                  {searchOrder && (
                    <s-link href="/app/vault">Clear Search</s-link>
                  )}
                </s-stack>
              </form>
            </s-box>
          </s-card>

          {/* Inspected Order Modal / Box */}
          {inspectedOrder && (
            <s-card>
              <s-box padding="base">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" align="space-between" align-items="center">
                    <s-stack direction="block" gap="extraTight">
                      <s-text variant="headingMd" fontWeight="bold">
                        Order Snapshot: {inspectedOrder.orderNumber}
                      </s-text>
                      <s-text tone="subdued">
                        Customer: {inspectedOrder.customerName} ({inspectedOrder.customerEmail || "No email"})
                      </s-text>
                    </s-stack>
                    <s-button variant="secondary" onClick={() => setInspectedOrder(null)}>
                      ✕ Close Snapshot
                    </s-button>
                  </s-stack>

                  <s-stack direction="inline" gap="base" align="center">
                    <s-badge tone={statusTone(inspectedOrder.financialStatus)}>
                      Payment: {inspectedOrder.financialStatus || "N/A"}
                    </s-badge>
                    <s-badge tone={statusTone(inspectedOrder.fulfillmentStatus)}>
                      Fulfillment: {inspectedOrder.fulfillmentStatus || "N/A"}
                    </s-badge>
                    <s-text fontWeight="bold">
                      Total: {inspectedOrder.totalPrice} {inspectedOrder.currency}
                    </s-text>
                    <s-text tone="subdued">
                      Processed: {formatTime(inspectedOrder.processedAt)}
                    </s-text>
                  </s-stack>

                  {/* Line items table */}
                  <s-box padding="tight" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack direction="block" gap="tight">
                      <s-text fontWeight="bold">Line Items &amp; SKUs:</s-text>
                      {(inspectedOrder.orderData?.lineItems?.nodes || []).map((li, idx) => (
                        <s-stack key={li.id || idx} direction="inline" align="space-between">
                          <s-text>
                            <strong>{li.quantity}x</strong> {li.title} {li.variant?.title ? `(${li.variant.title})` : ""}
                          </s-text>
                          <s-stack direction="inline" gap="base">
                            <s-text tone="subdued">SKU: {li.sku || li.variant?.sku || "None"}</s-text>
                            <s-text fontWeight="semibold">
                              {li.originalUnitPriceSet?.shopMoney?.amount || "—"} {li.originalUnitPriceSet?.shopMoney?.currencyCode || ""}
                            </s-text>
                          </s-stack>
                        </s-stack>
                      ))}
                    </s-stack>
                  </s-box>

                  {/* Shipping Address */}
                  {inspectedOrder.orderData?.shippingAddress && (
                    <s-text tone="subdued">
                      Shipping Address: {[
                        inspectedOrder.orderData.shippingAddress.address1,
                        inspectedOrder.orderData.shippingAddress.city,
                        inspectedOrder.orderData.shippingAddress.province,
                        inspectedOrder.orderData.shippingAddress.country,
                        inspectedOrder.orderData.shippingAddress.zip,
                      ].filter(Boolean).join(", ")}
                    </s-text>
                  )}
                </s-stack>
              </s-box>
            </s-card>
          )}

          {/* Orders Table */}
          {orders.length === 0 ? (
            <s-card>
              <s-box padding="base">
                <s-empty-state heading="No orders archived yet">
                  <s-paragraph>
                    Click <strong>&ldquo;Sync Orders &amp; Customers&rdquo;</strong> above to pull your store&apos;s transaction records into the secure vault.
                  </s-paragraph>
                </s-empty-state>
              </s-box>
            </s-card>
          ) : (
            <s-card>
              <s-box padding="base">
                <s-resource-list>
                  {orders.map((ord) => (
                    <s-resource-item key={ord.id} id={String(ord.id)}>
                      <s-stack direction="inline" align="space-between" align-items="center">
                        <s-stack direction="block" gap="tight">
                          <s-stack direction="inline" gap="tight" align="center">
                            <s-text fontWeight="bold">{ord.orderNumber}</s-text>
                            <s-badge tone={statusTone(ord.financialStatus)}>
                              {ord.financialStatus || "N/A"}
                            </s-badge>
                            {ord.fulfillmentStatus && (
                              <s-badge tone={statusTone(ord.fulfillmentStatus)}>
                                {ord.fulfillmentStatus}
                              </s-badge>
                            )}
                          </s-stack>
                          <s-text tone="subdued">
                            Customer: {ord.customerName} {ord.customerEmail ? `(${ord.customerEmail})` : ""} &bull; Processed: {formatTime(ord.processedAt)}
                          </s-text>
                        </s-stack>

                        <s-stack direction="inline" gap="base" align-items="center">
                          <s-text fontWeight="bold" variant="headingSm">
                            {ord.totalPrice} {ord.currency}
                          </s-text>
                          <s-button
                            variant="secondary"
                            onClick={() => setInspectedOrder(ord)}
                          >
                            Inspect Snapshot
                          </s-button>
                        </s-stack>
                      </s-stack>
                    </s-resource-item>
                  ))}
                </s-resource-list>
              </s-box>
            </s-card>
          )}
        </s-section>
      )}

      {/* ── TAB 2: Customers Directory ── */}
      {activeTab === "customers" && (
        <s-section heading="Archived Customers">
          <s-card>
            <s-box padding="base">
              <form method="get">
                <s-stack direction="inline" gap="base" align-items="end">
                  <s-text-field
                    name="searchCustomer"
                    label="Search Customers"
                    defaultValue={searchCustomer}
                    placeholder="Search by Name, Email, or Phone..."
                  />
                  <s-button submit variant="secondary">Search</s-button>
                  {searchCustomer && (
                    <s-link href="/app/vault">Clear Search</s-link>
                  )}
                </s-stack>
              </form>
            </s-box>
          </s-card>

          {customers.length === 0 ? (
            <s-card>
              <s-box padding="base">
                <s-empty-state heading="No customers archived yet">
                  <s-paragraph>
                    Click <strong>&ldquo;Sync Orders &amp; Customers&rdquo;</strong> to pull customer profiles and spending history.
                  </s-paragraph>
                </s-empty-state>
              </s-box>
            </s-card>
          ) : (
            <s-card>
              <s-box padding="base">
                <s-resource-list>
                  {customers.map((cust) => {
                    const addr = cust.customerData?.defaultAddress;
                    const addressStr = addr
                      ? [addr.city, addr.province, addr.country].filter(Boolean).join(", ")
                      : "";

                    return (
                      <s-resource-item key={cust.id} id={String(cust.id)}>
                        <s-stack direction="inline" align="space-between" align-items="center">
                          <s-stack direction="block" gap="tight">
                            <s-stack direction="inline" gap="tight" align="center">
                              <s-text fontWeight="bold">
                                {[cust.firstName, cust.lastName].filter(Boolean).join(" ") || cust.email || "Unnamed Customer"}
                              </s-text>
                              {cust.phone && <s-badge tone="subdued">{cust.phone}</s-badge>}
                            </s-stack>
                            <s-text tone="subdued">
                              Email: {cust.email || "—"} {addressStr ? `&bull; Location: ${addressStr}` : ""}
                            </s-text>
                          </s-stack>

                          <s-stack direction="inline" gap="base" align-items="center">
                            <s-badge tone="info">{cust.ordersCount} Orders</s-badge>
                            <s-text fontWeight="bold">
                              Spent: ${cust.totalSpent || "0.00"}
                            </s-text>
                          </s-stack>
                        </s-stack>
                      </s-resource-item>
                    );
                  })}
                </s-resource-list>
              </s-box>
            </s-card>
          )}
        </s-section>
      )}

      {/* ── TAB 3: Guide ── */}
      {activeTab === "guide" && (
        <s-section heading="Dispute Defense &amp; Accounting Vault Guide">
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-text fontWeight="bold" variant="headingMd">How to use your Revertly Data Vault:</s-text>
                
                <s-stack direction="block" gap="tight">
                  <s-text fontWeight="bold">1. Defeating Payment Chargebacks (PayPal / Stripe / Klarna):</s-text>
                  <s-paragraph>
                    When a buyer files a dispute alleging non-receipt or unauthorized transaction, click <strong>&ldquo;Inspect Snapshot&rdquo;</strong> on the order. You will see the timestamped delivery destination, variant SKU, and buyer contact details. Export the <strong>Dispute JSON</strong> or screenshot this view as authoritative proof.
                  </s-paragraph>
                </s-stack>

                <s-stack direction="block" gap="tight">
                  <s-text fontWeight="bold">2. Surviving Tax Audits (IRS / GST / VAT):</s-text>
                  <s-paragraph>
                    Export the <strong>Tax Audit CSV</strong> at the end of each financial quarter. This file includes clean, unedited financial statuses, net prices, and customer locations compatible with QuickBooks, Xero, and Microsoft Excel.
                  </s-paragraph>
                </s-stack>

                <s-stack direction="block" gap="tight">
                  <s-text fontWeight="bold">3. GDPR &amp; Privacy Compliance:</s-text>
                  <s-paragraph>
                    Revertly actively listens for Shopify&apos;s GDPR webhooks. When a customer exercises their &ldquo;Right to be Forgotten&rdquo;, personal identities are anonymized while preserving tax totals so your accounting books always balance.
                  </s-paragraph>
                </s-stack>
              </s-stack>
            </s-box>
          </s-card>
        </s-section>
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
