import assert from "node:assert";
import {
  PLAN_TIERS,
  PLAN_LIMITS,
  normalizePlanId,
  getPlanLimits,
  checkRestorePointLimit,
  checkRuleLimit,
  checkVaultAccess,
  checkFeatureAccess,
} from "../app/billing.server.js";
import prisma from "../app/db.server.js";
import fs from "node:fs";

console.log("=== STARTING PLANS & BILLING QA VERIFICATION SUITE ===\n");

let passedTests = 0;
let totalTests = 0;

function it(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     Error: ${err.message}`);
  }
}

async function itAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     Error: ${err.message}`);
  }
}

// ── Test 1: Plan Tiers & Hierarchy ──────────────────────────────────────────
console.log("1. Plan Tiers & Hierarchy:");
it("Contains exactly 5 tiers in correct pricing order", () => {
  assert.strictEqual(Object.keys(PLAN_TIERS).length, 5);
  assert.strictEqual(PLAN_TIERS.free.price, 0);
  assert.strictEqual(PLAN_TIERS.starter.price, 9);
  assert.strictEqual(PLAN_TIERS.growth.price, 24);
  assert.strictEqual(PLAN_TIERS.business.price, 49);
  assert.strictEqual(PLAN_TIERS.enterprise.price, 99);
  assert(PLAN_TIERS.free.order < PLAN_TIERS.starter.order);
  assert(PLAN_TIERS.starter.order < PLAN_TIERS.growth.order);
  assert(PLAN_TIERS.growth.order < PLAN_TIERS.business.order);
  assert(PLAN_TIERS.business.order < PLAN_TIERS.enterprise.order);
});

it("normalizePlanId normalizes aliases and invalid IDs", () => {
  assert.strictEqual(normalizePlanId("pro"), "growth");
  assert.strictEqual(normalizePlanId("PRO"), "growth");
  assert.strictEqual(normalizePlanId("Growth"), "growth");
  assert.strictEqual(normalizePlanId("invalid-plan"), "free");
  assert.strictEqual(normalizePlanId(null), "free");
});

// ── Test 2: Plan Limits Configuration ───────────────────────────────────────
console.log("\n2. Plan Limits Validation:");
it("Free plan has strict basic limits (100 products, 2 restore points, 1 rule)", () => {
  const limits = getPlanLimits("free");
  assert.strictEqual(limits.products, 100);
  assert.strictEqual(limits.restorePoints, 2);
  assert.strictEqual(limits.rules, 1);
  assert.strictEqual(limits.retentionDays, 7);
  assert.strictEqual(limits.vaultOrders, 0);
  assert.strictEqual(limits.themes, false);
  assert.strictEqual(limits.circuitBreaker, false);
  assert.strictEqual(limits.slack, false);
});

it("Starter plan limits (1000 products, 10 restore points, 3 rules, 30d retention)", () => {
  const limits = getPlanLimits("starter");
  assert.strictEqual(limits.products, 1000);
  assert.strictEqual(limits.restorePoints, 10);
  assert.strictEqual(limits.rules, 3);
  assert.strictEqual(limits.retentionDays, 30);
  assert.strictEqual(limits.vaultOrders, 0);
  assert.strictEqual(limits.themes, false);
  assert.strictEqual(limits.circuitBreaker, false);
});

it("Growth plan limits (5000 products, 50 restore points, 10 rules, 2500 vault orders)", () => {
  const limits = getPlanLimits("growth");
  assert.strictEqual(limits.products, 5000);
  assert.strictEqual(limits.restorePoints, 50);
  assert.strictEqual(limits.rules, 10);
  assert.strictEqual(limits.retentionDays, 90);
  assert.strictEqual(limits.vaultOrders, 2500);
  assert.strictEqual(limits.bulkRollback, true);
});

it("Business plan limits (30000 products, 100 restore points, unlimited rules, themes, slack, circuit breaker)", () => {
  const limits = getPlanLimits("business");
  assert.strictEqual(limits.products, 30000);
  assert.strictEqual(limits.restorePoints, 100);
  assert.strictEqual(limits.rules, Infinity);
  assert.strictEqual(limits.retentionDays, 180);
  assert.strictEqual(limits.vaultOrders, 15000);
  assert.strictEqual(limits.themes, true);
  assert.strictEqual(limits.circuitBreaker, true);
  assert.strictEqual(limits.slack, true);
});

it("Enterprise plan limits (200000 products, unlimited restore points, 365d retention)", () => {
  const limits = getPlanLimits("enterprise");
  assert.strictEqual(limits.products, 200000);
  assert.strictEqual(limits.restorePoints, Infinity);
  assert.strictEqual(limits.rules, Infinity);
  assert.strictEqual(limits.retentionDays, 365);
  assert.strictEqual(limits.vaultOrders, 100000);
  assert.strictEqual(limits.themes, true);
  assert.strictEqual(limits.circuitBreaker, true);
  assert.strictEqual(limits.slack, true);
});

