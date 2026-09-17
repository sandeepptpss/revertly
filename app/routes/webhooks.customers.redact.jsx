import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

/**
 * Customers Redact Webhook (GDPR Right to be Forgotten)
 * Triggered when a customer requests deletion of their personal identifiable information.
 */
export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
  const customerEmail = payload?.customer?.email;

  try {
    // 1. Delete customer record from CustomerArchive
    if (customerId) {
      await prisma.customerArchive.deleteMany({
        where: { shop, customerId },
      });
    } else if (customerEmail) {
      await prisma.customerArchive.deleteMany({
        where: { shop, email: customerEmail },
      });
    }

    // 2. Anonymize customer PII in OrderArchive while preserving non-PII financial totals for tax integrity
    if (customerEmail) {
      await prisma.orderArchive.updateMany({
        where: { shop, customerEmail },
        data: {
          customerName: "REDACTED_GDPR",
          customerEmail: "redacted@privacy.shopify.com",
        },
      });

      // 3. Purge customer subscriber profile from MarketingProfile archive
      await prisma.marketingProfile.deleteMany({
        where: { shop, email: customerEmail },
      });
    }

    console.log(`GDPR redaction completed for customer ${customerId || customerEmail}`);
  } catch (err) {
    console.error(`GDPR redaction error for ${shop}:`, err?.message || err);
  }

  return new Response("OK", { status: 200 });
};
