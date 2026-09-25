/**
 * GA4 / Google Tag Manager tag health monitoring.
 *
 * Verifies that a store's Google tag (a GA4 `G-…` measurement ID or a GTM
 * `GTM-…` container) is still being served. Everything here is read-only: the
 * live storefront is fetched with GET, and the published theme's layout,
 * snippet, section and template files are read with GraphQL *queries*.
 * Nothing is ever written to Shopify.
 *
 * Three rules keep this from paging a merchant falsely:
 *
 *  1. The live storefront decides. Theme files only corroborate, or stand in
 *     when the storefront is password-locked or unreachable — and a tag found
 *     only in a file never arms an alert, because a snippet sitting in the
 *     theme is not proof the tag is actually rendered.
 *  2. "We couldn't check" is UNKNOWN, never MISSING — the same discipline as
 *     themeEmbed.server.js. Tags added by apps or the Google & YouTube channel
 *     live outside the theme, so without a readable storefront their absence
 *     proves nothing.
 *  3. One alert per loss, and only after two consecutive MISSING checks of a
 *     tag that was previously seen live. A store that never had a tag is
 *     never paged.
 */
import prisma from "./db.server.js";
import { graphqlWithRetry } from "./backup.server.js";
import { checkFeatureAccess } from "./billing.server.js";
import { getOrCreateSettings, sendIncidentAlert } from "./monitor.server.js";
import { TAG_DETECTED, TAG_MISSING, TAG_UNKNOWN } from "./monitoring.constants.js";
import { getAdminClient } from "./sync.server.js";
import { validateServiceUrl } from "./uptime.server.js";

const STOREFRONT_TIMEOUT_MS = 10_000;
const CHECK_DEADLINE_MS = 25_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_THEME_PAGES = 8;
const MAX_IDS = 5;
const CONTEXT_CHARS = 150;
const USER_AGENT = "Revertly-Tag-Monitor/1.0";

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CONFIRM_RECHECK_MS = 15 * 60 * 1000;
const SKIP_DEFER_MS = 24 * 60 * 60 * 1000;
const ERROR_DEFER_MS = 60 * 60 * 1000;
const PUBLISH_RECHECK_DELAY_MS = 2 * 60 * 1000;

// Column sizes in prisma/schema.prisma (AppSettings.ga4*).
const ID_COLUMN_MAX = 255;
const DETAIL_COLUMN_MAX = 500;

// `*` matches zero or more characters in theme.files(filenames:).
const THEME_FILE_PATTERNS = ["layout/*", "snippets/*", "sections/*", "templates/*", "config/settings_data.json"];

const GA4_ID = /(?<![A-Za-z0-9_-])G-[A-Z0-9]{6,12}(?![A-Za-z0-9_-])/g;
const GTM_ID = /(?<![A-Za-z0-9_-])GTM-[A-Z0-9]{4,10}(?![A-Za-z0-9_-])/g;
const SAFE_ID = /^(?:G|GTM)-[A-Z0-9]{4,12}$/;
const PLACEHOLDER_ID = /^(?:G|GTM)-X+$/;
// An ID only counts when one of these appears near it. Without this, product
// SKUs such as "G-2100BLK" or copy like "G-SHOCK" would read as tags.
const TAG_CONTEXT =
  /google_tag|google[\s_-]?analytics|gtag|googletagmanager|gtm\.js|tag[\s_-]?manager|measurement[\s_-]?id|datalayer|ga4/i;
// Present on every Online Store page Shopify renders, and absent from bot
// challenges, "store unavailable" pages and non-Shopify hosts.
const STOREFRONT_MARKER = /Shopify\.shop\s*=|web-pixels-manager|shopify-features|id="shopify-section-/;
const PASSWORD_FORM = /storefront_password/;

export const TAG_HEALTH_SELECT = {
  monitoringEnabled: true,
  ga4Status: true,
  ga4MeasurementId: true,
  gtmContainerId: true,
  ga4DetectedIn: true,
  ga4StatusDetail: true,
  ga4LastCheckedAt: true,
  ga4NextCheckAt: true,
};

