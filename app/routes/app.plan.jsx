import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  PLAN_TIERS,
  INTERVAL_MONTHLY,
  INTERVAL_ANNUAL,
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_STARTER_ANNUAL,
  PLAN_GROWTH_ANNUAL,
  PLAN_BUSINESS_ANNUAL,
  PLAN_ENTERPRISE_ANNUAL,
  PLAN_ENTERPRISE_CUSTOM,
  ALL_BILLING_PLAN_NAMES,
} from "../billing.constants.js";
import {
  getStorePlan,
  normalizePlanId,
  planRank,
  planInfoForSubscriptionName,
  isSimulatedSubscriptionId,
  PLAN_LIMITS,
} from "../billing.server.js";
import { resolveBestDiscount, resolveDiscounts, getClaimableVipOffer, claimVipOffer } from "../storeDiscount.server.js";
import {
  getFreeGrowthOffer,
  claimFreeGrowthSeat,
  getFreeGrowthStatus,
  getActiveFreeGrowthGrant,
  releaseFreeGrowthSeat,
} from "../freeGrowth.server.js";
import { DISCOUNT_DURATION_MONTHS } from "../discount.constants.js";
import { Banner } from "../components/Banner.jsx";
import { SparklesIcon, ShieldCheckIcon } from "../components/Icons.jsx";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";

/** Rounds to cents and drops a trailing ".00" for a cleaner price tag. */
function formatPrice(amount) {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** Formats date as YYYY-MM-DD to match the Platform Admin status badges. */
function formatDate(d) {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Groups a number for display, pinned to en-US.
 *
 * A bare `toLocaleString()` follows whatever locale the *runtime* has, which
 * is not the merchant's. On the server that is the host's locale, so a store
 * on an en-IN box renders "2,00,000" for every merchant on earth; in the
 * browser it is the viewer's, so the same number arrives from the loader
 * grouped one way and re-renders grouped another, which is a hydration
 * mismatch on top of the wrong digits. Pinning the locale makes the output
 * depend on nothing but the value.
 */
function formatNumber(n) {
  if (n === Infinity) return "Unlimited";
  return Number(n).toLocaleString("en-US");
}

// ── Plan definitions ────────────────────────────────────────────────────────
//
// Every line below must correspond to something the app actually enforces.
// The numeric allowances mirror PLAN_LIMITS in billing.server.js, and each
// capability line maps to a boolean flag there:
//
//   uptimeMonitoring → Starter and above  (uptime.server.js, app.monitoring.jsx)
//   qaSuites         → Starter and above  (qa.server.js, app.qa.jsx)
//   teamRoles        → Starter and above  (app.team.jsx)
//   cloudSync        → Starter and above  (cloudSync.server.js, auth.cloud.$provider)
//   ga4Monitoring    → Starter and above  (ga4Monitor.server.js, app.monitoring.jsx)
//   bulkRollback     → Growth and above   (app.incidents_.$id.jsx)
//   vaultOrders>0    → Growth and above   (checkVaultAccess, app.vault.jsx)
//   marketingBackup  → Growth and above   (checkMarketingBackupAccess)
//   marketingProfiles→ Growth and above   (checkMarketingBackupAccess)
//   metafieldBackup  → Growth and above   (restore-points, app.export, scheduler)
//   themes           → Growth and above   (1 active theme on Growth, every theme on Business+;
//                                          live & draft rollback on Growth+)
//   circuitBreaker   → Business and above (monitor.server.js)
//   slack            → Business and above (app.settings.jsx, sendIncidentAlert)
//   marketingFlows   → Business and above (checkMarketingBackupAccess)
//
// Available on every plan, so listed on Free and inherited upward: product
// and restore-point rollback, selective field restore, the type-to-confirm
// lock on large restores, and the Trust & Security Center with its DPA. A
// line may not appear on a higher card as new ("plus:") when the tier below
// already has it — Enterprise used to list unlimited themes and flows that
// Business already included.
//
// A feature row is normally a plain string. An object of the shape
// { label, badge } renders the same row with a badge after it, used to call
// out a headline capability of the tier. The badge is cosmetic only: the gate
// is always the matching flag in PLAN_LIMITS, never this field. Reserve it for
// a tier that carries no card-level badge of its own — a bullet badge on a
// card that already says "Most Popular" reads as a second promotion competing
// with the first.
//
// { label, kind: "boundary" } renders a muted, unchecked row naming the tier a
// capability starts at. Use it where a gap between adjacent cards would
// otherwise look accidental.
const PLANS = [
  {
    id: "free",
    category: "Free to install",
    name: "Free",
    price: "$0",
    period: "",
    subtext: "Free forever",
    footerText: "Basic protection for new stores",
    features: [
      "Up to 50 products monitored",
      "7 days change history retention",
      // Automatic backups rotate oldest-first inside the allowance
      // (backup.server.js, reserveRestorePointSlot); the merchant's own
      // restore points are never deleted to make room.
      "Up to 2 restore points — automatic backups rotate",
      "1 active detection rule",
      "Manual single-product rollback & full restore from any restore point",
      // restoreDeletedProduct recreates the product as a draft from its
      // snapshot: details, tags and the first variant's price/SKU/barcode.
      "Deleted product recovery — recreated as a draft (details & first variant)",
      "Selective field-level restore — live stock is never overwritten",
      "Type-to-confirm safety lock on large restores",
      "Scheduled backups — daily, twice-daily or weekly",
      "Products, Collections, Pages & Blog backup",
      "Navigation Menu backup & restore — full menu hierarchy",
      "Email drift & bulk-anomaly alerts",
      "Incidents, Activity & Rollback History logs",
      "Offline JSON & CSV export and import",
      "Trust & Security Center with GDPR / CCPA DPA download",
      // Encryption covers the credentials the app holds for connected
      // services (cloud OAuth tokens, ESP API keys) — not backup contents.
      "AES-256-GCM encryption for connected-account credentials",
      "Security Headers & HSTS transport protection",
    ],
  },
  {
    id: "starter",
    category: "Starter Protection",
    name: "Starter",
    price: "$9",
    period: "/ month",
    subtext: "14-day free trial",
    footerText: "For boutiques & small stores",
    features: [
      "Everything in Free, plus:",
      "Up to 1,000 products monitored",
      "30 days change history retention",
      "Up to 10 restore points",
      "3 active detection rules",
      "Store & App Monitoring (24/7 Downtime Alerts)",
      "Automated QA & Backup Health",
      "GA4 & Google Tag Manager tag health alerts",
      "Team roles, permissions & audit log",
      "Offsite Cloud Backup — Google Drive & Dropbox",
      "Auto-push every scheduled backup to your cloud",
      "Bring back any Drive or Dropbox archive as a restore point",
      // Starter has no vault (PLAN_LIMITS.starter.vaultOrders === 0). Stating
      // the boundary here is what keeps the omission from reading as an
      // oversight — a merchant comparing cards should not have to infer it
      // from the absence of a row.
      { label: "Orders & Customers Vault starts at Growth", kind: "boundary" },
    ],
  },
  {
    id: "growth",
    category: "Most Popular",
    name: "Growth",
    price: "$24",
    period: "/ month",
    subtext: "14-day free trial",
    footerText: "For growing retail stores",
    features: [
      "Everything in Starter, plus:",
      "Up to 5,000 products monitored",
      "90 days change history retention",
      "Up to 50 restore points",
      "10 active detection rules",
      "Bulk multi-product incident rollback",
      "Orders & Customers Vault (2,500 most recent orders)",
      "Metafield Backups — values & definitions",
      "Shop, product, collection, page, blog & article metafields",
      "Metafield restore that skips live values by default",
      "Klaviyo & Mailchimp Backup — 10,000 subscriber profiles",
      "Lists, audiences, segments & profile fields captured",
      "Restore a deleted list or re-import lost subscribers",
      // The scheduler captures the live theme for every tier that has theme
      // access at all (scheduler.server.js gates on `themes` and passes no
      // themeId, so fetchThemeBackup falls back to MAIN). That is Growth and
      // above, which is why this says so here rather than on Business. Live
      // and draft theme rollback share the same `themes` gate
      // (app.restore-points_.$id.jsx, restore_theme).
      "1 Active Theme Backup (Templates, Sections & Settings)",
      "Live theme captured in every scheduled backup",
      "Safe Restore to Draft Theme (Live Preview First)",
      "1-Click Theme Code & Asset Rollback to the live theme",
      "Accountant-ready Tax Audit CSV export",
      "Chargeback Dispute Evidence Pack (JSON)",
    ],
  },
  {
    id: "business",
    category: "Store Shield",
    name: "Business",
    price: "$49",
    period: "/ month",
    subtext: "14-day free trial",
    footerText: "For scaling brands & agencies",
    features: [
      "Everything in Growth, plus:",
      "Up to 30,000 products monitored",
      "180 days (6 months) retention",
      "Up to 100 restore points",
      "Unlimited detection rules",
      // What Business adds to theme protection is breadth: every theme on the
      // store, not just the live one. Rollback itself is already on Growth.
      "Unlimited Themes & Liquid Code Backup — drafts included",
      "Orders & Customers Vault (15,000 most recent orders)",
      "Klaviyo & Mailchimp Backup — 50,000 subscriber profiles",
      // Flow capture is an inventory (name, status, trigger), not the flow
      // logic, and Mailchimp's API exposes classic automations only.
      "Klaviyo flow & Mailchimp automation inventory (name, status, trigger)",
      "Emergency Circuit Breaker (Auto-Draft / Auto-Revert)",
      "Real-time Slack Webhook Alerts",
    ],
  },
  {
    id: "enterprise",
    category: "Ultimate Plus",
    name: "Enterprise",
    price: "$99",
    period: "/ month",
    subtext: "14-day free trial",
    footerText: "For Shopify Plus & high volume",
    features: [
      "Everything in Business, plus:",
      // The webhook stops tracking once currentCount >= limits.products
      // (webhooks.products.update.jsx), so 200,000 itself is covered by
      // Enterprise and 200,001 is not. The wording has to say so, because the
      // Enterprise Plus banner below draws the same line from the other side.
      "Up to and including 200,000 products monitored",
      "365 days (1 full year) retention",
      "Unlimited restore points",
      "Orders & Customers Vault (100,000 most recent orders)",
      "Klaviyo & Mailchimp Backup — 250,000 profiles",
      // app.support.jsx raises Enterprise tickets to at least HIGH and the
      // admin queue (app.admin.jsx) serves them ahead of other plans.
      "Priority support queue for your store",
    ],
  },
];

// What each tier includes, in the words the downgrade warning uses. Built
// from PLAN_LIMITS so the warning can only ever name capabilities the target
// plan really lacks.
const CAPABILITY_LABELS = [
  ["uptimeMonitoring", "Store & App uptime monitoring"],
  ["qaSuites", "Automated QA & backup health checks"],
  ["teamRoles", "Team roles & audit log"],
  ["cloudSync", "Offsite Cloud Backup to Google Drive & Dropbox"],
  ["ga4Monitoring", "GA4 tag monitoring"],
  ["bulkRollback", "Bulk incident rollback"],
  ["vaultOrders", "Orders & Customers Vault"],
  ["metafieldBackup", "Metafield backups"],
  ["marketingBackup", "Klaviyo & Mailchimp backup"],
  ["themes", "Liquid theme backups"],
  ["unlimitedThemes", "Backups of every theme, drafts included"],
  ["marketingFlows", "Klaviyo flow & Mailchimp automation backup"],
  ["circuitBreaker", "Emergency Circuit Breaker"],
  ["slack", "Slack alerts"],
];

function capabilitiesFor(planId) {
  const limits = PLAN_LIMITS[planId] || PLAN_LIMITS.free;
  return CAPABILITY_LABELS.filter(([key]) => {
    if (key === "vaultOrders") return limits.vaultOrders > 0;
    if (key === "unlimitedThemes") return limits.themes && limits.themeLimit === Infinity;
    return Boolean(limits[key]);
  }).map(([, label]) => label);
}

/**
 * How many billing cycles a discount may run on a new charge: the grant's own
 * remaining term, never more than the standard 12 months. A 1-year grant taken
 * up in month 11 must not become 12 more discounted months on Shopify.
 */
function discountIntervalsFor(discount, isAnnual) {
  if (isAnnual) return 1;
  if (!discount?.expiresAt) return DISCOUNT_DURATION_MONTHS;
  const msLeft = new Date(discount.expiresAt).getTime() - Date.now();
  const months = Math.ceil(msLeft / (30 * 24 * 60 * 60 * 1000));
  return Math.min(DISCOUNT_DURATION_MONTHS, Math.max(1, months));
}

export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.NODE_ENV !== "production";

  // Returning from Shopify's approval screen is not proof of payment — anyone
  // can type a query string onto this URL. A custom offer is accepted only by
  // getStorePlan, once Shopify reports the dedicated custom subscription as
  // active, so no query parameter is read here.
  const {
    currentPlan,
    paidPlan,
    limits,
    subscriptionDiscountPercent,
    freeGrowth,
    isPartnerDev,
    partnerDevPlanName,
    billingInterval,
    trialEndsAt,
    isCustomSubscription,
    isSimulated,
  } = await getStorePlan(
    shop,
    billing,
    isTest,
    admin,
  );

  const [productCount, restorePointCount, ruleCount, vaultOrderCount, settings, allDiscounts, vipOffer, freeGrowthOffer, freeGrowthStatus, heldSeat] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.restorePoint.count({ where: { shop } }),
    // The rule allowance is a cap on *active* rules (checkRuleLimit), so the
    // usage shown beside it must count the same thing — counting disabled
    // rules made a store within its limit read "3 / 1".
    prisma.detectionRule.count({ where: { shop, isActive: true } }),
    prisma.orderArchive.count({ where: { shop } }),
    prisma.appSettings.findUnique({ where: { shop } }),
    // Both store-specific grant and global yearly promotion, read fresh
    // on every load so admin adjustments appear instantly.
    resolveDiscounts(shop),
    // A VIP offer discounts nothing until the merchant accepts it.
    getClaimableVipOffer(shop),
    // A free Growth seat is likewise claimed, not handed out at install.
    getFreeGrowthOffer(shop),
    getFreeGrowthStatus(),
    // Any seat this store ever held, expired or not.
    prisma.freeGrowthGrant.findUnique({ where: { shop }, select: { id: true } }),
  ]);

  if (settings?.productLimitReachedAt && (limits.products === Infinity || productCount < limits.products)) {
    await prisma.appSettings.update({
      where: { shop },
      data: { productLimitReachedAt: null },
    });
    settings.productLimitReachedAt = null;
  }

  // Which discount the store's current subscription should carry: the store
  // grant on a monthly plan, the larger of store and global on a yearly one.
  // Only that discount can be "waiting to be applied" — the other is not
  // missing from the charge, it is simply not the one that applies.
  const isBilled = paidPlan !== "free" && !isSimulated;
  const currentIntervalDiscount =
    billingInterval === INTERVAL_ANNUAL ? allDiscounts.yearlyDiscount : allDiscounts.monthlyDiscount;
  const describeDiscount = (candidate) =>
    candidate
      ? {
        percent: candidate.percent,
        source: candidate.source,
        label: candidate.label,
        note: candidate.note,
        expiresAt: candidate.expiresAt,
        appliesToCurrentPlan: isBilled && currentIntervalDiscount === candidate,
        needsApply:
          isBilled &&
          currentIntervalDiscount === candidate &&
          subscriptionDiscountPercent !== candidate.percent,
      }
      : null;

  const hasActiveSeat = Boolean(freeGrowth?.isActive);
  const isCustomPlanActive =
    Boolean(limits.isCustomLimit) && (limits.customBillingMethod === "EXTERNAL" || isCustomSubscription || isSimulated);

  return {
    currentPlan,
    // What the store is actually billed for. `currentPlan` can be higher than
    // this when a promotional Growth seat or Partner access is in play, and
    // the two must not be conflated: entitlements follow `currentPlan`, but
    // which plans are an upgrade or a downgrade — and which one Shopify would
    // cancel — follows what is really being paid for.
    paidPlan,
    billingInterval: billingInterval || INTERVAL_MONTHLY,
    limits,
    // The standard Enterprise ceiling, sent rather than hardcoded in the view
    // so the cards, the limit-reached banner and the Enterprise Plus upsell
    // can never drift apart from PLAN_LIMITS or from each other.
    enterpriseProductCap: PLAN_LIMITS.enterprise.products,
    usage: { productCount, restorePointCount, ruleCount, vaultOrderCount },
    shop,
    hasUsedTrial: Boolean(settings?.hasUsedTrial),
    // From Shopify's own subscription record (see getStorePlan), not the
    // estimate stored at first activation.
    trialEndsAt,
    productLimitReachedAt: settings?.productLimitReachedAt || null,
    customPlanOffer: settings?.customProductLimit
      ? {
          products: settings.customProductLimit,
          price: settings.customPriceAmount || 249,
          billingMethod: settings.customBillingMethod || "SHOPIFY",
          status: settings.customPriceStatus || "OFFERED",
          note: settings.customPlanNote || null,
        }
      : null,
    // A custom Enterprise Plus plan the store is actually on.
    customPlan: isCustomPlanActive
      ? { price: limits.customPriceAmount || settings?.customPriceAmount || 249, billingMethod: limits.customBillingMethod }
      : null,
    // A promotional Growth seat: full Growth features, no subscription, no charge.
    freeGrowth: hasActiveSeat ? { expiresAt: freeGrowth.expiresAt } : null,
    // An unexpired seat that a higher paid plan currently outranks. Starter
    // and Growth are still covered by it, so they are not for sale.
    supersededFreeGrowth: freeGrowth && !hasActiveSeat ? { expiresAt: freeGrowth.expiresAt } : null,
    heldFreeGrowthSeat: Boolean(heldSeat),
    // Overall status of the Free Growth promotion (limit, duration, whether sold out)
    freeGrowthStatus: freeGrowthStatus
      ? {
        enabled: freeGrowthStatus.enabled,
        limit: freeGrowthStatus.limit,
        durationMonths: freeGrowthStatus.durationMonths,
        remaining: freeGrowthStatus.remaining,
        isSoldOut: freeGrowthStatus.isSoldOut,
      }
      : null,
    // An unclaimed VIP offer. Nothing is discounted while this is showing.
    vipOffer: vipOffer ? { percent: vipOffer.discountPercent, note: vipOffer.note } : null,
    // An unclaimed free Growth seat. Only worth offering if Growth would
    // actually be an upgrade on what they already have. A Starter subscriber
    // may claim, but claiming cancels that subscription, so the card says so.
    freeGrowthOffer:
      freeGrowthOffer && !isPartnerDev && planRank(currentPlan) < planRank("growth") && planRank(paidPlan) < planRank("growth")
        ? { ...freeGrowthOffer, cancelsPlanName: isBilled ? PLAN_TIERS[paidPlan]?.name : null }
        : null,
    storeDiscount: describeDiscount(allDiscounts.storeDiscount),
    globalDiscount: describeDiscount(allDiscounts.globalDiscount),
    // Set when a yearly subscription carries the larger global discount in
    // place of the store's own — discounts never stack.
    storeDiscountSupersededBy:
      allDiscounts.storeDiscount && isBilled && currentIntervalDiscount === allDiscounts.globalDiscount
        ? allDiscounts.globalDiscount.percent
        : null,
    isBilled,
    isPartnerDev: Boolean(isPartnerDev),
    partnerDevPlanName: partnerDevPlanName || null,
    planCapabilities: Object.fromEntries(Object.keys(PLAN_TIERS).map((id) => [id, capabilitiesFor(id)])),
    planAllowances: Object.fromEntries(
      Object.keys(PLAN_TIERS).map((id) => [
        id,
        { retentionDays: PLAN_LIMITS[id].retentionDays, restorePoints: PLAN_LIMITS[id].restorePoints },
      ]),
    ),
  };
};

