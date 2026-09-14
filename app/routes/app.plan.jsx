import { useLoaderData, useFetcher, useRouteError } from "react-router";
import {
  authenticate,
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_PRO,
  PLAN_ENTERPRISE,
} from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

// ── Plan definitions ────────────────────────────────────────────────────────
const PLANS = [
  {
    id: "free",
    category: "Free to install",
    name: "Free",
    price: "$0",
    period: "",
    subtext: "",
    footerText: "Basic protection",
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
      "Email change alerts",
    ],
  },
  {
    id: "growth",
    category: "Most Popular",
    name: "Growth",
    price: "$19",
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
      "Email & Audit log reports",
    ],
  },
  {
    id: "business",
    category: "Ultimate Shield",
    name: "Business",
    price: "$29",
    period: "/ month",
    subtext: "Complete Peace of Mind",
    footerText: "For large stores & teams",
    features: [
      "Unlimited products monitored",
      "365 days (1 year) retention",
      "Unlimited restore points",
      "Full Store Backup (Themes, Code & Collections)",
      "1-Click Theme Code & Settings Rollback",
      "Unlimited detection rules",
      "Emergency Circuit Breaker (Auto-Draft)",
      "Real-time Slack Webhook Alerts",
      "Instant bulk & variant rollback",
      "Priority developer support",
    ],
  },
];

// Usage limits per plan
const PLAN_LIMITS = {
  free: { products: 100, restorePoints: 2, rules: 1 },
  starter: { products: 1000, restorePoints: 10, rules: 3 },
  growth: { products: 5000, restorePoints: 50, rules: 10 },
  pro: { products: 5000, restorePoints: 50, rules: 10 }, // backwards compat
  business: { products: Infinity, restorePoints: Infinity, rules: Infinity },
  enterprise: { products: Infinity, restorePoints: Infinity, rules: Infinity }, // backwards compat
};

// ── Server ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.NODE_ENV !== "production";

  let activeShopifyPlan = null;
  try {
    const billingCheck = await billing.check({
      plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS],
      isTest,
    });
    if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
      const subName = billingCheck.appSubscriptions[0]?.name;
      if (subName === PLAN_STARTER) activeShopifyPlan = "starter";
      else if (subName === PLAN_GROWTH || subName === PLAN_PRO) activeShopifyPlan = "growth";
      else if (subName === PLAN_BUSINESS || subName === PLAN_ENTERPRISE) activeShopifyPlan = "business";
    }
  } catch (err) {
    console.warn("Shopify billing check warning:", err?.message || err);
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  let currentPlan = activeShopifyPlan || settings?.planId || "free";

  // Normalize legacy plan IDs
  if (currentPlan === "pro") currentPlan = "growth";
  if (currentPlan === "enterprise") currentPlan = "business";

  if (activeShopifyPlan && settings && settings.planId !== activeShopifyPlan) {
    await prisma.appSettings.update({
      where: { shop },
      data: { planId: activeShopifyPlan },
    });
  }

  const [productCount, changeCount, restorePointCount, ruleCount] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.changeEvent.count({ where: { shop } }),
    prisma.restorePoint.count({ where: { shop } }),
    prisma.detectionRule.count({ where: { shop } }),
  ]);

  return {
    currentPlan,
    usage: { productCount, changeCount, restorePointCount, ruleCount },
    shop,
  };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const planId = formData.get("planId");
  const isTest = process.env.NODE_ENV !== "production";

  if (planId === "starter" || planId === "growth" || planId === "business" || planId === "pro" || planId === "enterprise") {
    let targetPlan = PLAN_STARTER;
    let normalizedPlanId = planId;

    if (planId === "growth" || planId === "pro") {
      targetPlan = PLAN_GROWTH;
      normalizedPlanId = "growth";
    } else if (planId === "business" || planId === "enterprise") {
      targetPlan = PLAN_BUSINESS;
      normalizedPlanId = "business";
    }

    const url = new URL(request.url);
    const returnUrl = `${url.origin}/app/plan`;

    try {
      return await billing.request({
        plan: targetPlan,
        isTest,
        returnUrl,
      });
    } catch (err) {
      console.warn("Shopify billing request fallback:", err?.message || err);
      await prisma.appSettings.upsert({
        where: { shop },
        create: { shop, planId: normalizedPlanId },
        update: { planId: normalizedPlanId },
      });

      return {
        success: true,
        planId: normalizedPlanId,
        message: `Switched to the ${normalizedPlanId.charAt(0).toUpperCase() + normalizedPlanId.slice(1)} plan.`,
      };
    }
  } else if (planId === "free") {
    try {
      const billingCheck = await billing.check({
        plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS],
        isTest,
      });
      if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
        for (const sub of billingCheck.appSubscriptions) {
          await billing.cancel({
            subscriptionId: sub.id,
            isTest,
            prorate: true,
          });
        }
      }
    } catch (err) {
      console.warn("Shopify billing cancel warning:", err?.message || err);
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: "free" },
      update: { planId: "free" },
    });

    return {
      success: true,
      planId: "free",
      message: "Successfully switched to the Free plan.",
    };
  }

  return { success: false, message: "Invalid plan selected." };
};

