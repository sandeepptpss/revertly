import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { generateOrdersCsv } from "../backup.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const perm = await checkPermission(shop, session, PERMISSIONS.VIEW);
  if (!perm.allowed || perm.actor?.suspended) {
    throw new Response("Forbidden: Insufficient permissions to export vault data", { status: 403 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "orders_csv";

  await logAudit(shop, perm.actor, "VAULT_EXPORTED", {
    resourceType: "DataVault",
    details: { type },
    request,
  });

  const cleanShop = shop.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date().toISOString().split("T")[0];

  if (type === "orders_csv") {
    const orders = await prisma.orderArchive.findMany({
      where: { shop },
      orderBy: { processedAt: "desc" },
    });

    const csvContent = generateOrdersCsv(orders);
    return new Response(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-orders-vault-${cleanShop}-${dateStr}.csv"`,
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  if (type === "customers_csv") {
    const customers = await prisma.customerArchive.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });

    const headers = [
      "Customer ID",
      "Email",
      "First Name",
      "Last Name",
      "Phone",
      "Orders Count",
      "Total Spent",
      "Shipping Address",
      "Archived At",
    ];

    const rows = customers.map((c) => {
      const raw = c.customerData || {};
      const addr = raw.defaultAddress || {};
      const fullAddr = [addr.address1, addr.city, addr.province, addr.country, addr.zip]
        .filter(Boolean)
        .join(", ");

      return [
        c.customerId,
        c.email || "",
        c.firstName || "",
        c.lastName || "",
        c.phone || "",
        c.ordersCount,
        c.totalSpent || "0.00",
        fullAddr,
        new Date(c.createdAt).toISOString(),
      ].map((val) => `"${String(val).replace(/"/g, '""')}"`);
    });

    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");

    return new Response(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-customers-vault-${cleanShop}-${dateStr}.csv"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // Fallback / Complete Dispute Evidence JSON
  const [orders, customers] = await Promise.all([
    prisma.orderArchive.findMany({ where: { shop }, orderBy: { processedAt: "desc" } }),
    prisma.customerArchive.findMany({ where: { shop }, orderBy: { createdAt: "desc" } }),
  ]);

  const payload = {
    _schema: "revertly-dispute-vault-v1",
    shop,
    exportedAt: new Date().toISOString(),
    totalOrders: orders.length,
    totalCustomers: customers.length,
    orders,
    customers,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="revertly-vault-evidence-${cleanShop}-${dateStr}.json"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};
