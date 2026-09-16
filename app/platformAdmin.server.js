/**
 * Platform-admin identity gate.
 *
 * This app is per-merchant (Shopify authenticates a *store*, not a person),
 * so "platform admin" is not a role in the TeamMember roster — that roster is
 * scoped to a single shop's own staff. The admin panel instead grants access
 * only when BOTH of these match the authenticated session:
 *
 *   1. the shop is the designated admin/operator store, AND
 *   2. the logged-in staff member's email is on the admin allow-list.
 *
 * Requiring both means a malicious or compromised staff account on some other
 * merchant's store — even one that happens to reuse the admin's email as a
 * store contact address — can never see this panel; only a real login to the
 * operator's own store, by that person, qualifies.
 *
 * Configurable via env so this doesn't need a code change to rotate/extend
 * admin access; defaults match the operator's current identity.
 */
const DEFAULT_ADMIN_SHOP = "quickstart-749ac396.myshopify.com";
const DEFAULT_ADMIN_EMAILS = ["sandeepptpss@gmail.com"];

function normalizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

export const PLATFORM_ADMIN_SHOP = normalizeShop(
  process.env.ADMIN_SHOP_DOMAIN || DEFAULT_ADMIN_SHOP,
);

export const PLATFORM_ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(",")
    : DEFAULT_ADMIN_EMAILS
  )
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

/** True only for the operator's own store, logged in as an allow-listed email. */
export function isPlatformAdmin(shop, session) {
  const normalizedShop = normalizeShop(shop);
  const email = (session?.email || "").trim().toLowerCase();
  if (!email) return false;
  return normalizedShop === PLATFORM_ADMIN_SHOP && PLATFORM_ADMIN_EMAILS.has(email);
}
