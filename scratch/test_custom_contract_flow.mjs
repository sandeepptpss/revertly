import { PrismaClient } from "@prisma/client";
import { getEffectivePlanId, getEffectiveLimits, getStorePlan } from "../app/billing.server.js";

const prisma = new PrismaClient();

async function runTests() {
  console.log("Starting Custom Contract & Shopify Billing Verification Tests...\n");
  const testShop = "contract-test-merchant.myshopify.com";

  try {
    // 0. Clean up or setup initial state
    await prisma.appSettings.upsert({
      where: { shop: testShop },
      create: { shop: testShop, planId: "starter", customProductLimit: null },
      update: { planId: "starter", customProductLimit: null, customPriceAmount: null, customBillingMethod: "SHOPIFY", customPriceStatus: null },
    });

    // 1. Admin sets DIRECT CONTRACT (EXTERNAL) at $199/mo & 300,000 products
    console.log("Test 1: Admin sets Direct Contract ($199/mo, 300,000 products)...");
    await prisma.appSettings.update({
      where: { shop: testShop },
      data: {
        customProductLimit: 300000,
        customPriceAmount: 199,
        customBillingMethod: "EXTERNAL",
        customPriceStatus: "ACTIVE",
        customPlanNote: "Enterprise contract agreement #1042",
      },
    });

    let planId = await getEffectivePlanId(testShop);
    let limits = await getEffectiveLimits(testShop);
    let storePlan = await getStorePlan(testShop);

    if (planId !== "enterprise") throw new Error(`Expected enterprise, got ${planId}`);
    if (limits.products !== 300000) throw new Error(`Expected 300000 products, got ${limits.products}`);
    if (limits.customBillingMethod !== "EXTERNAL") throw new Error(`Expected EXTERNAL, got ${limits.customBillingMethod}`);
    if (limits.customPriceStatus !== "ACTIVE") throw new Error(`Expected ACTIVE, got ${limits.customPriceStatus}`);
    if (limits.customPriceAmount !== 199) throw new Error(`Expected 199, got ${limits.customPriceAmount}`);
    console.log("✓ Direct Contract is ACTIVE immediately with 300,000 products and $199/mo\n");

    // 2. Admin edits Direct Contract (changes to $299/mo, 500,000 products)
    console.log("Test 2: Admin edits Direct Contract (updates to $299/mo, 500,000 products)...");
    await prisma.appSettings.update({
      where: { shop: testShop },
      data: {
        customProductLimit: 500000,
        customPriceAmount: 299,
        customBillingMethod: "EXTERNAL",
        customPriceStatus: "ACTIVE",
      },
    });

    limits = await getEffectiveLimits(testShop);
    if (limits.products !== 500000 || limits.customPriceAmount !== 299) {
      throw new Error(`Direct contract update failed: ${JSON.stringify(limits)}`);
    }
    console.log("✓ Direct Contract updated seamlessly to 500,000 products and $299/mo\n");

    // 3. Admin switches merchant from Direct Contract to SHOPIFY Billing
    console.log("Test 3: Admin switches merchant from Direct Contract to SHOPIFY Billing ($249/mo, 350,000 products)...");
    const prev = await prisma.appSettings.findUnique({ where: { shop: testShop } });
    const newBillingMethod = "SHOPIFY";
    const newPrice = 249;
    const newLimit = 350000;
    
    // Simulate admin action priceStatus transition
    const priceStatus =
      newBillingMethod === "EXTERNAL"
        ? "ACTIVE"
        : prev?.customBillingMethod === "EXTERNAL"
        ? "OFFERED"
        : prev?.customPriceAmount !== newPrice || prev?.customProductLimit !== newLimit
        ? "OFFERED"
        : prev?.customPriceStatus || "OFFERED";

    if (priceStatus !== "OFFERED") {
      throw new Error(`Expected OFFERED status when switching to SHOPIFY, got ${priceStatus}`);
    }

    await prisma.appSettings.update({
      where: { shop: testShop },
      data: {
        customProductLimit: newLimit,
        customPriceAmount: newPrice,
        customBillingMethod: newBillingMethod,
        customPriceStatus: priceStatus,
      },
    });

    limits = await getEffectiveLimits(testShop);
    if (limits.customPriceStatus !== "OFFERED") {
      throw new Error(`Status in DB expected OFFERED, got ${limits.customPriceStatus}`);
    }
    console.log("✓ Transition to SHOPIFY set status to OFFERED (merchant will see in-app approval card)\n");

    // 4. Merchant clicks Approve and returns from Shopify Billing
    console.log("Test 4: Merchant approves charge in Shopify (activation callback)...");
    await prisma.appSettings.update({
      where: { shop: testShop },
      data: {
        customPriceStatus: "ACTIVE",
        planId: "enterprise",
        productLimitReachedAt: null,
      },
    });

    limits = await getEffectiveLimits(testShop);
    planId = await getEffectivePlanId(testShop);
    if (limits.customPriceStatus !== "ACTIVE" || planId !== "enterprise" || limits.products !== 350000) {
      throw new Error(`Post-approval verification failed`);
    }
    console.log("✓ Shopify Billing approved: Status is ACTIVE, 350,000 product limit is in effect\n");

    // 5. Admin resets custom quota
    console.log("Test 5: Admin resets custom quota back to plan defaults...");
    await prisma.appSettings.update({
      where: { shop: testShop },
      data: {
        customProductLimit: null,
        customPriceAmount: null,
        customBillingMethod: "SHOPIFY",
        customPriceStatus: null,
        customPlanNote: null,
      },
    });

    limits = await getEffectiveLimits(testShop);
    if (limits.customProductLimit !== null || limits.customPriceAmount !== null) {
      throw new Error(`Reset failed: still has custom limits`);
    }
    console.log("✓ Reset completed: store cleanly reverted to standard limits\n");

    console.log("=========================================");
    console.log("ALL VERIFICATION CHECKS PASSED (5/5)!");
    console.log("=========================================");
  } finally {
    // Clean up test shop
    await prisma.appSettings.deleteMany({ where: { shop: testShop } }).catch(() => {});
    await prisma.$disconnect();
  }
}

runTests().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
