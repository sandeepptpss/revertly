import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

/**
 * Customers Data Request Webhook (GDPR compliance)
 * Triggered when a merchant or customer requests an export of their stored data.
 */
export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const customerEmail = payload?.customer?.email;
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;

  try {
    const [customer, orders] = await Promise.all([
      customerId
        ? prisma.customerArchive.findFirst({ where: { shop, customerId } })
        : customerEmail
        ? prisma.customerArchive.findFirst({ where: { shop, email: customerEmail } })
        : null,
      customerEmail
        ? prisma.orderArchive.findMany({ where: { shop, customerEmail }, take: 50 })
        : [],
    ]);

    console.log(
      `GDPR Data request processed for ${customerEmail || customerId || "unknown"}: found ${customer ? 1 : 0} customer record, ${orders.length} orders`
    );
  } catch (err) {
    console.warn("GDPR data request error:", err?.message || err);
  }

  return new Response("OK", { status: 200 });
};
