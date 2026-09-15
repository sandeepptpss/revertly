/**
 * Store & third-party app downtime monitoring.
 *
 * Merchants supply the URLs we probe, which makes this an SSRF vector: without
 * a guard, a "monitored service" pointing at 169.254.169.254 or 127.0.0.1 would
 * turn the app server into a proxy for reaching cloud metadata endpoints and
 * internal services. validateServiceUrl() is therefore mandatory before any
 * fetch, on create and on every check.
 */
import dns from "node:dns/promises";
import net from "node:net";
import prisma from "./db.server.js";
import { getOrCreateSettings, sendIncidentAlert } from "./monitor.server.js";
import { SERVICE_TYPES } from "./monitoring.constants.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DEGRADED_THRESHOLD_MS = 3_000;
const CHECK_RETENTION_DAYS = 30;

export { SERVICE_TYPES };

/** True for addresses that must never be reachable from a merchant-supplied URL. */
function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 0) return true; // this network
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    // IPv4-mapped (::ffff:127.0.0.1) must be judged on the embedded v4 address.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  return true;
}

/**
 * Validates and normalizes a monitored-service URL.
 * Resolves DNS so that a public hostname pointing at a private address is
 * rejected too, not just literal private IPs.
 *
 * @returns {Promise<{ok: true, url: string} | {ok: false, error: string}>}
 */
export async function validateServiceUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    return { ok: false, error: "Enter a valid absolute URL, e.g. https://example.com/health" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only http:// and https:// URLs can be monitored." };
  }

  if (parsed.port && !["80", "443", ""].includes(parsed.port)) {
    return { ok: false, error: "Only the standard ports 80 and 443 may be monitored." };
  }

  const host = parsed.hostname;
  if (host.toLowerCase() === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, error: "Loopback addresses cannot be monitored." };
  }

  // A literal IP can be judged directly; a hostname must be resolved first.
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      return { ok: false, error: "Private, loopback, and link-local addresses cannot be monitored." };
    }
  } else {
    let addresses;
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      return { ok: false, error: `Could not resolve host "${host}".` };
    }
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
      return { ok: false, error: "That host resolves to a private or reserved address." };
    }
  }

  return { ok: true, url: parsed.toString() };
}

/** Maps a probe outcome to a service status. */
function classify(statusCode, responseTimeMs, failed) {
  if (failed || !statusCode) return "DOWN";
  if (statusCode >= 500) return "DOWN";
  if (statusCode >= 400) return "DEGRADED";
  if (responseTimeMs > DEGRADED_THRESHOLD_MS) return "DEGRADED";
  return "OPERATIONAL";
}

/**
 * Probes one service, records the check, and updates rolling uptime.
 * Alerts only on a status transition, so a service that stays down does not
 * email the merchant every five minutes.
 */
export async function checkService(service) {
  const validation = await validateServiceUrl(service.url);

  let statusCode = null;
  let responseTimeMs = null;
  let errorMessage = null;
  let failed = false;

  if (!validation.ok) {
    failed = true;
    errorMessage = validation.error;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const resp = await fetch(validation.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Revertly-Uptime-Monitor/1.0" },
      });
      responseTimeMs = Date.now() - startedAt;
      statusCode = resp.status;
    } catch (err) {
      responseTimeMs = Date.now() - startedAt;
      failed = true;
      errorMessage =
        err?.name === "AbortError"
          ? `No response within ${REQUEST_TIMEOUT_MS / 1000}s`
          : err?.message || "Request failed";
    } finally {
      clearTimeout(timer);
    }
  }

  const status = classify(statusCode, responseTimeMs, failed);
  const isUp = status === "OPERATIONAL" || status === "DEGRADED";
  const previousStatus = service.status;

  await prisma.downtimeCheck.create({
    data: {
      shop: service.shop,
      serviceId: service.id,
      isUp,
      statusCode,
      responseTimeMs,
      errorMessage,
    },
  });

  // Rolling uptime over the retention window.
  const since = new Date(Date.now() - CHECK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [total, up] = await Promise.all([
    prisma.downtimeCheck.count({ where: { serviceId: service.id, checkedAt: { gte: since } } }),
    prisma.downtimeCheck.count({
      where: { serviceId: service.id, isUp: true, checkedAt: { gte: since } },
    }),
  ]);
  const uptimePercent = total > 0 ? Number(((up / total) * 100).toFixed(2)) : 100;

  const updated = await prisma.monitoredService.update({
    where: { id: service.id },
    data: {
      status,
      uptimePercent,
      lastResponseTimeMs: responseTimeMs,
      lastStatusCode: statusCode,
      lastCheckAt: new Date(),
    },
  });

  let alerted = false;
  if (status !== previousStatus) {
    alerted = await alertOnTransition(service, previousStatus, status, errorMessage);
  }

  return { service: updated, status, previousStatus, statusCode, responseTimeMs, errorMessage, alerted };
}

