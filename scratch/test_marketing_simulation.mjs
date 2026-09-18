import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  checkMarketingAccess,
  saveMarketingConnection,
  disconnectMarketingProvider,
  backupMarketingProvider,
  restoreMarketingList,
  reimportMarketingSubscribers,
  getMarketingStats,
  generateMarketingProfilesCsv,
} from "../app/marketing.server.js";

const TEST_SHOP = "marketing-simulation-qa.myshopify.com";

async function run() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  REVERTLY EMAIL MARKETING (ESP) BACKUP SIMULATION SUITE");
  console.log("════════════════════════════════════════════════════════════════\n");

  let passed = 0;
  function pass(msg) {
    console.log(`  ✅ [PASS] ${msg}`);
    passed++;
  }

  try {
    // 0. Clean up test shop
    await prisma.marketingFlow.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.marketingProfile.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.marketingList.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });

    console.log("▶ [SUITE 1] Plan Access Gating for Marketing Backups");

    // Free plan: Should be blocked
    await prisma.appSettings.create({
      data: { shop: TEST_SHOP, planId: "free" },
    });
    const freeAccess = await checkMarketingAccess(TEST_SHOP);
    assert.strictEqual(freeAccess.allowed, false, "Free plan must not have marketing access");
    pass("Free plan correctly blocked from Email Marketing backups");

    // Growth plan: Allowed, 10,000 profiles, flows locked
    await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: { planId: "growth" },
    });
    const growthAccess = await checkMarketingAccess(TEST_SHOP);
    assert.strictEqual(growthAccess.allowed, true, "Growth plan has marketing access");
    assert.strictEqual(growthAccess.maxProfiles, 10000, "Growth plan cap is 10,000 profiles");
    assert.strictEqual(growthAccess.flowsIncluded, false, "Growth plan does not include automated flows");
    pass("Growth plan has 10k profile cap and locked flows");

    // Business plan: Allowed, 50,000 profiles, flows included
    await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: { planId: "business" },
    });
    const bizAccess = await checkMarketingAccess(TEST_SHOP);
    assert.strictEqual(bizAccess.allowed, true);
    assert.strictEqual(bizAccess.maxProfiles, 50000);
    assert.strictEqual(bizAccess.flowsIncluded, true);
    pass("Business plan has 50k profile cap and includes automated flows");

    console.log("\n▶ [SUITE 2] Simulated Provider Connection Handshake");

    // Connect simulated Klaviyo
    const klConn = await saveMarketingConnection(TEST_SHOP, "KLAVIYO", "sim_klaviyo_test_secret");
    assert.strictEqual(klConn.success, true);
    assert.strictEqual(klConn.simulated, true);
    assert.strictEqual(klConn.accountName, "Klaviyo Simulator");

    const settingsAfterKl = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
    assert.strictEqual(settingsAfterKl.klaviyoConnected, true);
    assert.strictEqual(settingsAfterKl.klaviyoAccountName, "Klaviyo Simulator");
    pass("Klaviyo simulation connection saved successfully");

    // Connect simulated Mailchimp
    const mcConn = await saveMarketingConnection(TEST_SHOP, "MAILCHIMP", "sim_mailchimp_key-us21");
    assert.strictEqual(mcConn.success, true);
    assert.strictEqual(mcConn.simulated, true);
    assert.strictEqual(mcConn.accountName, "Mailchimp Simulator");

    const settingsAfterMc = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
    assert.strictEqual(settingsAfterMc.mailchimpConnected, true);
    assert.strictEqual(settingsAfterMc.mailchimpAccountName, "Mailchimp Simulator");
    assert.strictEqual(settingsAfterMc.mailchimpServerPrefix, "sim");
    pass("Mailchimp simulation connection saved with simulator prefix");

    console.log("\n▶ [SUITE 3] ESP Backup Capture (Lists, Profiles, Flows)");

    // Run Klaviyo Backup
    const klBackup = await backupMarketingProvider(TEST_SHOP, "KLAVIYO");
    assert.strictEqual(klBackup.success, true);
    assert.strictEqual(klBackup.provider, "KLAVIYO");
    assert.ok(klBackup.counts.lists > 0, "Should capture lists");
    assert.ok(klBackup.counts.profiles > 0, "Should capture profiles");
    assert.ok(klBackup.counts.flows > 0, "Should capture flows on Business plan");
    pass(`Klaviyo backup captured ${klBackup.counts.lists} lists, ${klBackup.counts.segments} segments, ${klBackup.counts.profiles} profiles, ${klBackup.counts.flows} flows`);

    // Run Mailchimp Backup
    const mcBackup = await backupMarketingProvider(TEST_SHOP, "MAILCHIMP");
    assert.strictEqual(mcBackup.success, true);
    assert.strictEqual(mcBackup.provider, "MAILCHIMP");
    assert.ok(mcBackup.counts.lists > 0);
    assert.ok(mcBackup.counts.profiles > 0);
    pass(`Mailchimp backup captured ${mcBackup.counts.lists} lists, ${mcBackup.counts.segments} segments, ${mcBackup.counts.profiles} profiles`);

    // Verify re-running backup updates in place rather than duplicating
    const initialProfilesCount = await prisma.marketingProfile.count({ where: { shop: TEST_SHOP } });
    await backupMarketingProvider(TEST_SHOP, "KLAVIYO");
    const afterRerunCount = await prisma.marketingProfile.count({ where: { shop: TEST_SHOP } });
    assert.strictEqual(afterRerunCount, initialProfilesCount, "Upsert by remote ID must prevent duplicate rows");
    pass("Re-running backup idempotently updates in place without duplicating records");

    console.log("\n▶ [SUITE 4] Stats & Dashboard Querying");

    const stats = await getMarketingStats(TEST_SHOP);
    assert.strictEqual(stats.lists, klBackup.counts.lists + mcBackup.counts.lists);
    assert.strictEqual(stats.segments, klBackup.counts.segments + mcBackup.counts.segments);
    assert.strictEqual(stats.profiles, klBackup.counts.profiles + mcBackup.counts.profiles);
    assert.strictEqual(stats.flows, klBackup.counts.flows + mcBackup.counts.flows);
    assert.strictEqual(stats.klaviyo.connected, true);
    assert.strictEqual(stats.mailchimp.connected, true);
    pass("Marketing statistics and counts match captured archives exactly");

    console.log("\n▶ [SUITE 5] Restoration, Re-import & CSV Portability");

    // Restore a list
    const sampleList = await prisma.marketingList.findFirst({ where: { shop: TEST_SHOP, provider: "KLAVIYO" } });
    assert.ok(sampleList, "Sample list must exist");
    const listRestore = await restoreMarketingList(TEST_SHOP, sampleList.id);
    assert.strictEqual(listRestore.success, true);
    assert.strictEqual(listRestore.simulated, true);
    pass(`Restore list "${sampleList.name}" executed successfully in simulation mode`);

    // Reimport subscribers
    const subRestore = await reimportMarketingSubscribers(TEST_SHOP, sampleList.id);
    assert.strictEqual(subRestore.success, true);
    assert.strictEqual(subRestore.simulated, true);
    assert.ok(subRestore.imported > 0);
    pass(`Re-import subscribers to "${sampleList.name}" simulated push of ${subRestore.imported} contacts`);

    // Export CSV portability test
    const profilesToExport = await prisma.marketingProfile.findMany({ where: { shop: TEST_SHOP }, take: 5 });
    const csvContent = generateMarketingProfilesCsv(profilesToExport);
    assert.ok(csvContent.includes("Provider,Profile ID,Email"), "CSV must include correct headers");
    assert.ok(csvContent.includes("KLAVIYO"), "CSV must contain exported Klaviyo data");
    pass("Marketing profiles CSV portability export generated cleanly");

    console.log("\n▶ [SUITE 6] Safe Disconnection without Data Loss");

    // Disconnect Klaviyo
    const disc = await disconnectMarketingProvider(TEST_SHOP, "KLAVIYO");
    assert.strictEqual(disc.success, true);

    const postDiscSettings = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
    assert.strictEqual(postDiscSettings.klaviyoConnected, false);
    assert.strictEqual(postDiscSettings.klaviyoApiKey, null);

    // Verify archives remain untouched
    const postDiscListCount = await prisma.marketingList.count({ where: { shop: TEST_SHOP, provider: "KLAVIYO" } });
    assert.ok(postDiscListCount > 0, "Existing archives must be safely preserved after key rotation / disconnection");
    pass("Disconnecting provider safely clears credentials while preserving all backup archives");

    console.log("\n================================================================");
    console.log(`  🎉 ALL ${passed}/${passed} EMAIL MARKETING SIMULATION TESTS PASSED! (100%)`);
    console.log("================================================================");
  } catch (err) {
    console.error("❌ Marketing simulation failed:", err);
    process.exit(1);
  } finally {
    // Cleanup mock store
    await prisma.marketingFlow.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.marketingProfile.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.marketingList.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
    await prisma.$disconnect();
  }
}

run();
