import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import {
  authenticate,
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
} from "../shopify.server.js";
import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { PLAN_TIERS } from "../billing.constants.js";
import {
  getStorePlan,
  normalizePlanId,
} from "../billing.server.js";
import { getActiveStoreDiscount, DISCOUNT_DURATION_MONTHS } from "../storeDiscount.server.js";
import { Banner } from "../components/Banner.jsx";
import { SparklesIcon } from "../components/Icons.jsx";

/** Rounds to cents and drops a trailing ".00" for a cleaner price tag. */
function formatPrice(amount) {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
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

  const { currentPlan, limits, subscriptionDiscountPercent } = await getStorePlan(shop, billing, isTest);

  const [productCount, changeCount, restorePointCount, ruleCount, vaultOrderCount, settings, activeDiscount] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.changeEvent.count({ where: { shop } }),
    prisma.restorePoint.count({ where: { shop } }),
    prisma.detectionRule.count({ where: { shop } }),
    prisma.orderArchive.count({ where: { shop } }),
    prisma.appSettings.findUnique({ where: { shop } }),
    // Platform-admin-granted discount, if the admin has set one for this
    // store. Read fresh on every load so a change made in the Admin Panel
    // shows up here without the merchant needing to do anything.
    getActiveStoreDiscount(shop),
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
    limits,
    usage: { productCount, changeCount, restorePointCount, ruleCount, vaultOrderCount },
    shop,
    hasUsedTrial: Boolean(settings?.hasUsedTrial),
    trialEndsAt: settings?.trialEndsAt || null,
    productLimitReachedAt: settings?.productLimitReachedAt || null,
    discount: activeDiscount
      ? {
          percent: activeDiscount.discountPercent,
          note: activeDiscount.note,
          expiresAt: activeDiscount.expiresAt,
          // A discount only reduces a real charge once it is attached to a
          // subscription. Granting one to a merchant who is already paying
          // leaves their existing subscription untouched, so offer them a way
          // to move onto a discounted one. Simulated subscriptions have no
          // real charge behind them, so there is nothing to re-issue.
          needsApply:
            currentPlan !== "free" &&
            subscriptionDiscountPercent !== activeDiscount.discountPercent &&
            !isSimulatedSubscription(settings?.subscriptionId),
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
  const rawPlanId = formData.get("planId");
  const targetPlanId = normalizePlanId(rawPlanId);
  const isTest = process.env.NODE_ENV !== "production";

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const currentPlan = normalizePlanId(settings?.planId);

  // If the platform admin has granted this store an active yearly discount,
  // apply it to the real Shopify charge — not just the price shown on this
  // page — for the same number of billing cycles the discount is valid for.
  const activeDiscount = await getActiveStoreDiscount(shop);

  if (targetPlanId === currentPlan) {
    // Re-requesting the current plan is normally a no-op, but it is the only
    // way to move an existing subscriber onto a discounted subscription.
    const canReissueForDiscount = Boolean(activeDiscount) && targetPlanId !== "free";
    if (!canReissueForDiscount) {
      return {
        success: false,
        message: `Your store is already subscribed to the ${PLAN_TIERS[currentPlan]?.name || currentPlan} plan.`,
      };
    }
  }

  if (targetPlanId === "free") {
    let allCancelled = true;

    try {
      const billingCheck = await billing.check({
        plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS, PLAN_ENTERPRISE],
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
      allCancelled = false;
      console.warn("[Revertly Billing] Shopify billing cancel warning:", err?.message || err);
    }

    if (!allCancelled) {
      return {
        success: false,
        message: "We couldn't cancel your active subscription with Shopify. Your plan has not been changed — please try again, or contact support.",
      };
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: "free", subscriptionId: null },
      update: { planId: "free", subscriptionId: null },
    });

    return {
      success: true,
      planId: "free",
      message: "Successfully downgraded to the Free plan. Paid features will be deactivated.",
    };
  }

  let targetShopifyPlan = PLAN_STARTER;
  if (targetPlanId === "growth") targetShopifyPlan = PLAN_GROWTH;
  else if (targetPlanId === "business") targetShopifyPlan = PLAN_BUSINESS;
  else if (targetPlanId === "enterprise") targetShopifyPlan = PLAN_ENTERPRISE;

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/plan`;

  const lineItemOverrides = activeDiscount
    ? {
        lineItems: [
          {
            amount: PLAN_TIERS[targetPlanId]?.price,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days,
            discount: {
              durationLimitInIntervals: DISCOUNT_DURATION_MONTHS,
              value: { percentage: activeDiscount.discountPercent / 100 },
            },
          },
        ],
      }
    : {};

  try {
    return await billing.request({
      plan: targetShopifyPlan,
      isTest,
      returnUrl,
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
      const simSubId = `sim_${targetPlanId}_${Date.now()}`;
      const now = new Date();
      const trialEndsAt = settings?.trialEndsAt || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      await prisma.appSettings.upsert({
        where: { shop },
        create: {
          shop,
          planId: targetPlanId,
          subscriptionId: simSubId,
          hasUsedTrial: true,
          trialEndsAt,
        },
        update: {
          planId: targetPlanId,
          subscriptionId: simSubId,
          hasUsedTrial: true,
          trialEndsAt,
        },
      });

      return {
        success: true,
        planId: targetPlanId,
        message: isDistributionError
          ? `Switched to ${PLAN_TIERS[targetPlanId]?.name} plan in Test Mode. (Partner Note: To test live Shopify billing screens, select 'Public distribution' in Partner Dashboard > Apps > Distribution).`
          : `Successfully upgraded to ${PLAN_TIERS[targetPlanId]?.name} (14-day trial active).`,
      };
    }

    return {
      success: false,
      message: `Unable to initiate Shopify billing for ${targetShopifyPlan}: ${detailedMessage || err?.message || "Please try again or contact support."}`,
    };
  }
};

export default function Plan() {
  const { currentPlan, usage, limits, trialEndsAt, productLimitReachedAt, discount } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const activePlan = result?.planId || currentPlan;
  const isSubmitting = fetcher.state !== "idle";

  const [confirmModal, setConfirmModal] = useState(null);

  const activeOrder = PLAN_TIERS[activePlan]?.order ?? 0;
  const trialStillActive = trialEndsAt && new Date(trialEndsAt) > new Date();

  function trialSubtext(plan) {
    if (plan.id === "free") return plan.subtext;
    if (activePlan === plan.id && trialStillActive) {
      return `Trial active until ${new Date(trialEndsAt).toLocaleDateString()}`;
    }
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

      {/* ── Admin-Granted Discount Banner ──
          Shown whenever the platform admin has an active discount on file.
          It reads differently depending on whether the discount is already
          attached to the live subscription or still needs to be applied. */}
      {discount && (
        <Banner
          tone={discount.needsApply ? "warning" : "success"}
          title={
            discount.needsApply
              ? `${discount.percent}% discount ready to apply`
              : `🎉 ${discount.percent}% discount applied`
          }
          className="rv-fade-in"
        >
          {discount.needsApply ? (
            <>
              You have a special {discount.percent}% discount, valid through{" "}
              {new Date(discount.expiresAt).toLocaleDateString()}, but your current subscription is still
              being charged at full price. Use <strong>Apply my {discount.percent}% discount</strong> on your
              active plan below to switch to the discounted price.
            </>
          ) : (
            <>
              Your special {discount.percent}% discount is active and reflected in the prices below, valid
              through {new Date(discount.expiresAt).toLocaleDateString()}.
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
            <span className="rv-badge rv-badge-success">Active</span>
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 800, color: "var(--rv-text)" }}>
            {PLAN_TIERS[activePlan]?.name || activePlan} Plan
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Real-time catalog watchdog, instant price crash rollback, and multi-resource backup.
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
      <div style={{ marginBottom: "20px" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 4px", color: "var(--rv-text)" }}>
          Choose Your Store Protection Plan
        </h3>
        <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: 0 }}>
          Scale your catalog guardrails as your store expands. All paid plans include a 14-day free trial. Upgrade, downgrade, or cancel anytime.
        </p>
      </div>

      {/* ── 5 Cards Responsive Grid ── */}
      <div className="rv-plan-grid">
        {PLANS.map((plan) => {
          const isCurrent = activePlan === plan.id;
          const planOrder = PLAN_TIERS[plan.id]?.order ?? 0;
          const isUpgrade = planOrder > activeOrder;
          const isDowngrade = planOrder < activeOrder;

          const isGrowth = plan.id === "growth";
          const isBusiness = plan.id === "business";
          const isEnterprise = plan.id === "enterprise";

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

          if (isCurrent) {
            cardBorder = "2px solid var(--rv-primary)";
            cardBg = "var(--rv-primary-surface)";
            boxShadow = "0 0 0 1px var(--rv-primary), 0 4px 16px rgba(0, 128, 96, 0.12)";
          } else if (isGrowth) {
            cardBorder = "2px solid var(--rv-info)";
            boxShadow = "0 4px 14px rgba(0, 91, 211, 0.12)";
          } else if (isBusiness) {
            cardBorder = "2px solid #6366f1";
          } else if (isEnterprise) {
            cardBorder = "2px solid #8b5cf6";
          }

          let buttonLabel = `Choose ${plan.name}`;
          if (isCurrent) {
            buttonLabel = "✓ Active Plan";
          } else if (plan.id === "free") {
            buttonLabel = "Downgrade to Free";
          } else if (isUpgrade) {
            buttonLabel = `Upgrade to ${plan.name}`;
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
                      {plan.name}
                    </span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      {isCurrent && <span className="rv-badge rv-badge-success rv-badge-sm">Current</span>}
                      {tierBadge}
                    </div>
                  </div>

                  {(() => {
                    const basePrice = PLAN_TIERS[plan.id]?.price ?? 0;
                    const hasDiscount = discount && basePrice > 0;
                    const discountedPrice = hasDiscount ? basePrice * (1 - discount.percent / 100) : basePrice;
                    return (
                      <div style={{ marginBottom: "4px" }}>
                        {hasDiscount && (
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                            <span style={{ fontSize: "13px", color: "var(--rv-text-subdued)", textDecoration: "line-through" }}>
                              {plan.price}
                            </span>
                            <span className="rv-badge rv-badge-success rv-badge-sm" style={{ fontWeight: 700 }}>
                              <SparklesIcon size={10} /> {discount.percent}% OFF
                            </span>
                          </div>
                        )}
                        <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                          <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>
                            {hasDiscount ? formatPrice(discountedPrice) : plan.price}
                          </span>
                          {plan.period && (
                            <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                              {plan.period}
                            </span>
                          )}
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
                  {isCurrent && discount?.needsApply && plan.id !== "free" ? (
                    <fetcher.Form method="POST" style={{ width: "100%" }}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="rv-btn rv-btn-primary"
                        style={{ width: "100%", fontWeight: 700 }}
                      >
                        {isSubmitting ? "Applying..." : `Apply my ${discount.percent}% discount`}
                      </button>
                    </fetcher.Form>
                  ) : isCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="rv-btn"
                      style={{ width: "100%", background: "var(--rv-primary-surface)", color: "var(--rv-primary-text)", border: "1px solid var(--rv-primary-border)", cursor: "default", fontWeight: 700 }}
                    >
                      ✓ Active Plan
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

                  <div style={{ textAlign: "center", marginTop: "8px", fontSize: "11px", color: isCurrent ? "var(--rv-primary-text)" : "var(--rv-text-subdued)", fontWeight: 500 }}>
                    {isCurrent ? (trialStillActive ? trialSubtext(plan) : "Active Plan • Included") : trialSubtext(plan)}
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
                <button
                  type="submit"
                  disabled={isSubmitting}
                  onClick={() => setConfirmModal(null)}
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
