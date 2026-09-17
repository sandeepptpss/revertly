import prisma from "./db.server.js";

import {
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_STARTER_ANNUAL,
  PLAN_GROWTH_ANNUAL,
  PLAN_BUSINESS_ANNUAL,
  PLAN_ENTERPRISE_ANNUAL,
  INTERVAL_MONTHLY,
  INTERVAL_ANNUAL,
  PLAN_PRO,
  PLAN_TIERS,
} from "./billing.constants.js";

export {
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_STARTER_ANNUAL,
  PLAN_GROWTH_ANNUAL,
  PLAN_BUSINESS_ANNUAL,
  PLAN_ENTERPRISE_ANNUAL,
  INTERVAL_MONTHLY,
  INTERVAL_ANNUAL,
  PLAN_PRO,
  PLAN_TIERS,
};

// ── Email marketing (ESP) backup ────────────────────────────────────────────
//
// Klaviyo and Mailchimp backup is a *customer-data* capability, so it unlocks
// on the same rung as the Orders & Customers Vault (Growth) rather than with
// the file-level Offsite Cloud Backup (Starter). Three keys, because the
// capability is not one switch:
//
//   marketingBackup   → the integration itself: connect an ESP account and
//                       capture lists/audiences, segments and profiles.
//   marketingProfiles → how many subscriber profiles may be held, the same
//                       shape as vaultOrders (0 means "not in plan", and the
//                       flag above must be checked rather than inferred).
//   marketingFlows    → Klaviyo flows and Mailchimp journeys/automations,
//                       which are automation *logic* rather than contact
//                       records and are a Business-and-above differentiator.
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
    cloudSync: false,
    marketingBackup: false,
    marketingProfiles: 0,
    marketingFlows: false,
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
    cloudSync: true,
    marketingBackup: false,
    marketingProfiles: 0,
    marketingFlows: false,
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
    cloudSync: true,
    marketingBackup: true,
    marketingProfiles: 10000,
    marketingFlows: false,
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
    cloudSync: true,
    marketingBackup: true,
    marketingProfiles: 50000,
    marketingFlows: true,
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
    cloudSync: true,
    marketingBackup: true,
    marketingProfiles: Infinity,
    marketingFlows: true,
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
 * The plan a shop is *entitled* to right now: what it pays for, raised to
 * Growth while it holds an unexpired promotional free-Growth seat.
 *
 * Every entitlement decision must go through this rather than reading
 * AppSettings.planId directly. A promotional seat deliberately leaves planId
 * at "free" (see freeGrowth.server.js), so code that reads the stored plan
 * enforces Free on a merchant whose Plans & Billing page promises Growth —
 * blocking restore points, rules and the vault, and pruning their history to
 * the 7-day Free window.
 *
 * Pass `settings` when the caller has already loaded the AppSettings row, to
 * avoid a second query.
 */
export async function getEffectivePlanId(shop, settings) {
  const row =
    settings !== undefined ? settings : await prisma.appSettings.findUnique({ where: { shop } });
  const paidPlan = normalizePlanId(row?.planId);

  const { getActiveFreeGrowthGrant } = await import("./freeGrowth.server.js");
  const grant = await getActiveFreeGrowthGrant(shop);

  return grant && planRank(paidPlan) <= planRank("growth") ? "growth" : paidPlan;
}

/** Plan limits for `getEffectivePlanId`. */
export async function getEffectiveLimits(shop, settings) {
  return getPlanLimits(await getEffectivePlanId(shop, settings));
}

/**
 * Resolves current active plan for a shop, synchronizing between Shopify billing and AppSettings.
 */
