import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { fetchThemeBackup, reserveRestorePointSlot } from "../backup.server.js";
import { validateSlackWebhookUrl } from "../monitor.server.js";
import { checkFeatureAccess } from "../billing.server.js";
import { scheduleTagRecheck } from "../ga4Monitor.server.js";
import { withJobLock } from "../cron.server.js";

// A theme download takes far longer than Shopify's 5-second webhook timeout,
// so the same publish is routinely delivered again while the first delivery
// is still capturing, and again after it finishes.
const REDELIVERY_WINDOW_MS = 10 * 60 * 1000;

export const action = async ({ request }) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic !== "THEMES_PUBLISH") {
    return new Response("Unhandled topic", { status: 200 });
  }

  try {
    const settings = await prisma.appSettings.findUnique({ where: { shop } });
    if (settings && !settings.monitoringEnabled) {
      return new Response("Monitoring disabled", { status: 200 });
    }

    // Re-verify the GA4 / GTM tag once the new theme is live. This only marks
    // the shop due; the background sweep does the check. Isolated so it can
    // never change this webhook's outcome.
    try {
      await scheduleTagRecheck(shop);
    } catch (tagErr) {
      console.warn("GA4 tag re-check scheduling on theme publish failed:", tagErr?.message || tagErr);
    }

    const theme = payload;
    const themeName = theme?.name || "Theme";
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    // The safety snapshot is a theme backup, which starts at Growth. Without
    // the plan there is nothing to capture — an empty theme-only restore
    // point would only use up the store's allowance.
    const [themeAccess, slackAccess] = await Promise.all([
      checkFeatureAccess(shop, "themes"),
      checkFeatureAccess(shop, "slack"),
    ]);
    let snapshotCreated = false;

    if (themeAccess.allowed) {
      // One capture per shop at a time; a delivery that finds the lock held
      // is a redelivery of a publish already being handled.
      const outcome = await withJobLock(`theme-publish:${shop}`.slice(0, 191), REDELIVERY_WINDOW_MS, async () => {
        const recent = await prisma.restorePoint.findFirst({
          where: {
            shop,
            source: "THEME_PUBLISH",
            createdAt: { gte: new Date(Date.now() - REDELIVERY_WINDOW_MS) },
            name: { contains: `"${themeName}"` },
          },
          select: { id: true },
        });
        if (recent) return { duplicate: true };

        // Captured before a slot is reserved, so a failed read neither writes
        // a "READY" snapshot with no files in it nor rotates out a good one.
        const themeData = admin
          ? await fetchThemeBackup(admin, theme?.id ? `gid://shopify/Theme/${theme.id}` : null)
          : null;
        if (!themeData?.files?.length) {
          console.warn(`[Revertly] Theme publish snapshot skipped for ${shop}: no theme files could be read.`);
          return { created: false };
        }

        const slot = await reserveRestorePointSlot(shop, { source: "THEME_PUBLISH" });
        if (!slot.allowed) return { created: false };

        await prisma.restorePoint.create({
          data: {
            shop,
            source: "THEME_PUBLISH",
            name: `Auto Snapshot: Theme Published - "${themeName}" (${timeStr})`,
            description: `Automatically created by Revertly when "${themeName}" was published live to the storefront.`,
            status: "READY",
            backupType: "THEMES",
            themeCount: 1,
            themeData,
          },
        });
        return { created: true };
      });

      if (outcome?.skipped || outcome?.duplicate) {
        return new Response("Duplicate theme publish delivery", { status: 200 });
      }
      snapshotCreated = Boolean(outcome?.created);
    }

    // Notify merchant via Slack webhook if configured. Host-allowlisted so a
    // stored non-Slack URL can't turn this webhook into an SSRF trigger.
    // Slack alerts are a Business feature; a store that downgraded keeps its
    // saved URL, so the entitlement is checked at send time.
    const slackTarget = validateSlackWebhookUrl(settings?.slackWebhookUrl);
    if (slackTarget.ok && slackAccess.allowed) {
      try {
        await fetch(slackTarget.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `*[Revertly Alert] Live Theme Published on ${shop}*`,
            attachments: [
              {
                color: "#2C6ECB",
                title: `New Live Theme: "${themeName}"`,
                text: snapshotCreated
                  ? `A new theme was published to your live storefront. Revertly has automatically created a safety restore point so you can rollback anytime.`
                  : `A new theme was published to your live storefront.`,
                footer: "Revertly Store Guardian",
                ts: Math.floor(Date.now() / 1000),
              },
            ],
          }),
        });
      } catch (slackErr) {
        console.warn("Slack notification on theme publish failed:", slackErr?.message || slackErr);
      }
    }

    return new Response(
      snapshotCreated ? "Theme published and safety snapshot created" : "Theme published; no snapshot for this plan",
      { status: 200 },
    );
  } catch (err) {
    console.error("webhooks.themes.publish error:", err?.message || err);
    return new Response("Error processing theme publish webhook", { status: 500 });
  }
};
