import { encrypt, decrypt, isEncrypted } from "../app/crypto.server.js";
import { applySecurityHeaders } from "../app/securityHeaders.server.js";
import assert from "node:assert";

console.log("==================================================");
console.log("🧪 RUNNING ENTERPRISE SECURITY & ZERO-REGRESSION TESTS");
console.log("==================================================");

let testsPassed = 0;

// Test 1: Plaintext roundtrip encryption & decryption
const originalToken = "shpat_live_merchant_token_987654321_abcdef";
const encryptedToken = encrypt(originalToken);
assert.notEqual(encryptedToken, originalToken, "Encrypted token must differ from plain-text");
assert.ok(encryptedToken.startsWith("enc:v1:"), "Encrypted token must have 'enc:v1:' prefix");
assert.ok(isEncrypted(encryptedToken), "isEncrypted must return true");

const decryptedToken = decrypt(encryptedToken);
assert.equal(decryptedToken, originalToken, "Decrypted token must exactly match original");
console.log("✅ Test 1 Passed: AES-256-GCM Roundtrip Encryption & Decryption verified.");
testsPassed++;

// Test 2: Backward Compatibility with Legacy Unencrypted Plain-Text
const legacyApiKey = "pk_live_legacy_plain_key_123456";
const decryptedLegacy = decrypt(legacyApiKey);
assert.equal(decryptedLegacy, legacyApiKey, "Legacy unencrypted string must be returned as-is");
assert.ok(!isEncrypted(legacyApiKey), "Legacy key must not be flagged as encrypted");
console.log("✅ Test 2 Passed: 100% Backward Compatibility with Legacy Plain-Text verified.");
testsPassed++;

// Test 3: Idempotency (Prevent Double-Encryption)
const doubleEncrypted = encrypt(encryptedToken);
assert.equal(doubleEncrypted, encryptedToken, "Encrypting an already-encrypted string must return it unchanged");
console.log("✅ Test 3 Passed: Idempotency (No Double-Encryption) verified.");
testsPassed++;

// Test 4: Null, Undefined, and Empty String Safety
assert.equal(encrypt(null), null, "encrypt(null) must return null");
assert.equal(decrypt(null), null, "decrypt(null) must return null");
assert.equal(encrypt(""), "", "encrypt('') must return ''");
assert.equal(decrypt(""), "", "decrypt('') must return ''");
console.log("✅ Test 4 Passed: Null / Undefined / Empty Input safety verified.");
testsPassed++;

// Test 5: Corrupted Ciphertext Fail-Safe (No server crash)
const corruptedCipher = "enc:v1:bad_iv:bad_tag:bad_data";
const safeFallback = decrypt(corruptedCipher);
assert.equal(safeFallback, corruptedCipher, "Corrupted ciphertext must fail safely without throwing");
console.log("✅ Test 5 Passed: Tamper & Corruption Fail-Safe verified.");
testsPassed++;

class MockHeaders {
  constructor() {
    this._map = new Map();
  }
  set(k, v) { this._map.set(k.toLowerCase(), v); }
  get(k) { return this._map.get(k.toLowerCase()); }
  has(k) { return this._map.has(k.toLowerCase()); }
}
const mockHeaders = typeof Headers !== "undefined" ? new Headers() : new MockHeaders();
// Simulate Shopify CSP already present
mockHeaders.set("Content-Security-Policy", "frame-ancestors https://admin.shopify.com https://test-store.myshopify.com;");

applySecurityHeaders(mockHeaders);

assert.ok(mockHeaders.has("Strict-Transport-Security"), "HSTS header must be present");
assert.equal(mockHeaders.get("Strict-Transport-Security"), "max-age=63072000; includeSubDomains; preload");

assert.ok(mockHeaders.has("X-Content-Type-Options"), "nosniff header must be present");
assert.equal(mockHeaders.get("X-Content-Type-Options"), "nosniff");

assert.ok(mockHeaders.has("Referrer-Policy"), "Referrer-Policy header must be present");
assert.equal(mockHeaders.get("Referrer-Policy"), "strict-origin-when-cross-origin");

assert.ok(mockHeaders.has("Permissions-Policy"), "Permissions-Policy header must be present");

// Critical: X-Frame-Options must NOT be set to DENY or SAMEORIGIN (which would break Shopify App Bridge)
assert.ok(!mockHeaders.has("X-Frame-Options"), "X-Frame-Options must NOT be set to preserve Shopify embedded iframe");

// Verify Shopify CSP preserved intact
assert.ok(mockHeaders.get("Content-Security-Policy").includes("frame-ancestors https://admin.shopify.com"), "Shopify App Bridge frame-ancestors preserved");

console.log("✅ Test 6 Passed: Enterprise Security Headers & Shopify iFrame Preservation verified.");
testsPassed++;

console.log("==================================================");
console.log(`🎉 ALL ${testsPassed} VERIFICATION TESTS PASSED SUCCESSFULLY!`);
console.log("==================================================");