export async function getStorePlan(shop, billing = null, isTest = true) {
  let activeShopifyPlan = null;
  let activeShopifyInterval = null;
  let subscriptionDiscountPercent = null;

  if (billing) {
    try {
      const billingCheck = await billing.check({
        plans: [
          PLAN_STARTER,
          PLAN_GROWTH,
          PLAN_BUSINESS,
          PLAN_ENTERPRISE,
          PLAN_STARTER_ANNUAL,
          PLAN_GROWTH_ANNUAL,
          PLAN_BUSINESS_ANNUAL,
          PLAN_ENTERPRISE_ANNUAL,
        ],
        isTest,
      });

      if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
        // Find active subscription
        const activeSub = billingCheck.appSubscriptions.find(
          (sub) => !sub.status || sub.status === "ACTIVE"
        ) || billingCheck.appSubscriptions[0];

        const subName = activeSub?.name;
        if (subName === PLAN_STARTER) {
          activeShopifyPlan = "starter";
          activeShopifyInterval = INTERVAL_MONTHLY;
        } else if (subName === PLAN_STARTER_ANNUAL) {
          activeShopifyPlan = "starter";
          activeShopifyInterval = INTERVAL_ANNUAL;
        } else if (subName === PLAN_GROWTH || subName === PLAN_PRO) {
          activeShopifyPlan = "growth";
          activeShopifyInterval = INTERVAL_MONTHLY;
        } else if (subName === PLAN_GROWTH_ANNUAL) {
          activeShopifyPlan = "growth";
          activeShopifyInterval = INTERVAL_ANNUAL;
        } else if (subName === PLAN_BUSINESS) {
          activeShopifyPlan = "business";
          activeShopifyInterval = INTERVAL_MONTHLY;
        } else if (subName === PLAN_BUSINESS_ANNUAL) {
          activeShopifyPlan = "business";
          activeShopifyInterval = INTERVAL_ANNUAL;
        } else if (subName === PLAN_ENTERPRISE) {
          activeShopifyPlan = "enterprise";
          activeShopifyInterval = INTERVAL_MONTHLY;
        } else if (subName === PLAN_ENTERPRISE_ANNUAL) {
          activeShopifyPlan = "enterprise";
          activeShopifyInterval = INTERVAL_ANNUAL;
        }

        if (!activeShopifyInterval && activeSub?.lineItems?.[0]?.plan?.pricingDetails?.interval) {
          const intVal = activeSub.lineItems[0].plan.pricingDetails.interval;
          activeShopifyInterval = intVal === "ANNUAL" ? INTERVAL_ANNUAL : INTERVAL_MONTHLY;
        }

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
    if (activeShopifyPlan && settings && (settings.planId !== activeShopifyPlan || (activeShopifyInterval && settings.billingInterval !== activeShopifyInterval))) {
      await prisma.appSettings.update({
        where: { shop },
        data: {
          planId: activeShopifyPlan,
          billingInterval: activeShopifyInterval || INTERVAL_MONTHLY,
        },
      });
      currentPlan = activeShopifyPlan;
    } else if (!activeShopifyPlan && settings && settings.planId !== "free") {
      // Shopify has no active payment, but DB still says paid plan -> downgrade to free
      await prisma.appSettings.update({
        where: { shop },
        data: { planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
      });
      currentPlan = "free";
    }
  }

  // A promotional free-Growth seat grants Growth entitlements with no
  // subscription behind them. If a store holds an active grant and does not
  // have a higher-tier paid Shopify subscription (Business or Enterprise):
  // - its effective entitlement plan is Growth;
  // - its billed plan is Free (no Shopify charge);
  // - freeGrowth details are returned with isActive: true.
  const { getActiveFreeGrowthGrant } = await import("./freeGrowth.server.js");
  const freeGrowthGrant = await getActiveFreeGrowthGrant(shop);

  let effectivePlan = currentPlan;
  let paidPlan = currentPlan;
  let freeGrowthInfo = null;

  if (freeGrowthGrant) {
    const hasHigherPaidPlan = planRank(currentPlan) > planRank("growth");
    if (!hasHigherPaidPlan) {
      effectivePlan = "growth";
      paidPlan = "free";

      // If a simulated subscription or stale growth planId was saved in AppSettings, clean it up
      // so it never conflicts with the promotional free status.
      if (settings && (settings.subscriptionId?.startsWith("sim_") || settings.planId !== "free")) {
        await prisma.appSettings.update({
          where: { shop },
          data: { planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
        }).catch((err) => {
          console.warn("[Revertly Billing] Could not reset stale subscription for free growth:", err?.message);
        });
      }
    }
    freeGrowthInfo = {
      expiresAt: freeGrowthGrant.expiresAt,
      isActive: !hasHigherPaidPlan,
      supersededByPaidPlan: hasHigherPaidPlan,
    };
  }

  const resolvedInterval =
    activeShopifyInterval ||
    settings?.billingInterval ||
    (settings?.subscriptionId?.includes("annual") ? INTERVAL_ANNUAL : INTERVAL_MONTHLY);

  return {
    currentPlan: effectivePlan,
    // What the merchant actually pays for, ignoring the promotion.
    paidPlan,
    limits: getPlanLimits(effectivePlan),
    subscriptionDiscountPercent,
    freeGrowth: freeGrowthInfo,
    billingInterval: resolvedInterval,
  };
}

/** Ordering of the plan ladder, used to compare entitlement levels. */
function planRank(planId) {
  return PLAN_TIERS[normalizePlanId(planId)]?.order ?? 0;
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
  const plan = await getEffectivePlanId(shop);
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
  const plan = await getEffectivePlanId(shop);
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
  const plan = await getEffectivePlanId(shop);
  const limits = getPlanLimits(plan);

  const allowed = limits.vaultOrders > 0;

  return {
    allowed,
    maxOrders: limits.vaultOrders,
    plan,
  };
}

/**
 * Check if the shop has access to Klaviyo / Mailchimp backup, how many
 * subscriber profiles it may hold, and whether flows and journeys are included.
 *
 * `allowed` reads the capability flag rather than inferring it from the profile
 * cap, so an Enterprise store — whose cap is Infinity, not a number — is never
 * mistaken for one without the feature.
 */
export async function checkMarketingBackupAccess(shop) {
  const plan = await getEffectivePlanId(shop);
  const limits = getPlanLimits(plan);

  return {
    allowed: Boolean(limits.marketingBackup),
    maxProfiles: limits.marketingProfiles,
    flowsIncluded: Boolean(limits.marketingFlows),
    plan,
  };
}

/**
 * Check if the shop has access to a specific premium feature.
 */
export async function checkFeatureAccess(shop, feature) {
  const plan = await getEffectivePlanId(shop);
  const limits = getPlanLimits(plan);

  const allowed = Boolean(limits[feature]);

  return {
    allowed,
    plan,
    feature,
  };
}
