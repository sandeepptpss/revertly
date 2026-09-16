/**
 * Subscription discounts granted by the platform admin.
 *
 * There are two independent sources:
 *   - a store-level grant (StoreDiscount), which is either STANDARD or VIP;
 *   - a global yearly discount (PlatformSettings) offered to every store.
 *
 * A store can qualify for both. They never stack: `resolveBestDiscount` picks
 * the single largest one, so the merchant's page, the admin panel and the real
 * Shopify charge can never disagree about what is being applied.
 */
import prisma from "./db.server.js";
import {
  DISCOUNT_DURATION_MONTHS,
  TIER_STANDARD,
  TIER_VIP,
  DISCOUNT_TIERS,
  normalizeTier,
} from "./discount.constants.js";

export { DISCOUNT_DURATION_MONTHS, TIER_STANDARD, TIER_VIP, DISCOUNT_TIERS, normalizeTier };

/** Defaults used until the operator saves platform settings for the first time. */
const DEFAULT_PLATFORM_SETTINGS = {
  id: 1,
  globalDiscountPercent: null,
  globalDiscountNote: null,
  globalDiscountActive: false,
  globalDiscountExpiresAt: null,
  freeGrowthEnabled: true,
  freeGrowthSeatLimit: 20,
  updatedByEmail: null,
};

/** One year from now, used both when granting and when renewing a discount. */
export function computeExpiry(from = new Date()) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + DISCOUNT_DURATION_MONTHS);
  return d;
}

/**
 * Platform-wide settings. Read-only: returns defaults rather than creating the
 * row, so this is safe to call from a loader.
 */
export async function getPlatformSettings() {
  const row = await prisma.platformSettings.findUnique({ where: { id: 1 } });
  return row || { ...DEFAULT_PLATFORM_SETTINGS };
}

/**
 * Whether a grant row is discounting anything right now.
 *
 * A VIP grant is an offer, so it counts for nothing until the merchant claims
 * it. Expiry is derived on read rather than written back, so this stays safe
 * to call from a loader; the stored `isActive` flag records only whether the
 * admin revoked the grant and is never the sole basis for "is this in force".
 */
export function isStoreDiscountInForce(row) {
  if (!row || !row.isActive) return false;
  if (normalizeTier(row.tier) === TIER_VIP && !row.claimedAt) return false;
  return row.expiresAt > new Date();
}

/** The store's own discount, only if it is actually in force right now. */
export async function getActiveStoreDiscount(shop) {
  const row = await prisma.storeDiscount.findUnique({ where: { shop } });
  return isStoreDiscountInForce(row) ? row : null;
}

/**
 * A VIP offer this store has been given but not yet taken up, or null.
 * Drives the "Claim your VIP discount" prompt on the merchant's billing page.
 */
export async function getClaimableVipOffer(shop) {
  const row = await prisma.storeDiscount.findUnique({ where: { shop } });
  if (!row || !row.isActive) return null;
  if (normalizeTier(row.tier) !== TIER_VIP) return null;
  if (row.claimedAt) return null;
  return row;
}

/**
 * Accept a VIP offer on the merchant's behalf. The 12-month term runs from the
 * moment of the claim, not from when the admin granted it, so a merchant who
 * takes it up late still gets a full year.
 *
 * Returns the claimed row, or null if there was no offer left to claim (an
 * admin revoked it, or a duplicate submit already claimed it).
 */
export async function claimVipOffer(shop) {
  const offer = await getClaimableVipOffer(shop);
  if (!offer) return null;

  const claimedAt = new Date();
  const result = await prisma.storeDiscount.updateMany({
    // Re-check claimedAt in the write so a double submit cannot restart the term.
    where: { shop, isActive: true, tier: TIER_VIP, claimedAt: null },
    data: { claimedAt, expiresAt: computeExpiry(claimedAt) },
  });
  if (result.count === 0) return null;

  return prisma.storeDiscount.findUnique({ where: { shop } });
}

/** The global discount, if the operator has one switched on and unexpired. */
export async function getActiveGlobalDiscount(settings = null) {
  const s = settings || (await getPlatformSettings());
  if (!s.globalDiscountActive) return null;
  if (!s.globalDiscountPercent || s.globalDiscountPercent < 1) return null;
  if (s.globalDiscountExpiresAt && s.globalDiscountExpiresAt <= new Date()) return null;
  return {
    percent: s.globalDiscountPercent,
    note: s.globalDiscountNote,
    expiresAt: s.globalDiscountExpiresAt,
  };
}

const SOURCE_LABELS = {
  VIP: "VIP discount",
  STANDARD: "Account discount",
  GLOBAL: "Limited-time offer",
};

/**
 * The single best percentage discount this store qualifies for, or null.
 *
 * Best = largest percentage. A store-level grant wins an exact tie, because it
 * was set for this merchant specifically and is the more meaningful thing to
 * show them.
 */
export async function resolveBestDiscount(shop, settings = null) {
  const [storeDiscount, globalDiscount] = await Promise.all([
    getActiveStoreDiscount(shop),
    getActiveGlobalDiscount(settings),
  ]);

  const candidates = [];
  if (storeDiscount) {
    const source = normalizeTier(storeDiscount.tier);
    candidates.push({
      percent: storeDiscount.discountPercent,
      source,
      label: SOURCE_LABELS[source],
      note: storeDiscount.note,
      expiresAt: storeDiscount.expiresAt,
      storeSpecific: true,
    });
  }
  if (globalDiscount) {
    candidates.push({
      percent: globalDiscount.percent,
      source: "GLOBAL",
      label: SOURCE_LABELS.GLOBAL,
      note: globalDiscount.note,
      expiresAt: globalDiscount.expiresAt,
      storeSpecific: false,
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.percent - a.percent || Number(b.storeSpecific) - Number(a.storeSpecific));
  return candidates[0];
}
