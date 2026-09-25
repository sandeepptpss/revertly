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
  PLAN_ENTERPRISE_CUSTOM,
  ALL_BILLING_PLAN_NAMES,
} from "./billing.constants.js";

export {
  PLAN_ENTERPRISE_CUSTOM,
  ALL_BILLING_PLAN_NAMES,
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
// ── Operational monitoring & governance ─────────────────────────────────────
//
//   uptimeMonitoring  → Store & App downtime probes and alerts (uptime.server.js,
//                       app.monitoring.jsx). Starter and above.
//   qaSuites          → Automated QA & backup health runs (qa.server.js,
//                       app.qa.jsx). Starter and above.
//   teamRoles         → inviting staff and assigning roles, plus the audit-log
//                       view (app.team.jsx). Starter and above. Roles already on
//                       the roster keep being enforced after a downgrade —
//                       restricting access is never unsafe — but a Free store
//                       cannot add or re-role members.
export const PLAN_LIMITS = {
  free: {
    products: 50,
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
    ga4Monitoring: false,
    uptimeMonitoring: false,
    qaSuites: false,
    teamRoles: false,
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
    ga4Monitoring: true,
    uptimeMonitoring: true,
    qaSuites: true,
    teamRoles: true,
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
    ga4Monitoring: true,
    uptimeMonitoring: true,
    qaSuites: true,
    teamRoles: true,
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
    ga4Monitoring: true,
    uptimeMonitoring: true,
    qaSuites: true,
    teamRoles: true,
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
    ga4Monitoring: true,
    uptimeMonitoring: true,
    qaSuites: true,
    teamRoles: true,
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

// ── Custom Enterprise Plus quota ────────────────────────────────────────────
//
// A negotiated product quota is only granted while it is being paid for: the
// offer must have been accepted (customPriceStatus "ACTIVE") and the store must
// actually be on Enterprise — through the dedicated custom Shopify plan or an
// external contract. An OFFERED quota is a price quote, and a CANCELLED one
// has lapsed; neither may lift a store's cap.

export function isCustomQuotaInForce(row, effectivePlan) {
  return Boolean(
    row?.customProductLimit > 0 &&
      row.customPriceStatus === "ACTIVE" &&
      effectivePlan === "enterprise",
  );
}

function applyCustomQuota(baseLimits, row, effectivePlan) {
  if (isCustomQuotaInForce(row, effectivePlan)) {
    return {
      ...baseLimits,
      products: row.customProductLimit,
      isCustomLimit: true,
      customProductLimit: row.customProductLimit,
      customPlanNote: row.customPlanNote || null,
      customPriceAmount: row.customPriceAmount || null,
      customBillingMethod: row.customBillingMethod || "SHOPIFY",
      customPriceStatus: row.customPriceStatus,
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
 * The custom-offer status implied by the subscription Shopify reports as
 * active. Only the dedicated custom plan can accept an offer. Any other active
 * charge means an accepted Shopify-billed custom plan has been replaced by a
 * standard one, so it is no longer in force. External contracts are managed
 * by hand and are never touched here.
 */
export function customStatusForActiveSubscription(row, isCustomSubscription) {
  const status = row?.customPriceStatus || null;
  if (!row?.customProductLimit || row.customBillingMethod === "EXTERNAL") return status;
  if (isCustomSubscription) return "ACTIVE";
  return status === "ACTIVE" ? "CANCELLED" : status;
}

// Exact (case-insensitive) map from a Shopify subscription name to our plan.
const SUBSCRIPTION_PLAN_INFO = new Map([
  [PLAN_STARTER, { planId: "starter", interval: INTERVAL_MONTHLY }],
  [PLAN_STARTER_ANNUAL, { planId: "starter", interval: INTERVAL_ANNUAL }],
  [PLAN_GROWTH, { planId: "growth", interval: INTERVAL_MONTHLY }],
  [PLAN_GROWTH_ANNUAL, { planId: "growth", interval: INTERVAL_ANNUAL }],
  [PLAN_PRO, { planId: "growth", interval: INTERVAL_MONTHLY }],
  [PLAN_BUSINESS, { planId: "business", interval: INTERVAL_MONTHLY }],
  [PLAN_BUSINESS_ANNUAL, { planId: "business", interval: INTERVAL_ANNUAL }],
  [PLAN_ENTERPRISE, { planId: "enterprise", interval: INTERVAL_MONTHLY }],
  [PLAN_ENTERPRISE_ANNUAL, { planId: "enterprise", interval: INTERVAL_ANNUAL }],
  [PLAN_ENTERPRISE_CUSTOM, { planId: "enterprise", interval: INTERVAL_MONTHLY, isCustom: true }],
].map(([name, info]) => [name.toLowerCase(), { isCustom: false, ...info }]));

/**
 * Our plan for a Shopify subscription name, or null for a name this build does
 * not recognise (which must never be read as "not paying"). Shared by the
 * billing sync below and the app_subscriptions/update webhook so the two can
 * never disagree about what a subscription is.
 */
export function planInfoForSubscriptionName(name) {
  const key = String(name || "").trim().toLowerCase();
  const exact = SUBSCRIPTION_PLAN_INFO.get(key);
  if (exact) return exact;
  if (key.includes("enterprise plus") || key.includes("custom enterprise")) {
    return { planId: "enterprise", interval: INTERVAL_MONTHLY, isCustom: true };
  }
  return null;
}

/**
 * The plan a shop is *entitled* to right now: what it pays for, raised to
 * Growth while it holds an unexpired promotional free-Growth seat or is a
 * Shopify Partner development store.
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

  let plan = grant && planRank(paidPlan) <= planRank("growth") ? "growth" : paidPlan;

  // The flag is refreshed on every token exchange (shopify.server.js afterAuth)
  // because this function has no admin client to ask Shopify itself.
  if (row?.isPartnerDevelopment && planRank(plan) < planRank("growth")) {
    plan = "growth";
  }
  return plan;
}

/** Plan limits for `getEffectivePlanId`, including a custom quota that is in force. */
export async function getEffectiveLimits(shop, settings) {
  const row =
    settings !== undefined ? settings : await prisma.appSettings.findUnique({ where: { shop } });
  const plan = await getEffectivePlanId(shop, row);
  return applyCustomQuota(getPlanLimits(plan), row, plan);
}

/**
 * Asks Shopify whether this is a Partner development store and records the
 * answer on AppSettings, where getEffectivePlanId can see it. Returns
 * `{ isPartnerDev, displayName }`, or null when the question could not be
 * answered — in which case the stored flag is left exactly as it was.
 *
 * Only an existing settings row is updated. Creating one here would switch on
 * the default daily backup schedule for a store that has not been set up.
 */
export async function refreshPartnerDevelopmentFlag(shop, admin) {
  if (!shop || !admin) return null;

  let planData = null;
  try {
    const resp = await admin.graphql(
      `#graphql
      query getShopPartnerPlan {
        shop {
          plan {
            partnerDevelopment
            displayName
          }
        }
      }`,
    );
    const json = await resp.json();
    planData = json?.data?.shop?.plan || null;
  } catch {
    return null;
  }
  if (!planData) return null;

  const isPartnerDev = Boolean(planData.partnerDevelopment);
  await prisma.appSettings
    .updateMany({
      where: { shop, isPartnerDevelopment: !isPartnerDev },
      data: { isPartnerDevelopment: isPartnerDev },
    })
    .catch((err) => {
      console.warn("[Revertly Billing] Could not store the partner-development flag:", err?.message);
    });

  return {
    isPartnerDev,
    displayName: isPartnerDev ? planData.displayName || "Partner Development" : null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves current active plan for a shop, synchronizing between Shopify billing and AppSettings.
 *
 * This is the one place the stored plan is reconciled with Shopify, so it also
 * records the live subscription id (which the subscription webhook uses to
 * ignore cancellations of subscriptions that have already been replaced),
 * settles the custom-offer status, and refreshes the Partner-development flag.
 */
export async function getStorePlan(shop, billing = null, isTest = true, admin = null) {
  let activeShopifyPlan = null;
  let activeShopifyInterval = null;
  let activeSubscription = null;
  let isCustomSubscription = false;
  let subscriptionDiscountPercent = null;

  // Null when Shopify could not be asked; the stored flag is used instead.
  const partner = admin ? await refreshPartnerDevelopmentFlag(shop, admin) : null;

  // Only a check that actually completed may be used to downgrade a store.
  // A thrown request, or an ACTIVE subscription under a name this build does
  // not recognise, tells us nothing about whether the merchant is paying.
  let noActivePaymentConfirmed = false;

  if (billing) {
    try {
      const billingCheck = await billing.check({ plans: ALL_BILLING_PLAN_NAMES, isTest });

      noActivePaymentConfirmed = !billingCheck?.hasActivePayment;

      if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
        // Find active subscription
        const activeSub = billingCheck.appSubscriptions.find(
          (sub) => !sub.status || sub.status === "ACTIVE"
        ) || billingCheck.appSubscriptions[0];

        const planInfo = planInfoForSubscriptionName(activeSub?.name);
        if (planInfo) {
          activeShopifyPlan = planInfo.planId;
          activeShopifyInterval = planInfo.interval;
          isCustomSubscription = planInfo.isCustom;
          activeSubscription = activeSub;
        }

        if (activeShopifyPlan && activeSub?.lineItems?.[0]?.plan?.pricingDetails?.interval === "ANNUAL") {
          activeShopifyInterval = INTERVAL_ANNUAL;
        }

        subscriptionDiscountPercent = readSubscriptionDiscountPercent(activeSub);

        if (!activeShopifyPlan) {
          // Paying, but the subscription name matched none of the known plans.
          // Leave the stored plan alone rather than dropping the merchant to
          // free while Shopify keeps charging them.
          console.warn(
            `[Revertly Billing] Unrecognised active subscription name for ${shop}: ${JSON.stringify(activeSub?.name)} — leaving stored plan unchanged.`,
          );
        }
      }
    } catch (err) {
      noActivePaymentConfirmed = false;
      console.warn("[Revertly Billing] Shopify billing check warning:", err?.message || err);
    }
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const isSimulated = isSimulatedSubscriptionId(settings?.subscriptionId);
  const isExternalActive =
    settings?.customBillingMethod === "EXTERNAL" && settings?.customPriceStatus === "ACTIVE";
  const isPartnerDev = partner ? partner.isPartnerDev : Boolean(settings?.isPartnerDevelopment);

  let currentPlan = isExternalActive
    ? "enterprise"
    : normalizePlanId(activeShopifyPlan || settings?.planId || "free");

  // If Shopify returned a definitive check, synchronize database (unless plan was activated in test/simulation mode)
  if (billing && !isSimulated && settings) {
    if (activeShopifyPlan) {
      const nextInterval = activeShopifyInterval || INTERVAL_MONTHLY;
      const nextSubscriptionId = activeSubscription?.id || settings.subscriptionId;
      const nextCustomStatus = customStatusForActiveSubscription(settings, isCustomSubscription);
      const needsPlanUpdate =
        settings.planId !== activeShopifyPlan ||
        settings.billingInterval !== nextInterval ||
        settings.subscriptionId !== nextSubscriptionId ||
        settings.customPriceStatus !== nextCustomStatus;
      if (needsPlanUpdate) {
        await prisma.appSettings.update({
          where: { shop },
          data: {
            planId: activeShopifyPlan,
            billingInterval: nextInterval,
            subscriptionId: nextSubscriptionId,
            ...(settings.customPriceStatus !== nextCustomStatus ? { customPriceStatus: nextCustomStatus } : {}),
          },
        });
        Object.assign(settings, {
          planId: activeShopifyPlan,
          billingInterval: nextInterval,
          subscriptionId: nextSubscriptionId,
          customPriceStatus: nextCustomStatus,
        });
      }
      if (!isExternalActive) currentPlan = activeShopifyPlan;
    } else if (noActivePaymentConfirmed && settings.planId !== "free" && !isExternalActive) {
      // Shopify has no active payment, but DB still says paid plan -> downgrade to free
      const lapsedCustom =
        settings.customBillingMethod !== "EXTERNAL" && settings.customPriceStatus === "ACTIVE";
      await prisma.appSettings.update({
        where: { shop },
        data: {
          planId: "free",
          subscriptionId: null,
          billingInterval: INTERVAL_MONTHLY,
          ...(lapsedCustom ? { customPriceStatus: "CANCELLED" } : {}),
        },
      });
      Object.assign(settings, {
        planId: "free",
        subscriptionId: null,
        billingInterval: INTERVAL_MONTHLY,
        ...(lapsedCustom ? { customPriceStatus: "CANCELLED" } : {}),
      });
      currentPlan = "free";
    }
  }

  // A promotional free-Growth seat grants Growth entitlements with no
  // subscription behind it. While a store holds an unexpired seat and is not
  // paying for more than Growth, its *entitlement* is Growth. What it is
  // *billed* for stays exactly what Shopify reports: a store still being
  // charged for Starter must see that charge here, not "No subscription".
  const { getActiveFreeGrowthGrant } = await import("./freeGrowth.server.js");
  const freeGrowthGrant = await getActiveFreeGrowthGrant(shop);

  let effectivePlan = currentPlan;
  let paidPlan = currentPlan;
  let freeGrowthInfo = null;

  if (freeGrowthGrant) {
    const hasHigherPaidPlan = planRank(currentPlan) > planRank("growth");
    if (!hasHigherPaidPlan) {
      effectivePlan = "growth";

      // A simulated (test-mode) subscription is not a charge. Clear it so it
      // never sits beside the promotion looking like one.
      if (settings && isSimulated) {
        await prisma.appSettings.update({
          where: { shop },
          data: { planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
        }).catch((err) => {
          console.warn("[Revertly Billing] Could not reset simulated subscription for free growth:", err?.message);
        });
        paidPlan = "free";
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

  // If this is a verified Shopify Partner development store, elevate to Growth
  // so agencies and freelance developers have full unrestricted testing
  // capabilities. getEffectivePlanId applies the same rule from the stored flag.
  if (isPartnerDev && planRank(effectivePlan) < planRank("growth")) {
    effectivePlan = "growth";
  }

  // Shopify is the authority on whether a real subscription is still in its
  // trial. The stored trialEndsAt is only an estimate made at first activation
  // and is never cleared, so reading it for a later, trial-less subscription
  // told a merchant billed from day one that their trial was still running.
  let trialEndsAt = null;
  if (activeSubscription) {
    const trialDays = Number(activeSubscription.trialDays) || 0;
    const createdAt = activeSubscription.createdAt ? new Date(activeSubscription.createdAt) : null;
    if (trialDays > 0 && createdAt && !Number.isNaN(createdAt.getTime())) {
      trialEndsAt = new Date(createdAt.getTime() + trialDays * DAY_MS);
    }
  } else if (isSimulated && paidPlan !== "free") {
    trialEndsAt = settings?.trialEndsAt || null;
  }

  const limits = applyCustomQuota(getPlanLimits(effectivePlan), settings, effectivePlan);

  return {
    currentPlan: effectivePlan,
    // What the merchant actually pays for, ignoring the promotion.
    paidPlan,
    limits,
    subscriptionDiscountPercent,
    freeGrowth: freeGrowthInfo,
    isPartnerDev,
    partnerDevPlanName: isPartnerDev ? partner?.displayName || "Partner Development" : null,
    billingInterval: resolvedInterval,
    trialEndsAt,
    isCustomSubscription,
    isSimulated,
  };
}

/** Plans activated in test/simulation mode never created a real Shopify charge. */
export function isSimulatedSubscriptionId(subscriptionId) {
  return Boolean(subscriptionId?.startsWith("sim_") || subscriptionId?.startsWith("test_"));
}

/** Ordering of the plan ladder, used to compare entitlement levels. */
export function planRank(planId) {
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

// Restore points the app takes on its own. They rotate out oldest-first to
// keep a store inside its allowance (backup.server.js, reserveRestorePointSlot);
// the merchant's own (MANUAL, which includes imports) never do.
export const AUTOMATIC_RESTORE_POINT_SOURCES = ["SCHEDULED", "THEME_PUBLISH", "BASELINE", "PRE_RESTORE"];

/**
 * Check if the shop can create another restore point.
 *
 * The allowance counts every restore point, but automatic ones make way for a
 * new one, so a store is only full when its own manual points alone fill it.
 * Counting automatic points as blocking meant a Free store's two scheduled
 * backups locked the merchant out of taking a manual one.
 */
export async function checkRestorePointLimit(shop) {
  const plan = await getEffectivePlanId(shop);
  const limits = getPlanLimits(plan);
  const [count, rotatable] = await Promise.all([
    prisma.restorePoint.count({ where: { shop } }),
    prisma.restorePoint.count({
      where: { shop, source: { in: AUTOMATIC_RESTORE_POINT_SOURCES }, status: { notIn: ["CREATING", "RESTORING"] } },
    }),
  ]);

  const allowed = limits.restorePoints === Infinity || count - rotatable < limits.restorePoints;

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

