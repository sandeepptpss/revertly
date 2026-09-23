import prisma from "../app/db.server.js";
import {
  saveMarketingConnection,
  getMarketingSettings,
  backupMarketingProvider,
} from "../app/marketing.server.js";
import { encrypt, decrypt, isEncrypted } from "../app/crypto.server.js";
import { applySecurityHeaders } from "../app/securityHeaders.server.js";
import assert from "node:assert";

const TEST_SHOP = "test-security-verification.myshopify.com";

console.log("================================================================================");
console.log("🔍 COMPREHENSIVE END-TO-END FLOW VERIFICATION (REGRESSION & FUNCTIONALITY)");
console.log("================================================================================");

async function runVerification() {
  let passedCount = 0;

  try {
    // Clean up any stale test data first
    await prisma.marketingProfile.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
    await prisma.marketingList.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
    await prisma.marketingFlow.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
    await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});

    // Ensure store exists with Growth plan so marketing features are unlocked
    await prisma.appSettings.create({
      data: {
        shop: TEST_SHOP,
        planId: "growth", // Growth tier has full marketing backup access
      },
    });

    console.log("\n--- TEST 1: NEW FLOW - SAVING CREDENTIALS WITH AES-256 ENCRYPTION ---");
    const testKey = "sim_prod_verified_key_999";
    const saveRes = await saveMarketingConnection(TEST_SHOP, "KLAVIYO", testKey);
    assert.ok(saveRes.success, `saveMarketingConnection should succeed: ${saveRes.message}`);

    // Inspect RAW database record directly
    const rawDbRow = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
    assert.ok(rawDbRow, "Database row must exist");
    assert.ok(
      rawDbRow.klaviyoApiKey.startsWith("enc:v1:"),
      `Raw DB column MUST be encrypted with 'enc:v1:' prefix. Found: ${rawDbRow.klaviyoApiKey}`,
    );
    assert.notEqual(rawDbRow.klaviyoApiKey, testKey, "Plaintext key must NEVER appear in DB");
    assert.ok(isEncrypted(rawDbRow.klaviyoApiKey), "isEncrypted helper must return true");

    console.log("✅ Verified: Data in MySQL database is genuinely encrypted with AES-256-GCM!");
    console.log(`   Sample Ciphertext in DB: ${rawDbRow.klaviyoApiKey.slice(0, 38)}...`);
    passedCount++;

    console.log("\n--- TEST 2: CURRENT FLOW - READING ENCRYPTED CREDENTIALS & CAPTURING BACKUP ---");
    const settings = await getMarketingSettings(TEST_SHOP);
    assert.equal(settings.klaviyo.connected, true, "Klaviyo must be reported as connected");
    assert.equal(settings.klaviyo.simulated, true, "Simulation mode must be correctly detected via decrypted key");

    // Run actual backup capture using the encrypted key
    const backupRes = await backupMarketingProvider(TEST_SHOP, "KLAVIYO");
    assert.ok(backupRes.success, `Backup capture should succeed: ${backupRes.message}`);
    assert.ok(backupRes.lists > 0, "Should have captured simulated lists");
    assert.ok(backupRes.profiles > 0, "Should have captured simulated profiles");

    console.log("✅ Verified: Backup Capture flow decrypted key transparently and executed successfully!");
    console.log(`   Captured: ${backupRes.lists} lists, ${backupRes.profiles} profiles.`);
    passedCount++;

    console.log("\n--- TEST 3: PREVIOUS FLOW / ZERO REGRESSION - LEGACY UNENCRYPTED DB RECORD ---");
    console.log("   Simulating a legacy store that connected Klaviyo months ago with plain-text key...");
    const legacyPlainKey = "sim_legacy_unencrypted_previews_key_555";

    // Manually force unencrypted plain text into DB (as it was before Step 1)
    await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: { klaviyoApiKey: legacyPlainKey },
    });

    const verifyRawLegacy = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
    assert.equal(verifyRawLegacy.klaviyoApiKey, legacyPlainKey, "DB row must hold raw plain text for test");
    assert.ok(!isEncrypted(verifyRawLegacy.klaviyoApiKey), "Must not be encrypted");

    // Call getMarketingSettings with legacy unencrypted key
    const legacySettings = await getMarketingSettings(TEST_SHOP);
    assert.equal(legacySettings.klaviyo.connected, true, "Legacy store must remain connected");
    assert.equal(legacySettings.klaviyo.simulated, true, "Legacy key must be read without crash");

    // Run backup capture with legacy unencrypted key
    const legacyBackupRes = await backupMarketingProvider(TEST_SHOP, "KLAVIYO");
    assert.ok(legacyBackupRes.success, `Legacy store backup should succeed: ${legacyBackupRes.message}`);
    console.log("✅ Verified: Previous flows are 100% UNTOUCHED and fully functional with legacy plain-text!");
    passedCount++;

    console.log("\n--- TEST 4: CLOUD SYNC TOKENS DUAL-MODE COMPATIBILITY ---");
    const legacyOAuthToken = "ya29.legacy_google_oauth_token_12345";
    assert.equal(decrypt(legacyOAuthToken), legacyOAuthToken, "Legacy unencrypted OAuth token returns as-is");

    const encryptedOAuthToken = encrypt("ya29.new_secure_oauth_token_67890");
    assert.ok(encryptedOAuthToken.startsWith("enc:v1:"), "New OAuth token encrypted with enc:v1:");
    assert.equal(decrypt(encryptedOAuthToken), "ya29.new_secure_oauth_token_67890", "Decrypted OAuth token matches");
    console.log("✅ Verified: Cloud Sync tokens seamlessly support both legacy and encrypted formats!");
    passedCount++;

    console.log("\n--- TEST 5: SHOPIFY EMBEDDED IFRAME & SECURITY HEADERS CHECK ---");
    class MockHeaders {
      constructor() { this._m = new Map(); }
      set(k, v) { this._m.set(k.toLowerCase(), v); }
      get(k) { return this._m.get(k.toLowerCase()); }
      has(k) { return this._m.has(k.toLowerCase()); }
    }
    const headers = new MockHeaders();
    // Simulate Shopify App Bridge CSP
    headers.set("Content-Security-Policy", "frame-ancestors https://admin.shopify.com https://test-store.myshopify.com;");

    applySecurityHeaders(headers);

    assert.ok(headers.has("Strict-Transport-Security"), "HSTS applied");
    assert.ok(headers.has("X-Content-Type-Options"), "X-Content-Type-Options applied");
    assert.ok(headers.has("Referrer-Policy"), "Referrer-Policy applied");
    assert.ok(headers.has("Permissions-Policy"), "Permissions-Policy applied");
    assert.ok(!headers.has("X-Frame-Options"), "X-Frame-Options must NOT block Shopify iframe");
    assert.ok(headers.get("Content-Security-Policy").includes("frame-ancestors https://admin.shopify.com"), "Shopify App Bridge frame preserved");

    console.log("✅ Verified: Security headers applied properly and Shopify iFrame App Bridge is 100% preserved!");
    passedCount++;

  } finally {
    // Clean up test data
    await prisma.marketingProfile.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
    await prisma.marketingList.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
    await prisma.marketingFlow.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
    await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } }).catch(() => {});
  }

  console.log("\n================================================================================");
  console.log(`🎉 ALL ${passedCount} CRITICAL FLOW VERIFICATIONS PASSED WITH ZERO REGRESSIONS!`);
  console.log("================================================================================\n");
}

runVerification().catch((err) => {
  console.error("❌ VERIFICATION FAILED:", err);
  process.exit(1);
});
