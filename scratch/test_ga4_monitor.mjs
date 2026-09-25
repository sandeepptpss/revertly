/**
 * QA for GA4 / GTM tag health monitoring (app/ga4Monitor.server.js) and its
 * wiring: the monitoring route's Verify Now action, the theme-publish webhook,
 * the background sweep, the plan gate and the alert link.
 *
 * Isolation:
 *  - Uses its own shops (ga4-qa-*.myshopify.com), cleaned before and after.
 *  - Every storefront fetch goes through a fake; `globalThis.fetch` is stubbed
 *    for the whole run because .env carries live RESEND_* keys and no test may
 *    send a real email or Slack message.
 *  - The sweep is always called with a `shops:` filter so it never touches
 *    rows other suites leave in the shared local database.
 *
 * Run: node --import ./scratch/_qa_route_register.mjs scratch/test_ga4_monitor.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import prisma from "../app/db.server.js";
import { setMockShop } from "./_qa_mock_admin.mjs";
import {
  extractTagIds,
  classifyTagHealth,
  fetchStorefrontHtml,
  scanActiveThemeFiles,
  decideTagAlert,
  verifyTagHealth,
  runDueTagChecks,
  scheduleTagRecheck,
  describeTagResult,
} from "../app/ga4Monitor.server.js";
import { validateServiceUrl } from "../app/uptime.server.js";
import { sendIncidentAlert } from "../app/monitor.server.js";
import { PLAN_LIMITS } from "../app/billing.server.js";
import { TAG_DETECTED, TAG_MISSING, TAG_UNKNOWN } from "../app/monitoring.constants.js";

const SHOP = "ga4-qa-test.myshopify.com";
const SHOP_LOCKED = "ga4-qa-locked.myshopify.com";
const SHOP_NEVER = "ga4-qa-never.myshopify.com";
const SHOP_RACE = "ga4-qa-race.myshopify.com";
const SHOP_FREE = "ga4-qa-free.myshopify.com";
const SHOP_OFF = "ga4-qa-off.myshopify.com";
const SHOP_NOT_DUE = "ga4-qa-notdue.myshopify.com";
const SHOP_NO_ADMIN = "ga4-qa-noadmin.myshopify.com";
const SHOP_ROUTE = "ga4-qa-route.myshopify.com";
const SHOP_ROUTE_FREE = "ga4-qa-route-free.myshopify.com";
const ALL_SHOPS = [
  SHOP, SHOP_LOCKED, SHOP_NEVER, SHOP_RACE, SHOP_FREE, SHOP_OFF, SHOP_NOT_DUE, SHOP_NO_ADMIN, SHOP_ROUTE, SHOP_ROUTE_FREE,
];

let passed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    failures.push({ label, message: err?.message || String(err) });
    console.log(`  ✗ ${label}\n      ${err?.message || err}`);
  }
}
function section(title) {
  console.log(`\n▶ ${title}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const GTAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script>
<script>window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());gtag('config', 'G-AB12CD34EF');</script>`;

const GTM = `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});
var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;
j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-K9QX7ZP');</script>`;

// Shopify's web-pixel config: JSON inside a JS string inside JSON.
const PIXEL_ONCE = String.raw`webPixelsConfigList: [{"id":"1","configuration":"{\"google_tag_ids\":[\"G-PX9ZQ2WM4K\",\"GT-KFGZ2B7\"]}"}]`;
const PIXEL_TWICE = String.raw`"{\"config\":\"{\\\"google_tag_ids\\\":[\\\"G-TW1CE2ESC3\\\"]}\"}"`;
const PIXEL_UNICODE = String.raw`{"google_tag_ids":["G-UNI0022AB"]}`;

const SHOPIFY_MARKER = `<script>var Shopify = Shopify || {};Shopify.shop = "${SHOP}";</script>`;

function storefrontPage(headExtra = "", bodyExtra = "") {
  return `<!doctype html><html><head><title>Store</title>${SHOPIFY_MARKER}${headExtra}</head><body><div id="shopify-section-header"></div>${bodyExtra}</body></html>`;
}

const PASSWORD_PAGE = `<!doctype html><html><head>${SHOPIFY_MARKER}</head><body>
<form method="post" action="/password" id="login_form"><input type="hidden" name="form_type" value="storefront_password"></form></body></html>`;

/** Resolves every URL without DNS, so no test depends on the network. */
const passValidate = async (u) => ({ ok: true, url: new URL(u).toString() });

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

/** A fake fetch that serves one fixed page and records every call. */
function pageFetch(html, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return htmlResponse(html, status);
  };
  impl.calls = calls;
  return impl;
}

/** Stateless fake admin serving theme files for the tag-scan query only. */
function themeAdmin({ files = [], errors = null, noTheme = false, pageSize = 250 } = {}) {
  const calls = [];
  return {
    calls,
    graphql: async (query, { variables } = {}) => {
      calls.push({ query, variables });
      const j = (body) => ({ json: async () => body });
      if (errors) return j({ errors });
      if (noTheme) return j({ data: { themes: { nodes: [] } } });
      const start = variables?.cursor ? Number(variables.cursor) : 0;
      const slice = files.slice(start, start + pageSize);
      const next = start + pageSize;
      return j({
        data: {
          themes: {
            nodes: [
              {
                id: "gid://shopify/OnlineStoreTheme/1",
                name: "Dawn",
                files: {
                  pageInfo: { hasNextPage: next < files.length, endCursor: String(next) },
                  nodes: slice.map((f) => ({ filename: f.filename, body: { content: f.content } })),
                },
              },
            ],
          },
        },
      });
    },
  };
}

