import { runDueTagChecks } from "../ga4Monitor.server.js";
import { assertCronAuth, withJobLock } from "../cron.server.js";

const handle = async ({ request }) => {
  const denied = assertCronAuth(request);
  if (denied) return denied;

  try {
    const result = await withJobLock("ga4:sweep", 15 * 60 * 1000, () => runDueTagChecks());
    return Response.json(result);
  } catch (error) {
    console.error("[Cron/ga4] error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};

export const loader = handle;
export const action = handle;
