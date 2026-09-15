import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import {
  PLAN_STARTER,
  PLAN_GROWTH,
  PLAN_BUSINESS,
  PLAN_ENTERPRISE,
  PLAN_PRO,
} from "../billing.server.js";

// Exact (case-insensitive) map from a Shopify subscription's name to our internal plan id.
const NAME_TO_PLAN = new Map(
  [
    [PLAN_STARTER, "starter"],
    [PLAN_GROWTH, "growth"],
    [PLAN_PRO, "growth"],
    [PLAN_BUSINESS, "business"],
    [PLAN_ENTERPRISE, "enterprise"],
  ].map(([name, planId]) => [name.toLowerCase(), planId])
);

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
      const targetPlan = NAME_TO_PLAN.get(name.toLowerCase()) || "free";

      const existing = await prisma.appSettings.findUnique({ where: { shop } });
      const alreadyUsedTrial = Boolean(existing?.hasUsedTrial);

      await prisma.appSettings.upsert({
        where: { shop },
        create: {
          shop,
          planId: targetPlan,
          subscriptionId,
          hasUsedTrial: true,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
        update: {
          planId: targetPlan,
          subscriptionId,
          hasUsedTrial: true,
          // Only (re)start the trial-end estimate the first time this shop
          // ever activates a paid plan; later activations aren't a new trial.
          ...(alreadyUsedTrial ? {} : { trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }),
        },
      });

      console.log(`[Revertly Webhook] Updated shop ${shop} plan to "${targetPlan}"`);
    } else if (TERMINAL_STATUSES.has(status)) {
      await prisma.appSettings.upsert({
        where: { shop },
        create: { shop, planId: "free", subscriptionId: null },
        update: { planId: "free", subscriptionId: null },
      });

      console.log(`[Revertly Webhook] Subscription ${status} — downgraded shop ${shop} to "free"`);
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