const THEME_TAG_SCAN_QUERY = `#graphql
  query revertlyTagScan($cursor: String, $filenames: [String!]) {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        name
        files(first: 250, after: $cursor, filenames: $filenames) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            filename
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }`;

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Undoes the escaping Shopify and themes wrap IDs in — the web-pixel config
 * is JSON inside a JS string, and loader URLs are sometimes URL-encoded — so
 * the ID boundaries below see plain text.
 */
function normalizeForScan(text) {
  return String(text)
    .replace(/\\u0022/gi, '"')
    .replace(/\\x22/gi, '"')
    .replace(/\\+(["'/])/g, "$1")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/%22/g, '"')
    .replace(/%2F/gi, "/")
    .replace(/%3D/gi, "=");
}

function collectIds(haystack, pattern, into) {
  for (const match of haystack.matchAll(pattern)) {
    if (into.length >= MAX_IDS) break;
    const id = match[0];
    if (PLACEHOLDER_ID.test(id) || into.includes(id)) continue;

    // The ID itself is left out of the window so "GTM-…" is never its own
    // evidence of a tag manager.
    const start = match.index;
    const end = start + id.length;
    const context = `${haystack.slice(Math.max(0, start - CONTEXT_CHARS), start)} ${haystack.slice(end, end + CONTEXT_CHARS)}`;
    if (TAG_CONTEXT.test(context)) into.push(id);
  }
}

/**
 * @returns {{ ga4: string[], gtm: string[] }} de-duplicated, in document order
 */
export function extractTagIds(text) {
  const ga4 = [];
  const gtm = [];
  if (!text) return { ga4, gtm };

  const haystack = normalizeForScan(text);
  collectIds(haystack, GA4_ID, ga4);
  collectIds(haystack, GTM_ID, gtm);
  return { ga4, gtm };
}

function mergeIds(into, ids) {
  for (const id of ids) {
    if (into.length >= MAX_IDS) return;
    if (!into.includes(id)) into.push(id);
  }
}

function hasIds(ids) {
  return ids.ga4.length > 0 || ids.gtm.length > 0;
}

function formatIds(ids) {
  return [...ids.ga4, ...ids.gtm].join(", ");
}

function formatFiles(files = []) {
  if (files.length <= 3) return files.join(", ");
  return `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;
}

function truncate(value, max) {
  if (value == null) return null;
  const str = String(value);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/**
 * Whether the fetched page is the store's real, complete storefront. Anything
 * else — a 402 "store unavailable" page, a 429 bot challenge, a 5xx, a page
 * cut off before </head> — cannot tell us the tag is gone.
 */
function assessStorefront(storefront) {
  if (!storefront?.ok) {
    return { reachable: false, reason: storefront?.error || "The storefront could not be fetched" };
  }
  if (storefront.locked) {
    return { reachable: false, reason: "The storefront is password protected" };
  }
  if (storefront.status !== 200) {
    return { reachable: false, reason: `The storefront returned HTTP ${storefront.status}` };
  }
  const html = storefront.html || "";
  if (!/<\/head>/i.test(html)) {
    return {
      reachable: false,
      reason: storefront.truncated
        ? "The storefront page was too large to read"
        : "The storefront returned an incomplete page",
    };
  }
  if (!STOREFRONT_MARKER.test(html)) {
    return { reachable: false, reason: "The storefront response was not a Shopify storefront page" };
  }
  return { reachable: true, reason: null };
}

/**
 * Turns the two raw reads into one verdict. The live storefront decides
 * whenever it is reachable; theme files decide nothing on their own except
 * a DETECTED that never arms an alert (liveDetected stays false).
 *
 * @returns {{ status: string, ga4Ids: string[], gtmIds: string[],
 *   detectedIn: string|null, liveDetected: boolean, detail: string }}
 */
export function classifyTagHealth({ storefront, theme }) {
  const themeOk = Boolean(theme?.ok);
  const themeIds = themeOk ? { ga4: theme.ga4 || [], gtm: theme.gtm || [] } : { ga4: [], gtm: [] };
  const themeFound = hasIds(themeIds);
  const themeFiles = themeOk ? formatFiles(theme.files) : "";
  const site = assessStorefront(storefront);

  if (site.reachable) {
    const live = extractTagIds(storefront.html);

    if (hasIds(live)) {
      return {
        status: TAG_DETECTED,
        ga4Ids: live.ga4,
        gtmIds: live.gtm,
        detectedIn: themeFound ? "BOTH" : "STOREFRONT",
        liveDetected: true,
        detail: themeFound
          ? `Served on the live storefront and present in your theme (${themeFiles}).`
          : "Served on the live storefront. It is loaded outside your theme files, for example by an app or the Google & YouTube channel.",
      };
    }

    if (storefront.truncated) {
      return {
        status: TAG_UNKNOWN,
        ga4Ids: [],
        gtmIds: [],
        detectedIn: null,
        liveDetected: false,
        detail: "The storefront page was larger than 3 MB, so the end of the page could not be checked for a tag.",
      };
    }

    let detail;
    if (themeFound) {
      detail = `No GA4 or GTM tag is served on the live storefront, although ${formatIds(themeIds)} appears in ${themeFiles}. The snippet may not be rendered by the published theme.`;
    } else if (themeOk) {
      detail = "No GA4 or GTM tag was found on the live storefront or in the published theme's files.";
    } else {
      detail = `No GA4 or GTM tag was found on the live storefront. Theme files could not be read: ${theme?.error || "unknown error"}.`;
    }
    return { status: TAG_MISSING, ga4Ids: [], gtmIds: [], detectedIn: null, liveDetected: false, detail };
  }

  if (themeFound) {
    return {
      status: TAG_DETECTED,
      ga4Ids: themeIds.ga4,
      gtmIds: themeIds.gtm,
      detectedIn: "THEME",
      liveDetected: false,
      detail: `${site.reason}, so this was verified from your theme files only (${themeFiles}).`,
    };
  }

  return {
    status: TAG_UNKNOWN,
    ga4Ids: [],
    gtmIds: [],
    detectedIn: null,
    liveDetected: false,
    detail: themeOk
      ? `${site.reason}. No tag was found in your theme files, but tags added by apps or the Google & YouTube channel can only be seen on the live storefront.`
      : `${site.reason}, and your theme files could not be read (${theme?.error || "unknown error"}).`,
  };
}

// ── Read-only I/O ───────────────────────────────────────────────────────────

async function readCappedText(resp, maxBytes) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const text = await resp.text();
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      text += decoder.decode(value.subarray(0, value.byteLength - (received - maxBytes)), { stream: true });
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}

/**
 * GETs the storefront, following redirects by hand so every hop passes the
 * same SSRF guard uptime monitoring uses. One controller bounds the whole
 * chain, not each hop.
 */
export async function fetchStorefrontHtml(
  shop,
  { fetchImpl = fetch, validateUrl = validateServiceUrl, timeoutMs = STOREFRONT_TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const first = await validateUrl(`https://${shop}/`);
    if (!first.ok) return { ok: false, error: first.error };
    let url = first.url;

    for (let hop = 0; ; hop++) {
      const resp = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      });

      if (resp.status < 300 || resp.status >= 400) {
        const { text, truncated } = await readCappedText(resp, MAX_HTML_BYTES);
        return {
          ok: true,
          status: resp.status,
          html: text,
          truncated,
          locked: PASSWORD_FORM.test(text),
          finalUrl: url,
        };
      }

      await resp.body?.cancel().catch(() => {});
      const location = resp.headers.get("location");
      if (!location) {
        return { ok: false, status: resp.status, error: `The storefront redirect (HTTP ${resp.status}) had no destination` };
      }

      const next = new URL(location, url);
      if (/\/password\/?$/.test(next.pathname)) {
        return { ok: true, status: resp.status, html: "", truncated: false, locked: true, finalUrl: next.toString() };
      }
      if (hop + 1 > MAX_REDIRECTS) {
        return { ok: false, error: "The storefront redirected too many times" };
      }

      const check = await validateUrl(next.toString());
      if (!check.ok) return { ok: false, error: `Storefront redirect rejected: ${check.error}` };
      url = check.url;
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err?.name === "AbortError"
          ? `The storefront did not respond within ${timeoutMs / 1000}s`
          : err?.message || "The storefront request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the published theme's layout, snippet, section and template files and
 * collects any tag IDs in them. GraphQL queries only.
 */
export async function scanActiveThemeFiles(admin, { maxAttempts = 5 } = {}) {
  if (!admin) return { ok: false, error: "No admin API client available" };

  const ga4 = [];
  const gtm = [];
  const files = [];
  let themeName = null;
  let cursor = null;

  try {
    for (let page = 0; page < MAX_THEME_PAGES; page++) {
      const json = await graphqlWithRetry(
        admin,
        THEME_TAG_SCAN_QUERY,
        { cursor, filenames: THEME_FILE_PATTERNS },
        { maxAttempts, label: "ga4 tag scan" },
      );
      if (json?.errors?.length) {
        return { ok: false, error: json.errors.map((e) => e.message).join("; ") };
      }

      const theme = json?.data?.themes?.nodes?.[0];
      if (!theme) return { ok: false, error: "No published theme found" };
      themeName = theme.name || null;

      const connection = theme.files;
      for (const node of connection?.nodes || []) {
        const content = node?.body?.content;
        if (typeof content !== "string" || !content) continue;
        const ids = extractTagIds(content);
        if (hasIds(ids)) {
          files.push(node.filename);
          mergeIds(ga4, ids.ga4);
          mergeIds(gtm, ids.gtm);
        }
      }

      if (!connection?.pageInfo?.hasNextPage) {
        return { ok: true, themeName, ga4, gtm, files, truncated: false };
      }
      cursor = connection.pageInfo.endCursor;
    }
    return { ok: true, themeName, ga4, gtm, files, truncated: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label} timed out after ${ms / 1000}s` }), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ── Alerting ────────────────────────────────────────────────────────────────

function toDate(value) {
  return value ? new Date(value) : null;
}

/**
 * Decides whether this check should alert, and when the next one is due.
 *
 * Armed means a tag has been seen on the live storefront since the last
 * missing-tag alert. The first MISSING of an armed store only schedules a
 * quick confirmation; the second one alerts.
 *
 * @returns {{ alert: "missing"|"recovered"|null, armed: boolean, nextCheckAt: Date }}
 */
export function decideTagAlert(prev, result, now = new Date()) {
  const lastDetected = toDate(prev?.ga4LastDetectedAt);
  const alertedAt = toDate(prev?.ga4AlertedAt);
  const armed = Boolean(lastDetected) && (!alertedAt || alertedAt < lastDetected);

  let alert = null;
  let nextCheckInMs = RECHECK_INTERVAL_MS;

  if (result.status === TAG_MISSING && armed) {
    if (prev?.ga4Status === TAG_MISSING) alert = "missing";
    else nextCheckInMs = CONFIRM_RECHECK_MS;
  } else if (result.liveDetected && alertedAt && lastDetected && alertedAt >= lastDetected) {
    alert = "recovered";
  }

  return { alert, armed, nextCheckAt: new Date(now.getTime() + nextCheckInMs) };
}

/**
 * Claims the right to send an alert with a conditional write, so a manual
 * Verify Now racing the background sweep sends it once.
 */
async function claimAlert(shop, prev, kind, now) {
  const where =
    kind === "missing"
      ? {
          shop,
          ga4LastDetectedAt: prev.ga4LastDetectedAt,
          OR: [{ ga4AlertedAt: null }, { ga4AlertedAt: { lt: prev.ga4LastDetectedAt } }],
        }
      : { shop, ga4AlertedAt: prev.ga4AlertedAt, ga4LastDetectedAt: prev.ga4LastDetectedAt };
  const data = kind === "missing" ? { ga4AlertedAt: now } : { ga4LastDetectedAt: now };

  const { count } = await prisma.appSettings.updateMany({ where, data });
  return count === 1;
}

// Only IDs this module wrote are ever stored, but the alert name goes into
// unescaped email HTML, so re-check the shape anyway.
function safeIdList(...values) {
  return values
    .filter(Boolean)
    .flatMap((value) => String(value).split(/,\s*/))
    .filter((id) => SAFE_ID.test(id))
    .join(", ");
}

function buildAlertIncident(kind, prev, result) {
  if (kind === "missing") {
    const ids = safeIdList(prev.ga4MeasurementId, prev.gtmContainerId) || "Your GA4 / GTM tag";
    return {
      id: "ga4-tag",
      name: `Analytics tag missing: ${ids} is no longer on your live storefront`,
      severity: "HIGH",
      status: "OPEN",
      affectedCount: 1,
      notes: result.detail,
      linkPath: "/app/monitoring",
    };
  }

  const ids = safeIdList(result.ga4Ids.join(","), result.gtmIds.join(",")) || "Your GA4 / GTM tag";
  return {
    id: "ga4-tag",
    name: `Analytics tag restored: ${ids} is back on your live storefront`,
    severity: "MEDIUM",
    status: "RESOLVED",
    affectedCount: 1,
    notes: result.detail,
    linkPath: "/app/monitoring",
  };
}

function joinIds(ids) {
  return ids.length ? truncate(ids.join(", "), ID_COLUMN_MAX) : null;
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Runs one full tag health check for a shop, stores the verdict on its
 * AppSettings row (ga4* columns only), and sends at most one alert.
 */
export async function verifyTagHealth(
  shop,
  { admin = null, source = "SCHEDULED", fetchImpl, validateUrl, notify = sendIncidentAlert, now = new Date() } = {},
) {
  const prev = await getOrCreateSettings(shop);
  const maxAttempts = source === "MANUAL" ? 2 : 5;

  const [storefront, theme] = await Promise.all([
    withDeadline(fetchStorefrontHtml(shop, { fetchImpl, validateUrl }), CHECK_DEADLINE_MS, "The storefront check"),
    withDeadline(scanActiveThemeFiles(admin, { maxAttempts }), CHECK_DEADLINE_MS, "The theme file scan"),
  ]);

  const result = classifyTagHealth({ storefront, theme });
  const decision = decideTagAlert(prev, result, now);

  // The claim has to land before the status update below, which reads nothing
  // back and never writes ga4AlertedAt, so it cannot undo a claim.
  let alert = null;
  if (decision.alert && (await claimAlert(shop, prev, decision.alert, now))) {
    try {
      await notify(shop, buildAlertIncident(decision.alert, prev, result), prev);
      alert = decision.alert;
    } catch (err) {
      console.warn(`[GA4] Alert failed for ${shop}:`, err?.message || err);
    }
  }

  const data = {
    ga4Status: result.status,
    ga4DetectedIn: result.status === TAG_DETECTED ? result.detectedIn : null,
    ga4StatusDetail: truncate(result.detail, DETAIL_COLUMN_MAX),
    ga4LastCheckedAt: now,
    ga4NextCheckAt: decision.nextCheckAt,
  };
  if (result.status === TAG_DETECTED) {
    data.ga4MeasurementId = joinIds(result.ga4Ids);
    data.gtmContainerId = joinIds(result.gtmIds);
  }
  if (result.liveDetected) data.ga4LastDetectedAt = now;

  await prisma.appSettings.update({ where: { shop }, data });

  return { ...result, alert, source, themeName: theme?.themeName || null };
}

/** One-line summary for the monitoring page's result banner. */
export function describeTagResult(result) {
  const ids = formatIds({ ga4: result.ga4Ids || [], gtm: result.gtmIds || [] });
  if (result.status === TAG_DETECTED) {
    const where =
      result.detectedIn === "THEME"
        ? "in your theme files (the live storefront could not be checked)"
        : result.detectedIn === "BOTH"
          ? "on the live storefront and in your theme files"
          : "on the live storefront";
    return `GA4 tag check: ${ids} detected ${where}.`;
  }
  if (result.status === TAG_MISSING) {
    return "GA4 tag check: no GA4 or GTM tag found on the live storefront.";
  }
  return `GA4 tag check: couldn't verify. ${result.detail}`;
}

/** Everything the monitoring page's tag health card needs. */
export async function getTagHealthSummary(shop) {
  const [access, row] = await Promise.all([
    checkFeatureAccess(shop, "ga4Monitoring"),
    prisma.appSettings.findUnique({ where: { shop }, select: TAG_HEALTH_SELECT }),
  ]);

  return {
    locked: !access.allowed,
    plan: access.plan,
    monitoringEnabled: row?.monitoringEnabled ?? true,
    status: row?.ga4Status ?? null,
    measurementId: row?.ga4MeasurementId ?? null,
    gtmContainerId: row?.gtmContainerId ?? null,
    detectedIn: row?.ga4DetectedIn ?? null,
    detail: row?.ga4StatusDetail ?? null,
    lastCheckedAt: row?.ga4LastCheckedAt ?? null,
    nextCheckAt: row?.ga4NextCheckAt ?? null,
  };
}

async function deferTagCheck(shop, now, delayMs) {
  await prisma.appSettings.updateMany({
    where: { shop },
    data: { ga4NextCheckAt: new Date(now.getTime() + delayMs) },
  });
}

/**
 * Marks a shop due for a re-check shortly after a theme publish. The delay
 * gives Shopify's storefront cache time to serve the new theme. A shop with
 * no settings row is a no-op — the sweep treats it as due anyway.
 */
export async function scheduleTagRecheck(shop, { delayMs = PUBLISH_RECHECK_DELAY_MS, now = new Date() } = {}) {
  await deferTagCheck(shop, now, delayMs);
}

/**
 * Background sweep. Stores that aren't entitled, or have no offline session,
 * are pushed a day out and don't use up the batch, so a backlog of Free
 * stores can't starve paying ones.
 */
export async function runDueTagChecks({
  now: fixedNow,
  maxChecks = 20,
  candidateLimit = 200,
  shops = null,
  resolveAdmin = getAdminClient,
  fetchImpl,
  validateUrl,
  notify,
} = {}) {
  const startedAt = fixedNow || new Date();
  const where = {
    monitoringEnabled: true,
    OR: [{ ga4NextCheckAt: null }, { ga4NextCheckAt: { lte: startedAt } }],
  };
  if (Array.isArray(shops)) where.shop = { in: shops };

  // MySQL sorts NULLs first ascending, so never-checked stores go first.
  const candidates = await prisma.appSettings.findMany({
    where,
    select: { shop: true },
    orderBy: { ga4NextCheckAt: "asc" },
    take: candidateLimit,
  });

  const results = [];
  let checked = 0;

  for (const { shop } of candidates) {
    if (checked >= maxChecks) break;
    const now = fixedNow || new Date();
    try {
      const access = await checkFeatureAccess(shop, "ga4Monitoring");
      if (!access.allowed) {
        await deferTagCheck(shop, now, SKIP_DEFER_MS);
        results.push({ shop, skipped: `not included in the ${access.plan} plan` });
        continue;
      }

      const admin = await resolveAdmin(shop);
      if (!admin) {
        await deferTagCheck(shop, now, SKIP_DEFER_MS);
        results.push({ shop, skipped: "no offline session" });
        continue;
      }

      checked++;
      const res = await verifyTagHealth(shop, { admin, source: "SCHEDULED", fetchImpl, validateUrl, notify, now });
      results.push({ shop, status: res.status, alert: res.alert });
    } catch (err) {
      results.push({ shop, error: err?.message || String(err) });
      await deferTagCheck(shop, now, ERROR_DEFER_MS).catch(() => {});
    }
  }

  return { timestamp: startedAt.toISOString(), candidates: candidates.length, checked, results };
}
