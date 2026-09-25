import { strict as assert } from "node:assert";
import prisma from "../app/db.server.js";
import { loader, action } from "../app/routes/app.trust.jsx";
import { setMockShop } from "./_qa_mock_admin.mjs";

const TEST_SHOP = "qa-trust-center-verification.myshopify.com";

async function runTrustPageVerification() {
  setMockShop(TEST_SHOP);
  console.log("===============================================================");
  console.log("🛡️  STARTING TRUST CENTER (/app/trust) QA FLOW VERIFICATION");
  console.log("===============================================================\n");

  // Setup test store in database
  await prisma.appSettings.upsert({
    where: { shop: TEST_SHOP },
    update: {
      planId: "enterprise",
      monitoringEnabled: true,
      circuitBreakerEnabled: true,
      cloudSyncConnected: true,
      cloudSyncProvider: "GOOGLE_DRIVE",
    },
    create: {
      shop: TEST_SHOP,
      planId: "enterprise",
      monitoringEnabled: true,
      circuitBreakerEnabled: true,
      cloudSyncConnected: true,
      cloudSyncProvider: "GOOGLE_DRIVE",
    },
  });

  // Create audit log event
  await prisma.auditLog.create({
    data: {
      shop: TEST_SHOP,
      userName: "Store Owner",
      userEmail: "owner@example.com",
      action: "SECURITY_VERIFY",
      resourceType: "System",
      resourceId: "0",
      details: JSON.stringify({ verified: true }),
    },
  });

  // Create a sample restore point
  await prisma.restorePoint.create({
    data: {
      shop: TEST_SHOP,
      name: "Trust Verification Snapshot",
      status: "READY",
      backupType: "FULL_STORE",
      productCount: 15,
      collectionCount: 2,
    },
  });

  // Mock Request with session
  const mockReq = new Request(`https://${TEST_SHOP}/app/trust`, {
    headers: {
      cookie: "mock_session=1",
    },
  });

  console.log("▶ [1] Testing loader data resolution...");
  const loaderData = await loader({ request: mockReq });

  assert.equal(loaderData.shop, TEST_SHOP, "Shop matches test shop");
  assert.equal(loaderData.planTier, "enterprise", "Plan tier resolves to enterprise");
  assert.equal(loaderData.circuitBreakerEnabled, true, "Circuit breaker is enabled on enterprise");
  assert.equal(loaderData.cloudSyncConnected, true, "Cloud sync is connected");
  assert.equal(loaderData.cloudSyncProvider, "GOOGLE_DRIVE", "Cloud sync provider is GOOGLE_DRIVE");
  assert.ok(loaderData.auditCount >= 1, "Audit count reflects logged events");
  assert.ok(loaderData.readyPointsCount >= 1, "Ready restore points count is retrieved");
  assert.ok(loaderData.installedDate, "Installed date is present");
  console.log("  ✓ Loader data contains all enriched trust metrics & plan tier");

  console.log("\n▶ [2] Testing action: runSecurityAudit flow...");
  const formData = new FormData();
  formData.append("intent", "runSecurityAudit");
  const actionReq = new Request(`https://${TEST_SHOP}/app/trust`, {
    method: "POST",
    body: formData,
  });

  const actionRes = await action({ request: actionReq });
  assert.equal(actionRes.success, true, "Security audit returns success: true");
  assert.ok(actionRes.auditedAt, "Security audit returns timestamp");
  assert.ok(actionRes.message.includes("AES-256-GCM"), "Message confirms encryption");
  assert.ok(actionRes.message.includes("TLS 1.3"), "Message confirms TLS 1.3");
  console.log("  ✓ Action runSecurityAudit runs successfully with live verification report");

  console.log("\n▶ [3] Testing Free plan downgrade gating in loader...");
  await prisma.appSettings.update({
    where: { shop: TEST_SHOP },
    data: { planId: "free" },
  });

  const freeLoaderData = await loader({ request: mockReq });
  assert.equal(freeLoaderData.planTier, "free", "Plan tier resolves to free");
  assert.equal(freeLoaderData.circuitBreakerEnabled, false, "Circuit breaker gated to false on free");
  assert.equal(freeLoaderData.cloudSyncConnected, false, "Cloud sync gated to false on free");
  console.log("  ✓ Downgraded store properly gates circuitBreaker and cloudSync flags");

  // Cleanup test records
  await prisma.auditLog.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });

  console.log("\n===============================================================");
  console.log("🎉 ALL TRUST CENTER (/app/trust) VERIFICATIONS PASSED (100%)");
  console.log("===============================================================");
}

runTrustPageVerification().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
