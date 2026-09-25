import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import {
  INTERVAL_MONTHLY,
  INTERVAL_ANNUAL,
  planInfoForSubscriptionName,
  customOfferPatchForActiveSubscription,
  customCancellationPatch,
} from "../billing.server.js";

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
      // An ACTIVE subscription means the merchant is being charged. If the
      // name matches no known plan (renamed or legacy tier), downgrading
      // them to free would strip entitlements they are paying for, so leave
      // the stored plan untouched and surface it for follow-up instead.
      const planInfo = planInfoForSubscriptionName(name);
      if (!planInfo) {
        console.error(
          `[Revertly Webhook] ACTIVE subscription "${name}" for ${shop} matches no known plan — leaving stored plan unchanged.`,
        );
        return new Response("Unrecognised active plan name; ignored", { status: 200 });
      }
      const targetPlan = planInfo.planId;

      let targetInterval = planInfo.interval || INTERVAL_MONTHLY;
      const lineItemInterval = subscription?.line_items?.[0]?.plan?.pricing_details?.interval;
      if (lineItemInterval === "ANNUAL" || name.toLowerCase().includes("annual")) {
        targetInterval = INTERVAL_ANNUAL;
      }

      const existing = await prisma.appSettings.findUnique({ where: { shop } });
      const alreadyUsedTrial = Boolean(existing?.hasUsedTrial);

      // Only the dedicated custom plan accepts a custom offer; any other
      // charge becoming active means a Shopify-billed custom plan was replaced.
      const customStatusChange = customOfferPatchForActiveSubscription(existing, planInfo.isCustom, {
        price: subscription.price ?? subscription?.line_items?.[0]?.plan?.pricing_details?.price?.amount ?? null,
        isNewSubscription: Boolean(subscriptionId) && subscriptionId !== existing?.subscriptionId,
      });

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
          ...customStatusChange,
        },
      });

      console.log(`[Revertly Webhook] Updated shop ${shop} plan to "${targetPlan}" (${targetInterval})`);
    } else if (TERMINAL_STATUSES.has(status)) {
      const existing = await prisma.appSettings.findUnique({ where: { shop } });
      if (existing?.customBillingMethod === "EXTERNAL" && existing?.customPriceStatus === "ACTIVE") {
        console.log(`[Revertly Webhook] Shop ${shop} is on an external contract — preserving Enterprise plan.`);
        return new Response("OK", { status: 200 });
      }

      // Every plan change replaces the old subscription, and Shopify then
      // reports the *old* one as CANCELLED — with no ordering guarantee
      // against the new one's ACTIVE event. Only the subscription the store is
      // actually on may downgrade it; a stale cancellation must not wipe out
      // the plan that replaced it.
      if (existing?.subscriptionId && subscriptionId && existing.subscriptionId !== subscriptionId) {
        console.log(
          `[Revertly Webhook] ${status} for replaced subscription ${subscriptionId} (current ${existing.subscriptionId}) on ${shop} — no plan change`,
        );
        return new Response("OK", { status: 200 });
      }

      // Disarm paid protections at the moment of downgrade.
      await prisma.appSettings.upsert({
        where: { shop },
        create: { shop, planId: "free", subscriptionId: null, billingInterval: INTERVAL_MONTHLY },
        update: {
          planId: "free",
          subscriptionId: null,
          billingInterval: INTERVAL_MONTHLY,
          circuitBreakerEnabled: false,
          ...customCancellationPatch(existing),
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
