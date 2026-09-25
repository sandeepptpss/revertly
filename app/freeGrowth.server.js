/**
 * "Growth plan free for the first N stores" launch promotion.
 *
 * The offer is shown to every installed store while seats remain, and a seat
 * is consumed only when a merchant claims it — so the promotion always gives
 * away N *real* activations rather than being used up by stores that installed
 * and never took it. A claimed seat entitles that store to full Growth
 * features at no charge for the duration the admin configured
 * (PlatformSettings.freeGrowthDurationMonths, 2 by default), counted from the claim.
 *
 * No Shopify subscription is created. The store's stored planId stays "free"
 * and getStorePlan() elevates its *effective* plan instead, so nothing can
 * confuse a promotional seat with a paid subscription.
 *
 * Seat accounting — one claim per store, ever:
 *   - every claim is recorded in FreeGrowthClaim under a one-way hash of the
 *     shop domain, and that ledger is what the seat count reads. It survives
 *     uninstall and shop/redact, so uninstalling and reinstalling cannot win a
 *     second seat (it used to: uninstall deleted the grant and freed the seat);
 *   - uninstalling does not end the seat either. A store that reinstalls
 *     before its seat expires gets the rest of its original term back;
 *   - an expired seat is not released — that store had its turn, it simply no
 *     longer gets the entitlement. That keeps this a genuine launch promotion
 *     rather than a rotating pool.
 */
import { createHash } from "node:crypto";
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

/** The ledger key for a shop. Matches the migration's SHA2(LOWER(TRIM(shop)), 256) backfill. */
export function freeGrowthClaimKey(shop) {
  return createHash("sha256").update(String(shop || "").trim().toLowerCase()).digest("hex");
}

/** Whether this store has ever claimed a seat, even if it was since uninstalled or redacted. */
export async function hasClaimedFreeGrowth(shop) {
  if (!shop) return false;
  const row = await prisma.freeGrowthClaim.findUnique({ where: { shopHash: freeGrowthClaimKey(shop) } });
  return Boolean(row);
}

/** Seats claimed, ever — expired, uninstalled and redacted stores included (see above). */
export async function countFreeGrowthSeatsUsed(client = prisma) {
  return client.freeGrowthClaim.count();
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
  const [status, held] = await Promise.all([getFreeGrowthStatus(), hasClaimedFreeGrowth(shop)]);
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
 * deciding, or this store has claimed before (a double submit, or a reinstall).
 *
 * Allocation is serialised behind a row lock on PlatformSettings so that
 * simultaneous claims cannot both read "19 used" and push past the cap.
 */
export async function claimFreeGrowthSeat(shop) {
  if (!shop) return null;

  if (await hasClaimedFreeGrowth(shop)) return null;

  const settings = await getPlatformSettings();
  if (!settings.freeGrowthEnabled || settings.freeGrowthSeatLimit < 1) return null;

  // The lock below needs a row to lock, and settings may never have been saved.
  await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT id FROM `PlatformSettings` WHERE id = 1 FOR UPDATE");

      const current = await tx.platformSettings.findUnique({ where: { id: 1 } });
      if (!current?.freeGrowthEnabled) return null;

      const shopHash = freeGrowthClaimKey(shop);
      const claimedBefore = await tx.freeGrowthClaim.findUnique({ where: { shopHash } });
      if (claimedBefore) return null;

      const used = await countFreeGrowthSeatsUsed(tx);
      if (used >= current.freeGrowthSeatLimit) return null;

      const durationMonths = Number(current.freeGrowthDurationMonths) || DEFAULT_FREE_GROWTH_DURATION_MONTHS;
      const claimedAt = new Date();
      const expiresAt = computeFreeGrowthExpiry(claimedAt, durationMonths);

      await tx.freeGrowthClaim.create({ data: { shopHash, claimedAt } });
      // A grant can outlive its claim record only for a store that claimed
      // before the ledger existed and was since redacted; replace it.
      await tx.freeGrowthGrant.deleteMany({ where: { shop } });
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

/**
 * Undo a claim that did not go through — the Plan page claims the seat first
 * and calls this if cancelling the merchant's Starter subscription then fails.
 * The store never got the promotion, so its claim record goes too. This is not
 * called on uninstall: a claimed seat stays claimed (see above).
 */
export async function releaseFreeGrowthSeat(shop) {
  await prisma.$transaction([
    prisma.freeGrowthGrant.deleteMany({ where: { shop } }),
    prisma.freeGrowthClaim.deleteMany({ where: { shopHash: freeGrowthClaimKey(shop) } }),
  ]);
}
