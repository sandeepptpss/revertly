import { runDueServiceChecks } from "../uptime.server.js";
import { assertCronAuth, withJobLock } from "../cron.server.js";

const handle = async ({ request }) => {
  const denied = assertCronAuth(request);
  if (denied) return denied;

  try {
    const result = await withJobLock("uptime:sweep", 10 * 60 * 1000, () => runDueServiceChecks());
    return Response.json(result);
  } catch (error) {
    console.error("[Cron/uptime] error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};

export const loader = handle;
export const action = handle;
