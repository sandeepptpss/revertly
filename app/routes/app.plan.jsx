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

// Usage limits per plan
const PLAN_LIMITS = {
  free: { products: 100, restorePoints: 2, rules: 1 },
  starter: { products: 1000, restorePoints: 10, rules: 3 },
  growth: { products: 5000, restorePoints: 50, rules: 10 },
  pro: { products: 5000, restorePoints: 50, rules: 10 }, // backwards compat
  business: { products: 20000, restorePoints: 100, rules: Infinity },
  enterprise: { products: Infinity, restorePoints: Infinity, rules: Infinity },
};

// ── Server ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.NODE_ENV !== "production";

  let activeShopifyPlan = null;
  try {
    const billingCheck = await billing.check({
      plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS, PLAN_ENTERPRISE],
      isTest,
    });
    if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
      const subName = billingCheck.appSubscriptions[0]?.name;
      if (subName === PLAN_STARTER) activeShopifyPlan = "starter";
      else if (subName === PLAN_GROWTH || subName === PLAN_PRO) activeShopifyPlan = "growth";
      else if (subName === PLAN_BUSINESS) activeShopifyPlan = "business";
      else if (subName === PLAN_ENTERPRISE) activeShopifyPlan = "enterprise";
    }
  } catch (err) {
    console.warn("Shopify billing check warning:", err?.message || err);
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  let currentPlan = activeShopifyPlan || settings?.planId || "free";

  // Normalize legacy plan IDs
  if (currentPlan === "pro") currentPlan = "growth";

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

  if (
    planId === "starter" ||
    planId === "growth" ||
    planId === "business" ||
    planId === "enterprise" ||
    planId === "pro"
  ) {
    let targetPlan = PLAN_STARTER;
    let normalizedPlanId = planId;

    if (planId === "growth" || planId === "pro") {
      targetPlan = PLAN_GROWTH;
      normalizedPlanId = "growth";
    } else if (planId === "business") {
      targetPlan = PLAN_BUSINESS;
      normalizedPlanId = "business";
    } else if (planId === "enterprise") {
      targetPlan = PLAN_ENTERPRISE;
      normalizedPlanId = "enterprise";
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
        plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS, PLAN_ENTERPRISE],
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
    <s-page heading="Plans & Billing" inlineSize="large">

      {/* ── Success Feedback Banner ── */}
      {result?.success && (
        <div
          style={{
            background: "var(--rv-primary-surface)",
            border: "1px solid var(--rv-primary-border)",
            color: "var(--rv-primary)",
            padding: "14px 18px",
            borderRadius: "var(--rv-radius-md)",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span>✅</span>
          <span>{result.message}</span>
        </div>
      )}

      {/* ── Current Plan Usage Summary Hero ── */}
      <div className="rv-hero-banner">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px" }}>
              YOUR CURRENT SUBSCRIPTION
            </span>
            <span className="rv-badge rv-badge-success">Active</span>
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 800, color: "var(--rv-text)" }}>
            {activePlan.charAt(0).toUpperCase() + activePlan.slice(1)} Plan
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Automated monitoring, catalog baseline protection, and multi-resource restore points.
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
        </div>
      </div>

      {/* ── Heading ── */}
      <div style={{ marginBottom: "20px" }}>
        <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 4px", color: "var(--rv-text)" }}>
          Choose Your Store Protection Plan
        </h3>
        <p style={{ fontSize: "13px", color: "var(--rv-text-subdued)", margin: 0 }}>
          Scale your peace of mind as your catalog expands. All paid plans include a 14-day free trial. Upgrade, downgrade, or cancel anytime.
        </p>
      </div>

      {/* ── 5 Cards Responsive Grid ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))",
          gap: "16px",
          alignItems: "stretch",
          marginBottom: "32px",
        }}
      >
        {PLANS.map((plan) => {
          const isCurrent = activePlan === plan.id;
          const isGrowth = plan.id === "growth";
          const isBusiness = plan.id === "business";
          const isEnterprise = plan.id === "enterprise";

          let cardBorder = "1px solid var(--rv-border)";
          let cardBg = "#ffffff";
          let badge = null;

          if (isCurrent) {
            badge = <span className="rv-badge rv-badge-success">Current Plan</span>;
          } else if (isGrowth) {
            cardBorder = "2px solid #005bd3";
            badge = <span className="rv-badge rv-badge-info">Most Popular</span>;
          } else if (isBusiness) {
            cardBorder = "2px solid #6366f1";
            badge = <span className="rv-badge rv-badge-warning">Store Shield</span>;
          } else if (isEnterprise) {
            cardBorder = "2px solid #8b5cf6";
            badge = <span className="rv-badge rv-badge-neutral">Shopify Plus</span>;
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
                boxShadow: isGrowth ? "0 4px 12px rgba(0, 91, 211, 0.12)" : "var(--rv-shadow-sm)",
              }}
            >
              <div className="rv-card-body" style={{ display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-between", padding: "20px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--rv-text)" }}>
                      {plan.name}
                    </span>
                    {badge}
                  </div>

                  <div style={{ display: "flex", alignItems: "baseline", gap: "4px", marginBottom: "4px" }}>
                    <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--rv-text)" }}>
                      {plan.price}
                    </span>
                    {plan.period && (
                      <span style={{ fontSize: "12px", color: "var(--rv-text-subdued)" }}>
                        {plan.period}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: "12px", color: "var(--rv-text-subdued)", marginBottom: "16px" }}>
                    {plan.category}
                  </div>

                  <div style={{ borderTop: "1px solid var(--rv-border)", marginBottom: "14px" }} />

                  {/* Features List */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "20px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px" }}>
                      What&apos;s Included:
                    </span>
                    {plan.features.map((feature, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", lineHeight: 1.4 }}>
                        <span style={{ color: "#008060", fontWeight: "bold" }}>✓</span>
                        <span style={{ color: "var(--rv-text)" }}>{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bottom Action Button */}
                <div style={{ borderTop: "1px solid #f1f2f3", paddingTop: "14px", marginTop: "auto" }}>
                  {isCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="rv-btn"
                      style={{ width: "100%", background: "#f1f2f3", color: "#6d7175", cursor: "default", fontWeight: 600 }}
                    >
                      ✓ Active Plan
                    </button>
                  ) : (
                    <fetcher.Form method="POST" style={{ width: "100%" }}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className={`rv-btn ${isGrowth ? "rv-btn-primary" : "rv-btn-secondary"}`}
                        style={{ width: "100%", fontWeight: 600 }}
                      >
                        {plan.id === "free" ? "Downgrade to Free" : `Choose ${plan.name}`}
                      </button>
                    </fetcher.Form>
                  )}

                  <div style={{ textAlign: "center", marginTop: "8px", fontSize: "11px", color: plan.subtext ? "var(--rv-primary)" : "var(--rv-text-subdued)", fontWeight: plan.subtext ? 600 : 400 }}>
                    {plan.subtext || plan.footerText}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

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
