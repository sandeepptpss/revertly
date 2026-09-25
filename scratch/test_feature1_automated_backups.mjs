import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  computeNextAutoBackup,
  runScheduledBackupForShop,
  runDueAutomatedBackups,
} from "../app/scheduler.server.js";

const TEST_SHOP = "qa-auto-backup-test.myshopify.com";

async function main() {
  console.log("▶ Verifying Feature 1: Automated Daily Backups");

  // 1. Test calculation
  const nextDaily = computeNextAutoBackup("DAILY", "02:00");
  assert(nextDaily instanceof Date, "computeNextAutoBackup returns a Date instance");
  assert(nextDaily.getTime() > Date.now(), "nextDaily is in the future");
  console.log("  ✅ PASS: computeNextAutoBackup calculates future UTC time correctly:", nextDaily.toISOString());

  // 2. Setup test shop settings and test product snapshots
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.auditLog.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.session.deleteMany({ where: { shop: TEST_SHOP } });

  // The sweep only backs up installed stores, which is to say stores with an
  // offline session (uninstall deletes it).
  await prisma.session.create({
    data: { id: `offline_${TEST_SHOP}`, shop: TEST_SHOP, state: "qa", isOnline: false, accessToken: "qa-token" },
  });

  await prisma.appSettings.create({
    data: {
      shop: TEST_SHOP,
      // Cloud sync is a paid feature. Without a plan that includes it the
      // scheduler skips the upload entirely and the restore point stays
      // NOT_SYNCED, which would not exercise the failure path below.
      planId: "starter",
      autoBackupSchedule: "DAILY",
      autoBackupTime: "02:00",
      nextAutoBackupAt: new Date(Date.now() - 10000), // In the past -> DUE
      cloudSyncConnected: true,
      cloudSyncAutoUpload: true,
      cloudSyncProvider: "GOOGLE_DRIVE",
    },
  });

  await prisma.productSnapshot.create({
    data: {
      shop: TEST_SHOP,
      productId: "9901",
      title: "Test Running Shoes",
      status: "ACTIVE",
      snapshotData: {
        id: "gid://shopify/Product/9901",
        title: "Test Running Shoes",
        status: "ACTIVE",
        variants: [{ id: "gid://shopify/ProductVariant/8801", price: "120.00" }],
      },
    },
  });

  // 3. Test runDueAutomatedBackups()
  const sweepRes = await runDueAutomatedBackups();
  console.log("  Sweep result:", JSON.stringify(sweepRes, null, 2));
  assert(sweepRes.successCount >= 1, "runDueAutomatedBackups successfully executed at least 1 due backup");

  // Verify database persistence
  const updatedSettings = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
  assert(updatedSettings.lastAutoBackupAt !== null, "lastAutoBackupAt was updated");
  assert(updatedSettings.nextAutoBackupAt !== null, "nextAutoBackupAt was updated");
  assert(updatedSettings.nextAutoBackupAt.getTime() > Date.now(), "New nextAutoBackupAt is strictly in the future");

  const createdRps = await prisma.restorePoint.findMany({ where: { shop: TEST_SHOP } });
  assert(createdRps.length === 1, "RestorePoint created by automated backup runner");
  assert(createdRps[0].status === "READY", "RestorePoint status is READY");
  assert(createdRps[0].productCount === 1, "Snapshot preserved product data");

  // Cloud auto-sync now performs a real upload. With no OAuth credentials
  // configured in this environment the upload cannot succeed, and the restore
  // point must say so rather than claiming an offsite copy that doesn't exist.
  // (This previously asserted SYNCED, which the old stub set without uploading.)
  assert(
    createdRps[0].cloudSyncStatus === "FAILED",
    `Unconfigured cloud auto-sync is recorded as FAILED, not a false SYNCED (got ${createdRps[0].cloudSyncStatus})`,
  );
  assert(
    createdRps[0].cloudSyncedAt === null,
    "No cloud sync timestamp is recorded when the upload did not happen",
  );
  // The sweep covers every due shop, so locate this test's own result rather
  // than assuming it is first.
  const ourResult = sweepRes.results.find((r) => r.shop === TEST_SHOP);
  assert(ourResult, "Sweep result includes this test shop");
  assert(
    ourResult.cloudSync?.success === false,
    "Sweep result reports the cloud sync failure to the caller",
  );
  // The backup itself must not be failed by a cloud problem.
  assert(sweepRes.successCount >= 1, "Backup still succeeds even when offsite sync fails");

  // Verify Audit Log
  const auditLogs = await prisma.auditLog.findMany({
    where: { shop: TEST_SHOP, action: "AUTOMATED_BACKUP_EXECUTED" },
  });
  assert(auditLogs.length === 1, "Audit log entry created for automated backup");

  // Uninstalled: the offline session is gone, so the next due run is skipped
  // and the schedule is left for a reinstall to resume.
  await prisma.session.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.update({ where: { shop: TEST_SHOP }, data: { nextAutoBackupAt: new Date(Date.now() - 10000) } });
  const before = await prisma.restorePoint.count({ where: { shop: TEST_SHOP } });
  const uninstalledSweep = await runDueAutomatedBackups();
  const skipped = uninstalledSweep.results.find((r) => r.shop === TEST_SHOP);
  assert(skipped?.skipped && /not installed/i.test(skipped.reason), "Uninstalled store is skipped by the sweep");
  assert((await prisma.restorePoint.count({ where: { shop: TEST_SHOP } })) === before, "No restore point created for an uninstalled store");
  assert((await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } })).autoBackupSchedule === "DAILY", "Schedule kept for reinstall");
  console.log("  ✅ PASS: Uninstalled store is skipped and its schedule kept");

  console.log("  ✅ PASS: Automated Daily Backups executed, persisted, and verified end-to-end!\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Feature 1 Test failed:", err);
  process.exit(1);
});
