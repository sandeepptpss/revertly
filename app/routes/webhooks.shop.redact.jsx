import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

/**
 * Shop Redact Webhook (GDPR compliance)
 * Triggered 48 hours after an app uninstallation to purge all store data.
 */
export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}. Initiating 48h store data purge.`);

  // Ordered, not parallel: RollbackResult -> RollbackJob is ON DELETE RESTRICT,
  // so the results must go first or every delete of a shop that ever ran a
  // rollback fails with a foreign-key violation. Each step is awaited and its
  // outcome recorded, because a swallowed rejection here means we tell Shopify
  // the store was purged while the rows are still on disk.
  const steps = [
    ["rollbackResult", () => prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop } } })],
    ["rollbackJob", () => prisma.rollbackJob.deleteMany({ where: { shop } })],
    ["changeEvent", () => prisma.changeEvent.deleteMany({ where: { shop } })],
    ["incident", () => prisma.incident.deleteMany({ where: { shop } })],
    ["detectionRule", () => prisma.detectionRule.deleteMany({ where: { shop } })],
    ["restorePoint", () => prisma.restorePoint.deleteMany({ where: { shop } })],
    ["orderArchive", () => prisma.orderArchive.deleteMany({ where: { shop } })],
    ["customerArchive", () => prisma.customerArchive.deleteMany({ where: { shop } })],
    ["productSnapshot", () => prisma.productSnapshot.deleteMany({ where: { shop } })],
    ["catalogSyncJob", () => prisma.catalogSyncJob.deleteMany({ where: { shop } })],
    ["downtimeCheck", () => prisma.downtimeCheck.deleteMany({ where: { shop } })],
    ["monitoredService", () => prisma.monitoredService.deleteMany({ where: { shop } })],
    ["teamMember", () => prisma.teamMember.deleteMany({ where: { shop } })],
    ["auditLog", () => prisma.auditLog.deleteMany({ where: { shop } })],
    ["qaTestRun", () => prisma.qaTestRun.deleteMany({ where: { shop } })],
    ["marketingProfile", () => prisma.marketingProfile.deleteMany({ where: { shop } })],
    ["marketingFlow", () => prisma.marketingFlow.deleteMany({ where: { shop } })],
    ["marketingList", () => prisma.marketingList.deleteMany({ where: { shop } })],
    ["freeGrowthGrant", () => prisma.freeGrowthGrant.deleteMany({ where: { shop } })],
    ["storeDiscount", () => prisma.storeDiscount.deleteMany({ where: { shop } })],
    ["supportTicket", () => prisma.supportTicket.deleteMany({ where: { shop } })],
    ["appSettings", () => prisma.appSettings.deleteMany({ where: { shop } })],
    ["session", () => prisma.session.deleteMany({ where: { shop } })],
  ];

  const failures = [];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (err) {
      failures.push(`${label}: ${err?.message || err}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `[Revertly GDPR] Shop redact INCOMPLETE for ${shop} — ${failures.length} step(s) failed:`,
      failures.join("; "),
    );
  } else {
    console.log(`All store records purged successfully for ${shop}.`);
  }

  return new Response("OK", { status: 200 });
};
