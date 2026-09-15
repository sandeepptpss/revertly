import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TEST_SHOP = "simulation-test-store.myshopify.com";

function computeNextAutoBackup(schedule, timeStr) {
  if (!schedule || schedule === "OFF") return null;
  const [hours, minutes] = (timeStr || "02:00").split(":").map((v) => parseInt(v, 10) || 0);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
  if (next.getTime() <= now.getTime()) {
    if (schedule === "TWICE_DAILY") {
      next.setUTCHours(next.getUTCHours() + 12);
    } else if (schedule === "WEEKLY") {
      next.setUTCDate(next.getUTCDate() + 7);
    } else {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next;
}

async function runSimulation() {
  console.log("==========================================================");
  console.log("🚀 STARTING REVERTLY FEATURE SIMULATION TEST");
  console.log("==========================================================\n");

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, testName) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      throw new Error(`Assertion failed for: ${testName}`);
    }
  }

  try {
    // ── 0. Setup test shop ──────────────────────────────────
    console.log("▶ Test Suite 1: AppSettings & Automated Schedule Computation");
    await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });

    // Test computeNextAutoBackup
    const nextDaily = computeNextAutoBackup("DAILY", "02:00");
    assert(nextDaily instanceof Date, "computeNextAutoBackup returns a valid Date instance for DAILY");
    assert(nextDaily.getTime() > Date.now(), "nextAutoBackupAt is strictly in the future");
    assert(computeNextAutoBackup("OFF", "02:00") === null, "computeNextAutoBackup returns null when schedule is OFF");

    // Save schedule in DB
    const settings = await prisma.appSettings.create({
      data: {
        shop: TEST_SHOP,
        autoBackupSchedule: "DAILY",
        autoBackupTime: "02:00",
        nextAutoBackupAt: nextDaily,
        cloudSyncProvider: "NONE",
        cloudSyncConnected: false,
        cloudSyncFolder: "Revertly_Backups",
      },
    });

    assert(settings.autoBackupSchedule === "DAILY", "Persisted autoBackupSchedule as DAILY");
    assert(settings.autoBackupTime === "02:00", "Persisted autoBackupTime as 02:00");
    assert(settings.nextAutoBackupAt !== null, "Persisted nextAutoBackupAt timestamp");

    // ── 1. Cloud Storage Connection Simulation ─────────────
    console.log("\n▶ Test Suite 2: Google Drive / Dropbox Cloud Sync Flow");

    // Connect Google Drive
    const connectedGdrive = await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: {
        cloudSyncProvider: "GOOGLE_DRIVE",
        cloudSyncEmail: "merchant@acme-store.com",
        cloudSyncFolder: "Revertly_Disaster_Vault",
        cloudSyncConnected: true,
        cloudSyncAutoUpload: true,
      },
    });

    assert(connectedGdrive.cloudSyncConnected === true, "Google Drive connected flag set to true");
    assert(connectedGdrive.cloudSyncProvider === "GOOGLE_DRIVE", "Cloud provider is GOOGLE_DRIVE");
    assert(connectedGdrive.cloudSyncEmail === "merchant@acme-store.com", "Cloud sync email recorded correctly");
    assert(connectedGdrive.cloudSyncFolder === "Revertly_Disaster_Vault", "Custom folder name saved correctly");

    // Switch to Dropbox
    const connectedDropbox = await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: {
        cloudSyncProvider: "DROPBOX",
        cloudSyncEmail: "ops@acme-store.com",
      },
    });
    assert(connectedDropbox.cloudSyncProvider === "DROPBOX", "Cloud provider seamlessly switched to DROPBOX");

    // Disconnect cloud
    const disconnected = await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: {
        cloudSyncConnected: false,
        cloudSyncProvider: "NONE",
        cloudSyncEmail: null,
        cloudSyncAutoUpload: false,
      },
    });
    assert(disconnected.cloudSyncConnected === false, "Cloud storage disconnected successfully");
    assert(disconnected.cloudSyncProvider === "NONE", "Cloud provider reset to NONE");

    // Re-connect Google Drive for Restore Point test
    await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: {
        cloudSyncProvider: "GOOGLE_DRIVE",
        cloudSyncEmail: "merchant@acme-store.com",
        cloudSyncConnected: true,
        cloudSyncAutoUpload: true,
      },
    });

    // ── 2. Restore Point Cloud Sync Workflow ──────────────
    console.log("\n▶ Test Suite 3: Restore Point Snapshot Cloud Archival");

    const rp = await prisma.restorePoint.create({
      data: {
        shop: TEST_SHOP,
        name: "Snapshot - BFCM Campaign Ready",
        description: "Full store backup before flash sale starts",
        status: "READY",
        backupType: "FULL",
        productCount: 250,
        themeCount: 1,
        collectionCount: 12,
        pageCount: 8,
        menuCount: 2,
        cloudSyncStatus: "NOT_SYNCED",
      },
    });

    assert(rp.cloudSyncStatus === "NOT_SYNCED", "New restore point defaults to NOT_SYNCED status");
    assert(rp.cloudSyncedAt === null, "New restore point has no cloudSyncedAt timestamp yet");

    // Simulate "Sync to Cloud" trigger
    const syncTime = new Date();
    const syncedRp = await prisma.restorePoint.update({
      where: { id: rp.id },
      data: {
        cloudSyncedAt: syncTime,
        cloudSyncStatus: "SYNCED",
        cloudProvider: "GOOGLE_DRIVE",
      },
    });

    assert(syncedRp.cloudSyncStatus === "SYNCED", "Restore point cloudSyncStatus updated to SYNCED");
    assert(syncedRp.cloudProvider === "GOOGLE_DRIVE", "Restore point cloudProvider set to GOOGLE_DRIVE");
    assert(syncedRp.cloudSyncedAt instanceof Date, "Restore point cloudSyncedAt has valid timestamp");

    // ── 3. Dashboard Loader Simulation ─────────────────────
    console.log("\n▶ Test Suite 4: Dashboard Indicator & Cadence Loader Simulation");

    // Query like app._index.jsx loader does
    const [latestRp, shopSettings] = await Promise.all([
      prisma.restorePoint.findFirst({
        where: { shop: TEST_SHOP, status: "READY" },
        orderBy: { createdAt: "desc" },
      }),
      prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } }),
    ]);

    const schedule = shopSettings?.autoBackupSchedule || "DAILY";
    const preferredTime = shopSettings?.autoBackupTime || "02:00";
    const lastBackupAt = shopSettings?.lastAutoBackupAt || latestRp?.createdAt || null;
    const nextBackupAt = shopSettings?.nextAutoBackupAt || computeNextAutoBackup(schedule, preferredTime);

    const backupCadence = {
      schedule,
      preferredTime,
      lastBackupAt: lastBackupAt ? lastBackupAt.toISOString() : null,
      nextBackupAt: nextBackupAt ? nextBackupAt.toISOString() : null,
      cloudSync: {
        connected: Boolean(shopSettings?.cloudSyncConnected),
        provider: shopSettings?.cloudSyncProvider || "NONE",
        email: shopSettings?.cloudSyncEmail || null,
        folder: shopSettings?.cloudSyncFolder || "Revertly_Backups",
      },
    };

    assert(backupCadence.schedule === "DAILY", "Dashboard loader reports DAILY cadence");
    assert(backupCadence.preferredTime === "02:00", "Dashboard loader reports preferredTime 02:00 UTC");
    assert(backupCadence.lastBackupAt !== null, "Dashboard loader found latest safe snapshot timestamp");
    assert(backupCadence.nextBackupAt !== null, "Dashboard loader calculated next scheduled backup timestamp");
    assert(backupCadence.cloudSync.connected === true, "Dashboard loader identifies cloud sync as CONNECTED");
    assert(backupCadence.cloudSync.provider === "GOOGLE_DRIVE", "Dashboard loader identifies provider as GOOGLE_DRIVE");

    console.log("\n==========================================================");
    console.log(`🎉 ALL SIMULATION TESTS PASSED: ${passedTests}/${totalTests} tests successful!`);
    console.log("==========================================================");
  } catch (err) {
    console.error("\n❌ SIMULATION TEST FAILED:", err);
    process.exit(1);
  } finally {
    // Clean up mock store
    await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.$disconnect();
  }
}

runSimulation();
