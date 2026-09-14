import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

/**
 * Shop Redact Webhook (GDPR compliance)
 * Triggered 48 hours after an app uninstallation to purge all store data.
 */
export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}. Initiating 48h store data purge.`);

  try {
    await Promise.allSettled([
      prisma.orderArchive.deleteMany({ where: { shop } }),
      prisma.customerArchive.deleteMany({ where: { shop } }),
      prisma.productSnapshot.deleteMany({ where: { shop } }),
      prisma.changeEvent.deleteMany({ where: { shop } }),
      prisma.incident.deleteMany({ where: { shop } }),
      prisma.detectionRule.deleteMany({ where: { shop } }),
      prisma.restorePoint.deleteMany({ where: { shop } }),
      prisma.appSettings.deleteMany({ where: { shop } }),
      prisma.session.deleteMany({ where: { shop } }),
    ]);

    console.log(`All store records purged successfully for ${shop}.`);
  } catch (err) {
    console.error(`Shop redact error for ${shop}:`, err?.message || err);
  }

  return new Response("OK", { status: 200 });
};
