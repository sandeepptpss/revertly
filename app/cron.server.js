/**
 * Cron authentication and distributed job locking for Revertly.
 *
 * The /api/cron/* routes are reachable by anyone on the internet and trigger
 * privileged work (backups, restores of scheduling state, outbound requests),
 * so they are gated on a shared secret. They deliberately fail CLOSED: if
 * CRON_SECRET is not configured the endpoints refuse to run at all rather than
 * defaulting to open.
 *
 * Scheduled sweeps also run from an in-process interval in every web instance.
 * Without coordination, N instances would each fire the same sweep. JobLock
 * gives us a single winner per interval, with a TTL so a crashed holder
 * self-heals instead of wedging the schedule forever.
 */
import crypto from "node:crypto";
import prisma from "./db.server.js";

/** Identifies this process in JobLock.owner — diagnostics only, never for authz. */
export const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

/**
 * Compares two strings without leaking their contents through timing.
 * Hashing first keeps timingSafeEqual happy when lengths differ.
 */
function safeEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Authorizes a cron request.
 *
 * @returns {Response|null} a Response to return immediately, or null when authorized.
 */
export function assertCronAuth(request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    // Fail closed. An unset secret must never mean "allow everyone".
    return Response.json(
      {
        success: false,
        error:
          "Cron endpoints are disabled because CRON_SECRET is not configured. " +
          "Set CRON_SECRET in the environment to enable scheduled jobs.",
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const provided =
    request.headers.get("x-cron-secret") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("token") ||
    "";

  if (!provided || !safeEquals(provided, secret)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

/**
 * Attempts to take a named lock.
 *
 * Acquisition is atomic in both branches: the insert relies on the unique index
 * on `name`, and the steal is a single conditional UPDATE, so concurrent callers
 * cannot both succeed.
 *
 * @returns {Promise<boolean>} true if this caller now holds the lock.
 */
export async function acquireJobLock(name, ttlMs = 10 * 60 * 1000) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    await prisma.jobLock.create({
      data: { name, owner: INSTANCE_ID, lockedAt: now, expiresAt },
    });
    return true;
  } catch (err) {
    // P2002 = unique constraint violation: someone already holds (or held) it.
    if (err?.code !== "P2002") throw err;
  }

  // Take over only if the existing lock has lapsed.
  const stolen = await prisma.jobLock.updateMany({
    where: { name, expiresAt: { lt: now } },
    data: { owner: INSTANCE_ID, lockedAt: now, expiresAt },
  });

  return stolen.count === 1;
}

/**
 * Releases a lock, but only if this instance still owns it — prevents a slow
 * job from releasing a lock that another instance legitimately took over after
 * the TTL lapsed.
 */
export async function releaseJobLock(name) {
  try {
    await prisma.jobLock.deleteMany({ where: { name, owner: INSTANCE_ID } });
  } catch (err) {
    console.warn(`[Cron] Could not release lock "${name}":`, err?.message);
  }
}

/**
 * Runs `fn` while holding `name`. If the lock is already held, `fn` is skipped
 * and a { skipped: true } result is returned instead.
 */
export async function withJobLock(name, ttlMs, fn) {
  const acquired = await acquireJobLock(name, ttlMs);
  if (!acquired) {
    return { skipped: true, reason: `Job "${name}" is already running in another instance.` };
  }
  try {
    return await fn();
  } finally {
    await releaseJobLock(name);
  }
}