// ── Component ────────────────────────────────────────────────────────────────
export default function Plan() {
  const { currentPlan, usage } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const activePlan = result?.planId || currentPlan;
  const limits = PLAN_LIMITS[activePlan] || PLAN_LIMITS.free;
  const isSubmitting = fetcher.state !== "idle";

  return (
    <s-page>
      {/* Success banner */}
      {result?.success && (
        <s-section>
          <s-banner tone="success">{result.message}</s-banner>
        </s-section>
      )}

      {/* ── Current Plan Usage Summary ── */}
      <s-section>
        <s-card>
          <s-box padding="400">
            <s-stack direction="inline" align="space-between" gap="400" blockAlign="center" wrap>
              <s-stack direction="block" gap="100">
                <s-text tone="subdued" variant="bodyXs" fontWeight="bold">
                  YOUR CURRENT PLAN
                </s-text>
                <s-stack direction="inline" gap="200" blockAlign="center">
                  <s-text variant="headingMd" fontWeight="bold">
                    {activePlan.charAt(0).toUpperCase() + activePlan.slice(1)} Plan
                  </s-text>
                  <s-badge tone="success">Active</s-badge>
                </s-stack>
              </s-stack>
              <s-stack direction="inline" gap="500" wrap>
                <s-stack direction="block" gap="050">
                  <s-text tone="subdued" variant="bodyXs">Products Monitored</s-text>
                  <s-text variant="bodySm" fontWeight="bold">
                    {usage.productCount.toLocaleString()} /{" "}
                    {limits.products === Infinity ? "Unlimited" : limits.products.toLocaleString()}
                  </s-text>
                </s-stack>
                <s-stack direction="block" gap="050">
                  <s-text tone="subdued" variant="bodyXs">Restore Points</s-text>
                  <s-text variant="bodySm" fontWeight="bold">
                    {usage.restorePointCount} / {limits.restorePoints === Infinity ? "Unlimited" : limits.restorePoints}
                  </s-text>
                </s-stack>
                <s-stack direction="block" gap="050">
                  <s-text tone="subdued" variant="bodyXs">Active Rules</s-text>
                  <s-text variant="bodySm" fontWeight="bold">
                    {usage.ruleCount} / {limits.rules === Infinity ? "Unlimited" : limits.rules}
                  </s-text>
                </s-stack>
              </s-stack>
            </s-stack>
          </s-box>
        </s-card>
      </s-section>

      {/* ── Main Pricing Header ── */}
      <s-section>
        <s-stack direction="block" gap="100">
          <s-text variant="headingLg" fontWeight="bold">Choose Your Protection Plan</s-text>
          <s-text tone="subdued" variant="bodyMd">
            Scale your peace of mind as your store grows. Upgrade, downgrade, or cancel anytime.
          </s-text>
        </s-stack>
      </s-section>

      {/* ── Four Cards Columns ── */}
      <s-section>
        <s-columns columns="4">
          {PLANS.map((plan) => {
            const isCurrent = activePlan === plan.id;
            const isGrowth = plan.id === "growth";
            const isBusiness = plan.id === "business";

            return (
              <s-card key={plan.id}>
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    borderRadius: "10px",
                    border: isGrowth ? "2px solid #005bd3" : "1px solid transparent",
                    background: isGrowth ? "rgba(0, 91, 211, 0.02)" : "transparent",
                    transition: "all 0.2s ease",
                  }}
                >
                  <s-box padding="400">
                    <s-stack direction="block" gap="300">
                      {/* Header */}
                      <s-stack direction="block" gap="100">
                        <s-stack direction="inline" align="space-between" blockAlign="center" gap="100">
                          <s-text variant="headingMd" fontWeight="bold">
                            {plan.name}
                          </s-text>
                          {isCurrent ? (
                            <s-badge tone="success">Current</s-badge>
                          ) : isGrowth ? (
                            <s-badge tone="info">Most Popular</s-badge>
                          ) : isBusiness ? (
                            <s-badge tone="magic">Ultimate</s-badge>
                          ) : null}
                        </s-stack>
                        
                        <s-stack direction="inline" align="baseline" gap="050">
                          <s-text variant="heading2xl" fontWeight="bold">
                            {plan.price}
                          </s-text>
                          {plan.period && (
                            <s-text tone="subdued" variant="bodySm">
                              {plan.period}
                            </s-text>
                          )}
                        </s-stack>
                        
                        <s-text tone="subdued" variant="bodyXs">
                          {plan.category}
                        </s-text>
                      </s-stack>

                      <div style={{ borderTop: "1px solid var(--p-color-border-subdued, #e1e3e5)" }} />

                      {/* Features List */}
                      <s-stack direction="block" gap="200">
                        <s-text variant="bodyXs" fontWeight="bold">What&apos;s included:</s-text>
                        <s-stack direction="block" gap="150">
                          {plan.features.map((feature, idx) => (
                            <s-stack key={idx} direction="inline" gap="150" blockAlign="start">
                              <svg width="12" height="12" viewBox="0 0 20 20" fill="none" style={{ minWidth: "12px", marginTop: "2px" }}>
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" fill="#008060" />
                              </svg>
                              <s-text variant="bodyXs">{feature}</s-text>
                            </s-stack>
                          ))}
                        </s-stack>
                      </s-stack>
                    </s-stack>

                    {/* Actions */}
                    <s-box paddingBlockStart="400">
                      <s-stack direction="block" gap="150" align="center">
                        {isCurrent ? (
                          <s-button disabled fullWidth>
                            Active Plan
                          </s-button>
                        ) : (
                          <fetcher.Form method="POST" style={{ width: "100%" }}>
                            <input type="hidden" name="planId" value={plan.id} />
                            <s-button
                              submit
                              variant={isGrowth ? "primary" : "secondary"}
                              fullWidth
                              loading={isSubmitting}
                            >
                              {plan.id === "free" ? "Downgrade to Free" : `Choose ${plan.name}`}
                            </s-button>
                          </fetcher.Form>
                        )}
                        {plan.subtext ? (
                          <s-text tone="success" variant="bodyXs" fontWeight="bold">
                            {plan.subtext}
                          </s-text>
                        ) : (
                          <s-text tone="subdued" variant="bodyXs">
                            {plan.footerText}
                          </s-text>
                        )}
                      </s-stack>
                    </s-box>
                  </s-box>
                </div>
              </s-card>
            );
          })}
        </s-columns>
      </s-section>

      {/* ── Guarantee & Disclaimer ── */}
      <s-section>
        <s-box paddingBlockStart="400">
          <s-stack direction="block" gap="100" align="center">
            <s-text tone="subdued" variant="bodyXs">
              All plans include automated snapshot tracking. Charges are billed in USD every 30 days. You can upgrade, downgrade, or cancel anytime directly in Shopify.
            </s-text>
            <s-link url="/app/support">
              Need help choosing? Contact developer support
            </s-link>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
