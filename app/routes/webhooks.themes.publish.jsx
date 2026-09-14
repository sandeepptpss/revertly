import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { fetchThemeBackup } from "../backup.server.js";

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

    const theme = payload;
    const themeName = theme?.name || "Theme";
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    // Capture theme files snapshot if admin API client is available
    let themeData = null;
    if (admin) {
      themeData = await fetchThemeBackup(admin);
    }

    // Auto-create a safety restore point
    await prisma.restorePoint.create({
      data: {
        shop,
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

    // Notify merchant via Slack webhook if configured
    if (settings?.slackWebhookUrl) {
      try {
        await fetch(settings.slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `*[Revertly Alert] Live Theme Published on ${shop}*`,
            attachments: [
              {
                color: "#2C6ECB",
                title: `🎨 New Live Theme: "${themeName}"`,
                text: `A new theme was published to your live storefront. Revertly has automatically created a safety restore point so you can rollback anytime.`,
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

    return new Response("Theme published and safety snapshot created", { status: 200 });
  } catch (err) {
    console.error("webhooks.themes.publish error:", err?.message || err);
    return new Response("Error processing theme publish webhook", { status: 500 });
  }
};
