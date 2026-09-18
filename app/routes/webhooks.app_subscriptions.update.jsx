import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
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
} from "../billing.server.js";

// Exact (case-insensitive) map from a Shopify subscription's name to our internal plan id and interval.
const NAME_TO_PLAN_INFO = new Map([
  [PLAN_STARTER.toLowerCase(), { planId: "starter", interval: INTERVAL_MONTHLY }],
  [PLAN_STARTER_ANNUAL.toLowerCase(), { planId: "starter", interval: INTERVAL_ANNUAL }],
  [PLAN_GROWTH.toLowerCase(), { planId: "growth", interval: INTERVAL_MONTHLY }],
  [PLAN_GROWTH_ANNUAL.toLowerCase(), { planId: "growth", interval: INTERVAL_ANNUAL }],
  [PLAN_PRO.toLowerCase(), { planId: "growth", interval: INTERVAL_MONTHLY }],
  [PLAN_BUSINESS.toLowerCase(), { planId: "business", interval: INTERVAL_MONTHLY }],
  [PLAN_BUSINESS_ANNUAL.toLowerCase(), { planId: "business", interval: INTERVAL_ANNUAL }],
  [PLAN_ENTERPRISE.toLowerCase(), { planId: "enterprise", interval: INTERVAL_MONTHLY }],
  [PLAN_ENTERPRISE_ANNUAL.toLowerCase(), { planId: "enterprise", interval: INTERVAL_ANNUAL }],
]);

// Statuses that mean the subscription is permanently gone and the shop should
// fall back to Free. Transient states (PENDING approval, a temporary FROZEN
// payment hold, ACCEPTED-but-not-yet-active) must NOT strip paid access.
const TERMINAL_STATUSES = new Set(["CANCELLED", "EXPIRED", "DECLINED"]);

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[Revertly Webhook] Received ${topic} for shop ${shop}`);

  try {
    const subscription = payload?.app_subscription;
    if (!subscription) {
      return new Response("Missing app_subscription payload", { status: 200 });
    }

    const name = String(subscription.name || "").trim();
    const status = String(subscription.status || "").toUpperCase();
    const subscriptionId = subscription.admin_graphql_api_id || subscription.id
      ? String(subscription.admin_graphql_api_id || subscription.id)
      : null;

    console.log(`[Revertly Webhook] Subscription "${name}" status changed to ${status} for ${shop}`);

    if (status === "ACTIVE") {
      const planInfo = NAME_TO_PLAN_INFO.get(name.toLowerCase());
      if (!planInfo) {
        // An ACTIVE subscription means the merchant is being charged. If the
        // name matches no known plan (renamed or legacy tier), downgrading
        // them to free would strip entitlements they are paying for, so leave
        // the stored plan untouched and surface it for follow-up instead.
        console.error(
          `[Revertly Webhook] ACTIVE subscription "${name}" for ${shop} matches no known plan — leaving stored plan unchanged.`,
        );
        return new Response("Unrecognised active plan name; ignored", { status: 200 });
      }
      const targetPlan = planInfo.planId;

      let targetInterval = planInfo?.interval || INTERVAL_MONTHLY;
      const lineItemInterval = subscription?.line_items?.[0]?.plan?.pricing_details?.interval;
      if (lineItemInterval === "ANNUAL" || name.toLowerCase().includes("annual")) {
        targetInterval = INTERVAL_ANNUAL;
      }

      const existing = await prisma.appSettings.findUnique({ where: { shop } });
      const alreadyUsedTrial = Boolean(existing?.hasUsedTrial);

      await prisma.appSettings.upsert({
        where: { shop },
        create: {
          shop,
          planId: targetPlan,
          subscriptionId,
          billingInterval: targetInterval,
          hasUsedTrial: true,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
        update: {
          planId: targetPlan,
          subscriptionId,
          billingInterval: targetInterval,
          hasUsedTrial: true,
          // Only (re)start the trial-end estimate the first time this shop
          // ever activates a paid plan; later activations aren't a new trial.
          ...(alreadyUsedTrial ? {} : { trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }),
        },
      });

      console.log(`[Revertly Webhook] Updated shop ${shop} plan to "${targetPlan}" (${targetInterval})`);
    } else if (TERMINAL_STATUSES.has(status)) {
      // Disarm paid protections at the moment of downgrade. Leaving
      // circuitBreakerEnabled=true would keep the Settings page reporting
      // "Armed" for a feature the shop can no longer use, and the runtime
      // guard in triggerCircuitBreaker would be the only thing standing
      // between a free shop and automated catalog mutations.
      await prisma.appSettings.upsert({
        where: { shop },
        create: { shop, planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
        update: {
          planId: "free",
          subscriptionId: null,
          billingInterval: INTERVAL_MONTHLY,
          circuitBreakerEnabled: false,
        },
      });

      console.log(`[Revertly Webhook] Subscription ${status} — downgraded shop ${shop} to "free" and disarmed the circuit breaker`);
    } else {
      // PENDING / FROZEN / ACCEPTED / anything else transient: leave the
      // shop's current plan untouched until we see a terminal or ACTIVE status.
      console.log(`[Revertly Webhook] Transient status ${status} for ${shop} — no plan change`);
    }
  } catch (err) {
    console.error(`[Revertly Webhook Error] Failed to process app_subscriptions/update for ${shop}:`, err);
  }

  return new Response("OK", { status: 200 });
};
