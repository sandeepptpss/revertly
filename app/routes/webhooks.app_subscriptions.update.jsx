import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

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

    console.log(`[Revertly Webhook] Subscription "${name}" status changed to ${status} for ${shop}`);

    let targetPlan = "free";

    if (status === "ACTIVE") {
      const lowerName = name.toLowerCase();
      if (lowerName.includes("starter")) targetPlan = "starter";
      else if (lowerName.includes("growth") || lowerName.includes("pro")) targetPlan = "growth";
      else if (lowerName.includes("business")) targetPlan = "business";
      else if (lowerName.includes("enterprise")) targetPlan = "enterprise";
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: { shop, planId: targetPlan },
      update: { planId: targetPlan },
    });

    console.log(`[Revertly Webhook] Updated shop ${shop} plan to "${targetPlan}"`);
  } catch (err) {
    console.error(`[Revertly Webhook Error] Failed to process app_subscriptions/update for ${shop}:`, err);
  }

  return new Response("OK", { status: 200 });
};
