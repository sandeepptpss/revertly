import { runDueQaSuites } from "../qa.server.js";
import { assertCronAuth, withJobLock } from "../cron.server.js";

const handle = async ({ request }) => {
  const denied = assertCronAuth(request);
  if (denied) return denied;

  try {
    const result = await withJobLock("qa:sweep", 30 * 60 * 1000, () => runDueQaSuites());
    return Response.json(result);
  } catch (error) {
    console.error("[Cron/qa] error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};

export const loader = handle;
export const action = handle;
