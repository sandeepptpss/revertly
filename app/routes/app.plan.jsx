import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import {
  authenticate,
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_STARTER_ANNUAL,
  PLAN_GROWTH_ANNUAL,
  PLAN_BUSINESS_ANNUAL,
  PLAN_ENTERPRISE_ANNUAL,
} from "../shopify.server.js";
import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { PLAN_TIERS, INTERVAL_MONTHLY, INTERVAL_ANNUAL } from "../billing.constants.js";
import {
  getStorePlan,
  normalizePlanId,
} from "../billing.server.js";
import { resolveBestDiscount, getClaimableVipOffer, claimVipOffer } from "../storeDiscount.server.js";
import { getFreeGrowthOffer, claimFreeGrowthSeat, getFreeGrowthStatus } from "../freeGrowth.server.js";
import { DISCOUNT_DURATION_MONTHS } from "../discount.constants.js";
import { Banner } from "../components/Banner.jsx";
import { SparklesIcon, ShieldCheckIcon } from "../components/Icons.jsx";

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

// ── Plan definitions ────────────────────────────────────────────────────────
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
      "Up to 100 products monitored",
      "7 days change history retention",
      "Up to 2 restore points",
      "1 active detection rule",
      "Manual single-product rollback",
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
      "Up to 1,000 products monitored",
      "30 days change history retention",
      "Up to 10 restore points",
      "3 active detection rules",
      "Single & multi-product rollback",
      "Email catalog drift alerts",
      "Automated daily catalog sync",
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
      "Up to 5,000 products monitored",
      "90 days change history retention",
      "Up to 50 restore points",
      "10 active detection rules",
      "Bulk product rollback (CSV undo)",
      "1-Click Deleted Product Recovery",
      "Collections & Smart Rules Backup",
      "Orders & Customers Vault (2,500 orders)",
      "Accountant-ready Tax CSV export",
      "Email & Audit log reports",
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
      "Up to 20,000 products monitored",
      "180 days (6 months) retention",
      "Up to 100 restore points",
      "Full Store Themes & Liquid Code Backup",
      "1-Click Theme Code & Asset Rollback",
      "Orders & Customers Vault (15,000 orders)",
      "Chargeback Dispute Proof Pack (JSON)",
      "Emergency Circuit Breaker (Auto-Draft)",
      "Unlimited detection rules",
      "Real-time Slack Webhook Alerts",
    ],
  },
  {
    id: "enterprise",
    category: "Ultimate Plus",
    name: "Enterprise",
    price: "$79",
    period: "/ month",
    subtext: "14-day free trial",
    footerText: "For Shopify Plus & high volume",
    features: [
      "Unlimited products monitored",
      "365 days (1 full year) retention",
      "Unlimited restore points",
      "Unlimited Themes, Code & Assets",
      "Unlimited Orders & Customers Vault",
      "Dedicated GDPR & Tax compliance exports",
      "High-speed GraphQL rate allocation",
      "Multi-store staging & priority SLA",
      "Priority 24/7 Developer Support",
    ],
  },
];

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.NODE_ENV !== "production";

  const { currentPlan, paidPlan, limits, subscriptionDiscountPercent, freeGrowth, billingInterval } = await getStorePlan(
    shop,
    billing,
    isTest,
  );

  const [productCount, changeCount, restorePointCount, ruleCount, vaultOrderCount, settings, bestDiscount, vipOffer, freeGrowthOffer, freeGrowthStatus] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.changeEvent.count({ where: { shop } }),
    prisma.restorePoint.count({ where: { shop } }),
    prisma.detectionRule.count({ where: { shop } }),
    prisma.orderArchive.count({ where: { shop } }),
    prisma.appSettings.findUnique({ where: { shop } }),
    // The single best discount this store qualifies for — its own VIP or
    // standard grant, or the global offer. Read fresh on every load so a
    // change made in the Admin Panel shows up with no action by the merchant.
    resolveBestDiscount(shop),
    // A VIP offer discounts nothing until the merchant accepts it.
    getClaimableVipOffer(shop),
    // A free Growth seat is likewise claimed, not handed out at install.
    getFreeGrowthOffer(shop),
    getFreeGrowthStatus(),
  ]);

  if (settings?.productLimitReachedAt && (limits.products === Infinity || productCount < limits.products)) {
    await prisma.appSettings.update({
      where: { shop },
      data: { productLimitReachedAt: null },
    });
    settings.productLimitReachedAt = null;
  }

  return {
    currentPlan,
    // What the store is actually billed for. `currentPlan` can be higher than
    // this when a promotional Growth seat is in play, and the two must not be
    // conflated: entitlements follow `currentPlan`, but which plans are an
    // upgrade or a downgrade — and which one Shopify would cancel — follows
    // what is really being paid for.
    paidPlan,
    billingInterval: billingInterval || INTERVAL_MONTHLY,
    limits,
    usage: { productCount, changeCount, restorePointCount, ruleCount, vaultOrderCount },
    shop,
    hasUsedTrial: Boolean(settings?.hasUsedTrial),
    trialEndsAt: settings?.trialEndsAt || null,
    productLimitReachedAt: settings?.productLimitReachedAt || null,
    // A promotional Growth seat: full Growth features, no subscription, no charge.
    freeGrowth: freeGrowth?.isActive ? { expiresAt: freeGrowth.expiresAt } : null,
    // Overall status of the Free Growth promotion (limit, duration, whether sold out)
    freeGrowthStatus: freeGrowthStatus
      ? {
        limit: freeGrowthStatus.limit,
        durationMonths: freeGrowthStatus.durationMonths,
        remaining: freeGrowthStatus.remaining,
        isSoldOut: freeGrowthStatus.isSoldOut,
      }
      : null,
    // An unclaimed VIP offer. Nothing is discounted while this is showing.
    vipOffer: vipOffer ? { percent: vipOffer.discountPercent, note: vipOffer.note } : null,
    // An unclaimed free Growth seat. Only worth offering if Growth would
    // actually be an upgrade on what they already pay for.
    freeGrowthOffer:
      freeGrowthOffer && PLAN_TIERS[paidPlan]?.order < PLAN_TIERS.growth.order ? freeGrowthOffer : null,
    discount: bestDiscount
      ? {
        percent: bestDiscount.percent,
        source: bestDiscount.source,
        label: bestDiscount.label,
        note: bestDiscount.note,
        expiresAt: bestDiscount.expiresAt,
        // A discount only reduces a real charge once it is attached to a
        // subscription. Granting one to a merchant who is already paying
        // leaves their existing subscription untouched, so offer them a way
        // to move onto a discounted one. A promotional Growth seat has no
        // subscription to re-issue, and nor does a simulated one.
        needsApply:
          paidPlan !== "free" &&
          subscriptionDiscountPercent !== bestDiscount.percent &&
          !isSimulatedSubscription(settings?.subscriptionId) &&
          (billingInterval === INTERVAL_ANNUAL || bestDiscount.source !== "GLOBAL"),
      }
      : null,
  };
};

