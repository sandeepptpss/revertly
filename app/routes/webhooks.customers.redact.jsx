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
    // Match on id OR email, never one *or* the other: orders captured without a
    // Shopify customer id are archived under a synthetic `cust_<orderId>`, which
    // can only ever be found by email.
    const idOrEmail = [
      ...(customerId ? [{ customerId }] : []),
      ...(customerEmail ? [{ email: customerEmail }] : []),
    ];
    if (idOrEmail.length === 0) {
      console.warn(`[Revertly GDPR] customers/redact for ${shop} carried no customer id or email.`);
      return new Response("OK", { status: 200 });
    }

    // Read before deleting so an id-only payload still yields the address
    // needed to find this person's orders and marketing profile.
    const archived = await prisma.customerArchive.findMany({
      where: { shop, OR: idOrEmail },
      select: { email: true },
    });

    const emails = [
      ...new Set([customerEmail, ...archived.map((a) => a.email)].filter(Boolean)),
    ];

    // 1. Delete the customer record itself
    await prisma.customerArchive.deleteMany({ where: { shop, OR: idOrEmail } });

    if (emails.length > 0) {
      // 2. Anonymise PII in OrderArchive, keeping financial totals for tax
      //    integrity. The full order payload in `orderData` carries the
      //    customer's email, phone and shipping address, so scrubbing the
      //    columns alone would leave the PII fully intact and exportable.
      const orders = await prisma.orderArchive.findMany({
        where: { shop, customerEmail: { in: emails } },
        select: { id: true, orderData: true },
      });

      for (const order of orders) {
        const data = order.orderData && typeof order.orderData === "object" ? order.orderData : null;
        const scrubbed = data
          ? {
              ...data,
              customer: data.customer
                ? {
                    id: data.customer.id ?? null,
                    displayName: "REDACTED_GDPR",
                    email: "redacted@privacy.shopify.com",
                    phone: null,
                  }
                : data.customer,
              shippingAddress: data.shippingAddress ? null : data.shippingAddress,
            }
          : data;

        await prisma.orderArchive.update({
          where: { id: order.id },
          data: {
            customerName: "REDACTED_GDPR",
            customerEmail: "redacted@privacy.shopify.com",
            ...(scrubbed ? { orderData: scrubbed } : {}),
          },
        });
      }

      // 3. Purge customer subscriber profile from MarketingProfile archive
      await prisma.marketingProfile.deleteMany({
        where: { shop, email: { in: emails } },
      });
    }

    console.log(`GDPR redaction completed for customer ${customerId || customerEmail}`);
  } catch (err) {
    console.error(`GDPR redaction error for ${shop}:`, err?.message || err);
  }

  return new Response("OK", { status: 200 });
};
