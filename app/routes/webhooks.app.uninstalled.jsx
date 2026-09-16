import { authenticate } from "../shopify.server";
import db from "../db.server";
import { releaseFreeGrowthSeat } from "../freeGrowth.server.js";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Free the store's promotional Growth seat so the next new store can take it.
  await releaseFreeGrowthSeat(shop);

  return new Response();
};