/** Plans activated in test/simulation mode never created a real Shopify charge. */
function isSimulatedSubscription(subscriptionId) {
  return Boolean(subscriptionId?.startsWith("sim_") || subscriptionId?.startsWith("test_"));
}

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const isTest = process.env.NODE_ENV !== "production";

  // ── Claiming a free Growth seat ──────────────────────────────────────────
  if (formData.get("intent") === "claimFreeGrowth") {
    const grant = await claimFreeGrowthSeat(shop);
    if (!grant) {
      return {
        success: false,
        message:
          "Those free Growth seats have all been taken. Refresh the page to see your current options.",
      };
    }

    await prisma.auditLog
      .create({
        data: {
          shop,
          userEmail: null,
          userName: "Merchant",
          action: "FREE_GROWTH_CLAIMED",
          resourceType: "FreeGrowthGrant",
          details: {
            expiresAt: grant.expiresAt,
            durationMonths: Math.max(1, Math.round((new Date(grant.expiresAt).getTime() - new Date(grant.grantedAt).getTime()) / (30 * 24 * 60 * 60 * 1000))),
          },
        },
      })
      .catch(() => { });

    // When claiming Free Growth, clean up any simulated or stale subscription on the store.
    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: "free", subscriptionId: null },
      update: { planId: "free", subscriptionId: null },
    }).catch(() => { });

    return {
      success: true,
      planId: "growth",
      // An entitlement, not a subscription — so this result must not be read as
      // a change to what the store is billed for.
      promotional: true,
      freeGrowth: { expiresAt: grant.expiresAt },
      message: `Free Growth promotion activated! Full Growth features are unlocked free of charge through ${formatDate(grant.expiresAt)}. There is no subscription and nothing to pay.`,
    };
  }

  // ── Accepting a VIP offer ────────────────────────────────────────────────
  if (formData.get("intent") === "claimVip") {
    const claimed = await claimVipOffer(shop);
    if (!claimed) {
      return {
        success: false,
        message: "That VIP offer is no longer available. Refresh the page to see your current pricing.",
      };
    }

    await prisma.auditLog
      .create({
        data: {
          shop,
          userEmail: null,
          userName: "Merchant",
          action: "VIP_DISCOUNT_CLAIMED",
          resourceType: "StoreDiscount",
          details: {
            discountPercent: claimed.discountPercent,
            claimedAt: claimed.claimedAt,
            expiresAt: claimed.expiresAt,
            durationMonths: DISCOUNT_DURATION_MONTHS,
          },
        },
      })
      .catch(() => { });

    return {
      success: true,
      message: `VIP discount activated — ${claimed.discountPercent}% off for the next ${DISCOUNT_DURATION_MONTHS} months, through ${new Date(claimed.expiresAt).toLocaleDateString()}.`,
    };
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

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const currentPlan = normalizePlanId(settings?.planId);
  const currentInterval = settings?.billingInterval || (settings?.subscriptionId?.includes("annual") ? INTERVAL_ANNUAL : INTERVAL_MONTHLY);

  // The single best discount this store qualifies for, applied to the real
  // Shopify charge — not just the price shown on this page — for the same
  // number of billing cycles the discount is valid for.
  const activeDiscount = await resolveBestDiscount(shop);

  const isSamePlan = targetPlanId === currentPlan;
  const isSameInterval = targetInterval === currentInterval;

  if (isSamePlan && isSameInterval) {
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
    const isSimulated = isSimulatedSubscription(settings?.subscriptionId);

    if (!isSimulated) {
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
          for (const sub of billingCheck.appSubscriptions) {
            if (sub.id) {
              try {
                await billing.cancel({
                  subscriptionId: sub.id,
                  isTest,
                  prorate: true,
                });
              } catch (cancelErr) {
                allCancelled = false;
                console.error("[Revertly Billing] Failed to cancel subscription", sub.id, cancelErr?.message || cancelErr);
              }
            }
          }
        }
      } catch (err) {
        if (!isTest) {
          allCancelled = false;
        }
        console.warn("[Revertly Billing] Shopify billing cancel warning:", err?.message || err);
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
      // as "Armed" for a plan that no longer includes it.
      update: { planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY, circuitBreakerEnabled: false },
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

  const targetTier = PLAN_TIERS[targetPlanId];
  const targetPrice = isAnnual ? targetTier?.yearlyPrice : targetTier?.price;

  // Global Yearly Discount applies only to Annual plans. Store-specific discounts (VIP/Account) apply to both.
  const isDiscountEligible = activeDiscount && (isAnnual || activeDiscount.source !== "GLOBAL");

  const lineItemOverrides = isDiscountEligible
    ? {
      lineItems: [
        {
          amount: targetPrice,
          currencyCode: "USD",
          interval: isAnnual ? BillingInterval.Annual : BillingInterval.Every30Days,
          discount: {
            durationLimitInIntervals: isAnnual ? 1 : DISCOUNT_DURATION_MONTHS,
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

  try {
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

    if (isDistributionError || isTest) {
      const simSubId = `sim_${targetPlanId}_${isAnnual ? "annual_" : ""}${Date.now()}`;
      const now = new Date();
      const trialEndsAt = settings?.trialEndsAt || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

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
          trialEndsAt,
        },
      });

      const currentOrder = PLAN_TIERS[currentPlan]?.order ?? 0;
      const targetOrder = PLAN_TIERS[targetPlanId]?.order ?? 0;
      const isDowngrade = targetOrder < currentOrder;
      const cycleLabel = isAnnual ? "Yearly" : "Monthly";

      let successMessage = isDistributionError
        ? `Switched to ${targetTier?.name} plan (${cycleLabel}) in Test Mode. (Partner Note: To test live Shopify billing screens, select 'Public distribution' in Partner Dashboard > Apps > Distribution).`
        : isDowngrade
          ? `Successfully switched to ${targetTier?.name} plan (${cycleLabel}).`
          : isSamePlan
            ? `Successfully updated billing cycle to ${cycleLabel} for ${targetTier?.name} plan.`
            : `Successfully upgraded to ${targetTier?.name} (${cycleLabel}, 14-day trial active).`;

      return {
        success: true,
        planId: targetPlanId,
        billingInterval: targetInterval,
        message: successMessage,
      };
    }

    return {
      success: false,
      message: `Unable to initiate Shopify billing for ${targetShopifyPlan}: ${detailedMessage || err?.message || "Please try again or contact support."}`,
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
    discount,
    freeGrowth,
    freeGrowthStatus,
    vipOffer,
    freeGrowthOffer,
  } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const activePlan = result?.planId || currentPlan;
  const activeInterval = result?.billingInterval || billingInterval || "EVERY_30_DAYS";
  const activeFreeGrowth = result?.freeGrowth || freeGrowth;
  const isSubmitting = fetcher.state !== "idle";

  const [billingCycle, setBillingCycle] = useState(
    activeInterval === "ANNUAL" ? "annual" : "monthly"
  );
  const [confirmModal, setConfirmModal] = useState(null);

  // Auto-close confirmation modal once an action result returns
  useEffect(() => {
    if (result) {
      setConfirmModal(null);
    }
  }, [result]);

  // Upgrade/downgrade is a statement about *money*, so it is measured against
  // the plan being billed, not against an entitlement handed out by the
  // promotion. Measuring it against `activePlan` labelled Starter a
  // "downgrade" for a promotional Growth store that would in fact start paying
  // $9, and offered it a "Downgrade to Free" that the action then rejected as
  // "already subscribed to the Free plan".
  const billedPlan = result?.planId && !result.promotional ? result.planId : paidPlan;
  const billedOrder = PLAN_TIERS[billedPlan]?.order ?? 0;
  const trialStillActive = trialEndsAt && new Date(trialEndsAt) > new Date();

  function trialSubtext(plan) {
    if (plan.id === "free") return plan.subtext;
    if (activePlan === plan.id && trialStillActive) {
      return `Trial active until ${new Date(trialEndsAt).toLocaleDateString()}`;
    }
    // The trial is once per store, so keep advertising it only while it is
    // still on offer — see the trialDays override in the action.
    if (hasUsedTrial) return "Billed from day one";
    return plan.subtext;
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
        >
          You&apos;ve reached your plan&apos;s monitored product limit — newly added products are no longer being tracked. Upgrade below to resume 24/7 protection across all products.
        </Banner>
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

      {/* ── Free Growth Promotion Banner ──
          A promotional seat: Growth features at no charge, no subscription. */}
      {activeFreeGrowth && (
        <Banner tone="success" title="🎉 Free Growth Promotion Active" className="rv-fade-in">
          You claimed the Free Growth promotion from the first {freeGrowthStatus?.limit || 20} stores offer. Every Growth feature is unlocked on your
          account at no charge until {formatDate(activeFreeGrowth.expiresAt)}. There is no
          subscription and nothing to pay. You can still upgrade to Business or Enterprise at any time.
        </Banner>
      )}

      {/* ── Free Growth Sold Out Notice (if merchant did not claim and seats are full) ── */}
      {!activeFreeGrowth && !freeGrowthOffer && freeGrowthStatus?.isSoldOut && (
        <Banner tone="info" title="Free Growth Promotion Concluded" className="rv-fade-in">
          The Free Growth offer for the first {freeGrowthStatus.limit} merchants has reached capacity and been fully claimed. Standard store protection plans are available below.
        </Banner>
      )}

      {/* ── Admin-Granted Discount Banner ──
          Shown whenever the platform admin has an active discount on file.
          It reads differently depending on whether the discount is already
          attached to the live subscription or still needs to be applied. */}
      {discount && (
        <Banner
          tone={discount.needsApply ? "warning" : "success"}
          title={
            discount.needsApply
              ? `${discount.label}: ${discount.percent}% ready to apply`
              : `🎉 ${discount.label}: ${discount.percent}% off`
          }
          className="rv-fade-in"
        >
          {discount.needsApply ? (
            <>
              Your {discount.percent}% {discount.source === "VIP" ? "VIP " : ""}discount
              {discount.expiresAt && <> is valid through {new Date(discount.expiresAt).toLocaleDateString()}</>},
              but your current subscription is still being charged at full price. Use{" "}
              <strong>Apply my {discount.percent}% discount</strong> on your active plan below to switch to
              the discounted price.
            </>
          ) : discount.source === "GLOBAL" ? (
            <>
              A {discount.percent}% Global Yearly Discount is active on all yearly plans
              {discount.expiresAt && <>, valid through {new Date(discount.expiresAt).toLocaleDateString()}</>}.
              Choose <strong>Yearly Billing</strong> below to lock in {discount.percent}% savings.
            </>
          ) : (
            <>
              Your {discount.percent}% {discount.source === "VIP" ? "VIP " : ""}discount is active and
              reflected in the prices below
              {discount.expiresAt && <>, valid through {new Date(discount.expiresAt).toLocaleDateString()}</>}.
            </>
          )}
        </Banner>
      )}

      {/* ── Current Plan Usage Summary Hero ── */}
      <div className="rv-hero-banner" style={{ marginBottom: "28px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px" }}>
              CURRENT SUBSCRIPTION
            </span>
            {activeFreeGrowth ? (
              <span className="rv-badge rv-badge-success" style={{ fontWeight: 700 }}>
                Free Growth · to {formatDate(activeFreeGrowth.expiresAt)}
              </span>
            ) : billedPlan !== "free" ? (
              <span className="rv-badge rv-badge-success">
                Active · {activeInterval === "ANNUAL" ? "Billed Annually" : "Billed Monthly"}
              </span>
            ) : (
              <span className="rv-badge rv-badge-neutral">No subscription</span>
            )}
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 800, color: "var(--rv-text)" }}>
            {activeFreeGrowth ? "Free Growth" : `${PLAN_TIERS[activePlan]?.name || activePlan} Plan`}
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
              {usage.productCount.toLocaleString()} / {limits.products === Infinity ? "Unlimited" : limits.products.toLocaleString()}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Restore Points</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {usage.restorePointCount} / {limits.restorePoints === Infinity ? "Unlimited" : limits.restorePoints}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Detection Rules</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {usage.ruleCount} / {limits.rules === Infinity ? "Unlimited" : limits.rules}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Orders in Vault</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {usage.vaultOrderCount.toLocaleString()} / {limits.vaultOrders === Infinity ? "Unlimited" : limits.vaultOrders === 0 ? "Not in Plan" : limits.vaultOrders.toLocaleString()}
            </strong>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "2px" }}>Change Retention</div>
            <strong style={{ fontSize: "15px", color: "var(--rv-text)" }}>
              {limits.retentionDays} Days
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
          Scale your catalog guardrails as your store expands. All paid plans include a 14-day free trial. Upgrade, downgrade, or cancel anytime.
        </p>
      </div>

      {/* ── Monthly / Yearly Billing Toggle ── */}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginBottom: "28px" }}>
        <div
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
            }}
          >
            Monthly Billing
          </button>
          <button
            type="button"
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
            {discount && discount.percent > 0 && (
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
                {discount.percent}% OFF
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── 5 Cards Responsive Grid ── */}
      <div className="rv-plan-grid">
        {PLANS.map((plan) => {
          const tier = PLAN_TIERS[plan.id];
          const isAnnualSelected = billingCycle === "annual";
          const isCurrentPlanId = activePlan === plan.id;
          const isCurrentInterval = activeInterval === (isAnnualSelected ? "ANNUAL" : "EVERY_30_DAYS");
          const isExactCurrent = isCurrentPlanId && (plan.id === "free" || isCurrentInterval);
          const isSameTierDifferentCycle = isCurrentPlanId && !isCurrentInterval && plan.id !== "free";

          // True only for the plan the store is actually billed for. For a
          // promotional Growth store that is the Free card, which must not
          // offer a "downgrade" to the plan it is already on.
          const isBilledPlan = billedPlan === plan.id && !isCurrentPlanId;
          const planOrder = tier?.order ?? 0;
          const isUpgrade = planOrder > billedOrder;
          const isDowngrade = planOrder < billedOrder;

          const isGrowth = plan.id === "growth";
          const isBusiness = plan.id === "business";
          const isEnterprise = plan.id === "enterprise";
          const isFreeGrowthCard = Boolean(activeFreeGrowth) && isGrowth;

          // Applicable discount depends on the selected billing cycle:
          // - Global Yearly Discount applies only to Yearly Billing.
          // - Store-specific discounts (VIP / Account) apply to both Monthly and Yearly.
          const applicableDiscount = isAnnualSelected
            ? (discount && discount.percent > 0 ? discount : null)
            : (discount && discount.percent > 0 && discount.source !== "GLOBAL" ? discount : null);
          const hasApplicableDiscount = Boolean(applicableDiscount && applicableDiscount.percent > 0);

          let cardBorder = "1px solid var(--rv-border)";
          let cardBg = "var(--rv-surface)";
          let boxShadow = "var(--rv-shadow-sm)";
          let tierBadge = null;

          if (isGrowth) {
            tierBadge = <span className="rv-badge rv-badge-info rv-badge-sm">Most Popular</span>;
          } else if (isBusiness) {
            tierBadge = <span className="rv-badge rv-badge-warning rv-badge-sm">Store Shield</span>;
          } else if (isEnterprise) {
            tierBadge = <span className="rv-badge rv-badge-neutral rv-badge-sm">Shopify Plus</span>;
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
            buttonLabel = isFreeGrowthCard ? "✓ Free Growth Active" : "✓ Active Plan";
          } else if (isSameTierDifferentCycle) {
            buttonLabel = isAnnualSelected
              ? (hasApplicableDiscount ? `Switch to Yearly (${applicableDiscount.percent}% Off)` : "Switch to Yearly")
              : "Switch to Monthly";
          } else if (isBilledPlan) {
            buttonLabel = activeFreeGrowth ? "Standard Free (Included)" : "✓ Your billed plan";
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
                      {isFreeGrowthCard ? "Free Growth" : plan.name}
                    </span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      {isExactCurrent && (
                        <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                          {isFreeGrowthCard ? "Free Growth Active" : "Current"}
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
                          <div style={{ fontSize: "11px", color: "var(--rv-text-subdued)", marginTop: "2px" }}>
                            Basic protection for new stores
                          </div>
                        </div>
                      );
                    }

                    if (isFreeGrowthCard) {
                      return (
                        <div style={{ marginBottom: "4px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                            <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", textDecoration: "line-through" }}>
                              {isAnnualSelected ? `$${tier?.yearlyPrice}/yr` : `$${tier?.monthlyPrice}/mo`}
                            </span>
                            <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                              <SparklesIcon size={10} /> FREE PROMOTION
                            </span>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                            <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>$0</span>
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {isAnnualSelected ? "/ year" : "/ month"}
                            </span>
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--rv-primary)", fontWeight: 600, marginTop: "2px" }}>
                            Free Growth promotion active
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
                          Billed monthly · 14-day trial
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
                    {plan.features.map((feature, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", lineHeight: 1.4 }}>
                        <span style={{ color: "var(--rv-primary)", fontWeight: "bold" }}>✓</span>
                        <span style={{ color: "var(--rv-text)" }}>{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bottom Action Button */}
                <div style={{ borderTop: "1px solid var(--rv-border-subtle)", paddingTop: "14px", marginTop: "auto" }}>
                  {isExactCurrent && discount?.needsApply && plan.id !== "free" ? (
                    <fetcher.Form method="POST" style={{ width: "100%" }}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <input type="hidden" name="interval" value={billingCycle} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="rv-btn rv-btn-primary"
                        style={{ width: "100%", fontWeight: 700 }}
                      >
                        {isSubmitting ? "Applying..." : `Apply my ${discount.percent}% discount`}
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
                  ) : isBilledPlan ? (
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
                        : trialStillActive
                          ? trialSubtext(plan)
                          : `Active Plan • ${activeInterval === "ANNUAL" ? "Billed Annually" : "Billed Monthly"}`)
                      : isSameTierDifferentCycle
                        ? (isAnnualSelected ? (hasApplicableDiscount ? `${applicableDiscount.percent}% discount applied` : "Billed annually") : "Billed monthly")
                        : trialSubtext(plan)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Downgrade Confirmation Modal ── */}
      {confirmModal && (
        <div
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
            style={{
              background: "#ffffff",
              borderRadius: "var(--rv-radius-md)",
              maxWidth: "480px",
              width: "100%",
              padding: "24px",
              boxShadow: "var(--rv-shadow-lg)",
            }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: "18px", fontWeight: 700, color: "var(--rv-text)" }}>
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
              ⚠️ <strong>Note:</strong> Downgrading will lower your monitored product and restore point allowances. Premium capabilities (such as Liquid Theme Backups, Data Vault sync, and Circuit Breaker) will be restricted to the new plan&apos;s limits.
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
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
