/**
 * Discount constants shared by server code and the admin UI.
 *
 * Kept out of storeDiscount.server.js because React Router only strips
 * server-only modules from `loader`/`action`; anything a component renders
 * must come from a module the client bundle is allowed to import.
 */
export const DISCOUNT_DURATION_MONTHS = 12;

export const TIER_STANDARD = "STANDARD";
export const TIER_VIP = "VIP";
export const DISCOUNT_TIERS = [TIER_STANDARD, TIER_VIP];

export function normalizeTier(tier) {
  const t = String(tier || "").trim().toUpperCase();
  return DISCOUNT_TIERS.includes(t) ? t : TIER_STANDARD;
}
