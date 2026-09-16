/**
 * Store-specific yearly discount, granted by the platform admin.
 *
 * Shared between the admin panel (which writes it) and the merchant's Plans &
 * Billing page (which reads it) so the two can never disagree about what
 * counts as "currently active".
 */
import prisma from "./db.server.js";

export const DISCOUNT_DURATION_MONTHS = 12;

/** One year from now, used both when granting and when renewing a discount. */
export function computeExpiry(from = new Date()) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + DISCOUNT_DURATION_MONTHS);
  return d;
}

/**
 * Returns the merchant's discount only if it is actually in force right now:
 * the active flag is set AND it has not passed its yearly expiry.
 *
 * Expiry is derived on read rather than written back, so this stays safe to
 * call from a loader. The stored `isActive` flag records only whether the
 * admin revoked the grant; it is never the sole basis for "is this in force".
 */
export async function getActiveStoreDiscount(shop) {
  const row = await prisma.storeDiscount.findUnique({ where: { shop } });
  if (!row || !row.isActive) return null;
  if (row.expiresAt <= new Date()) return null;
  return row;
}
