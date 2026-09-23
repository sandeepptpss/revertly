/**
 * Enterprise HTTP Security Headers Middleware
 *
 * Enforces production-grade browser defenses without interfering with
 * Shopify's embedded iFrame (App Bridge) architecture.
 */

/**
 * Applies security headers to the given Response Headers object.
 *
 * @param {Headers} responseHeaders - Standard Web API Headers instance
 */
export function applySecurityHeaders(responseHeaders) {
  if (!responseHeaders || typeof responseHeaders.set !== "function") {
    return;
  }

  // Enforce HTTPS-only transport (2-year HSTS with subdomains and preload)
  if (!responseHeaders.has("Strict-Transport-Security")) {
    responseHeaders.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  // Prevent MIME-type sniffing
  if (!responseHeaders.has("X-Content-Type-Options")) {
    responseHeaders.set("X-Content-Type-Options", "nosniff");
  }

  // Strict privacy-preserving referrer policy
  if (!responseHeaders.has("Referrer-Policy")) {
    responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }

  // Restrict sensitive browser APIs that an embedded Shopify admin app never requires
  if (!responseHeaders.has("Permissions-Policy")) {
    responseHeaders.set(
      "Permissions-Policy",
      "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
    );
  }

  // Cross-Origin-Opener-Policy: same-origin-allow-popups allows Google Drive / Dropbox OAuth popups to function
  if (!responseHeaders.has("Cross-Origin-Opener-Policy")) {
    responseHeaders.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  }

  // NOTE: We intentionally DO NOT set 'X-Frame-Options: DENY' or 'SAMEORIGIN'.
  // Shopify apps are embedded in the Shopify Admin via iframe.
  // Shopify's addDocumentResponseHeaders() sets Content-Security-Policy: frame-ancestors
  // which is the modern standard for iframe protection while keeping App Bridge alive.
}