/**
 * Notifies the merchant when a service changes state, reusing the existing
 * incident alert transport (Slack + Resend + team routing).
 */
async function alertOnTransition(service, from, to, errorMessage) {
  // Recoveries and newly-detected outages are both worth knowing about, but a
  // first check on a brand-new service shouldn't page anyone.
  if (!from || from === to) return false;

  const recovered = to === "OPERATIONAL";
  const severity = to === "DOWN" ? "CRITICAL" : to === "DEGRADED" ? "HIGH" : "MEDIUM";

  try {
    const settings = await getOrCreateSettings(service.shop);
    const pseudoIncident = {
      id: `service-${service.id}`,
      name: recovered
        ? `Service recovered: ${service.name}`
        : `Service ${to.toLowerCase()}: ${service.name}`,
      severity,
      status: to,
      affectedCount: 1,
      notes: errorMessage || null,
    };
    await sendIncidentAlert(service.shop, pseudoIncident, settings);
    return true;
  } catch (err) {
    console.warn(`[Uptime] Alert failed for service ${service.id}:`, err?.message);
    return false;
  }
}

/** Runs every service whose check interval has elapsed. */
export async function runDueServiceChecks() {
  const now = new Date();
  const services = await prisma.monitoredService.findMany();

  const due = services.filter((s) => {
    if (!s.lastCheckAt) return true;
    const nextDue = new Date(s.lastCheckAt.getTime() + (s.checkIntervalMinutes || 5) * 60 * 1000);
    return nextDue <= now;
  });

  const results = [];
  for (const service of due) {
    try {
      const res = await checkService(service);
      results.push({ serviceId: service.id, name: service.name, status: res.status, alerted: res.alerted });
    } catch (err) {
      results.push({ serviceId: service.id, name: service.name, error: err?.message || String(err) });
    }
  }

  const pruned = await pruneOldChecks();

  return { timestamp: now.toISOString(), totalServices: services.length, checked: due.length, results, pruned };
}

/** Drops check rows past the retention window so the table stays bounded. */
export async function pruneOldChecks() {
  const cutoff = new Date(Date.now() - CHECK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await prisma.downtimeCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } });
  return res.count;
}

/**
 * Ensures a shop has its baseline services. Idempotent — safe on every visit.
 */
export async function ensureDefaultServices(shop) {
  const existing = await prisma.monitoredService.count({ where: { shop } });
  if (existing > 0) return { created: 0 };

  const created = await prisma.monitoredService.createMany({
    data: [
      {
        shop,
        name: "Storefront",
        serviceType: "STOREFRONT",
        url: `https://${shop}`,
        checkIntervalMinutes: 5,
      },
      {
        shop,
        name: "Shopify Platform Status",
        serviceType: "SHOPIFY_API",
        url: "https://www.shopifystatus.com",
        checkIntervalMinutes: 15,
      },
    ],
  });

  return { created: created.count };
}
