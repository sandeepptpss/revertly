/**
 * Platform-admin identity gate.
 *
 * This app is per-merchant (Shopify authenticates a *store*, not a person),
 * so "platform admin" is not a role in the TeamMember roster — that roster is
 * scoped to a single shop's own staff. Access is granted only to a session
 * authenticated against the designated operator store.
 *
 * On top of that, when the session actually identifies a *person*, that person
 * must also be on the admin allow-list. Only online-token sessions carry a
 * user; this app requests offline tokens (no `useOnlineTokens`), so in practice
 * the store check is the operative gate today. It is not a weak one: passing it
 * requires a real authenticated admin session for the operator's own store.
 * The email check is kept so that turning on online tokens tightens the gate
 * automatically rather than silently doing nothing.
 *
 * Configurable via env so this doesn't need a code change to rotate/extend
 * admin access; defaults match the operator's current identity.
 */
const DEFAULT_ADMIN_SHOP = "quickstart-749ac396.myshopify.com";
const DEFAULT_ADMIN_EMAILS = ["sandeepptpss@gmail.com", "officialtpss@gmail.com"];

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

/**
 * The staff member's email, for sessions that identify one. Shopify exposes it
 * under `onlineAccessInfo.associated_user` — there is no `session.email` — and
 * offline sessions carry no user at all, so this is often empty.
 */
export function getSessionEmail(session) {
  const email = session?.onlineAccessInfo?.associated_user?.email ?? session?.email ?? "";
  return String(email).trim().toLowerCase();
}

/** True only for an authenticated session on the operator's own store. */
export function isPlatformAdmin(shop, session) {
  if (!session) return false;
  if (normalizeShop(shop) !== PLATFORM_ADMIN_SHOP) return false;

  const email = getSessionEmail(session);
  if (!email) return true;
  return PLATFORM_ADMIN_EMAILS.has(email) || Boolean(session.accountOwner);
}
