process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "mock-shopify-secret-for-tests";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

import assert from "node:assert";
import {
  createLaunchToken,
  verifyLaunchToken,
  cloudCallbackUrl,
  buildAuthorizeUrl,
} from "../app/cloudOAuth.server.js";

async function run() {
  console.log("▶ Testing Cloud OAuth Launch and URL Generation...");
  const shop = "quickstart-749ac396.myshopify.com";

  // 1. Launch token tests
  const gdToken = createLaunchToken(shop, "GOOGLE_DRIVE");
  const verifiedGd = verifyLaunchToken(gdToken, "GOOGLE_DRIVE");
  assert.strictEqual(verifiedGd.shop, shop, "Verified Google Drive launch token shop matches");
  assert.strictEqual(verifiedGd.provider, "GOOGLE_DRIVE", "Verified Google Drive launch token provider matches");

  const dbToken = createLaunchToken(shop, "DROPBOX");
  const verifiedDb = verifyLaunchToken(dbToken, "DROPBOX");
  assert.strictEqual(verifiedDb.shop, shop, "Verified Dropbox launch token shop matches");
  assert.strictEqual(verifiedDb.provider, "DROPBOX", "Verified Dropbox launch token provider matches");

  // Tampered launch token should fail
  assert.throws(() => verifyLaunchToken(gdToken + "tamper", "GOOGLE_DRIVE"), /signature is invalid/);
  // Provider mismatch should fail
  assert.throws(() => verifyLaunchToken(gdToken, "DROPBOX"), /does not match the requested provider/);
  console.log("  ✓ Launch tokens create, verify, and reject tampering");

  // 2. Callback URLs
  const gdCallback = cloudCallbackUrl("GOOGLE_DRIVE");
  assert(gdCallback.startsWith("http"), `Callback URL must be absolute: ${gdCallback}`);
  assert(gdCallback.endsWith("/auth/cloud/google_drive/callback"), `Callback URL must end with expected path: ${gdCallback}`);

  const dbCallback = cloudCallbackUrl("DROPBOX");
  assert(dbCallback.startsWith("http"), `Callback URL must be absolute: ${dbCallback}`);
  assert(dbCallback.endsWith("/auth/cloud/dropbox/callback"), `Callback URL must end with expected path: ${dbCallback}`);
  console.log("  ✓ Callback URLs are absolute and properly formatted");

  // 3. Google Drive Authorize URL
  const gdAuthUrl = buildAuthorizeUrl(shop, "GOOGLE_DRIVE");
  const parsedGd = new URL(gdAuthUrl);
  assert.strictEqual(parsedGd.origin, "https://accounts.google.com");
  assert.strictEqual(parsedGd.pathname, "/o/oauth2/v2/auth");
  assert.strictEqual(parsedGd.searchParams.get("response_type"), "code");
  assert.strictEqual(parsedGd.searchParams.get("access_type"), "offline");
  assert.strictEqual(parsedGd.searchParams.get("prompt"), "consent");
  assert.strictEqual(parsedGd.searchParams.get("redirect_uri"), gdCallback);
  assert(parsedGd.searchParams.get("state"), "State parameter must be present");
  console.log("  ✓ Google Drive authorize URL is fully constructed with offline consent & state");

  // 4. Dropbox Authorize URL
  const dbAuthUrl = buildAuthorizeUrl(shop, "DROPBOX");
  const parsedDb = new URL(dbAuthUrl);
  assert.strictEqual(parsedDb.origin, "https://www.dropbox.com");
  assert.strictEqual(parsedDb.pathname, "/oauth2/authorize");
  assert.strictEqual(parsedDb.searchParams.get("response_type"), "code");
  assert.strictEqual(parsedDb.searchParams.get("token_access_type"), "offline");
  assert.strictEqual(parsedDb.searchParams.get("redirect_uri"), dbCallback);
  assert(parsedDb.searchParams.get("state"), "State parameter must be present");
  console.log("  ✓ Dropbox authorize URL is fully constructed with token_access_type=offline & state");

  // 5. Live request against running dev server on localhost:44499
  try {
    const respGd = await fetch(`http://127.0.0.1:44499/auth/cloud/google_drive?token=${encodeURIComponent(gdToken)}`, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    assert.strictEqual(respGd.status, 302, `Expected 302 redirect for Google Drive, got ${respGd.status}`);
    const locationGd = respGd.headers.get("location");
    assert(locationGd && locationGd.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), `Redirect location must point to Google: ${locationGd}`);
    console.log("  ✓ Live test: /auth/cloud/google_drive with launch token returns 302 redirecting to Google OAuth!");

    const respDb = await fetch(`http://127.0.0.1:44499/auth/cloud/dropbox?token=${encodeURIComponent(dbToken)}`, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    assert.strictEqual(respDb.status, 302, `Expected 302 redirect for Dropbox, got ${respDb.status}`);
    const locationDb = respDb.headers.get("location");
    assert(locationDb && locationDb.startsWith("https://www.dropbox.com/oauth2/authorize"), `Redirect location must point to Dropbox: ${locationDb}`);
    console.log("  ✓ Live test: /auth/cloud/dropbox with launch token returns 302 redirecting to Dropbox OAuth!");
  } catch (err) {
    console.error("Live dev server request failed:", err.message);
    throw err;
  }

  console.log("\n🎉 All Cloud OAuth Flow verification checks PASSED!");
}

run().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
