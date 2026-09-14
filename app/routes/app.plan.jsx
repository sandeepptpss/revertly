import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError, Link } from "react-router";
import {
  authenticate,
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
} from "../shopify.server.js";
import prisma from "../db.server.js";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  PLAN_TIERS,
  PLAN_LIMITS,
  getStorePlan,
  normalizePlanId,
} from "../billing.server.js";

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

// ── Server ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.NODE_ENV !== "production";

  const { currentPlan, limits } = await getStorePlan(shop, billing, isTest);

  const [productCount, changeCount, restorePointCount, ruleCount, vaultOrderCount] = await Promise.all([
    prisma.productSnapshot.count({ where: { shop } }),
    prisma.changeEvent.count({ where: { shop } }),
    prisma.restorePoint.count({ where: { shop } }),
    prisma.detectionRule.count({ where: { shop } }),
    prisma.orderArchive.count({ where: { shop } }),
  ]);

  return {
    currentPlan,
    limits,
    usage: { productCount, changeCount, restorePointCount, ruleCount, vaultOrderCount },
    shop,
  };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const rawPlanId = formData.get("planId");
  const targetPlanId = normalizePlanId(rawPlanId);
  const isTest = process.env.NODE_ENV !== "production";

  // Check current store plan
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const currentPlan = normalizePlanId(settings?.planId);

  if (targetPlanId === currentPlan) {
    return {
      success: false,
      message: `Your store is already subscribed to the ${PLAN_TIERS[currentPlan]?.name || currentPlan} plan.`,
    };
  }

  if (targetPlanId === "free") {
    // Downgrade to Free: cancel any active Shopify subscription
    try {
      const billingCheck = await billing.check({
        plans: [PLAN_STARTER, PLAN_GROWTH, PLAN_BUSINESS, PLAN_ENTERPRISE],
        isTest,
      });

      if (billingCheck?.hasActivePayment && billingCheck?.appSubscriptions?.length > 0) {
        for (const sub of billingCheck.appSubscriptions) {
          if (sub.id) {
            await billing.cancel({
              subscriptionId: sub.id,
              isTest,
              prorate: true,
            });
          }
        }
      }
    } catch (err) {
      console.warn("[Revertly Billing] Shopify billing cancel warning:", err?.message || err);
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: "free" },
      update: { planId: "free" },
    });

    return {
      success: true,
      planId: "free",
      message: "Successfully downgraded to the Free plan. Paid features will be deactivated.",
    };
  }

  // Target is a paid plan
  let targetShopifyPlan = PLAN_STARTER;
  if (targetPlanId === "growth") targetShopifyPlan = PLAN_GROWTH;
  else if (targetPlanId === "business") targetShopifyPlan = PLAN_BUSINESS;
  else if (targetPlanId === "enterprise") targetShopifyPlan = PLAN_ENTERPRISE;

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/plan`;

  try {
    // billing.request initiates Shopify subscription and throws an out-of-app redirect
    return await billing.request({
      plan: targetShopifyPlan,
      isTest,
      returnUrl,
    });
  } catch (err) {
    // CRITICAL: If Shopify threw a Response (App Bridge 401 redirect or 302 exitIframe), rethrow it!
    if (err instanceof Response) {
      throw err;
    }

    console.error("[Revertly Billing Error] billing.request failed:", err);
    return {
      success: false,
      message: `Unable to initiate Shopify billing for ${targetShopifyPlan}: ${err?.message || "Please try again or contact support."}`,
    };
  }
};

// ── Component ────────────────────────────────────────────────────────────────
export default function Plan() {
  const { currentPlan, usage, limits } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const activePlan = result?.planId || currentPlan;
  const isSubmitting = fetcher.state !== "idle";

  const [confirmModal, setConfirmModal] = useState(null); // { planId, planName, isDowngrade }

  const activeOrder = PLAN_TIERS[activePlan]?.order ?? 0;

  return (
    <s-page heading="Plans & Billing" inlineSize="large">

      {/* ── Success/Error Feedback Banner ── */}
      {result?.message && (
        <div
          style={{
            background: result.success ? "var(--rv-primary-surface)" : "var(--rv-critical-surface)",
            border: `1px solid ${result.success ? "var(--rv-primary-border)" : "var(--rv-critical-border)"}`,
            color: result.success ? "var(--rv-primary)" : "var(--rv-critical)",
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
          <span>{result.success ? "✅" : "⚠️"}</span>
          <span>{result.message}</span>
        </div>
      )}

      {/* ── Current Plan Usage Summary Hero ── */}
      <div className="rv-hero-banner" style={{ marginBottom: "28px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", color: "var(--rv-text-subdued)", letterSpacing: "0.5px" }}>
              YOUR CURRENT SUBSCRIPTION
            </span>
            <span className="rv-badge rv-badge-success">Active</span>
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 800, color: "var(--rv-text)" }}>
            {PLAN_TIERS[activePlan]?.name || activePlan} Plan
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--rv-text-subdued)" }}>
            Automated monitoring, catalog drift defense, and multi-resource store backup.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "28px", flexWrap: "wrap" }}>
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
              {limits.retentionDays} Days ({usage.changeCount.toLocaleString()} recorded)
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
          let cardBg = "#ffffff";
          let boxShadow = "var(--rv-shadow-sm)";
          let tierBadge = null;

          if (isGrowth) {
            tierBadge = <span className="rv-badge rv-badge-info">Most Popular</span>;
          } else if (isBusiness) {
            tierBadge = <span className="rv-badge rv-badge-warning">Store Shield</span>;
          } else if (isEnterprise) {
            tierBadge = <span className="rv-badge rv-badge-neutral">Shopify Plus</span>;
          }

          if (isCurrent) {
            cardBorder = "2px solid #008060";
            cardBg = "rgba(0, 128, 96, 0.02)";
            boxShadow = "0 0 0 1px #008060, 0 4px 16px rgba(0, 128, 96, 0.12)";
          } else if (isGrowth) {
            cardBorder = "2px solid #005bd3";
            boxShadow = "0 4px 12px rgba(0, 91, 211, 0.12)";
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
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--rv-text)" }}>
                      {plan.name}
                    </span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      {isCurrent && <span className="rv-badge rv-badge-success">Current Plan</span>}
                      {tierBadge}
                    </div>
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
                      style={{ width: "100%", background: "#e4f8f0", color: "#008060", border: "1px solid #aee9d1", cursor: "default", fontWeight: 700 }}
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
                        className={`rv-btn ${isGrowth ? "rv-btn-primary" : "rv-btn-primary"}`}
                        style={{
                          width: "100%",
                          fontWeight: 700,
                          background: isEnterprise ? "#8b5cf6" : isBusiness ? "#6366f1" : isGrowth ? "var(--rv-primary)" : "#005bd3",
                          borderColor: isEnterprise ? "#8b5cf6" : isBusiness ? "#6366f1" : isGrowth ? "var(--rv-primary)" : "#005bd3",
                          color: "#ffffff",
                        }}
                      >
                        {buttonLabel}
                      </button>
                    </fetcher.Form>
                  )}

                  <div style={{ textAlign: "center", marginTop: "8px", fontSize: "11px", color: isCurrent ? "var(--rv-primary)" : "var(--rv-text-subdued)", fontWeight: 500 }}>
                    {isCurrent ? "Active Plan • Included" : plan.subtext}
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
            background: "rgba(0, 0, 0, 0.4)",
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
              boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
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
                background: "#fff4f2",
                border: "1px solid #fed2cd",
                borderRadius: "var(--rv-radius-sm)",
                padding: "12px 14px",
                fontSize: "12px",
                color: "#d72c0d",
                marginBottom: "20px",
                lineHeight: 1.4,
              }}
            >
              ⚠️ <strong>Note:</strong> Downgrading will lower your monitored product and restore point limits. Premium capabilities (such as Liquid Themes Backup, Data Vault sync, and Circuit Breaker) will be restricted to the new plan&apos;s allowance.
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