// ── Test 3: Shopify Server Billing Config File Inspection ─────────────────────
console.log("\n3. Shopify Billing Config & Trial Days Inspection:");
it("shopify.server.js contains 14-day free trial on all paid plans", () => {
  const content = fs.readFileSync("./app/shopify.server.js", "utf8");
  assert(content.includes("trialDays: 14"), "trialDays: 14 missing from shopify.server.js");
  assert(content.includes("BillingReplacementBehavior.ApplyImmediately"), "ApplyImmediately missing");
  assert(content.includes("amount: 9"), "Starter $9 missing");
  assert(content.includes("amount: 24"), "Growth $24 missing");
  assert(content.includes("amount: 49"), "Business $49 missing");
  assert(content.includes("amount: 99"), "Enterprise $99 missing");
});

// ── Test 4: Webhook Registration Inspection ───────────────────────────────────
console.log("\n4. Webhook Registration Inspection:");
it("shopify.app.toml registers app_subscriptions/update", () => {
  const toml = fs.readFileSync("./shopify.app.toml", "utf8");
  assert(toml.includes('topics = [ "app_subscriptions/update" ]'), "Webhook topic missing from shopify.app.toml");
  assert(toml.includes('uri = "/webhooks/app_subscriptions/update"'), "Webhook uri missing from shopify.app.toml");
});

it("webhooks.app_subscriptions.update.jsx exists and exports an action", () => {
  assert(fs.existsSync("./app/routes/webhooks.app_subscriptions.update.jsx"));
  const code = fs.readFileSync("./app/routes/webhooks.app_subscriptions.update.jsx", "utf8");
  assert(code.includes("export const action = async"), "action function not exported");
});

// ── Test 5: End-to-End Entitlement & Database Enforcements ────────────────────
console.log("\n5. Database Entitlements & Gating Checks:");
async function runAsyncTests() {
  const testShop = "billing-simulation-store.myshopify.com";

  // Test with Free plan
  await prisma.appSettings.upsert({
    where: { shop: testShop },
    create: { shop: testShop, planId: "free" },
    update: { planId: "free" },
  });

  await itAsync("Free Plan: checkVaultAccess returns allowed: false", async () => {
    const access = await checkVaultAccess(testShop);
    assert.strictEqual(access.allowed, false);
    assert.strictEqual(access.plan, "free");
  });

  await itAsync("Free Plan: checkFeatureAccess for themes and circuitBreaker returns allowed: false", async () => {
    const themes = await checkFeatureAccess(testShop, "themes");
    const cb = await checkFeatureAccess(testShop, "circuitBreaker");
    const slack = await checkFeatureAccess(testShop, "slack");
    assert.strictEqual(themes.allowed, false);
    assert.strictEqual(cb.allowed, false);
    assert.strictEqual(slack.allowed, false);
  });

  // Test with Growth plan
  await prisma.appSettings.update({
    where: { shop: testShop },
    data: { planId: "growth" },
  });

  await itAsync("Growth Plan: checkVaultAccess returns allowed: true with 2,500 orders", async () => {
    const access = await checkVaultAccess(testShop);
    assert.strictEqual(access.allowed, true);
    assert.strictEqual(access.maxOrders, 2500);
    assert.strictEqual(access.plan, "growth");
  });

  await itAsync("Growth Plan: themes and slack remain locked (Business+ required)", async () => {
    const themes = await checkFeatureAccess(testShop, "themes");
    const slack = await checkFeatureAccess(testShop, "slack");
    assert.strictEqual(themes.allowed, false);
    assert.strictEqual(slack.allowed, false);
  });

  // Test with Business plan
  await prisma.appSettings.update({
    where: { shop: testShop },
    data: { planId: "business" },
  });

  await itAsync("Business Plan: themes, circuit breaker, and slack are unlocked", async () => {
    const themes = await checkFeatureAccess(testShop, "themes");
    const cb = await checkFeatureAccess(testShop, "circuitBreaker");
    const slack = await checkFeatureAccess(testShop, "slack");
    const vault = await checkVaultAccess(testShop);
    assert.strictEqual(themes.allowed, true);
    assert.strictEqual(cb.allowed, true);
    assert.strictEqual(slack.allowed, true);
    assert.strictEqual(vault.maxOrders, 15000);
  });

  // Reset to Business
  await prisma.appSettings.update({
    where: { shop: testShop },
    data: { planId: "business" },
  });

  console.log(`\n=== TEST SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED ===\n`);
  if (passedTests === totalTests) {
    console.log("🎉 ALL QA ACCEPTANCE TESTS PASSED SUCCESSFULLY!");
  } else {
    console.error("⚠️ SOME TESTS FAILED.");
    process.exit(1);
  }
}

runAsyncTests().catch((err) => {
  console.error("FATAL ERROR IN TEST RUNNER:", err);
  process.exit(1);
}).finally(() => {
  prisma.$disconnect();
});