const THEME_WITH_TAG = [
  { filename: "layout/theme.liquid", content: "<html><head>{% render 'google-analytics' %}</head></html>" },
  { filename: "snippets/google-analytics.liquid", content: GTAG },
];
const THEME_WITHOUT_TAG = [{ filename: "layout/theme.liquid", content: "<html><head>{{ content_for_header }}</head></html>" }];

function spyNotify() {
  const calls = [];
  const fn = async (shop, incident, settings) => {
    calls.push({ shop, incident, settings });
  };
  fn.calls = calls;
  return fn;
}

let clock = Date.UTC(2026, 8, 24, 12, 0, 0);
function tick(minutes = 1) {
  clock += minutes * 60 * 1000;
  return new Date(clock);
}

async function cleanup() {
  await prisma.downtimeCheck.deleteMany({ where: { shop: { in: ALL_SHOPS } } });
  await prisma.monitoredService.deleteMany({ where: { shop: { in: ALL_SHOPS } } });
  await prisma.auditLog.deleteMany({ where: { shop: { in: ALL_SHOPS } } });
  await prisma.teamMember.deleteMany({ where: { shop: { in: ALL_SHOPS } } });
  await prisma.appSettings.deleteMany({ where: { shop: { in: ALL_SHOPS } } });
}

async function freshShop(shop, data = {}) {
  await prisma.appSettings.deleteMany({ where: { shop } });
  return prisma.appSettings.create({ data: { shop, planId: "starter", ...data } });
}

function readRow(shop) {
  return prisma.appSettings.findUnique({ where: { shop } });
}

/** Runs one verifyTagHealth against a fake storefront + fake theme. */
async function runCheck(shop, { html, status = 200, themeFiles = [], storefrontFetch, notify, now }) {
  return verifyTagHealth(shop, {
    admin: themeAdmin({ files: themeFiles }),
    fetchImpl: storefrontFetch || pageFetch(html, status),
    validateUrl: passValidate,
    notify,
    now: now || tick(),
  });
}

// Every outbound request that is not an explicitly faked storefront lands
// here, so nothing can leave the machine.
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  outbound.push({ url: String(url), init });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

