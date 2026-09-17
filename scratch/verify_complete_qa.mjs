import assert from "node:assert";
import prisma from "../app/db.server.js";
import { PLAN_TIERS, INTERVAL_MONTHLY, INTERVAL_ANNUAL } from "../app/billing.constants.js";
import {
  computeFreeGrowthExpiry,
  getFreeGrowthStatus,
  getFreeGrowthOffer,
  claimFreeGrowthSeat,
} from "../app/freeGrowth.server.js";
import { resolveBestDiscount } from "../app/storeDiscount.server.js";

async function runAllTests() {
  console.log("=== STARTING COMPLETE QA VERIFICATION ===");

  // ── TEST 1: Expiry calculation with configurable duration ──
  console.log("\n[TEST 1] Verifying computeFreeGrowthExpiry...");
  const baseDate = new Date("2026-09-16T12:00:00.000Z");
  
  const expiry2m = computeFreeGrowthExpiry(baseDate, 2);
  console.log("  Base date:", baseDate.toISOString());
  console.log("  2 months expiry:", expiry2m.toISOString());
  assert.strictEqual(expiry2m.toISOString().slice(0, 10), "2026-11-16", "2 months expiry should be 2026-11-16");

  const expiry6m = computeFreeGrowthExpiry(baseDate, 6);
  console.log("  6 months expiry:", expiry6m.toISOString());
  assert.strictEqual(expiry6m.toISOString().slice(0, 10), "2027-03-16", "6 months expiry should be 2027-03-16");
  console.log("  ✓ Test 1 passed: Expiry computation correctly handles configurable duration in months.");

  // ── TEST 2: Free Growth status with limit & duration from PlatformSettings ──
  console.log("\n[TEST 2] Verifying getFreeGrowthStatus from PlatformSettings...");
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { freeGrowthSeatLimit: 20, freeGrowthDurationMonths: 2, freeGrowthEnabled: true },
  });

  const status = await getFreeGrowthStatus();
  console.log("  Status from DB:", status);
  assert.strictEqual(status.limit, 20, "Limit must be 20");
  assert.strictEqual(status.durationMonths, 2, "Duration must be 2");
  assert.strictEqual(status.used, 1, "Used seats should be 1 (quickstart store)");
  assert.strictEqual(status.remaining, 19, "Remaining seats should be 19");
  assert.strictEqual(status.isSoldOut, false, "Should not be sold out");
  console.log("  ✓ Test 2 passed: getFreeGrowthStatus accurately returns admin-configured limit and duration.");

  // ── TEST 3: Admin configuration changes ──
  console.log("\n[TEST 3] Testing Admin updating limit to 50 and duration to 3 months...");
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { freeGrowthSeatLimit: 50, freeGrowthDurationMonths: 3 },
  });
  const updatedStatus = await getFreeGrowthStatus();
  assert.strictEqual(updatedStatus.limit, 50, "Limit should be 50");
  assert.strictEqual(updatedStatus.durationMonths, 3, "Duration should be 3");
  assert.strictEqual(updatedStatus.remaining, 49, "Remaining should be 49");
  console.log("  ✓ Test 3 passed: Platform settings updates are immediately reflected.");

  // ── TEST 4: Sold out behavior when limit is reached ──
  console.log("\n[TEST 4] Testing Sold Out condition when limit is reached...");
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { freeGrowthSeatLimit: 1, freeGrowthDurationMonths: 2 }, // used is 1, so remaining is 0
  });
  const soldOutStatus = await getFreeGrowthStatus();
  console.log("  Sold-out status:", soldOutStatus);
  assert.strictEqual(soldOutStatus.remaining, 0, "Remaining must be 0");
  assert.strictEqual(soldOutStatus.isSoldOut, true, "isSoldOut must be true");

  const newStoreShop = "unclaimed-test-store.myshopify.com";
  const offerForNewStore = await getFreeGrowthOffer(newStoreShop);
  console.log("  Offer for new store when limit is reached:", offerForNewStore);
  assert.strictEqual(offerForNewStore, null, "No offer should be returned when seats are full");

  const claimResult = await claimFreeGrowthSeat(newStoreShop);
  console.log("  Claim attempt result:", claimResult);
  assert.strictEqual(claimResult, null, "Claim attempt must be rejected when sold out");
  console.log("  ✓ Test 4 passed: Offer is automatically closed when seat limit is reached.");

  // Reset limit back to 20
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { freeGrowthSeatLimit: 20, freeGrowthDurationMonths: 2 },
  });

  // ── TEST 5: Existing grant expiry date verification ──
  console.log("\n[TEST 5] Verifying existing grant for quickstart store...");
  const quickstartGrant = await prisma.freeGrowthGrant.findUnique({
    where: { shop: "quickstart-749ac396.myshopify.com" },
  });
  console.log("  Quickstart grant:", quickstartGrant);
  assert(quickstartGrant, "Grant must exist");
  const grantedTime = new Date(quickstartGrant.grantedAt).getTime();
  const expiresTime = new Date(quickstartGrant.expiresAt).getTime();
  const diffDays = Math.round((expiresTime - grantedTime) / (24 * 60 * 60 * 1000));
  console.log(`  Granted: ${quickstartGrant.grantedAt.toISOString()} -> Expires: ${quickstartGrant.expiresAt.toISOString()} (${diffDays} days)`);
  assert(diffDays >= 60 && diffDays <= 62, "Expiry should be ~2 months (61 days)");
  assert.strictEqual(quickstartGrant.expiresAt.toISOString().slice(0, 10), "2026-11-16", "Expiry date must be 2026-11-16");
  console.log("  ✓ Test 5 passed: Existing merchant grant correctly displays 2-month expiry.");

  // ── TEST 6: Annual Pricing - Standard base rates without hardcoded 17% discount ──
  console.log("\n[TEST 6] Verifying standard annual plan pricing in PLAN_TIERS...");
  console.log("  Starter:", PLAN_TIERS.starter);
  console.log("  Growth:", PLAN_TIERS.growth);
  console.log("  Business:", PLAN_TIERS.business);
  console.log("  Enterprise:", PLAN_TIERS.enterprise);

  assert.strictEqual(PLAN_TIERS.starter.price, 9);
  assert.strictEqual(PLAN_TIERS.starter.yearlyPrice, 108, "Starter yearly price must be 9 * 12 = 108");
  assert.strictEqual(PLAN_TIERS.starter.yearlyMonthlyEquivalent, 9, "Starter monthly eq must be 9");

  assert.strictEqual(PLAN_TIERS.growth.price, 24);
  assert.strictEqual(PLAN_TIERS.growth.yearlyPrice, 288, "Growth yearly price must be 24 * 12 = 288");
  assert.strictEqual(PLAN_TIERS.growth.yearlyMonthlyEquivalent, 24, "Growth monthly eq must be 24");

  assert.strictEqual(PLAN_TIERS.business.price, 49);
  assert.strictEqual(PLAN_TIERS.business.yearlyPrice, 588, "Business yearly price must be 49 * 12 = 588");
  assert.strictEqual(PLAN_TIERS.business.yearlyMonthlyEquivalent, 49, "Business monthly eq must be 49");

  assert.strictEqual(PLAN_TIERS.enterprise.price, 79);
  assert.strictEqual(PLAN_TIERS.enterprise.yearlyPrice, 948, "Enterprise yearly price must be 79 * 12 = 948");
  assert.strictEqual(PLAN_TIERS.enterprise.yearlyMonthlyEquivalent, 79, "Enterprise monthly eq must be 79");
  console.log("  ✓ Test 6 passed: PLAN_TIERS has standard 12x annual prices with no unconfigured discounts.");

  // ── TEST 7: Admin-configured discounts application ──
  console.log("\n[TEST 7] Verifying Admin-configured discounts...");
  const initialPlatformSettings = await prisma.platformSettings.findUnique({ where: { id: 1 } });

  // Baseline: ensure global discount is inactive
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { globalDiscountActive: false },
  });

  const noDiscount = await resolveBestDiscount("quickstart-749ac396.myshopify.com");
  console.log("  Discount when none active:", noDiscount);
  assert.strictEqual(noDiscount, null, "No discount should be active initially");

  // Test activating a 20% global discount
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: {
      globalDiscountActive: true,
      globalDiscountPercent: 20,
      globalDiscountExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  const active20Discount = await resolveBestDiscount("quickstart-749ac396.myshopify.com");
  console.log("  Discount after activating 20% global discount:", active20Discount);
  assert(active20Discount, "Discount should now be found");
  assert.strictEqual(active20Discount.percent, 20, "Discount percent must be 20");

  // Calculate discounted annual prices
  const starterFinalYearly = PLAN_TIERS.starter.yearlyPrice * (1 - active20Discount.percent / 100);
  const starterFinalMonthlyEq = PLAN_TIERS.starter.yearlyMonthlyEquivalent * (1 - active20Discount.percent / 100);
  console.log(`  Starter with 20% Admin discount: $${starterFinalYearly}/yr, $${starterFinalMonthlyEq}/mo equivalent`);
  assert.strictEqual(starterFinalYearly, 86.4, "Starter 20% off yearly should be 86.4");
  assert.strictEqual(starterFinalMonthlyEq, 7.2, "Starter 20% off monthly eq should be 7.2");

  // Clean up: restore original platform settings
  if (initialPlatformSettings) {
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        globalDiscountActive: initialPlatformSettings.globalDiscountActive,
        globalDiscountPercent: initialPlatformSettings.globalDiscountPercent,
        globalDiscountExpiresAt: initialPlatformSettings.globalDiscountExpiresAt,
        globalDiscountNote: initialPlatformSettings.globalDiscountNote,
      },
    });
  }

  console.log("  ✓ Test 7 passed: Admin-configured discounts are accurately applied.");

  console.log("\n=============================================");
  console.log("🎉 ALL QA VERIFICATION TESTS PASSED SUCCESSFULLY!");
  console.log("=============================================");
}

runAllTests()
  .catch((err) => {
    console.error("❌ QA Test Failure:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
