/**
 * Shared monitoring constants.
 *
 * Kept out of uptime.server.js so route components can import them without
 * pulling server-only code (prisma, dns) into the client bundle.
 */
export const SERVICE_TYPES = ["STOREFRONT", "SHOPIFY_API", "APP", "CUSTOM"];

export const SERVICE_STATUSES = ["OPERATIONAL", "DEGRADED", "DOWN"];

/**
 * Theme App Embed detection result.
 *
 * UNKNOWN exists so the UI can say "we couldn't check" rather than reporting a
 * failed lookup as "the merchant hasn't set this up".
 */
export const EMBED_ACTIVE = "ACTIVE";
export const EMBED_INACTIVE = "INACTIVE";
export const EMBED_UNKNOWN = "UNKNOWN";
