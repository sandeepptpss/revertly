import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { fetchThemeBackup, reserveRestorePointSlot } from "../backup.server.js";
import { validateSlackWebhookUrl } from "../monitor.server.js";
import { checkFeatureAccess } from "../billing.server.js";
import { scheduleTagRecheck } from "../ga4Monitor.server.js";

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

    const slot = themeAccess.allowed ? await reserveRestorePointSlot(shop, { source: "THEME_PUBLISH" }) : null;
    if (slot?.allowed) {
      // Capture theme files snapshot if admin API client is available
      let themeData = null;
      if (admin) {
        themeData = await fetchThemeBackup(admin);
      }

      // Auto-create a safety restore point
      await prisma.restorePoint.create({
        data: {
          shop,
          source: "THEME_PUBLISH",
          name: `Auto Snapshot: Theme Published - "${themeName}" (${timeStr})`,
          description: `Automatically created by Revertly when "${themeName}" was published live to the storefront.`,
          status: "READY",
          backupType: "THEMES",
          themeCount: 1,
          themeData: themeData || {
            activeTheme: {
              id: theme?.id ? `gid://shopify/Theme/${theme.id}` : null,
              name: themeName,
              role: "MAIN",
            },
            files: [],
          },
        },
      });
      snapshotCreated = true;
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
