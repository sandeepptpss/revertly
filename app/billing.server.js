import prisma from "./db.server.js";

import {
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_PRO,
  PLAN_TIERS,
} from "./billing.constants.js";

export {
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_PRO,
  PLAN_TIERS,
};

export const PLAN_LIMITS = {
  free: {
    products: 100,
    restorePoints: 2,
    rules: 1,
    retentionDays: 7,
    vaultOrders: 0,
    themes: false,
    circuitBreaker: false,
    slack: false,
    bulkRollback: false,
  },
  starter: {
    products: 1000,
    restorePoints: 10,
    rules: 3,
    retentionDays: 30,
    vaultOrders: 0,
    themes: false,
    circuitBreaker: false,
    slack: false,
    bulkRollback: false,
  },
  growth: {
    products: 5000,
    restorePoints: 50,
    rules: 10,
    retentionDays: 90,
    vaultOrders: 2500,
    themes: false,
    circuitBreaker: false,
    slack: false,
    bulkRollback: true,
  },
  business: {
    products: 20000,
    restorePoints: 100,
    rules: Infinity,
    retentionDays: 180,
    vaultOrders: 15000,
    themes: true,
    circuitBreaker: true,
    slack: true,
    bulkRollback: true,
  },
  enterprise: {
    products: Infinity,
    restorePoints: Infinity,
    rules: Infinity,
    retentionDays: 365,
    vaultOrders: Infinity,
    themes: true,
    circuitBreaker: true,
    slack: true,
    bulkRollback: true,
  },
};

export function normalizePlanId(planId) {
  if (!planId) return "free";
  const lower = String(planId).toLowerCase().trim();
  if (lower === "pro") return "growth";
  if (PLAN_TIERS[lower]) return lower;
  return "free";
}

export function getPlanLimits(planId) {
  const norm = normalizePlanId(planId);
  return PLAN_LIMITS[norm] || PLAN_LIMITS.free;
}

/**
 * Resolves current active plan for a shop, synchronizing between Shopify billing and AppSettings.
 */
export async function getStorePlan(shop, billing = null, isTest = true) {
  let activeShopifyPlan = null;
  let subscriptionDiscountPercent = null;

  if (billing) {
    try {
      const billingCheck = await billing.check({
        plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS, PLAN_ENTERPRISE],
        isTest,
      });

      if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
        // Find active subscription
        const activeSub = billingCheck.appSubscriptions.find(
          (sub) => !sub.status || sub.status === "ACTIVE"
        ) || billingCheck.appSubscriptions[0];

        const subName = activeSub?.name;
        if (subName === PLAN_STARTER) activeShopifyPlan = "starter";
        else if (subName === PLAN_GROWTH || subName === PLAN_PRO) activeShopifyPlan = "growth";
        else if (subName === PLAN_BUSINESS) activeShopifyPlan = "business";
        else if (subName === PLAN_ENTERPRISE) activeShopifyPlan = "enterprise";

        subscriptionDiscountPercent = readSubscriptionDiscountPercent(activeSub);
      }
    } catch (err) {
      console.warn("[Revertly Billing] Shopify billing check warning:", err?.message || err);
    }
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const isSimulated = Boolean(
    settings?.subscriptionId?.startsWith("sim_") ||
    settings?.subscriptionId?.startsWith("test_")
  );
  let currentPlan = normalizePlanId(activeShopifyPlan || settings?.planId || "free");

  // If Shopify returned a definitive check, synchronize database (unless plan was activated in test/simulation mode)
  if (billing && !isSimulated) {
    if (activeShopifyPlan && settings && settings.planId !== activeShopifyPlan) {
      await prisma.appSettings.update({
        where: { shop },
        data: { planId: activeShopifyPlan },
      });
      currentPlan = activeShopifyPlan;
    } else if (!activeShopifyPlan && settings && settings.planId !== "free") {
      // Shopify has no active payment, but DB still says paid plan -> downgrade to free
      await prisma.appSettings.update({
        where: { shop },
        data: { planId: "free", subscriptionId: null },
      });
      currentPlan = "free";
    }
  }

  return {
    currentPlan,
    limits: getPlanLimits(currentPlan),
    subscriptionDiscountPercent,
  };
}

/**
 * The percentage discount actually attached to a live Shopify subscription,
 * or null. Used to tell an admin-granted discount that is merely *on file*
 * apart from one that is really reducing the merchant's charge.
 */
function readSubscriptionDiscountPercent(subscription) {
  for (const lineItem of subscription?.lineItems || []) {
    const discount = lineItem?.plan?.pricingDetails?.discount;
    const percentage = discount?.value?.percentage;
    if (!percentage) continue;

    // A discount that has run out its term is no longer reducing anything.
    const remaining = discount.remainingDurationInIntervals;
    if (remaining !== null && remaining !== undefined && remaining <= 0) continue;

    return Math.round(percentage * 100);
  }
  return null;
}

/**
 * Check if the shop can create another restore point.
 */
export async function checkRestorePointLimit(shop) {
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const plan = normalizePlanId(settings?.planId);
  const limits = getPlanLimits(plan);
  const count = await prisma.restorePoint.count({ where: { shop } });

  const allowed = limits.restorePoints === Infinity || count < limits.restorePoints;

  return {
    allowed,
    currentCount: count,
    limit: limits.restorePoints,
    plan,
  };
}

/**
 * Check if the shop can activate or create another detection rule.
 */
export async function checkRuleLimit(shop) {
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const plan = normalizePlanId(settings?.planId);
  const limits = getPlanLimits(plan);
  const activeCount = await prisma.detectionRule.count({
    where: { shop, isActive: true },
  });

  const allowed = limits.rules === Infinity || activeCount < limits.rules;

  return {
    allowed,
    activeCount,
    limit: limits.rules,
    plan,
  };
}

/**
 * Check if the shop has access to Orders & Customers Vault and its max order sync count.
 */
export async function checkVaultAccess(shop) {
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const plan = normalizePlanId(settings?.planId);
  const limits = getPlanLimits(plan);

  const allowed = limits.vaultOrders > 0;

  return {
    allowed,
    maxOrders: limits.vaultOrders,
    plan,
  };
}

/**
 * Check if the shop has access to a specific premium feature.
 */
export async function checkFeatureAccess(shop, feature) {
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const plan = normalizePlanId(settings?.planId);
  const limits = getPlanLimits(plan);

  const allowed = Boolean(limits[feature]);

  return {
    allowed,
    plan,
    feature,
  };
}
