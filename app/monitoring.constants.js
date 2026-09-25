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

/**
 * GA4 / Google Tag Manager tag health result (ga4Monitor.server.js).
 *
 * UNKNOWN plays the same role as EMBED_UNKNOWN: a password-locked or
 * unreachable storefront is "we couldn't check", never "the tag is missing".
 */
export const TAG_DETECTED = "DETECTED";
export const TAG_MISSING = "MISSING";
export const TAG_UNKNOWN = "UNKNOWN";
