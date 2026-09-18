/**
 * "Growth plan free for the first N stores" launch promotion.
 *
 * The offer is shown to every installed store while seats remain, and a seat
 * is consumed only when a merchant claims it — so the promotion always gives
 * away N *real* activations rather than being used up by stores that installed
 * and never took it. A claimed seat entitles that store to full Growth
 * features at no charge for 12 months, counted from the claim.
 *
 * No Shopify subscription is created. The store's stored planId stays "free"
 * and getStorePlan() elevates its *effective* plan instead, so nothing can
 * confuse a promotional seat with a paid subscription.
 *
 * Seat accounting:
 *   - uninstalling releases the seat (the row is deleted) and it returns to
 *     the pool for another store to claim;
 *   - an expired seat is NOT released — that store had its turn, it simply no
 *     longer gets the entitlement. That keeps this a genuine launch promotion
 *     rather than a rotating pool.
 */
import prisma from "./db.server.js";
import { getPlatformSettings } from "./storeDiscount.server.js";

export const FREE_GROWTH_PLAN_ID = "growth";
export const DEFAULT_FREE_GROWTH_DURATION_MONTHS = 2;

/** Calculates expiry date from a starting date and number of months. */
export function computeFreeGrowthExpiry(from = new Date(), durationMonths = DEFAULT_FREE_GROWTH_DURATION_MONTHS) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + durationMonths);
  return d;
}

/** The store's seat if it still entitles them to Growth, else null. */
export async function getActiveFreeGrowthGrant(shop) {
  const grant = await prisma.freeGrowthGrant.findUnique({ where: { shop } });
  if (!grant) return null;
  if (grant.expiresAt <= new Date()) return null;
  return grant;
}

/** Seats claimed, including expired ones (see the accounting note above). */
export async function countFreeGrowthSeatsUsed() {
  return prisma.freeGrowthGrant.count();
}

export async function getFreeGrowthStatus() {
  const [settings, used] = await Promise.all([getPlatformSettings(), countFreeGrowthSeatsUsed()]);
  // A configured limit of 0 closes the promotion and must survive as 0 — `||`
  // would fall back to 20 and advertise seats that can never be claimed.
  const rawLimit = Number(settings.freeGrowthSeatLimit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 20;
  const durationMonths = Number(settings.freeGrowthDurationMonths) || DEFAULT_FREE_GROWTH_DURATION_MONTHS;
  const remaining = Math.max(0, limit - used);
  return {
    enabled: Boolean(settings.freeGrowthEnabled),
    limit,
    durationMonths,
    used,
    remaining,
    isSoldOut: remaining < 1,
  };
}

/**
 * Whether this store can still claim a free Growth seat: the promotion is
 * running, seats are left, and it does not already hold one. Read-only, so it
 * is safe to call from a loader.
 */
export async function getFreeGrowthOffer(shop) {
  const [status, held] = await Promise.all([
    getFreeGrowthStatus(),
    prisma.freeGrowthGrant.findUnique({ where: { shop } }),
  ]);
  if (!status.enabled || status.remaining < 1 || held) return null;
  return {
    remaining: status.remaining,
    limit: status.limit,
    durationMonths: status.durationMonths,
  };
}

/**
 * Claim a seat for this store. Returns the grant, or null when there was
 * nothing to claim — the promotion is off, seats ran out while they were
 * deciding, or they already hold one (a double submit).
 *
 * Allocation is serialised behind a row lock on PlatformSettings so that
 * simultaneous claims cannot both read "19 used" and push past the cap.
 */
export async function claimFreeGrowthSeat(shop) {
  if (!shop) return null;

  const existing = await prisma.freeGrowthGrant.findUnique({ where: { shop } });
  if (existing) return null;

  const settings = await getPlatformSettings();
  if (!settings.freeGrowthEnabled || settings.freeGrowthSeatLimit < 1) return null;

  // The lock below needs a row to lock, and settings may never have been saved.
  await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT id FROM `PlatformSettings` WHERE id = 1 FOR UPDATE");

      const current = await tx.platformSettings.findUnique({ where: { id: 1 } });
      if (!current?.freeGrowthEnabled) return null;

      const alreadyHeld = await tx.freeGrowthGrant.findUnique({ where: { shop } });
      if (alreadyHeld) return null;

      const used = await tx.freeGrowthGrant.count();
      if (used >= current.freeGrowthSeatLimit) return null;

      const durationMonths = Number(current.freeGrowthDurationMonths) || DEFAULT_FREE_GROWTH_DURATION_MONTHS;
      const claimedAt = new Date();
      const expiresAt = computeFreeGrowthExpiry(claimedAt, durationMonths);

      return tx.freeGrowthGrant.create({
        data: { shop, grantedAt: claimedAt, expiresAt },
      });
    });
  } catch (err) {
    // A concurrent claim winning the unique-shop race is not an error.
    if (err?.code === "P2002") return null;
    console.error("[Revertly FreeGrowth] Could not claim a seat for", shop, err?.message || err);
    return null;
  }
}

/** Uninstall releases the seat back to the pool. */
export async function releaseFreeGrowthSeat(shop) {
  await prisma.freeGrowthGrant.deleteMany({ where: { shop } });
}