async function main() {
  await cleanup();

  // ── extractTagIds ─────────────────────────────────────────────────────────
  section("extractTagIds — detection rules");

  await check("finds the GA4 measurement ID in a standard gtag.js snippet", () => {
    assert.deepStrictEqual(extractTagIds(GTAG), { ga4: ["G-AB12CD34EF"], gtm: [] });
  });
  await check("finds the GTM container ID in the standard GTM snippet", () => {
    assert.deepStrictEqual(extractTagIds(GTM).gtm, ["GTM-K9QX7ZP"]);
  });
  await check("finds IDs in Shopify's web-pixel config escaped once", () => {
    assert.deepStrictEqual(extractTagIds(PIXEL_ONCE).ga4, ["G-PX9ZQ2WM4K"]);
  });
  await check("finds IDs in web-pixel config escaped twice", () => {
    assert.deepStrictEqual(extractTagIds(PIXEL_TWICE).ga4, ["G-TW1CE2ESC3"]);
  });
  await check("finds IDs behind \\u0022 unicode-escaped quotes", () => {
    assert.deepStrictEqual(extractTagIds(PIXEL_UNICODE).ga4, ["G-UNI0022AB"]);
  });
  await check("finds IDs inside &quot;-encoded HTML attributes", () => {
    const html = `<div data-config="{&quot;measurement_id&quot;:&quot;G-HTMLQUOT1&quot;}"></div>`;
    assert.deepStrictEqual(extractTagIds(html).ga4, ["G-HTMLQUOT1"]);
  });
  await check("finds IDs in a URL-encoded loader URL", () => {
    const html = "https%3A%2F%2Fwww.googletagmanager.com%2Fgtag%2Fjs%3Fid%3DG-URLENC123";
    assert.deepStrictEqual(extractTagIds(html).ga4, ["G-URLENC123"]);
  });
  await check("finds IDs in theme settings (google_analytics_id)", () => {
    assert.deepStrictEqual(extractTagIds('{"google_analytics_id": "G-SETT1NG5AB"}').ga4, ["G-SETT1NG5AB"]);
  });
  await check("ignores G-XXXXXXXXXX / GTM-XXXXXXX placeholders", () => {
    const html = "gtag('config', 'G-XXXXXXXXXX'); dataLayer.push('GTM-XXXXXXX');";
    assert.deepStrictEqual(extractTagIds(html), { ga4: [], gtm: [] });
  });
  await check("ignores GT- (Google tag) and AW- (Ads) IDs", () => {
    const html = "gtag('config', 'AW-123456789'); gtag('config', 'GT-ABCD1234');";
    assert.deepStrictEqual(extractTagIds(html), { ga4: [], gtm: [] });
  });
  await check("ignores product copy and SKUs with no Google-tag context", () => {
    const html = "<p>The new G-SHOCK watch, SKU G-2100BLK, is back in stock. Order GTM-ORDER12 today.</p>";
    assert.deepStrictEqual(extractTagIds(html), { ga4: [], gtm: [] });
  });
  await check("accepts an all-letter GA4 ID when it sits in gtag context", () => {
    assert.deepStrictEqual(extractTagIds("gtag('config', 'G-ABCDEFGHIJ');").ga4, ["G-ABCDEFGHIJ"]);
  });
  await check("does not treat a GTM ID as its own tag-manager context", () => {
    assert.deepStrictEqual(extractTagIds("<span>GTM-AB12CD</span>").gtm, []);
  });
  await check("de-duplicates and keeps document order", () => {
    const html = `${GTAG} gtag('config', 'G-SECOND1234'); gtag('config', 'G-AB12CD34EF');`;
    assert.deepStrictEqual(extractTagIds(html).ga4, ["G-AB12CD34EF", "G-SECOND1234"]);
  });

  // ── classifyTagHealth ─────────────────────────────────────────────────────
  section("classifyTagHealth — the live storefront decides");

  const reachable = (html) => ({ ok: true, status: 200, html, truncated: false, locked: false });
  const themeHit = { ok: true, ga4: ["G-AB12CD34EF"], gtm: [], files: ["snippets/google-analytics.liquid"] };
  const themeMiss = { ok: true, ga4: [], gtm: [], files: [] };

  await check("reachable + live tag + theme tag → DETECTED in BOTH, armed", () => {
    const r = classifyTagHealth({ storefront: reachable(storefrontPage(GTAG)), theme: themeHit });
    assert.strictEqual(r.status, TAG_DETECTED);
    assert.strictEqual(r.detectedIn, "BOTH");
    assert.strictEqual(r.liveDetected, true);
  });
  await check("reachable + live tag only → DETECTED on STOREFRONT (app / channel tag)", () => {
    const r = classifyTagHealth({ storefront: reachable(storefrontPage(PIXEL_ONCE)), theme: themeMiss });
    assert.strictEqual(r.status, TAG_DETECTED);
    assert.strictEqual(r.detectedIn, "STOREFRONT");
    assert.deepStrictEqual(r.ga4Ids, ["G-PX9ZQ2WM4K"]);
  });
  await check("reachable + no live tag + theme tag → MISSING, naming the theme file", () => {
    const r = classifyTagHealth({ storefront: reachable(storefrontPage()), theme: themeHit });
    assert.strictEqual(r.status, TAG_MISSING);
    assert.match(r.detail, /snippets\/google-analytics\.liquid/);
    assert.strictEqual(r.liveDetected, false);
  });
  await check("reachable + no tag anywhere → MISSING", () => {
    const r = classifyTagHealth({ storefront: reachable(storefrontPage()), theme: themeMiss });
    assert.strictEqual(r.status, TAG_MISSING);
  });
  await check("password-locked + theme tag → DETECTED from THEME only, never armed", () => {
    const r = classifyTagHealth({
      storefront: { ok: true, status: 302, html: "", truncated: false, locked: true },
      theme: themeHit,
    });
    assert.strictEqual(r.status, TAG_DETECTED);
    assert.strictEqual(r.detectedIn, "THEME");
    assert.strictEqual(r.liveDetected, false);
    assert.match(r.detail, /password protected/);
  });
  await check("password-locked + no theme tag → UNKNOWN (pixels are invisible here)", () => {
    const r = classifyTagHealth({
      storefront: { ok: true, status: 200, html: PASSWORD_PAGE, truncated: false, locked: true },
      theme: themeMiss,
    });
    assert.strictEqual(r.status, TAG_UNKNOWN);
  });
  await check("unreachable + theme scan failed → UNKNOWN", () => {
    const r = classifyTagHealth({ storefront: { ok: false, error: "timeout" }, theme: { ok: false, error: "THROTTLED" } });
    assert.strictEqual(r.status, TAG_UNKNOWN);
    assert.match(r.detail, /THROTTLED/);
  });
  for (const status of [402, 403, 429, 500, 503]) {
    await check(`HTTP ${status} is unreachable, never MISSING`, () => {
      const r = classifyTagHealth({ storefront: { ...reachable(storefrontPage()), status }, theme: themeMiss });
      assert.strictEqual(r.status, TAG_UNKNOWN);
    });
  }
  await check("a 200 page with no Shopify storefront marker is UNKNOWN (bot challenge)", () => {
    const r = classifyTagHealth({ storefront: reachable("<html><head><title>Just a moment…</title></head><body></body></html>"), theme: themeMiss });
    assert.strictEqual(r.status, TAG_UNKNOWN);
  });
  await check("a body cut off before </head> is UNKNOWN", () => {
    const r = classifyTagHealth({
      storefront: { ok: true, status: 200, html: `<html><head>${SHOPIFY_MARKER}`, truncated: true, locked: false },
      theme: themeMiss,
    });
    assert.strictEqual(r.status, TAG_UNKNOWN);
  });
  await check("a page capped after </head> with no tag found is UNKNOWN, not MISSING", () => {
    const r = classifyTagHealth({
      storefront: { ok: true, status: 200, html: storefrontPage(), truncated: true, locked: false },
      theme: themeMiss,
    });
    assert.strictEqual(r.status, TAG_UNKNOWN);
  });

  // ── fetchStorefrontHtml ───────────────────────────────────────────────────
  section("fetchStorefrontHtml — read-only, SSRF-guarded, bounded");

  await check("a redirect to /password marks the storefront locked", async () => {
    const impl = async () => new Response(null, { status: 302, headers: { location: "/password" } });
    const r = await fetchStorefrontHtml(SHOP, { fetchImpl: impl, validateUrl: passValidate });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.locked, true);
  });
  await check("a 200 password page is detected as locked", async () => {
    const r = await fetchStorefrontHtml(SHOP, { fetchImpl: pageFetch(PASSWORD_PAGE), validateUrl: passValidate });
    assert.strictEqual(r.locked, true);
  });
  await check("a redirect to a private address is rejected by the real SSRF guard", async () => {
    const impl = async () => new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } });
    const firstHopOnly = async (u) => (u.includes(SHOP) ? passValidate(u) : validateServiceUrl(u));
    const r = await fetchStorefrontHtml(SHOP, { fetchImpl: impl, validateUrl: firstHopOnly });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Redirect rejected/i);
  });
  await check("follows a primary-domain redirect and reads the final page", async () => {
    const seen = [];
    const impl = async (url) => {
      seen.push(url);
      if (url.includes("myshopify")) return new Response(null, { status: 301, headers: { location: "https://www.example-store.com/" } });
      return htmlResponse(storefrontPage(GTAG));
    };
    const r = await fetchStorefrontHtml(SHOP, { fetchImpl: impl, validateUrl: passValidate });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(seen.length, 2);
    assert.match(r.html, /G-AB12CD34EF/);
  });
  await check("one deadline covers the whole redirect chain", async () => {
    const impl = (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        if (url.includes("myshopify")) {
          setTimeout(() => resolve(new Response(null, { status: 301, headers: { location: "https://slow.example.com/" } })), 150);
        }
        // The second hop never answers.
      });
    const started = Date.now();
    const r = await fetchStorefrontHtml(SHOP, { fetchImpl: impl, validateUrl: passValidate, timeoutMs: 250 });
    const elapsed = Date.now() - started;
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /did not respond/);
    assert.ok(elapsed < 400, `took ${elapsed}ms — the timeout restarted per hop`);
  });
  await check("the body read is capped at 3 MB and flagged truncated", async () => {
    const big = storefrontPage("", "x".repeat(3.2 * 1024 * 1024));
    const r = await fetchStorefrontHtml(SHOP, { fetchImpl: pageFetch(big), validateUrl: passValidate });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.html.length <= 3 * 1024 * 1024, `read ${r.html.length} chars`);
  });
  await check("only ever issues GET requests with manual redirects", async () => {
    const impl = pageFetch(storefrontPage(GTAG));
    await fetchStorefrontHtml(SHOP, { fetchImpl: impl, validateUrl: passValidate });
    assert.ok(impl.calls.length > 0);
    for (const c of impl.calls) {
      assert.strictEqual(c.init.method, "GET");
      assert.strictEqual(c.init.redirect, "manual");
    }
  });

  // ── scanActiveThemeFiles ──────────────────────────────────────────────────
  section("scanActiveThemeFiles — queries only");

  await check("finds the tag in a snippet and names the file", async () => {
    const r = await scanActiveThemeFiles(themeAdmin({ files: THEME_WITH_TAG }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.ga4, ["G-AB12CD34EF"]);
    assert.deepStrictEqual(r.files, ["snippets/google-analytics.liquid"]);
  });
  await check("paginates through every page of theme files", async () => {
    const files = [
      ...THEME_WITHOUT_TAG,
      { filename: "sections/a.liquid", content: "a" },
      { filename: "sections/b.liquid", content: "b" },
      { filename: "sections/c.liquid", content: "c" },
      { filename: "snippets/gtm.liquid", content: GTM },
    ];
    const admin = themeAdmin({ files, pageSize: 2 });
    const r = await scanActiveThemeFiles(admin);
    assert.strictEqual(admin.calls.length, 3);
    assert.deepStrictEqual(r.gtm, ["GTM-K9QX7ZP"]);
  });
  await check("GraphQL errors, no main theme, or no admin all give ok:false", async () => {
    assert.strictEqual((await scanActiveThemeFiles(themeAdmin({ errors: [{ message: "Access denied" }] }))).ok, false);
    assert.strictEqual((await scanActiveThemeFiles(themeAdmin({ noTheme: true }))).ok, false);
    assert.strictEqual((await scanActiveThemeFiles(null)).ok, false);
  });
  await check("never sends a mutation, and asks only for the MAIN theme", async () => {
    const admin = themeAdmin({ files: THEME_WITH_TAG });
    await scanActiveThemeFiles(admin);
    for (const c of admin.calls) {
      assert.ok(!/\bmutation\b/i.test(c.query), "a mutation was sent");
      assert.match(c.query, /roles:\s*\[MAIN\]/);
    }
  });

  // ── decideTagAlert (pure) ─────────────────────────────────────────────────
  section("decideTagAlert — one alert per loss");

  const t0 = new Date("2026-09-24T00:00:00Z");
  const live = { status: TAG_DETECTED, liveDetected: true };
  const missing = { status: TAG_MISSING, liveDetected: false };

  await check("an unarmed store never alerts and stays on the 6 h cadence", () => {
    const d = decideTagAlert({ ga4Status: TAG_MISSING, ga4LastDetectedAt: null }, missing, t0);
    assert.strictEqual(d.alert, null);
    assert.strictEqual(d.nextCheckAt.getTime() - t0.getTime(), 6 * 3600 * 1000);
  });
  await check("the first MISSING of an armed store schedules a 15-minute confirmation", () => {
    const d = decideTagAlert({ ga4Status: TAG_DETECTED, ga4LastDetectedAt: t0 }, missing, new Date(t0.getTime() + 1000));
    assert.strictEqual(d.alert, null);
    assert.strictEqual(d.nextCheckAt.getTime() - t0.getTime() - 1000, 15 * 60 * 1000);
  });
  await check("the second MISSING in a row alerts", () => {
    const d = decideTagAlert({ ga4Status: TAG_MISSING, ga4LastDetectedAt: t0 }, missing, t0);
    assert.strictEqual(d.alert, "missing");
  });
  await check("after an alert, a live detection is a recovery", () => {
    const d = decideTagAlert(
      { ga4Status: TAG_MISSING, ga4LastDetectedAt: t0, ga4AlertedAt: new Date(t0.getTime() + 1000) },
      live,
      t0,
    );
    assert.strictEqual(d.alert, "recovered");
  });

  // ── verifyTagHealth (DB) ──────────────────────────────────────────────────
  section("verifyTagHealth — persistence and alert lifecycle");

  const SLACK = "https://hooks.slack.com/services/T000/B000/QA";
  await freshShop(SHOP, { slackWebhookUrl: SLACK, alertEmail: "qa-owner@example.test" });
  const notify = spyNotify();

  await check("1. live DETECTED: stored, armed, no alert, next check in 6 h", async () => {
    const now = tick();
    const r = await runCheck(SHOP, { html: storefrontPage(GTAG), themeFiles: THEME_WITH_TAG, notify, now });
    const row = await readRow(SHOP);
    assert.strictEqual(r.status, TAG_DETECTED);
    assert.strictEqual(row.ga4Status, TAG_DETECTED);
    assert.strictEqual(row.ga4MeasurementId, "G-AB12CD34EF");
    assert.strictEqual(row.ga4DetectedIn, "BOTH");
    assert.strictEqual(row.ga4LastDetectedAt.getTime(), now.getTime());
    assert.strictEqual(row.ga4NextCheckAt.getTime() - now.getTime(), 6 * 3600 * 1000);
    assert.strictEqual(notify.calls.length, 0);
  });
  await check("   only ga4* columns were written", async () => {
    const row = await readRow(SHOP);
    assert.strictEqual(row.planId, "starter");
    assert.strictEqual(row.slackWebhookUrl, SLACK);
    assert.strictEqual(row.alertEmail, "qa-owner@example.test");
    assert.strictEqual(row.monitoringEnabled, true);
  });
  await check("2. first MISSING: no alert, 15-minute confirm, last ID kept", async () => {
    const now = tick();
    await runCheck(SHOP, { html: storefrontPage(), notify, now });
    const row = await readRow(SHOP);
    assert.strictEqual(row.ga4Status, TAG_MISSING);
    assert.strictEqual(row.ga4MeasurementId, "G-AB12CD34EF");
    assert.strictEqual(row.ga4DetectedIn, null);
    assert.strictEqual(row.ga4NextCheckAt.getTime() - now.getTime(), 15 * 60 * 1000);
    assert.strictEqual(notify.calls.length, 0);
  });
  await check("3. second MISSING: exactly one HIGH alert naming the lost ID, linking to /app/monitoring", async () => {
    const r = await runCheck(SHOP, { html: storefrontPage(), notify });
    assert.strictEqual(r.alert, "missing");
    assert.strictEqual(notify.calls.length, 1);
    const { incident, settings } = notify.calls[0];
    assert.strictEqual(incident.severity, "HIGH");
    assert.strictEqual(incident.linkPath, "/app/monitoring");
    assert.match(incident.name, /G-AB12CD34EF/);
    assert.strictEqual(settings.slackWebhookUrl, SLACK, "the shop's own alert settings are passed through");
    assert.ok((await readRow(SHOP)).ga4AlertedAt, "ga4AlertedAt was claimed");
  });
  await check("4. third MISSING: no repeat alert", async () => {
    await runCheck(SHOP, { html: storefrontPage(), notify });
    assert.strictEqual(notify.calls.length, 1);
  });
  await check("5. UNKNOWN in between: no alert, IDs kept", async () => {
    const r = await runCheck(SHOP, { html: "Service Unavailable", status: 503, notify });
    const row = await readRow(SHOP);
    assert.strictEqual(r.status, TAG_UNKNOWN);
    assert.strictEqual(row.ga4Status, TAG_UNKNOWN);
    assert.strictEqual(row.ga4MeasurementId, "G-AB12CD34EF");
    assert.strictEqual(notify.calls.length, 1);
  });
  await check("6. live DETECTED again: one MEDIUM recovery", async () => {
    const r = await runCheck(SHOP, { html: storefrontPage(GTAG), notify });
    assert.strictEqual(r.alert, "recovered");
    assert.strictEqual(notify.calls.length, 2);
    assert.strictEqual(notify.calls[1].incident.severity, "MEDIUM");
    assert.match(notify.calls[1].incident.name, /restored/i);
  });
  await check("7. the next loss alerts again (re-armed)", async () => {
    await runCheck(SHOP, { html: storefrontPage(), notify });
    assert.strictEqual(notify.calls.length, 2, "first MISSING must only confirm");
    await runCheck(SHOP, { html: storefrontPage(), notify });
    assert.strictEqual(notify.calls.length, 3);
    assert.strictEqual(notify.calls[2].incident.severity, "HIGH");
  });
  await check("an alert failure never fails the check", async () => {
    await freshShop(SHOP_RACE);
    await runCheck(SHOP_RACE, { html: storefrontPage(GTAG) });
    await runCheck(SHOP_RACE, { html: storefrontPage(), notify: spyNotify() });
    const boom = async () => {
      throw new Error("Slack is down");
    };
    const r = await runCheck(SHOP_RACE, { html: storefrontPage(), notify: boom });
    assert.strictEqual(r.status, TAG_MISSING);
    assert.strictEqual(r.alert, null);
    assert.strictEqual((await readRow(SHOP_RACE)).ga4Status, TAG_MISSING);
  });

  await check("a password-locked store that launches without a tag is never paged", async () => {
    await freshShop(SHOP_LOCKED);
    const n = spyNotify();
    const lockedFetch = async () => new Response(null, { status: 302, headers: { location: "/password" } });
    const r = await runCheck(SHOP_LOCKED, { storefrontFetch: lockedFetch, themeFiles: THEME_WITH_TAG, notify: n });
    assert.strictEqual(r.status, TAG_DETECTED);
    assert.strictEqual((await readRow(SHOP_LOCKED)).ga4LastDetectedAt, null, "a THEME-only detection must not arm");
    await runCheck(SHOP_LOCKED, { html: storefrontPage(), themeFiles: THEME_WITH_TAG, notify: n });
    await runCheck(SHOP_LOCKED, { html: storefrontPage(), themeFiles: THEME_WITH_TAG, notify: n });
    assert.strictEqual(n.calls.length, 0);
  });
  await check("a store that never had a tag is never alerted", async () => {
    await freshShop(SHOP_NEVER);
    const n = spyNotify();
    for (let i = 0; i < 3; i++) await runCheck(SHOP_NEVER, { html: storefrontPage(), notify: n });
    const row = await readRow(SHOP_NEVER);
    assert.strictEqual(row.ga4Status, TAG_MISSING);
    assert.strictEqual(n.calls.length, 0);
  });
  await check("two checks racing on the same loss send one alert", async () => {
    await freshShop(SHOP_RACE);
    await runCheck(SHOP_RACE, { html: storefrontPage(GTAG) });
    await runCheck(SHOP_RACE, { html: storefrontPage() });
    const n = spyNotify();
    const now = tick();
    await Promise.all([
      runCheck(SHOP_RACE, { html: storefrontPage(), notify: n, now }),
      runCheck(SHOP_RACE, { html: storefrontPage(), notify: n, now }),
    ]);
    assert.strictEqual(n.calls.length, 1, `sent ${n.calls.length} alerts`);
  });
  await check("describeTagResult summarises each verdict for the banner", () => {
    assert.match(describeTagResult({ status: TAG_DETECTED, detectedIn: "STOREFRONT", ga4Ids: ["G-AB12CD34EF"], gtmIds: [] }), /G-AB12CD34EF detected on the live storefront/);
    assert.match(describeTagResult({ status: TAG_MISSING, ga4Ids: [], gtmIds: [] }), /no GA4 or GTM tag/);
    assert.match(describeTagResult({ status: TAG_UNKNOWN, ga4Ids: [], gtmIds: [], detail: "x" }), /couldn't verify/);
  });

  // ── runDueTagChecks ───────────────────────────────────────────────────────
  section("runDueTagChecks — background sweep");

  await check("skips Free and no-session shops without spending the batch; ignores disabled and not-due shops", async () => {
    const now = tick();
    const hourAgo = new Date(now.getTime() - 3600 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000);
    await freshShop(SHOP_FREE, { planId: "free", ga4NextCheckAt: new Date(twoHoursAgo.getTime() - 60000) });
    await freshShop(SHOP_NO_ADMIN, { ga4NextCheckAt: twoHoursAgo });
    await freshShop(SHOP, { ga4NextCheckAt: hourAgo });
    await freshShop(SHOP_OFF, { monitoringEnabled: false, ga4NextCheckAt: null });
    await freshShop(SHOP_NOT_DUE, { ga4NextCheckAt: new Date(now.getTime() + 3600 * 1000) });

    const resolveAdmin = async (shop) => (shop === SHOP_NO_ADMIN ? null : themeAdmin({ files: THEME_WITH_TAG }));
    const res = await runDueTagChecks({
      now,
      maxChecks: 1,
      shops: [SHOP_FREE, SHOP_NO_ADMIN, SHOP, SHOP_OFF, SHOP_NOT_DUE],
      resolveAdmin,
      fetchImpl: pageFetch(storefrontPage(GTAG)),
      validateUrl: passValidate,
      notify: spyNotify(),
    });

    assert.strictEqual(res.checked, 1);
    const byShop = Object.fromEntries(res.results.map((r) => [r.shop, r]));
    assert.match(byShop[SHOP_FREE]?.skipped || "", /not included/);
    assert.match(byShop[SHOP_NO_ADMIN]?.skipped || "", /no offline session/);
    assert.strictEqual(byShop[SHOP]?.status, TAG_DETECTED);
    assert.ok(!byShop[SHOP_OFF], "a monitoring-disabled shop was picked");
    assert.ok(!byShop[SHOP_NOT_DUE], "a not-yet-due shop was picked");

    const day = 24 * 3600 * 1000;
    assert.strictEqual((await readRow(SHOP_FREE)).ga4NextCheckAt.getTime() - now.getTime(), day);
    assert.strictEqual((await readRow(SHOP_NO_ADMIN)).ga4NextCheckAt.getTime() - now.getTime(), day);
    assert.strictEqual((await readRow(SHOP_FREE)).ga4Status, null, "a Free shop must not be checked");
    assert.strictEqual((await readRow(SHOP_OFF)).ga4NextCheckAt, null);
  });

  // ── Theme publish webhook + scheduling ────────────────────────────────────
  section("theme publish → re-check scheduling");

  await check("scheduleTagRecheck marks the shop due ~2 minutes out", async () => {
    await freshShop(SHOP, { ga4NextCheckAt: new Date(Date.now() + 6 * 3600 * 1000) });
    const now = new Date();
    await scheduleTagRecheck(SHOP, { now });
    assert.strictEqual((await readRow(SHOP)).ga4NextCheckAt.getTime() - now.getTime(), 2 * 60 * 1000);
  });
  await check("scheduleTagRecheck is a no-op for a shop with no settings row", async () => {
    await scheduleTagRecheck("ga4-qa-nonexistent.myshopify.com");
    assert.strictEqual(await readRow("ga4-qa-nonexistent.myshopify.com"), null);
  });
  await check("the webhook schedules after the monitoringEnabled gate, isolated in its own try/catch", () => {
    const src = fs.readFileSync(new URL("../app/routes/webhooks.themes.publish.jsx", import.meta.url), "utf8");
    const gate = src.indexOf('"Monitoring disabled"');
    const call = src.indexOf("await scheduleTagRecheck(shop)");
    const snapshot = src.indexOf("fetchThemeBackup(admin");
    assert.ok(gate !== -1 && call !== -1 && snapshot !== -1, "expected markers not found");
    assert.ok(gate < call && call < snapshot, "scheduling is not between the gate and the snapshot");
    assert.match(src, /try \{\s*await scheduleTagRecheck\(shop\);\s*\} catch \(/);
  });
  await check("the scheduler runs the sweep under its own lock", () => {
    const src = fs.readFileSync(new URL("../app/scheduler.server.js", import.meta.url), "utf8");
    assert.match(src, /withJobLock\("ga4:sweep", 15 \* 60 \* 1000, \(\) => runDueTagChecks\(\)\)/);
    const cron = fs.readFileSync(new URL("../app/routes/api.cron.ga4.jsx", import.meta.url), "utf8");
    assert.match(cron, /assertCronAuth\(request\)/);
    assert.match(cron, /withJobLock\("ga4:sweep", 15 \* 60 \* 1000/);
  });

  // ── Alert transport ───────────────────────────────────────────────────────
  section("sendIncidentAlert — linkPath override is backward compatible");

  const prevAppUrl = process.env.SHOPIFY_APP_URL;
  process.env.SHOPIFY_APP_URL = "https://app.example.test";
  const settings = { slackWebhookUrl: SLACK, alertOnHigh: true, alertEmail: null };
  // Slack delivery is checked against the plan at send time (Business+), so
  // the link-format checks run on a Business store.
  await prisma.appSettings.update({ where: { shop: SHOP }, data: { planId: "business" } });
  const slackLink = async (incident) => {
    outbound.length = 0;
    await sendIncidentAlert(SHOP, { severity: "HIGH", status: "OPEN", affectedCount: 1, name: "QA", ...incident }, settings);
    const slack = outbound.find((o) => o.url.startsWith("https://hooks.slack.com/"));
    assert.ok(slack, "no Slack request was captured");
    return JSON.parse(slack.init.body).attachments[0].title_link;
  };

  await check("an in-app linkPath replaces the incident link", async () => {
    assert.strictEqual(await slackLink({ id: "ga4-tag", linkPath: "/app/monitoring" }), "https://app.example.test/app/monitoring");
  });
  await check("a real Incident row keeps /app/incidents/<id>", async () => {
    assert.strictEqual(await slackLink({ id: 42 }), "https://app.example.test/app/incidents/42");
  });
  await check("absolute or protocol-relative linkPaths are ignored", async () => {
    assert.strictEqual(await slackLink({ id: 7, linkPath: "https://evil.test/x" }), "https://app.example.test/app/incidents/7");
    assert.strictEqual(await slackLink({ id: 7, linkPath: "//evil.test/x" }), "https://app.example.test/app/incidents/7");
  });
  if (prevAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = prevAppUrl;

  // ── Plan gate ─────────────────────────────────────────────────────────────
  section("plan gate");

  await check("ga4Monitoring is off on Free and on from Starter up", () => {
    assert.strictEqual(PLAN_LIMITS.free.ga4Monitoring, false);
    for (const id of ["starter", "growth", "business", "enterprise"]) {
      assert.strictEqual(PLAN_LIMITS[id].ga4Monitoring, true, `${id} is missing ga4Monitoring`);
    }
  });

  // ── Monitoring route ──────────────────────────────────────────────────────
  section("/app/monitoring — loader and Verify Now action");

  const { loader, action } = await import("../app/routes/app.monitoring.jsx");
  const post = (fields) =>
    new Request("https://app.example.test/app/monitoring", { method: "POST", body: new URLSearchParams(fields) });

  await check("the loader returns tagHealth alongside the existing data", async () => {
    await freshShop(SHOP_ROUTE);
    setMockShop(SHOP_ROUTE);
    const data = await loader({ request: new Request("https://app.example.test/app/monitoring") });
    assert.ok(Array.isArray(data.services), "services missing");
    assert.ok(Array.isArray(data.recentChecks), "recentChecks missing");
    assert.strictEqual(data.tagHealth.locked, false);
    assert.strictEqual(data.tagHealth.status, null);
  });
  await check("Verify Now runs a check and reports it in the result banner", async () => {
    setMockShop(SHOP_ROUTE);
    outbound.length = 0;
    const res = await action({ request: post({ intent: "verifyGa4" }) });
    const row = await readRow(SHOP_ROUTE);
    assert.match(res.message, /^GA4 tag check:/);
    assert.ok(["success", "critical", "warning"].includes(res.tone), `tone was ${res.tone}`);
    assert.ok([TAG_DETECTED, TAG_MISSING, TAG_UNKNOWN].includes(row.ga4Status), `status was ${row.ga4Status}`);
    assert.ok(row.ga4LastCheckedAt, "last checked time not stored");
    for (const o of outbound) {
      assert.strictEqual((o.init?.method || "GET").toUpperCase(), "GET", `non-GET request to ${o.url}`);
    }
  });
  await check("a Free-plan store gets the upgrade message and no check runs", async () => {
    await freshShop(SHOP_ROUTE_FREE, { planId: "free" });
    setMockShop(SHOP_ROUTE_FREE);
    outbound.length = 0;
    const res = await action({ request: post({ intent: "verifyGa4" }) });
    assert.strictEqual(res.success, false);
    assert.match(res.message, /not included in the FREE plan/);
    assert.strictEqual((await readRow(SHOP_ROUTE_FREE)).ga4Status, null);
    assert.strictEqual(outbound.length, 0, "a storefront request was made for a locked store");
  });
  await check("a failing tag summary hides the card instead of breaking the page", () => {
    const src = fs.readFileSync(new URL("../app/routes/app.monitoring.jsx", import.meta.url), "utf8");
    assert.match(src, /await getTagHealthSummary\(shop\)\.catch\(/, "loader does not guard the tag summary");
    assert.match(src, /\{tagHealth && \(/, "card is not conditional on tagHealth");
  });
  await check("existing intents are untouched (unknown intent still rejected)", async () => {
    setMockShop(SHOP_ROUTE);
    const res = await action({ request: post({ intent: "nope" }) });
    assert.deepStrictEqual(res, { success: false, message: "Unknown action." });
  });
}

main()
  .catch((err) => {
    failures.push({ label: "suite crashed", message: err?.stack || String(err) });
    console.error(err);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.warn("cleanup failed:", err?.message || err);
    }
    globalThis.fetch = realFetch;
    console.log("\n════════════════════════════════════════════════════");
    if (failures.length) {
      console.log(`  ${passed} passed, ${failures.length} FAILED`);
      for (const f of failures) console.log(`   - ${f.label}: ${f.message}`);
    } else {
      console.log(`  ${passed} GA4 tag health checks passed`);
    }
    console.log("════════════════════════════════════════════════════\n");
    await prisma.$disconnect();
    process.exit(failures.length === 0 ? 0 : 1);
  });