/**
 * Every live subscription Shopify reports for this store, each tagged with
 * the plan it stands for. `ok: false` means Shopify could not be asked, which
 * must never be mistaken for "nothing to cancel".
 */
async function readBilledSubscriptions(billing, isTest) {
  try {
    const check = await billing.check({ plans: ALL_BILLING_PLAN_NAMES, isTest });
    const subs = check?.hasActivePayment ? check.appSubscriptions || [] : [];
    return { ok: true, subs: subs.map((sub) => ({ ...sub, info: planInfoForSubscriptionName(sub.name) })) };
  } catch (err) {
    console.warn("[Revertly Billing] Shopify billing check failed:", err?.message || err);
    return { ok: false, subs: [] };
  }
}

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  const billingPerm = await checkPermission(shop, session, PERMISSIONS.BILLING_MANAGE);
  if (!billingPerm.allowed) {
    return { success: false, message: billingPerm.message };
  }
  // Billing changes are the most consequential thing a team member can do,
  // so each one is recorded against the person who made it.
  const audit = (action, details, resourceType = "Subscription") =>
    logAudit(shop, billingPerm.actor, action, { resourceType, details, request });

  const formData = await request.formData();
  const isTest = process.env.NODE_ENV !== "production";
  const intent = formData.get("intent");
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const isExternalContract =
    settings?.customBillingMethod === "EXTERNAL" && settings?.customPriceStatus === "ACTIVE";
  const isShopifyCustomPlan =
    Boolean(settings?.customProductLimit) &&
    settings?.customBillingMethod !== "EXTERNAL" &&
    settings?.customPriceStatus === "ACTIVE";

  // ── Claiming a free Growth seat ──────────────────────────────────────────
  if (intent === "claimFreeGrowth") {
    if (settings?.isPartnerDevelopment) {
      return {
        success: false,
        message: "Partner development stores already have every Growth feature at no charge, so there is no seat to claim.",
      };
    }

    // Eligibility is decided from what Shopify is really billing — the page
    // only hides the offer, and a stale tab or a hand-built request would
    // otherwise let a Business store spend a seat and reset its own plan.
    const billed = await readBilledSubscriptions(billing, isTest);
    if (!billed.ok && !isTest) {
      return {
        success: false,
        message: "We couldn't confirm your current subscription with Shopify, so nothing was changed. Please try again.",
      };
    }
    const paidRanks = billed.subs.map((sub) => (sub.info ? planRank(sub.info.planId) : planRank("enterprise")));
    if (isSimulatedSubscriptionId(settings?.subscriptionId)) paidRanks.push(planRank(settings.planId));
    if (isExternalContract) paidRanks.push(planRank("enterprise"));
    const highestPaid = Math.max(0, ...paidRanks);
    if (highestPaid >= planRank("growth")) {
      return {
        success: false,
        message: "Your current plan already includes every Growth feature, so the free Growth seat isn't available to your store.",
      };
    }

    // Secure the seat before touching the subscription: cancelling first and
    // then losing the race for the last seat would leave the store with
    // neither.
    const grant = await claimFreeGrowthSeat(shop);
    if (!grant) {
      return {
        success: false,
        message:
          "Those free Growth seats have all been taken. Refresh the page to see your current options.",
      };
    }

    // Anything still billing below Growth (Starter) is now redundant, and the
    // offer promised there would be nothing to pay.
    const cancelled = [];
    for (const sub of billed.subs.filter((s) => s.id)) {
      try {
        await billing.cancel({ subscriptionId: sub.id, isTest, prorate: true });
        cancelled.push(sub.name);
      } catch (cancelErr) {
        console.error("[Revertly Billing] Could not cancel", sub.id, "while claiming Free Growth:", cancelErr?.message || cancelErr);
        await releaseFreeGrowthSeat(shop);
        return {
          success: false,
          message: `We couldn't cancel your ${sub.name} subscription with Shopify, so the free Growth seat was not claimed and nothing has changed. Please try again, or contact support.`,
        };
      }
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
      update: { planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
    }).catch(() => { });

    await audit(
      "FREE_GROWTH_CLAIMED",
      {
        expiresAt: grant.expiresAt,
        durationMonths: Math.max(1, Math.round((new Date(grant.expiresAt).getTime() - new Date(grant.grantedAt).getTime()) / (30 * 24 * 60 * 60 * 1000))),
        cancelledSubscriptions: cancelled,
      },
      "FreeGrowthGrant",
    );

    return {
      success: true,
      planId: "growth",
      // An entitlement, not a subscription — so this result must not be read as
      // a change to what the store is billed for.
      promotional: true,
      freeGrowth: { expiresAt: grant.expiresAt },
      message:
        `Free Growth promotion activated! Full Growth features are unlocked free of charge through ${formatDate(grant.expiresAt)}. There is no subscription and nothing to pay.` +
        (cancelled.length ? ` Your ${cancelled.join(", ")} subscription was cancelled, with a prorated credit from Shopify.` : ""),
    };
  }

  // ── Accepting a VIP offer ────────────────────────────────────────────────
  if (intent === "claimVip") {
    const claimed = await claimVipOffer(shop);
    if (!claimed) {
      return {
        success: false,
        message: "That VIP offer is no longer available. Refresh the page to see your current pricing.",
      };
    }

    await audit(
      "VIP_DISCOUNT_CLAIMED",
      {
        discountPercent: claimed.discountPercent,
        claimedAt: claimed.claimedAt,
        expiresAt: claimed.expiresAt,
        durationMonths: DISCOUNT_DURATION_MONTHS,
      },
      "StoreDiscount",
    );

    return {
      success: true,
      message: `VIP discount activated — ${claimed.discountPercent}% off for the next ${DISCOUNT_DURATION_MONTHS} months, through ${formatDate(claimed.expiresAt)}.`,
    };
  }

  // ── Activating a Custom Enterprise Plus Offer ─────────────────────────────
  if (intent === "activateCustomPlus") {
    if (!settings?.customProductLimit) {
      return { success: false, message: "No custom plan offer is currently configured for this store." };
    }
    if (settings.customPriceStatus === "ACTIVE") {
      return { success: false, message: "Your Custom Enterprise Plus plan is already active." };
    }

    const customPrice = settings.customPriceAmount || 249;
    const customQuota = settings.customProductLimit;

    // If it's a direct contract handled externally
    if (settings.customBillingMethod === "EXTERNAL") {
      await prisma.appSettings.update({
        where: { shop },
        data: {
          planId: "enterprise",
          customPriceStatus: "ACTIVE",
          productLimitReachedAt: null,
        },
      });
      await audit("CUSTOM_PLAN_ACTIVATED", { billingMethod: "EXTERNAL", products: customQuota, price: customPrice });
      return {
        success: true,
        planId: "enterprise",
        message: `Custom Enterprise Plus (${formatNumber(customQuota)} products) is active under your direct contract.`,
      };
    }

    // In-app Shopify billing request, under the dedicated custom plan name so
    // that only this charge — never a standard Enterprise one — can accept
    // the offer (billing.server.js, customStatusForActiveSubscription).
    const url = new URL(request.url);
    const returnUrl = `${url.origin}/app/plan`;

    try {
      await audit("CUSTOM_PLAN_REQUESTED", { billingMethod: "SHOPIFY", products: customQuota, price: customPrice });
      return await billing.request({
        plan: PLAN_ENTERPRISE_CUSTOM,
        isTest,
        returnUrl,
        trialDays: 0,
        lineItems: [
          {
            amount: customPrice,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days,
          },
        ],
      });
    } catch (err) {
      if (err instanceof Response) {
        throw err;
      }
      console.warn("[Revertly Billing] Custom Plus billing.request failed:", err?.message || err);

      // A failed charge request is never a reason to hand out the plan. Only
      // a development/test build — which has no real charge to create — may
      // simulate the activation.
      if (!isTest) {
        return {
          success: false,
          message: "We couldn't start the Shopify approval for your Custom Enterprise Plus plan. Nothing has been changed — please try again, or contact support.",
        };
      }

      const simSubId = `sim_custom_plus_${Date.now()}`;
      await prisma.appSettings.update({
        where: { shop },
        data: {
          planId: "enterprise",
          subscriptionId: simSubId,
          billingInterval: INTERVAL_MONTHLY,
          customPriceStatus: "ACTIVE",
          productLimitReachedAt: null,
        },
      });
      await audit("CUSTOM_PLAN_ACTIVATED", { billingMethod: "SHOPIFY", simulated: true, products: customQuota, price: customPrice });

      return {
        success: true,
        planId: "enterprise",
        message: `Custom Enterprise Plus plan ($${customPrice}/mo for ${formatNumber(customQuota)} products) activated in test mode — no charge was created.`,
      };
    }
  }

  // Resolved strictly, NOT through normalizePlanId(): that maps anything it
  // doesn't recognise — a typo, a stale form, a missing field — to "free",
  // which here is the branch that cancels the merchant's subscription. An
  // unrecognised plan must be refused, never silently downgraded.
  const rawPlanId = String(formData.get("planId") ?? "").trim().toLowerCase();
  const targetPlanId = rawPlanId === "pro" ? "growth" : rawPlanId;
  if (!PLAN_TIERS[targetPlanId]) {
    return {
      success: false,
      message: "That plan isn't available. Pick a plan from the list below and try again.",
    };
  }

  const rawInterval = String(formData.get("interval") ?? "monthly").toLowerCase();
  const isAnnual = rawInterval === "annual" || rawInterval === "yearly";
  const targetInterval = isAnnual ? INTERVAL_ANNUAL : INTERVAL_MONTHLY;

  const currentPlan = normalizePlanId(settings?.planId);
  const currentInterval = settings?.billingInterval || (settings?.subscriptionId?.includes("annual") ? INTERVAL_ANNUAL : INTERVAL_MONTHLY);
  const targetTier = PLAN_TIERS[targetPlanId];

  // Plans priced outside the standard list cannot be changed from here. An
  // external contract is not billed through Shopify at all, so "downgrading"
  // it here reported success and changed nothing.
  if (isExternalContract) {
    return {
      success: false,
      message: "Your store is on a Custom Enterprise Plus contract billed outside Shopify. To change or cancel it, contact our team — nothing has been changed.",
    };
  }
  // Re-requesting Enterprise would swap the negotiated charge for the
  // standard price list while the custom quota stayed on.
  if (isShopifyCustomPlan && targetPlanId === "enterprise") {
    return {
      success: false,
      message: `Your store is on a Custom Enterprise Plus plan ($${settings.customPriceAmount || 249}/month). To change its billing, contact our team — nothing has been changed.`,
    };
  }

  // Growth that the store already has for nothing is not for sale. Buying
  // Starter or Growth beside it charged the merchant for no extra access.
  const seat = await getActiveFreeGrowthGrant(shop);
  if (targetPlanId !== "free" && planRank(targetPlanId) <= planRank("growth")) {
    if (seat) {
      return {
        success: false,
        message: `Growth is already included free on your store until ${formatDate(seat.expiresAt)}, so there is nothing to buy on ${targetTier.name}.${planRank(currentPlan) > planRank("growth") ? " Choose Free to stop paying and keep Growth until then." : ""}`,
      };
    }
    if (settings?.isPartnerDevelopment) {
      return {
        success: false,
        message: `Your Partner development store already has Growth at no charge, so there is nothing to buy on ${targetTier.name}.`,
      };
    }
  }

  // The single best discount this store qualifies for on the requested interval,
  // applied to the real Shopify charge — not just the price shown on this page.
  const activeDiscount = await resolveBestDiscount(shop, isAnnual ? INTERVAL_ANNUAL : INTERVAL_MONTHLY);

  const isSamePlan = targetPlanId === currentPlan;
  const isSameInterval = targetInterval === currentInterval;
  const isDiscountReissue = isSamePlan && isSameInterval;

  if (isDiscountReissue) {
    // Re-requesting the current plan is normally a no-op, but it is the only
    // way to move an existing subscriber onto a discounted subscription.
    const canReissueForDiscount = Boolean(activeDiscount) && targetPlanId !== "free";
    if (!canReissueForDiscount) {
      return {
        success: false,
        message: `Your store is already subscribed to the ${PLAN_TIERS[currentPlan]?.name || currentPlan} plan (${isAnnual ? "Yearly" : "Monthly"}).`,
      };
    }
  }

  if (targetPlanId === "free") {
    let allCancelled = true;
    const cancelledIds = [];
    const isSimulated = isSimulatedSubscriptionId(settings?.subscriptionId);

    if (!isSimulated) {
      const billed = await readBilledSubscriptions(billing, isTest);
      if (!billed.ok && !isTest) {
        allCancelled = false;
      }
      for (const sub of billed.subs) {
        if (!sub.id) continue;
        try {
          await billing.cancel({
            subscriptionId: sub.id,
            isTest,
            prorate: true,
          });
          cancelledIds.push(sub.id);
        } catch (cancelErr) {
          allCancelled = false;
          console.error("[Revertly Billing] Failed to cancel subscription", sub.id, cancelErr?.message || cancelErr);
        }
      }

      if (!allCancelled) {
        return {
          success: false,
          message: "We couldn't cancel your active subscription with Shopify. Your plan has not been changed — please try again, or contact support.",
        };
      }
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
      // Disarm paid protections at the moment of downgrade, exactly as the
      // app_subscriptions/update webhook does for a Shopify-side cancellation.
      // Without this, a downgrade made here (and every simulated one, which
      // fires no webhook at all) leaves Settings reporting the Circuit Breaker
      // as "Armed" for a plan that no longer includes it. A Shopify-billed
      // custom plan ends with its subscription, so its quota ends too.
      update: {
        planId: "free",
        subscriptionId: null,
        billingInterval: INTERVAL_MONTHLY,
        circuitBreakerEnabled: false,
        ...(isShopifyCustomPlan ? { customPriceStatus: "CANCELLED" } : {}),
      },
    });

    await audit("PLAN_DOWNGRADED", {
      from: currentPlan,
      to: "free",
      cancelledSubscriptionIds: cancelledIds,
      simulated: isSimulated,
    });

    return {
      success: true,
      planId: "free",
      billingInterval: INTERVAL_MONTHLY,
      message: "Successfully downgraded to the Free plan. Paid features will be deactivated.",
    };
  }

  let targetShopifyPlan = isAnnual ? PLAN_STARTER_ANNUAL : PLAN_STARTER;
  if (targetPlanId === "growth") targetShopifyPlan = isAnnual ? PLAN_GROWTH_ANNUAL : PLAN_GROWTH;
  else if (targetPlanId === "business") targetShopifyPlan = isAnnual ? PLAN_BUSINESS_ANNUAL : PLAN_BUSINESS;
  else if (targetPlanId === "enterprise") targetShopifyPlan = isAnnual ? PLAN_ENTERPRISE_ANNUAL : PLAN_ENTERPRISE;

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/plan`;

  const targetPrice = isAnnual ? targetTier?.yearlyPrice : targetTier?.price;

  // Active discount resolved for the selected billing interval.
  const isDiscountEligible = Boolean(activeDiscount && activeDiscount.percent > 0);

  const lineItemOverrides = isDiscountEligible
    ? {
      lineItems: [
        {
          amount: targetPrice,
          currencyCode: "USD",
          interval: isAnnual ? BillingInterval.Annual : BillingInterval.Every30Days,
          discount: {
            durationLimitInIntervals: discountIntervalsFor(activeDiscount, isAnnual),
            value: { percentage: activeDiscount.percent / 100 },
          },
        },
      ],
    }
    : {};

  // The 14-day trial in shopify.server.js is per *plan*, so without this a
  // merchant could subscribe, trial, downgrade to Free and re-subscribe for
  // another free 14 days, indefinitely. `hasUsedTrial` is already recorded on
  // first activation (here and in the app_subscriptions/update webhook); this
  // is the point where it is finally honoured.
  const trialOverride = settings?.hasUsedTrial ? { trialDays: 0 } : {};

  const currentOrder = PLAN_TIERS[currentPlan]?.order ?? 0;
  const targetOrder = PLAN_TIERS[targetPlanId]?.order ?? 0;
  const cycleLabel = isAnnual ? "Yearly" : "Monthly";

  try {
    await audit("PLAN_CHANGE_REQUESTED", {
      from: currentPlan,
      to: targetPlanId,
      interval: targetInterval,
      discountPercent: isDiscountEligible ? activeDiscount.percent : null,
    });
    return await billing.request({
      plan: targetShopifyPlan,
      isTest,
      returnUrl,
      ...trialOverride,
      ...lineItemOverrides,
    });
  } catch (err) {
    if (err instanceof Response) {
      throw err;
    }

    console.error("[Revertly Billing Error] billing.request failed:", err);

    const errorList = Array.isArray(err?.errorData)
      ? err.errorData.map((e) => e?.message || (typeof e === "string" ? e : JSON.stringify(e))).filter(Boolean)
      : [];
    const detailedMessage = errorList.join(" | ");
    const isDistributionError =
      detailedMessage.toLowerCase().includes("public distribution") ||
      (err?.message && err.message.toLowerCase().includes("public distribution"));

    // Only a development/test build may stand in for Shopify. In production a
    // failed charge request — including an app that is not yet publicly
    // distributed — must leave the plan exactly as it was: simulating it
    // there handed out paid plans for free, under a `sim_` subscription the
    // billing sync then never re-checked.
    if (isTest) {
      const simSubId = `sim_${targetPlanId}_${isAnnual ? "annual_" : ""}${Date.now()}`;
      const startsTrial = !settings?.hasUsedTrial;
      const trialEndsAt = startsTrial ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) : null;

      await prisma.appSettings.upsert({
        where: { shop },
        create: {
          shop,
          planId: targetPlanId,
          subscriptionId: simSubId,
          billingInterval: targetInterval,
          hasUsedTrial: true,
          trialEndsAt,
        },
        update: {
          planId: targetPlanId,
          subscriptionId: simSubId,
          billingInterval: targetInterval,
          hasUsedTrial: true,
          // A store that already had its trial gets no new one, and must
          // not be shown one either.
          ...(startsTrial ? { trialEndsAt } : {}),
        },
      });

      await audit("PLAN_CHANGED", {
        from: currentPlan,
        to: targetPlanId,
        interval: targetInterval,
        discountPercent: isDiscountEligible ? activeDiscount.percent : null,
        simulated: true,
      });

      let successMessage;
      if (isDiscountReissue) {
        successMessage = `Applied your ${activeDiscount.percent}% discount to the ${targetTier?.name} plan (${cycleLabel}).`;
      } else if (isSamePlan) {
        successMessage = `Successfully updated billing cycle to ${cycleLabel} for ${targetTier?.name} plan.`;
      } else if (targetOrder < currentOrder) {
        successMessage = `Successfully switched to ${targetTier?.name} plan (${cycleLabel}).`;
      } else {
        successMessage = `Successfully upgraded to ${targetTier?.name} (${cycleLabel}${startsTrial ? ", 14-day trial active" : ", billed from day one"}).`;
      }
      successMessage += isDistributionError
        ? " Test mode — no charge was created. (Partner Note: To test live Shopify billing screens, select 'Public distribution' in Partner Dashboard > Apps > Distribution.)"
        : " Test mode — no charge was created.";

      return {
        success: true,
        planId: targetPlanId,
        billingInterval: targetInterval,
        message: successMessage,
      };
    }

    return {
      success: false,
      message: isDistributionError
        ? "Shopify billing isn't available for this app yet (it needs public distribution), so no charge was created and your plan has not been changed. Please contact support."
        : `Unable to initiate Shopify billing for ${targetShopifyPlan}: ${detailedMessage || err?.message || "Please try again or contact support."} Your plan has not been changed.`,
    };
  }
};

export default function Plan() {
  const {
    currentPlan,
    paidPlan,
    billingInterval,
    usage,
    limits,
    hasUsedTrial,
    trialEndsAt,
    productLimitReachedAt,
    customPlanOffer,
    customPlan,
    storeDiscount,
    globalDiscount,
    storeDiscountSupersededBy,
    isBilled,
    freeGrowth,
    supersededFreeGrowth,
    heldFreeGrowthSeat,
    freeGrowthStatus,
    vipOffer,
    freeGrowthOffer,
    shop,
    enterpriseProductCap,
    isPartnerDev,
    partnerDevPlanName,
    planCapabilities,
    planAllowances,
  } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;

  // The catalog ceiling in force for this store: their approved custom quota
  // if they have one, otherwise the standard Enterprise cap. `>` and not `>=`
  // because the cap itself is included — webhooks.products.update.jsx stops
  // tracking at `currentCount >= limits.products`, so the first count the cap
  // cannot serve is cap + 1.
  const catalogCap = limits?.isCustomLimit ? limits.products : enterpriseProductCap;
  const isOverCatalogCap = catalogCap !== Infinity && usage.productCount > catalogCap;
  const activePlan = result?.planId || currentPlan;
  const activeInterval = result?.billingInterval || billingInterval || "EVERY_30_DAYS";
  const activeFreeGrowth = result?.freeGrowth || freeGrowth;
  const isSubmitting = fetcher.state !== "idle";

  const [billingCycle, setBillingCycle] = useState(
    activeInterval === "ANNUAL" ? "annual" : "monthly"
  );
  const [confirmModal, setConfirmModal] = useState(null);
  const cancelButtonRef = useRef(null);

  // Auto-close confirmation modal once an action result returns
  useEffect(() => {
    if (result) {
      setConfirmModal(null);
    }
  }, [result]);

  // While the modal is open, Escape closes it wherever focus is, and focus
  // starts on the safe choice. The overlay's own onKeyDown only ever fired
  // once focus was already inside it, which it never was on open.
  useEffect(() => {
    if (!confirmModal) return undefined;
    cancelButtonRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape" && !isSubmitting) setConfirmModal(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmModal, isSubmitting]);

  // Upgrade/downgrade is a statement about *money*, so it is measured against
  // the plan being billed, not against an entitlement handed out by the
  // promotion. Measuring it against `activePlan` labelled Starter a
  // "downgrade" for a promotional Growth store that would in fact start paying
  // $9, and offered it a "Downgrade to Free" that the action then rejected as
  // "already subscribed to the Free plan".
  const billedPlan = result?.planId && !result.promotional ? result.planId : paidPlan;
  const billedOrder = PLAN_TIERS[billedPlan]?.order ?? 0;
  const trialStillActive = trialEndsAt && new Date(trialEndsAt) > new Date();

  // Growth the store holds without paying for it: a promotional seat, or the
  // access every Partner development store gets. Either way the Growth card
  // is the current plan on both billing toggles — there is no interval to
  // switch — and the tiers it already covers are not for sale.
  const isPartnerGrowth = Boolean(isPartnerDev) && billedOrder < PLAN_TIERS.growth.order;
  const complimentaryGrowth = activeFreeGrowth
    ? { kind: "promotion", until: activeFreeGrowth.expiresAt }
    : isPartnerGrowth
      ? { kind: "partner" }
      : null;
  // A seat outranked by a paid Business/Enterprise plan still covers Starter
  // and Growth, which the action therefore refuses to sell.
  const seatCoverage = activeFreeGrowth || supersededFreeGrowth;
  const coveredLabel = complimentaryGrowth?.kind === "partner"
    ? "Included with Partner access"
    : seatCoverage
      ? `Included free until ${formatDate(seatCoverage.expiresAt)}`
      : null;

  function trialSubtext(plan) {
    if (plan.id === "free") return plan.subtext;
    if (activePlan === plan.id && trialStillActive) {
      return `Trial active until ${formatDate(trialEndsAt)}`;
    }
    // The trial is once per store, so keep advertising it only while it is
    // still on offer — see the trialDays override in the action.
    if (hasUsedTrial) return "Billed from day one";
    return plan.subtext;
  }

  // What a downgrade really takes away: capabilities of the plan the store is
  // entitled to now that the target plan lacks. A store keeping Growth
  // through a seat or Partner access keeps Growth's capabilities too.
  function capabilitiesLostTo(targetPlanId) {
    const keepsGrowth = (seatCoverage || isPartnerDev) && PLAN_TIERS[targetPlanId].order < PLAN_TIERS.growth.order;
    const targetEntitlement = keepsGrowth ? "growth" : targetPlanId;
    const kept = new Set(planCapabilities?.[targetEntitlement] || []);
    return (planCapabilities?.[activePlan] || []).filter((c) => !kept.has(c));
  }

  return (
    <s-page heading="Plans & Billing" inlineSize="large">

      {/* ── Action Result Banner ── */}
      {result?.message && (
        <Banner
          tone={result.success ? "success" : "critical"}
          title={result.success ? "Subscription Updated" : "Billing Notice"}
        >
          {result.message}
        </Banner>
      )}

      {/* ── Product Limit Reached Alert ── */}
      {productLimitReachedAt && (
        <Banner
          tone="critical"
          title="Monitored Product Capacity Reached"
          action={
            currentPlan === "enterprise" ? (
              <Link
                to={`/app/support?category=Billing&priority=HIGH&subject=${encodeURIComponent(`Custom Enterprise Plus Plan Quote (> ${formatNumber(limits.products)} products)`)}&products=${usage.productCount}`}
                className="rv-btn rv-btn-critical rv-btn-sm"
              >
                Request Custom Plus Tier
              </Link>
            ) : null
          }
        >
          {/* A store on a custom quota is still planId "enterprise", so quoting
              a fixed 200,000 here told a merchant with an approved 500,000
              capacity that they had run out at 200,000. The ceiling they
              actually hit is the one in their own limits. */}
          {currentPlan === "enterprise"
            ? `Your store has reached the ${formatNumber(limits.products)} product limit for your ${limits.isCustomLimit ? "custom Enterprise quota" : "Enterprise plan"}. Newly added products are no longer tracked. Contact us for a Custom Enterprise Plus setup tailored for high-volume catalogs.`
            : "You've reached your plan's monitored product limit — newly added products are no longer being tracked. Upgrade below to resume 24/7 protection across all products."}
        </Banner>
      )}

      {/* ── Custom Quota Active Notice ── */}
      {limits?.isCustomLimit && (
        <Banner
          tone="success"
          title="Custom Enterprise Quota Active"
        >
          Your store has an approved custom capacity of{" "}
          <strong>{formatNumber(limits.products)} products</strong>
          {limits.customPriceAmount ? (
            <span> at <strong>${limits.customPriceAmount}/month</strong> ({limits.customBillingMethod === "EXTERNAL" ? "Direct Contract" : "Shopify Billing"})</span>
          ) : null}
          . Continuous tracking and backups are active for your high-volume catalog.
        </Banner>
      )}

      {/* ── Pending Custom Enterprise Plus Offer ── */}
      {customPlanOffer && customPlanOffer.status === "OFFERED" && (
        <div
          className="rv-card rv-fade-in"
          style={{
            marginBottom: "20px",
            borderColor: "var(--rv-primary)",
            background: "linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(124, 58, 237, 0.04) 100%)",
            boxShadow: "0 4px 16px rgba(99, 102, 241, 0.12)",
          }}
        >
          <div
            className="rv-card-body"
            style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}
          >
            <div className="rv-card-icon-badge info" style={{ width: "40px", height: "40px" }}>
              <SparklesIcon size={24} />
            </div>
            <div style={{ flex: 1, minWidth: "260px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                <span className="rv-badge rv-badge-primary" style={{ fontWeight: 800 }}>
                  EXCLUSIVE CUSTOM OFFER
                </span>
                <span className="rv-badge rv-badge-success" style={{ fontWeight: 800 }}>
                  ${customPlanOffer.price} / month
                </span>
              </div>
              <h3 style={{ margin: "0 0 4px", fontSize: "17px", fontWeight: 800, color: "var(--rv-text)" }}>
                Your Custom Enterprise Plus Plan ({formatNumber(customPlanOffer.products)} Products) is Ready!
              </h3>
              <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                {customPlanOffer.note
                  ? customPlanOffer.note
                  : `Your store has been approved for a tailored catalog capacity of ${formatNumber(customPlanOffer.products)} products with full Enterprise protections, priority sync queue, and 365-day change retention.`}
              </p>
            </div>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="activateCustomPlus" />
              <button
                type="submit"
                disabled={isSubmitting}
                className="rv-btn rv-btn-primary rv-btn-lg"
                style={{ fontWeight: 700, whiteSpace: "nowrap" }}
              >
                <SparklesIcon size={16} />
                <span>
                  {isSubmitting
                    ? "Processing..."
                    : customPlanOffer.billingMethod === "EXTERNAL"
                    ? "Activate Contract Plan"
                    : `Approve via Shopify Billing ($${customPlanOffer.price}/mo) →`}
                </span>
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Unclaimed Free Growth Seat ──
          Seats are consumed on claim, not at install, so this is a live
          first-come offer and the remaining count is real. */}
      {freeGrowthOffer && (
        <div
          className="rv-card rv-fade-in"
          style={{ marginBottom: "20px", borderColor: "var(--rv-primary-border)" }}
        >
          <div className="rv-card-body" style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <div className="rv-card-icon-badge success">
              <ShieldCheckIcon size={22} />
            </div>
            <div style={{ flex: 1, minWidth: "260px" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 800, color: "var(--rv-text)" }}>
                Get the Growth plan free — {freeGrowthOffer.remaining} of {freeGrowthOffer.limit} places left
              </h3>
              <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                Claim your place to unlock every Growth feature at no charge for{" "}
                {freeGrowthOffer.durationMonths} months. No subscription is created and there is nothing to
                pay. Places are first come, first served — your {freeGrowthOffer.durationMonths} months start
                the day you claim.
              </p>
              {freeGrowthOffer.cancelsPlanName && (
                <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--rv-text)", lineHeight: 1.5 }}>
                  <strong>Claiming cancels your {freeGrowthOffer.cancelsPlanName} subscription</strong>, with a
                  prorated credit from Shopify, so you are not charged for both. When the promotion ends your store
                  returns to the Free plan, and you can subscribe to any plan again at that point.
                </p>
              )}
            </div>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="claimFreeGrowth" />
              <button
                type="submit"
                disabled={isSubmitting}
                className="rv-btn rv-btn-primary rv-btn-lg"
                style={{ fontWeight: 700, whiteSpace: "nowrap" }}
              >
                <ShieldCheckIcon size={16} />
                <span>{isSubmitting ? "Activating..." : "Claim free Growth plan"}</span>
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Unclaimed VIP Offer ──
          A VIP discount does nothing until the merchant accepts it, and the
          12-month term starts from the claim, so this is an explicit action
          rather than a passive banner. */}
      {vipOffer && (
        <div
          className="rv-card rv-fade-in"
          style={{ marginBottom: "20px", borderColor: "var(--rv-primary-border)" }}
        >
          <div className="rv-card-body" style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <div className="rv-card-icon-badge success">
              <SparklesIcon size={22} />
            </div>
            <div style={{ flex: 1, minWidth: "260px" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 800, color: "var(--rv-text)" }}>
                You have a VIP offer: {vipOffer.percent}% off
              </h3>
              <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.5 }}>
                Claim it to lock in {vipOffer.percent}% off any paid plan for the next {DISCOUNT_DURATION_MONTHS}{" "}
                months. Your {DISCOUNT_DURATION_MONTHS} months start the day you claim, so nothing is lost by
                deciding later — but the discount does not apply until you do.
              </p>
              {vipOffer.note && (
                <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--rv-text-subdued)", fontStyle: "italic" }}>
                  {vipOffer.note}
                </p>
              )}
            </div>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="claimVip" />
              <button
                type="submit"
                disabled={isSubmitting}
                className="rv-btn rv-btn-primary rv-btn-lg"
                style={{ fontWeight: 700, whiteSpace: "nowrap" }}
              >
                <SparklesIcon size={16} />
                <span>{isSubmitting ? "Activating..." : `Claim ${vipOffer.percent}% VIP discount`}</span>
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* ── Partner Development Store VIP Banner ── */}
      {isPartnerDev && (
        <Banner
          tone="success"
          title="Verified Shopify Partner Store: Free Unrestricted Access"
          className="rv-fade-in"
        >
          We detected that this is a <strong>Shopify Partner Development Store</strong> ({partnerDevPlanName || "Development"}). As part of our agency partner program, you have full unrestricted access to <strong>Growth Plan Protection</strong> at <strong>$0 / month</strong> forever. Build, test, and protect client stores with zero subscription charges!
        </Banner>
      )}

      {/* ── Free Growth Promotion Banner ──
          A promotional seat: Growth features at no charge, no subscription. */}
      {activeFreeGrowth && (
        <Banner tone="success" title="Free Growth Promotion Active" className="rv-fade-in">
          You claimed the Free Growth promotion{freeGrowthStatus?.limit ? ` from the first ${freeGrowthStatus.limit} stores offer` : ""}. Every Growth feature is unlocked on your
          account at no charge until {formatDate(activeFreeGrowth.expiresAt)}. There is no
          subscription and nothing to pay. You can still upgrade to Business or Enterprise at any time.
        </Banner>
      )}

      {/* ── Free Growth Sold Out Notice ──
          Only news to a store that could have wanted a seat: never to one that
          holds (or held) a seat, already has Growth or better, or when the
          operator simply switched the promotion off or closed it at 0 seats. */}
      {!activeFreeGrowth &&
        !freeGrowthOffer &&
        !heldFreeGrowthSeat &&
        !isPartnerDev &&
        billedOrder < PLAN_TIERS.growth.order &&
        freeGrowthStatus?.enabled &&
        freeGrowthStatus.limit > 0 &&
        freeGrowthStatus.isSoldOut && (
        <Banner tone="info" title="Free Growth Promotion Concluded" className="rv-fade-in">
          The Free Growth offer for the first {freeGrowthStatus.limit} merchants has reached capacity and been fully claimed. Standard store protection plans are available below.
        </Banner>
      )}

      {/* ── Store-Specific Discount Banner ──
          Shown whenever the platform admin has granted an individual discount to this store. */}
      {storeDiscount && (
        <Banner
          tone={storeDiscount.needsApply ? "warning" : "success"}
          title={
            storeDiscount.needsApply
              ? `${storeDiscount.label}: ${storeDiscount.percent}% ready to apply`
              : `${storeDiscount.label}: ${storeDiscount.percent}% off`
          }
          className="rv-fade-in"
        >
          {storeDiscount.needsApply ? (
            <>
              Your {storeDiscount.percent}% {storeDiscount.source === "VIP" ? "VIP " : ""}account discount
              {storeDiscount.expiresAt && <> is valid through {formatDate(storeDiscount.expiresAt)}</>},
              but it is not applied to your current subscription yet. Use{" "}
              <strong>Apply my {storeDiscount.percent}% discount</strong> on your active plan below to switch to
              the discounted price.
            </>
          ) : storeDiscountSupersededBy ? (
            // Discounts never stack: a yearly plan takes the larger of the
            // store grant and the global yearly discount.
            <>
              Your {storeDiscount.percent}% {storeDiscount.source === "VIP" ? "VIP " : ""}account discount is on file
              {storeDiscount.expiresAt && <>, valid through {formatDate(storeDiscount.expiresAt)}</>}. Your yearly
              subscription already carries the larger {storeDiscountSupersededBy}% Global Yearly Discount instead —
              discounts don&apos;t stack, so you always get the bigger one.
            </>
          ) : (
            <>
              Your {storeDiscount.percent}% {storeDiscount.source === "VIP" ? "VIP " : ""}account discount is active
              {storeDiscount.appliesToCurrentPlan || isBilled
                ? " and applied to your subscription"
                : " and will be applied when you choose a paid plan below"}
              {storeDiscount.expiresAt && <>, valid through {formatDate(storeDiscount.expiresAt)}</>}.
              {storeDiscount.note && <div style={{ marginTop: "4px", fontStyle: "italic" }}>{storeDiscount.note}</div>}
            </>
          )}
        </Banner>
      )}

      {/* ── Global Yearly Discount Banner ──
          Shown whenever a platform-wide annual promotion is active. */}
      {globalDiscount && (
        <Banner
          tone="info"
          title={`Global Yearly Discount: ${globalDiscount.percent}% off`}
          className="rv-fade-in"
        >
          A {globalDiscount.percent}% Global Yearly Discount is active on all yearly plans
          {globalDiscount.expiresAt && <>, valid through {formatDate(globalDiscount.expiresAt)}</>}.
          Choose <strong>Yearly Billing</strong> below to lock in {globalDiscount.percent}% savings.
        </Banner>
      )}

      {/* ── Current Plan Usage Summary Hero ── */}
      <div className="rv-hero-banner" style={{ marginBottom: "28px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px" }}>
              CURRENT SUBSCRIPTION
            </span>
            {activeFreeGrowth && (
              <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                Free Growth · to {formatDate(activeFreeGrowth.expiresAt)}
              </span>
            )}
            {/* A charge is shown whenever one exists, even beside a free
                entitlement — hiding it is how a merchant ended up paying for
                Starter under a page that said "nothing to pay". */}
            {billedPlan !== "free" ? (
              <span className="rv-badge rv-badge-success">
                {customPlan?.billingMethod === "EXTERNAL"
                  ? "Active · Direct contract"
                  : `${activeFreeGrowth ? `${PLAN_TIERS[billedPlan]?.name} billed` : "Active"} · ${activeInterval === "ANNUAL" ? "Billed Annually" : "Billed Monthly"}`}
              </span>
            ) : isPartnerGrowth ? (
              <span className="rv-badge rv-badge-success">Partner access · no charge</span>
            ) : !activeFreeGrowth ? (
              <span className="rv-badge rv-badge-neutral">No subscription</span>
            ) : null}
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 800, color: "var(--rv-text)" }}>
            {activeFreeGrowth ? "Free Growth" : customPlan ? "Custom Enterprise Plus" : `${PLAN_TIERS[activePlan]?.name || activePlan} Plan`}
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            {activeFreeGrowth ? (
              <>
                Real-time catalog watchdog, instant price crash rollback, and multi-resource backup.{" "}
                <span style={{ color: "var(--rv-primary)", fontWeight: 600 }}>
                  Free Growth promotion active until {formatDate(activeFreeGrowth.expiresAt)}.
                </span>
              </>
            ) : (
              "Real-time catalog watchdog, instant price crash rollback, and multi-resource backup."
            )}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "24px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Products Monitored</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {formatNumber(usage.productCount)} / {formatNumber(limits.products)}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Restore Points</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {usage.restorePointCount} / {limits.restorePoints === Infinity ? "Unlimited" : limits.restorePoints}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Active Detection Rules</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {usage.ruleCount} / {limits.rules === Infinity ? "Unlimited" : limits.rules}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Orders in Vault</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {formatNumber(usage.vaultOrderCount)} / {limits.vaultOrders === 0 ? "Not in Plan" : formatNumber(limits.vaultOrders)}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Change Retention</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {limits.retentionDays} Days
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Offsite Cloud Backup</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {limits.cloudSync ? "Google Drive & Dropbox" : "Not in Plan"}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Email Marketing Backup</div>
            {/* The profile allowance, not a usage count: nothing in the app
                stores synced ESP profiles yet, so a "0 / 10,000" here would
                report a real figure the store has no way to move. */}
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {limits.marketingBackup
                ? `Klaviyo & Mailchimp · ${formatNumber(limits.marketingProfiles)} profiles`
                : "Not in Plan"}
            </strong>
          </div>
        </div>
      </div>

      {/* ── Heading ── */}
      <div style={{ marginBottom: "16px" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 4px", color: "var(--rv-text)" }}>
          Choose Your Store Protection Plan
        </h3>
        <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: 0 }}>
          Scale your catalog guardrails as your store expands.{" "}
          {hasUsedTrial
            ? "Your store has already used its one free trial, so a new plan is billed from day one."
            : "All paid plans include a 14-day free trial."}{" "}
          Upgrade, downgrade, or cancel anytime.
        </p>
      </div>

      {/* ── Monthly / Yearly Billing Toggle ── */}
      {(() => {
        const yearlyDiscountPercent = Math.max(globalDiscount?.percent || 0, storeDiscount?.percent || 0);

        return (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginBottom: "28px" }}>
            <div
              role="group"
              aria-label="Billing cycle"
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "var(--rv-surface-subdued, #f1f2f4)",
                padding: "4px",
                borderRadius: "32px",
                border: "1px solid var(--rv-border, #e1e3e5)",
                boxShadow: "inset 0 1px 2px rgba(0,0,0,0.04)",
              }}
            >
              <button
                type="button"
                aria-pressed={billingCycle === "monthly"}
                onClick={() => setBillingCycle("monthly")}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "8px 20px",
                  borderRadius: "24px",
                  fontSize: "13px",
                  fontWeight: billingCycle === "monthly" ? 700 : 500,
                  background: billingCycle === "monthly" ? "#ffffff" : "transparent",
                  color: billingCycle === "monthly" ? "var(--rv-text, #202223)" : "var(--rv-text-subdued, #6d7175)",
                  boxShadow: billingCycle === "monthly" ? "0 2px 6px rgba(0,0,0,0.08)" : "none",
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span>Monthly Billing</span>
                {storeDiscount && storeDiscount.percent > 0 && (
                  <span
                    style={{
                      background: "linear-gradient(135deg, #10b981, #059669)",
                      color: "#ffffff",
                      fontSize: "11px",
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: "12px",
                      letterSpacing: "0.3px",
                      boxShadow: "0 1px 3px rgba(16,185,129,0.3)",
                    }}
                  >
                    {storeDiscount.percent}% OFF
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-pressed={billingCycle === "annual"}
                onClick={() => setBillingCycle("annual")}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "8px 16px",
                  borderRadius: "24px",
                  fontSize: "13px",
                  fontWeight: billingCycle === "annual" ? 700 : 500,
                  background: billingCycle === "annual" ? "#ffffff" : "transparent",
                  color: billingCycle === "annual" ? "var(--rv-primary, #008060)" : "var(--rv-text-subdued, #6d7175)",
                  boxShadow: billingCycle === "annual" ? "0 2px 6px rgba(0,0,0,0.08)" : "none",
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span>Yearly Billing</span>
                {yearlyDiscountPercent > 0 && (
                  <span
                    style={{
                      background: "linear-gradient(135deg, #10b981, #059669)",
                      color: "#ffffff",
                      fontSize: "11px",
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: "12px",
                      letterSpacing: "0.3px",
                      boxShadow: "0 1px 3px rgba(16,185,129,0.3)",
                    }}
                  >
                    {yearlyDiscountPercent}% OFF
                  </span>
                )}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── 5 Cards Responsive Grid ── */}
      <div className="rv-plan-grid">
        {PLANS.map((plan) => {
          const tier = PLAN_TIERS[plan.id];
          const isAnnualSelected = billingCycle === "annual";
          const isCurrentPlanId = activePlan === plan.id;
          const isCurrentInterval = activeInterval === (isAnnualSelected ? "ANNUAL" : "EVERY_30_DAYS");

          const isGrowth = plan.id === "growth";
          const isBusiness = plan.id === "business";
          const isEnterprise = plan.id === "enterprise";
          const isComplimentaryCard = Boolean(complimentaryGrowth) && isGrowth;
          const isFreeGrowthCard = isComplimentaryCard && complimentaryGrowth.kind === "promotion";
          const isPartnerCard = isComplimentaryCard && complimentaryGrowth.kind === "partner";
          const isCustomCard = Boolean(customPlan) && isEnterprise;

          // Growth held free (a promotional seat or Partner access) has no
          // billing interval to switch — it is an entitlement, not a
          // subscription. Treating the Yearly toggle as a "different cycle" on
          // this card offered "Switch to Yearly" beside a $0 price, and
          // submitting it opened a real annual Growth charge for the plan the
          // merchant already holds free. A custom Enterprise Plus plan is
          // likewise priced off the list, with no yearly counterpart. These
          // cards therefore stay current on both toggles; Business and
          // Enterprise remain genuine paid upgrades.
          const isExactCurrent =
            isCurrentPlanId && (plan.id === "free" || isCurrentInterval || isComplimentaryCard || isCustomCard);
          const isSameTierDifferentCycle =
            isCurrentPlanId && !isCurrentInterval && plan.id !== "free" && !isComplimentaryCard && !isCustomCard;
          // Starter and Growth are not for sale while Growth is already held
          // for nothing — the action refuses them, so the card says why.
          const isCoveredTier = Boolean(coveredLabel) && !isExactCurrent && (plan.id === "starter" || isGrowth);

          // True only for the plan the store is actually billed for. For a
          // promotional Growth store that is the Free card, which must not
          // offer a "downgrade" to the plan it is already on.
          const isBilledPlan = billedPlan === plan.id && !isCurrentPlanId;
          const planOrder = tier?.order ?? 0;
          const isUpgrade = planOrder > billedOrder;
          const isDowngrade = planOrder < billedOrder;

          const yearlyDiscountPercent = Math.max(globalDiscount?.percent || 0, storeDiscount?.percent || 0);

          // Applicable discount depends on the selected billing cycle:
          // - Global Yearly Discount applies only to Yearly Billing.
          // - Store-specific discounts (VIP / Account) apply to both Monthly and Yearly.
          const applicableDiscount = isAnnualSelected
            ? (yearlyDiscountPercent > 0
                ? (storeDiscount?.percent >= (globalDiscount?.percent || 0) ? storeDiscount : globalDiscount)
                : null)
            : (storeDiscount && storeDiscount.percent > 0 ? storeDiscount : null);
          const hasApplicableDiscount = Boolean(applicableDiscount && applicableDiscount.percent > 0);

          let cardBorder = "1px solid var(--rv-border)";
          let cardBg = "var(--rv-surface)";
          let boxShadow = "var(--rv-shadow-sm)";
          let tierBadge = null;

          // One badge per card. The promotional tier badge is a shopping cue
          // for a plan the merchant might move to, so on the plan they are
          // already on it yields to "Current" rather than stacking beside it —
          // otherwise Enterprise alone renders two badges while every other
          // card renders one. The tier labels survive as the footer line
          // ("For Shopify Plus & high volume"), so nothing is lost.
          if (!isExactCurrent) {
            if (isGrowth) {
              tierBadge = <span className="rv-badge rv-badge-info rv-badge-sm">Most Popular</span>;
            } else if (isBusiness) {
              tierBadge = <span className="rv-badge rv-badge-warning rv-badge-sm">Store Shield</span>;
            } else if (isEnterprise) {
              tierBadge = <span className="rv-badge rv-badge-neutral rv-badge-sm">Shopify Plus</span>;
            }
          }

          if (isExactCurrent) {
            cardBorder = "2px solid var(--rv-primary)";
            cardBg = "var(--rv-primary-surface)";
            boxShadow = "0 0 0 1px var(--rv-primary), 0 4px 16px rgba(0, 128, 96, 0.12)";
          } else if (isSameTierDifferentCycle) {
            cardBorder = "2px dashed var(--rv-primary)";
            cardBg = "var(--rv-surface)";
          } else if (isGrowth) {
            cardBorder = "2px solid var(--rv-info)";
            boxShadow = "0 4px 14px rgba(0, 91, 211, 0.12)";
          } else if (isBusiness) {
            cardBorder = "2px solid #6366f1";
          } else if (isEnterprise) {
            cardBorder = "2px solid #8b5cf6";
          }

          let buttonLabel = `Choose ${plan.name}`;
          if (isExactCurrent) {
            buttonLabel = isFreeGrowthCard
              ? "✓ Free Growth Active"
              : isPartnerCard
                ? "✓ Partner Access Active"
                : isCustomCard
                  ? "✓ Custom Plan Active"
                  : "✓ Active Plan";
          } else if (isSameTierDifferentCycle) {
            buttonLabel = isAnnualSelected
              ? (hasApplicableDiscount ? `Switch to Yearly (${applicableDiscount.percent}% Off)` : "Switch to Yearly")
              : "Switch to Monthly";
          } else if (isCoveredTier) {
            buttonLabel = coveredLabel;
          } else if (isBilledPlan) {
            buttonLabel = complimentaryGrowth ? "Standard Free (Included)" : "✓ Your billed plan";
          } else if (plan.id === "free") {
            buttonLabel = "Downgrade to Free";
          } else if (isUpgrade) {
            buttonLabel = isAnnualSelected ? `Upgrade to Yearly ${plan.name}` : `Upgrade to ${plan.name}`;
          } else if (isDowngrade) {
            buttonLabel = `Downgrade to ${plan.name}`;
          }

          return (
            <div
              key={plan.id}
              className="rv-card"
              style={{
                border: cardBorder,
                background: cardBg,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                boxShadow,
                position: "relative",
              }}
            >
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-between", padding: "20px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                    <span style={{ fontSize: "17px", fontWeight: 700, color: "var(--rv-text)" }}>
                      {isFreeGrowthCard ? "Free Growth" : isCustomCard ? "Enterprise Plus" : plan.name}
                    </span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      {isExactCurrent && (
                        <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                          {isFreeGrowthCard ? "Free Growth Active" : isPartnerCard ? "Partner Access" : "Current"}
                        </span>
                      )}
                      {tierBadge}
                    </div>
                  </div>

                  {(() => {
                    if (plan.id === "free") {
                      return (
                        <div style={{ marginBottom: "4px" }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                            <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>$0</span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>forever</span>
                          </div>
                          {/* This slot is the billing line on every other card
                              ("Billed monthly · 14-day trial"). It previously
                              repeated plan.footerText, which renders two lines
                              below, printing the same sentence twice. */}
                          <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                            No subscription · no credit card required
                          </div>
                        </div>
                      );
                    }

                    if (isCustomCard) {
                      return (
                        <div style={{ marginBottom: "4px" }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                            <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>
                              {formatPrice(customPlan.price)}
                            </span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>/ month</span>
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--rv-primary)", fontWeight: 600, marginTop: "2px" }}>
                            Custom Enterprise Plus · {formatNumber(limits.products)} products
                          </div>
                        </div>
                      );
                    }

                    if (isComplimentaryCard) {
                      return (
                        <div style={{ marginBottom: "4px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                            <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", textDecoration: "line-through" }}>
                              {isAnnualSelected ? `$${tier?.yearlyPrice}/yr` : `$${tier?.monthlyPrice}/mo`}
                            </span>
                            <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                              <SparklesIcon size={10} /> {isPartnerCard ? "PARTNER ACCESS" : "FREE PROMOTION"}
                            </span>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                            <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>$0</span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {isAnnualSelected ? "/ year" : "/ month"}
                            </span>
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--rv-primary)", fontWeight: 600, marginTop: "2px" }}>
                            {isPartnerCard ? "Partner development store · no charge" : "Free Growth promotion active"}
                          </div>
                        </div>
                      );
                    }

                    const baseMonthly = tier?.monthlyPrice ?? 0;
                    const baseYearly = tier?.yearlyPrice ?? 0;
                    const yearlyMonthlyEq = tier?.yearlyMonthlyEquivalent ?? 0;

                    const discountMultiplier = hasApplicableDiscount ? (1 - applicableDiscount.percent / 100) : 1;

                    if (isAnnualSelected) {
                      const finalYearly = baseYearly * discountMultiplier;
                      const finalMonthlyEq = yearlyMonthlyEq * discountMultiplier;

                      return (
                        <div style={{ marginBottom: "4px" }}>
                          {hasApplicableDiscount && (
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px", flexWrap: "wrap" }}>
                              {/* The struck-out figure must be the undiscounted
                                  version of the price beside it — the yearly
                                  monthly equivalent. Striking out the monthly
                                  list price made Enterprise ($99 → $66) read as
                                  33% off under a "20% OFF" badge. */}
                              <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", textDecoration: "line-through" }}>
                                {formatPrice(yearlyMonthlyEq)}/mo
                              </span>
                              <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                                {applicableDiscount.percent}% OFF
                              </span>
                            </div>
                          )}
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                            <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>
                              {hasApplicableDiscount ? formatPrice(finalMonthlyEq) : formatPrice(baseYearly)}
                            </span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {hasApplicableDiscount ? "/ month" : "/ year"}
                            </span>
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                            {hasApplicableDiscount
                              ? `Billed annually (${formatPrice(finalYearly)}/yr) · ${applicableDiscount.percent}% off applied`
                              : `Billed annually · ${formatPrice(yearlyMonthlyEq)}/month equivalent`}
                          </div>
                        </div>
                      );
                    }

                    // Monthly billing selected
                    const finalMonthly = baseMonthly * discountMultiplier;
                    return (
                      <div style={{ marginBottom: "4px" }}>
                        {hasApplicableDiscount && (
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                            <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", textDecoration: "line-through" }}>
                              ${baseMonthly}/mo
                            </span>
                            <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                              {applicableDiscount.percent}% OFF
                            </span>
                          </div>
                        )}
                        <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                          <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>
                            {formatPrice(finalMonthly)}
                          </span>
                          <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                            / month
                          </span>
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                          {/* The trial is once per store, so it cannot be
                              hardcoded here: on a store that has used it this
                              line promised a "14-day trial" directly above a
                              button footer reading "Billed from day one". */}
                          {[
                            "Billed monthly",
                            hasApplicableDiscount && `${applicableDiscount.percent}% discount applied`,
                            hasUsedTrial ? "billed from day one" : "14-day trial",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "6px" }}>
                    {plan.footerText}
                  </div>

                  <div style={{ borderTop: "1px solid var(--rv-border)", margin: "10px 0 14px" }} />

                  {/* Features List */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "20px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px" }}>
                      What&apos;s Included:
                    </span>
                    {plan.features.map((feature, idx) => {
                      // A row is either a plain string or { label, badge } /
                      // { label, kind }.
                      const label = typeof feature === "string" ? feature : feature.label;
                      const badge = typeof feature === "string" ? null : feature.badge;
                      const kind = typeof feature === "string" ? null : feature.kind;

                      // A boundary row states where a capability *starts*, so
                      // it must not carry a ✓ — that would claim the tier
                      // includes the very thing the row says it does not.
                      if (kind === "boundary") {
                        return (
                          <div
                            key={idx}
                            style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", lineHeight: 1.4 }}
                          >
                            <span style={{ color: "var(--rv-text-subdued)", fontWeight: "bold" }}>↑</span>
                            <span style={{ color: "var(--rv-text-subdued)" }}>{label}</span>
                          </div>
                        );
                      }

                      // "Everything in Starter, plus:" is a roll-up of the tier
                      // below, not an item of its own — a ✓ beside it would read
                      // as one more feature rather than as the heading it is.
                      const isInheritanceLine = label.endsWith("plus:");
                      if (isInheritanceLine) {
                        return (
                          <div
                            key={idx}
                            style={{
                              fontSize: "12px",
                              fontWeight: 700,
                              color: "var(--rv-text-subdued)",
                              lineHeight: 1.4,
                            }}
                          >
                            {label}
                          </div>
                        );
                      }
                      return (
                        <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", lineHeight: 1.4 }}>
                          <span style={{ color: "var(--rv-primary)", fontWeight: "bold" }}>✓</span>
                          <span style={{ color: "var(--rv-text)" }}>
                            <span style={{ fontWeight: badge ? 600 : undefined }}>{label}</span>
                            {badge && (
                              <span className="rv-badge rv-badge-success rv-badge-sm" style={{ marginLeft: "6px" }}>
                                {badge}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Bottom Action Button */}
                <div style={{ borderTop: "1px solid var(--rv-border-subtle)", paddingTop: "14px", marginTop: "auto" }}>
                  {isExactCurrent && applicableDiscount?.needsApply && plan.id !== "free" && !isComplimentaryCard && !isCustomCard ? (
                    <fetcher.Form method="POST" style={{ width: "100%" }}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <input type="hidden" name="interval" value={billingCycle} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="rv-btn rv-btn-primary"
                        style={{ width: "100%", fontWeight: 700 }}
                      >
                        {isSubmitting ? "Applying..." : `Apply my ${applicableDiscount.percent}% discount`}
                      </button>
                    </fetcher.Form>
                  ) : isExactCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="rv-btn"
                      style={{ width: "100%", background: "var(--rv-primary-surface)", color: "var(--rv-primary-text)", border: "1px solid var(--rv-primary-border)", cursor: "default", fontWeight: 700 }}
                    >
                      {buttonLabel}
                    </button>
                  ) : isBilledPlan || isCoveredTier ? (
                    <button
                      type="button"
                      disabled
                      className="rv-btn"
                      style={{ width: "100%", background: "var(--rv-surface-subdued)", color: "var(--rv-text-subdued)", border: "1px solid var(--rv-border)", cursor: "default", fontWeight: 600 }}
                    >
                      {buttonLabel}
                    </button>
                  ) : isDowngrade ? (
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setConfirmModal({ planId: plan.id, planName: plan.name, isDowngrade: true })}
                      className="rv-btn rv-btn-secondary"
                      style={{ width: "100%", fontWeight: 600 }}
                    >
                      {buttonLabel}
                    </button>
                  ) : (
                    <fetcher.Form method="POST" style={{ width: "100%" }}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <input type="hidden" name="interval" value={billingCycle} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="rv-btn rv-btn-primary"
                        style={{
                          width: "100%",
                          fontWeight: 700,
                          background: isEnterprise ? "#7c3aed" : isBusiness ? "#4f46e5" : isGrowth ? "var(--rv-primary)" : "var(--rv-info)",
                          borderColor: "transparent",
                          color: "#ffffff",
                        }}
                      >
                        {buttonLabel}
                      </button>
                    </fetcher.Form>
                  )}

                  <div style={{ textAlign: "center", marginTop: "8px", fontSize: "11px", color: isExactCurrent ? "var(--rv-primary-text)" : "var(--rv-text-subdued)", fontWeight: 500 }}>
                    {isExactCurrent
                      ? (isFreeGrowthCard
                        ? `Free Growth active until ${formatDate(activeFreeGrowth.expiresAt)}`
                        : isPartnerCard
                          ? "Partner access • No charge"
                          : isCustomCard
                            ? `Active Plan • ${customPlan.billingMethod === "EXTERNAL" ? "Direct contract" : "Billed Monthly"}`
                            : plan.id === "free"
                              ? "Active Plan • No charge"
                              : trialStillActive
                                ? trialSubtext(plan)
                                : `Active Plan • ${activeInterval === "ANNUAL" ? "Billed Annually" : "Billed Monthly"}`)
                      : isSameTierDifferentCycle
                        ? (isAnnualSelected ? (hasApplicableDiscount ? `${applicableDiscount.percent}% discount applied` : "Billed annually") : "Billed monthly")
                        : isCoveredTier
                          ? "Nothing to buy — already on your store"
                          : trialSubtext(plan)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Custom Enterprise Plus (above the Enterprise cap) Dynamic Section ── */}
      {/* The trigger is the ceiling this store actually has: a merchant already
          on an approved custom quota has bought the very thing this section
          sells, so pitching it to them at 200,001 of their 500,000 products
          reads as the page not knowing what they pay for. */}
      <div
        className="rv-card rv-fade-in"
        style={{
          marginTop: "24px",
          background: isOverCatalogCap ? "linear-gradient(135deg, rgba(124, 58, 237, 0.08) 0%, rgba(79, 70, 229, 0.05) 100%)" : "var(--rv-surface)",
          border: isOverCatalogCap ? "2px solid #7c3aed" : "1px solid var(--rv-border)",
          boxShadow: isOverCatalogCap ? "0 8px 24px rgba(124, 58, 237, 0.15)" : "var(--rv-shadow-sm)",
          padding: "24px",
          borderRadius: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "20px" }}>
          <div style={{ flex: 1, minWidth: "280px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px", flexWrap: "wrap" }}>
              <span
                className="rv-badge"
                style={{
                  background: "#7c3aed",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "11px",
                  padding: "3px 10px",
                  borderRadius: "12px",
                  letterSpacing: "0.5px",
                }}
              >
                ENTERPRISE PLUS
              </span>
              {isOverCatalogCap ? (
                <span className="rv-badge rv-badge-warning" style={{ fontWeight: 700 }}>
                  High Volume Catalog: {formatNumber(usage.productCount)} Products
                </span>
              ) : (
                <span className="rv-badge rv-badge-neutral">
                  Catalogs of More Than {formatNumber(catalogCap)} Products
                </span>
              )}
            </div>

            <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 800, color: "var(--rv-text)" }}>
              {isOverCatalogCap
                ? "Custom High-Capacity Tier Recommended for Your Store"
                : `Tracking More Than ${formatNumber(catalogCap)} Products, or Need Custom Retention?`}
            </h3>

            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "var(--rv-text-subdued)", lineHeight: 1.6, maxWidth: "680px" }}>
              {isOverCatalogCap
                ? `Your store currently has ${formatNumber(usage.productCount)} products, which exceeds your ${formatNumber(catalogCap)} ${limits?.isCustomLimit ? "custom quota" : "Enterprise plan limit"}. Our dedicated engineering team provides isolated sync clusters, custom API rate allocations, and tailored retention pipelines for mega-catalogs.`
                : `Enterprise covers catalogs up to and including ${formatNumber(catalogCap)} products. Above that — mega-catalogs of ${formatNumber(catalogCap + 1)} to 1,000,000+ SKUs, multi-year compliance archives, and customized disaster recovery SLAs — we offer tailored Enterprise Plus solutions with dedicated infrastructure.`}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px", marginTop: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--rv-text)" }}>
                <span style={{ color: "#7c3aed", fontWeight: 800 }}>✓</span>
                <span>Unlimited Products &amp; Variants</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--rv-text)" }}>
                <span style={{ color: "#7c3aed", fontWeight: 800 }}>✓</span>
                <span>Dedicated Isolated Sync Queue</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--rv-text)" }}>
                <span style={{ color: "#7c3aed", fontWeight: 800 }}>✓</span>
                <span>Custom Multi-Year Retention</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--rv-text)" }}>
                <span style={{ color: "#7c3aed", fontWeight: 800 }}>✓</span>
                <span>Dedicated Slack Bridge &amp; Priority SLA</span>
              </div>
            </div>
          </div>

          <div style={{ alignSelf: "center", display: "flex", flexDirection: "column", gap: "8px", minWidth: "220px" }}>
            <Link
              to={`/app/support?category=Billing&priority=HIGH&subject=${encodeURIComponent(
                `Custom Enterprise Plus Quote (${formatNumber(usage.productCount)} products)`
              )}&products=${usage.productCount}&message=${encodeURIComponent(
                `Hi Revertly Team,\n\nOur store (${shop}) has approximately ${formatNumber(usage.productCount)} products. We would like to request a Custom Enterprise Plus quote with dedicated infrastructure and custom limits.\n\nLooking forward to hearing from you.`
              )}`}
              className="rv-btn"
              style={{
                background: "#7c3aed",
                color: "#ffffff",
                padding: "12px 20px",
                fontWeight: 700,
                textAlign: "center",
                borderRadius: "8px",
                boxShadow: "0 2px 8px rgba(124, 58, 237, 0.3)",
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              {isOverCatalogCap ? "Request Custom Plus Quote →" : "Contact Enterprise Sales →"}
            </Link>
            <span style={{ fontSize: "11px", color: "var(--rv-text-subdued)", textAlign: "center" }}>
              Fast response • Quotes within 24 hours
            </span>
          </div>
        </div>
      </div>

      {/* ── Downgrade Confirmation Modal ── */}
      {confirmModal && (
        <div
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSubmitting) {
              setConfirmModal(null);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "20px",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="downgrade-modal-title"
            style={{
              background: "#ffffff",
              borderRadius: "var(--rv-radius-md)",
              maxWidth: "480px",
              width: "100%",
              padding: "24px",
              boxShadow: "var(--rv-shadow-lg)",
            }}
          >
            <h3 id="downgrade-modal-title" style={{ margin: "0 0 10px", fontSize: "18px", fontWeight: 700, color: "var(--rv-text)" }}>
              Confirm Plan Downgrade
            </h3>
            <p style={{ fontSize: "14px", color: "var(--rv-text)", lineHeight: 1.5, margin: "0 0 16px" }}>
              Are you sure you want to switch to the <strong>{confirmModal.planName}</strong> plan?
            </p>
            <div
              style={{
                background: "var(--rv-critical-surface)",
                border: "1px solid var(--rv-critical-border)",
                borderRadius: "var(--rv-radius-sm)",
                padding: "12px 14px",
                fontSize: "13px",
                color: "var(--rv-critical-text)",
                marginBottom: "20px",
                lineHeight: 1.4,
              }}
            >
              {(() => {
                const lost = capabilitiesLostTo(confirmModal.planId);
                return (
                  <>
                    <strong>Note:</strong> Downgrading will lower your monitored product and restore point allowances, and shorten how long change history is kept.
                    {lost.length > 0 ? (
                      <> The {confirmModal.planName} plan does not include: {lost.join(", ")}.</>
                    ) : (
                      <> Every capability you use today is still included on {confirmModal.planName}.</>
                    )}{" "}
                    {(() => {
                      // Stated plainly because it is what the retention policy
                      // and the restore-point allowance really do — "backups
                      // already stored are kept" was not true.
                      const target = planAllowances?.[confirmModal.planId];
                      if (!target) return null;
                      return (
                        <>
                          Restore points older than {confirmModal.planName}&apos;s {target.retentionDays}-day history
                          window are removed, and automatic backups rotate to fit its allowance of{" "}
                          {target.restorePoints === Infinity ? "unlimited" : target.restorePoints} restore points.
                          Restore points you created yourself are never rotated out.
                        </>
                      );
                    })()}
                  </>
                );
              })()}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                ref={cancelButtonRef}
                onClick={() => setConfirmModal(null)}
                className="rv-btn rv-btn-secondary"
                disabled={isSubmitting}
              >
                Cancel &amp; Keep Current Plan
              </button>
              <fetcher.Form method="POST">
                <input type="hidden" name="planId" value={confirmModal.planId} />
                <input type="hidden" name="interval" value={billingCycle} />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rv-btn rv-btn-critical"
                  style={{ fontWeight: 600 }}
                >
                  {isSubmitting ? "Processing..." : `Confirm Downgrade to ${confirmModal.planName}`}
                </button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer Info ── */}
      <div style={{ textAlign: "center", padding: "16px 20px", color: "var(--rv-text-subdued)", fontSize: "12px" }}>
        All plans include automated snapshot tracking. Charges are processed through Shopify Billing in USD. You can upgrade, downgrade, or cancel anytime directly in your Shopify Admin.
        <div style={{ marginTop: "6px" }}>
          Need custom volume limits or agency onboarding? <Link to="/app/support" style={{ color: "var(--rv-info)" }}>Contact Developer Support →</Link>
        </div>
      </div>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
