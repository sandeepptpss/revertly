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
  GLOBAL: "Global Yearly Discount",
};

/**
 * Resolves both store-specific and global discounts available to this store.
 *
 * Global discount applies exclusively to annual/yearly billing.
 * Store-specific discounts (STANDARD/VIP) apply to the store's account (including monthly).
 */
export async function resolveDiscounts(shop, settings = null) {
  const [storeDiscount, globalDiscount] = await Promise.all([
    getActiveStoreDiscount(shop),
    getActiveGlobalDiscount(settings),
  ]);

  let storeCandidate = null;
  if (storeDiscount) {
    const source = normalizeTier(storeDiscount.tier);
    storeCandidate = {
      percent: storeDiscount.discountPercent,
      source,
      label: SOURCE_LABELS[source],
      note: storeDiscount.note,
      expiresAt: storeDiscount.expiresAt,
      storeSpecific: true,
    };
  }

  let globalCandidate = null;
  if (globalDiscount) {
    globalCandidate = {
      percent: globalDiscount.percent,
      source: "GLOBAL",
      label: SOURCE_LABELS.GLOBAL,
      note: globalDiscount.note,
      expiresAt: globalDiscount.expiresAt,
      storeSpecific: false,
    };
  }

  // Monthly candidate: ONLY storeCandidate (global discount does not apply to monthly)
  const monthlyDiscount = storeCandidate;

  // Yearly candidate: highest percentage between store and global; store-specific wins ties
  let yearlyDiscount = null;
  if (storeCandidate && globalCandidate) {
    yearlyDiscount =
      storeCandidate.percent >= globalCandidate.percent
        ? storeCandidate
        : globalCandidate;
  } else {
    yearlyDiscount = storeCandidate || globalCandidate || null;
  }

  return {
    storeDiscount: storeCandidate,
    globalDiscount: globalCandidate,
    monthlyDiscount,
    yearlyDiscount,
    // Overall best discount for backwards compatibility
    bestDiscount: yearlyDiscount || monthlyDiscount || null,
  };
}

/**
 * The single best percentage discount this store qualifies for, or null.
 * Interval-aware:
 * - When interval is monthly ("monthly" / "EVERY_30_DAYS"), only store discounts apply.
 * - When interval is annual ("annual" / "ANNUAL"), the best between store and global applies.
 * - When interval is null, returns yearlyDiscount || monthlyDiscount || null.
 */
export async function resolveBestDiscount(shop, interval = null, settings = null) {
  let effectiveInterval = interval;
  let effectiveSettings = settings;
  if (interval && typeof interval === "object" && !settings) {
    effectiveSettings = interval;
    effectiveInterval = null;
  }

  const discounts = await resolveDiscounts(shop, effectiveSettings);
  if (effectiveInterval === "monthly" || effectiveInterval === "EVERY_30_DAYS") {
    return discounts.monthlyDiscount;
  }
  if (effectiveInterval === "annual" || effectiveInterval === "ANNUAL") {
    return discounts.yearlyDiscount;
  }
  return discounts.bestDiscount;
}
