/**
 * Shared monitoring constants.
 *
 * Kept out of uptime.server.js so route components can import them without
 * pulling server-only code (prisma, dns) into the client bundle.
 */
export const SERVICE_TYPES = ["STOREFRONT", "SHOPIFY_API", "APP", "CUSTOM"];

export const SERVICE_STATUSES = ["OPERATIONAL", "DEGRADED", "DOWN"];
