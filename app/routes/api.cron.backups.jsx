import { runDueAutomatedBackups, runScheduledBackupForShop } from "../scheduler.server.js";
import { assertCronAuth, withJobLock } from "../cron.server.js";

const handle = async ({ request }) => {
  const denied = assertCronAuth(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const force = url.searchParams.get("force") === "true";

  try {
    if (shop) {
      // Per-shop runs are serialized against that shop only, so one slow store
      // can't block backups for every other store.
      const result = await withJobLock(`backups:${shop}`, 15 * 60 * 1000, () =>
        runScheduledBackupForShop(shop, { force, source: "CRON_ENDPOINT" }),
      );
      return Response.json(result);
    }

    const summary = await withJobLock("backups:sweep", 30 * 60 * 1000, () =>
      runDueAutomatedBackups(),
    );
    return Response.json(summary);
  } catch (error) {
    console.error("[Cron/backups] error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};

export const loader = handle;
export const action = handle;
