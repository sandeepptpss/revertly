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
//
// ── Metafield backup ────────────────────────────────────────────────────────
//
//   metafieldBackup   → standalone Shop/Product/Collection/Page/Blog/Article
//                       metafield *and metafield-definition* capture and
//                       restore. Growth and above.
//
// This is deliberately *not* the same thing as the product metafields that
// ride along inside a product snapshot — those stay on every plan, because
// removing them would break rollback for Free stores. What Growth buys is
// store-wide metafield coverage beyond products, the definitions themselves,
// and handle-based restore onto a different store.
//
// The flag must be re-checked at restore time, not just at backup time: a
// store can capture a metafield backup on Growth and then downgrade, and the
// snapshot outlives the subscription.
// ── Theme backup & rollback ──────────────────────────────────────────────────
//
// Theme protection starts at Growth with 1 Active Theme backup, giving retail
// merchants essential protection against accidental theme breaks or app overwrites.
// Business and Enterprise unlock Unlimited Themes, draft theme backups, and 1-click
// live/draft code rollback.
//
//   themes            → active theme backup & restore on Growth and above.
//   themeLimit        → 1 active theme on Growth; Infinity on Business+.
//                       The single source of truth for how many themes a tier
//                       may capture. checkThemeAccess derives `unlimitedThemes`
//                       from it (themeLimit === Infinity), so the two can never
//                       contradict each other.
export const PLAN_LIMITS = {
  free: {
    products: 100,
    restorePoints: 2,
    rules: 1,
    retentionDays: 7,
    vaultOrders: 0,
    themes: false,
    themeLimit: 0,
    circuitBreaker: false,
    slack: false,
    bulkRollback: false,
    cloudSync: false,
    marketingBackup: false,
    marketingProfiles: 0,
    marketingFlows: false,
    metafieldBackup: false,
  },
  starter: {
    products: 1000,
    restorePoints: 10,
    rules: 3,
    retentionDays: 30,
    vaultOrders: 0,
    themes: false,
    themeLimit: 0,
    circuitBreaker: false,
    slack: false,
    bulkRollback: false,
    cloudSync: true,
    marketingBackup: false,
    marketingProfiles: 0,
    marketingFlows: false,
    metafieldBackup: false,
  },
  growth: {
    products: 5000,
    restorePoints: 50,
    rules: 10,
    retentionDays: 90,
    vaultOrders: 2500,
    themes: true,
    themeLimit: 1,
    circuitBreaker: false,
    slack: false,
    bulkRollback: true,
    cloudSync: true,
    marketingBackup: true,
    marketingProfiles: 10000,
    marketingFlows: false,
    metafieldBackup: true,
  },
  business: {
    products: 30000,
    restorePoints: 100,
    rules: Infinity,
    retentionDays: 180,
    vaultOrders: 15000,
    themes: true,
    themeLimit: Infinity,
    circuitBreaker: true,
    slack: true,
    bulkRollback: true,
    cloudSync: true,
    marketingBackup: true,
    marketingProfiles: 50000,
    marketingFlows: true,
    metafieldBackup: true,
  },
  enterprise: {
    products: 200000,
    restorePoints: Infinity,
    rules: Infinity,
    retentionDays: 365,
    vaultOrders: 100000,
    themes: true,
    themeLimit: Infinity,
    circuitBreaker: true,
    slack: true,
    bulkRollback: true,
    cloudSync: true,
    marketingBackup: true,
    marketingProfiles: 250000,
    marketingFlows: true,
    metafieldBackup: true,
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

  if (row?.customBillingMethod === "EXTERNAL" && row?.customPriceStatus === "ACTIVE") {
    return "enterprise";
  }

  const paidPlan = normalizePlanId(row?.planId);

  const { getActiveFreeGrowthGrant } = await import("./freeGrowth.server.js");
  const grant = await getActiveFreeGrowthGrant(shop);

  return grant && planRank(paidPlan) <= planRank("growth") ? "growth" : paidPlan;
}

/** Plan limits for `getEffectivePlanId`, respecting any admin-granted customProductLimit. */
export async function getEffectiveLimits(shop, settings) {
  const row =
    settings !== undefined ? settings : await prisma.appSettings.findUnique({ where: { shop } });
  const plan = await getEffectivePlanId(shop, row);
  const baseLimits = getPlanLimits(plan);

  if (row?.customProductLimit && row.customProductLimit > 0) {
    return {
      ...baseLimits,
      products: row.customProductLimit,
      isCustomLimit: true,
      customProductLimit: row.customProductLimit,
      customPlanNote: row.customPlanNote || null,
      customPriceAmount: row.customPriceAmount || null,
      customBillingMethod: row.customBillingMethod || "SHOPIFY",
      customPriceStatus: row.customPriceStatus || null,
    };
  }

  return {
    ...baseLimits,
    isCustomLimit: false,
    customProductLimit: null,
    customPlanNote: null,
    customPriceAmount: null,
    customBillingMethod: null,
    customPriceStatus: null,
  };
}

/**
 * Resolves current active plan for a shop, synchronizing between Shopify billing and AppSettings.
 */
export async function getStorePlan(shop, billing = null, isTest = true) {
  let activeShopifyPlan = null;
  let activeShopifyInterval = null;
  let subscriptionDiscountPercent = null;
  // Only a check that actually completed may be used to downgrade a store.
  // A thrown request, or an ACTIVE subscription under a name this build does
  // not recognise, tells us nothing about whether the merchant is paying.
  let noActivePaymentConfirmed = false;

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

      noActivePaymentConfirmed = !billingCheck?.hasActivePayment;

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
        } else if (
          subName?.toLowerCase().includes("enterprise plus") ||
          subName?.toLowerCase().includes("custom enterprise")
        ) {
          activeShopifyPlan = "enterprise";
          activeShopifyInterval = INTERVAL_MONTHLY;
        }

        if (!activeShopifyInterval && activeSub?.lineItems?.[0]?.plan?.pricingDetails?.interval) {
          const intVal = activeSub.lineItems[0].plan.pricingDetails.interval;
          activeShopifyInterval = intVal === "ANNUAL" ? INTERVAL_ANNUAL : INTERVAL_MONTHLY;
        }

        subscriptionDiscountPercent = readSubscriptionDiscountPercent(activeSub);

        if (!activeShopifyPlan) {
          // Paying, but the subscription name matched none of the known plans.
          // Leave the stored plan alone rather than dropping the merchant to
          // free while Shopify keeps charging them.
          console.warn(
            `[Revertly Billing] Unrecognised active subscription name for ${shop}: ${JSON.stringify(subName)} — leaving stored plan unchanged.`,
          );
        }
      }
    } catch (err) {
      noActivePaymentConfirmed = false;
      console.warn("[Revertly Billing] Shopify billing check warning:", err?.message || err);
    }
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const isSimulated = Boolean(
    settings?.subscriptionId?.startsWith("sim_") ||
    settings?.subscriptionId?.startsWith("test_")
  );
  const isExternalActive =
    settings?.customBillingMethod === "EXTERNAL" && settings?.customPriceStatus === "ACTIVE";

  let currentPlan = isExternalActive
    ? "enterprise"
    : normalizePlanId(activeShopifyPlan || settings?.planId || "free");

  // If Shopify returned a definitive check, synchronize database (unless plan was activated in test/simulation mode)
  if (billing && !isSimulated) {
    const needsPlanUpdate = settings && (
      settings.planId !== activeShopifyPlan ||
      (activeShopifyInterval && settings.billingInterval !== activeShopifyInterval) ||
      (activeShopifyPlan === "enterprise" && settings.customPriceStatus === "OFFERED")
    );
    if (activeShopifyPlan && needsPlanUpdate) {
      await prisma.appSettings.update({
        where: { shop },
        data: {
          planId: activeShopifyPlan,
          billingInterval: activeShopifyInterval || INTERVAL_MONTHLY,
          ...(settings.customPriceStatus === "OFFERED" ? { customPriceStatus: "ACTIVE" } : {}),
        },
      });
      currentPlan = activeShopifyPlan;
    } else if (noActivePaymentConfirmed && settings && settings.planId !== "free" && !isExternalActive) {
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

  const baseLimits = getPlanLimits(effectivePlan);
  const limits =
    settings?.customProductLimit && settings.customProductLimit > 0
      ? {
          ...baseLimits,
          products: settings.customProductLimit,
          isCustomLimit: true,
          customProductLimit: settings.customProductLimit,
          customPlanNote: settings.customPlanNote || null,
        }
      : {
          ...baseLimits,
          isCustomLimit: false,
          customProductLimit: null,
          customPlanNote: null,
        };

  return {
    currentPlan: effectivePlan,
    // What the merchant actually pays for, ignoring the promotion.
    paidPlan,
    limits,
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

/**
 * Check if the shop has access to theme backups, how many themes it can back up,
 * and whether unlimited/draft theme backups are included.
 *
 * `unlimitedThemes` is derived from `themeLimit` rather than stored beside it.
 * Held as two independent fields the pair can disagree — a tier set to
 * `themeLimit: 5, unlimitedThemes: true` would advertise a cap that nothing
 * enforces — so the count is the single source of truth and "unlimited" is
 * simply the absence of one.
 */
export async function checkThemeAccess(shop) {
  const plan = await getEffectivePlanId(shop);
  const limits = getPlanLimits(plan);
  const themeLimit = limits.themes ? (limits.themeLimit ?? 0) : 0;

  return {
    allowed: Boolean(limits.themes),
    themeLimit,
    unlimitedThemes: themeLimit === Infinity,
    plan,
  };
}

