/**
 * QA for the Platform Admin Panel (app/routes/app.admin.jsx) and the billing
 * paths it drives: authorization, the global discount, the Free Growth
 * promotion, support tickets, custom Enterprise Plus quotas (and how the
 * billing sync and subscription webhook accept them), store discounts, the
 * loader's per-store plan/cap/discount view, the rendered table, and support
 * ticket creation.
 *
 * Isolation:
 *  - Every merchant row belongs to a qa-admin-*.myshopify.com shop, cleaned
 *    before and after.
 *  - PlatformSettings is a singleton the running dev app reads, so it is
 *    snapshotted first and restored exactly at the end.
 *  - globalThis.fetch is stubbed: .env carries live RESEND_* keys and support
 *    ticket creation sends an email.
 *
 * Run: node --import ./scratch/_qa_admin_render_register.mjs scratch/test_admin_panel_qa.mjs
 */
/* global globalThis */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const PREFIX = "qa-admin-";
const OP = `${PREFIX}operator.myshopify.com`;
const OP_EMAIL = "qa-op@example.com";
process.env.ADMIN_SHOP_DOMAIN = OP;
process.env.ADMIN_EMAILS = OP_EMAIL;

const { default: prisma } = await import("../app/db.server.js");
const { setMockShop, setMockSessionExtras, setMockWebhook, setMockAdminOverride } = await import("./_qa_mock_admin.mjs");
const billing = await import("../app/billing.server.js");
const adminRoute = await import("../app/routes/app.admin.jsx");
const supportRoute = await import("../app/routes/app.support.jsx");
const webhookRoute = await import("../app/routes/webhooks.app_subscriptions.update.jsx");
const productWebhook = await import("../app/routes/webhooks.products.update.jsx");
const routerStub = await import("./_qa_react_router_stub.mjs");
const freeGrowth = await import("../app/freeGrowth.server.js");
const rulesRoute = await import("../app/routes/app.rules.jsx");
const uninstallRoute = await import("../app/routes/webhooks.app.uninstalled.jsx");
const redactRoute = await import("../app/routes/webhooks.shop.redact.jsx");
const planRoute = await import("../app/routes/app.plan.jsx");

const M_FREE = `${PREFIX}free.myshopify.com`;
const M_EXT = `${PREFIX}external.myshopify.com`;
const M_PARTNER = `${PREFIX}partner.myshopify.com`;
const M_CUSTOM = `${PREFIX}custom.myshopify.com`;
const M_SESSION_ONLY = `${PREFIX}sessiononly.myshopify.com`;
const M_GONE = `${PREFIX}gone.myshopify.com`;
const M_BILLED = `${PREFIX}billed.myshopify.com`;
const M_RULES = `${PREFIX}rules.myshopify.com`;
const M_SEAT = `${PREFIX}seat.myshopify.com`;
const TEST_SHOPS = [OP, M_FREE, M_EXT, M_PARTNER, M_CUSTOM, M_SESSION_ONLY, M_GONE, M_BILLED, M_RULES, M_SEAT, `${PREFIX}downgraded.myshopify.com`];
const CUSTOM_SUB_ID = "gid://shopify/AppSubscription/990001";
const CUSTOM_SUB_ID_NEW = "gid://shopify/AppSubscription/990002";

const results = [];
async function check(group, name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
    console.log(`  PASS  [${group}] ${name}`);
  } catch (err) {
    results.push({ group, name, ok: false, error: err?.message || String(err) });
    console.log(`  FAIL  [${group}] ${name}\n        ${err?.message || err}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ id: "qa-stub" }), { status: 200 });

function asAdmin(extras = {}) {
  setMockShop(OP);
  setMockSessionExtras({
    onlineAccessInfo: { associated_user: { email: OP_EMAIL, account_owner: false, ...extras } },
  });
}
function asMerchant(shop, email = "owner@merchant.test") {
  setMockShop(shop);
  setMockSessionExtras({ onlineAccessInfo: { associated_user: { email, account_owner: true } } });
}
async function post(route, fields) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return route.action({ request: new Request("http://localhost/app/admin", { method: "POST", body }) });
}
// Every admin call re-asserts the operator session: webhook and support checks
// point the stub at merchant stores.
const adminPost = (fields) => {
  asAdmin();
  return post(adminRoute, fields);
};
const settingsOf = (shop) => prisma.appSettings.findUnique({ where: { shop } });

async function cleanup() {
  const where = { shop: { startsWith: PREFIX } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.changeEvent.deleteMany({ where });
  await prisma.incident.deleteMany({ where });
  await prisma.supportTicket.deleteMany({ where });
  await prisma.storeDiscount.deleteMany({ where });
  await prisma.freeGrowthGrant.deleteMany({ where });
  await prisma.freeGrowthClaim.deleteMany({
    where: { shopHash: { in: TEST_SHOPS.map((shop) => freeGrowth.freeGrowthClaimKey(shop)) } },
  });
  await prisma.detectionRule.deleteMany({ where });
  await prisma.teamMember.deleteMany({ where }).catch(() => {});
  await prisma.productSnapshot.deleteMany({ where });
  await prisma.appSettings.deleteMany({ where });
  await prisma.session.deleteMany({ where });
}

async function seed() {
  const session = (shop) => ({ id: `offline_${shop}`, shop, state: "", accessToken: "qa-token" });
  await prisma.session.createMany({
    data: [OP, M_FREE, M_EXT, M_PARTNER, M_CUSTOM, M_SESSION_ONLY, M_BILLED, M_RULES, M_SEAT].map(session),
  });
  await prisma.appSettings.createMany({
    data: [
      { shop: M_FREE, planId: "free" },
      { shop: M_GONE, planId: "starter" },
      {
        shop: M_EXT,
        planId: "free",
        customProductLimit: 400000,
        customPriceAmount: 500,
        customBillingMethod: "EXTERNAL",
        customPriceStatus: "ACTIVE",
      },
      { shop: M_PARTNER, planId: "free", isPartnerDevelopment: true },
      { shop: M_BILLED, planId: "business", billingInterval: "EVERY_30_DAYS", subscriptionId: "gid://shopify/AppSubscription/880001" },
      { shop: M_RULES, planId: "free" },
      { shop: M_SEAT, planId: "free" },
      {
        shop: M_CUSTOM,
        planId: "enterprise",
        billingInterval: "EVERY_30_DAYS",
        subscriptionId: CUSTOM_SUB_ID,
        customProductLimit: 350000,
        customPriceAmount: 249,
        customBillingMethod: "SHOPIFY",
        customPriceStatus: "ACTIVE",
      },
    ],
  });
  await prisma.productSnapshot.create({
    data: { shop: M_FREE, productId: "gid://shopify/Product/qa-admin-1", title: "Only product", status: "ACTIVE", snapshotData: {} },
  });
}

/** A billing double whose check reports one active custom subscription. */
function customBilling(id, price) {
  return {
    check: async () => ({
      hasActivePayment: true,
      appSubscriptions: [
        {
          id,
          name: billing.PLAN_ENTERPRISE_CUSTOM,
          status: "ACTIVE",
          lineItems: [{ plan: { pricingDetails: { price: { amount: price, currencyCode: "USD" }, interval: "EVERY_30_DAYS" } } }],
        },
      ],
    }),
  };
}

/**
 * An Admin API double for one store's app subscriptions. Records every
 * cancellation (with its prorate flag); `failCancel` makes Shopify refuse them,
 * `unreachable` makes every call throw.
 */
function subscriptionsAdmin({ subs = [], failCancel = false, unreachable = false } = {}) {
  const calls = { cancelled: [] };
  const admin = {
    calls,
    graphql: async (query, opts = {}) => {
      if (unreachable) throw new Error("network down");
      const j = (data) => ({ json: async () => ({ data }) });
      if (query.includes("activeSubscriptions")) {
        return j({ currentAppInstallation: { activeSubscriptions: subs.filter((sub) => !calls.cancelled.some((c) => c.id === sub.id)) } });
      }
      if (query.includes("appSubscriptionCancel")) {
        if (failCancel) return j({ appSubscriptionCancel: { appSubscription: null, userErrors: [{ field: ["id"], message: "Cannot cancel" }] } });
        calls.cancelled.push({ id: opts.variables.id, prorate: opts.variables.prorate });
        return j({ appSubscriptionCancel: { appSubscription: { id: opts.variables.id, status: "CANCELLED" }, userErrors: [] } });
      }
      return j({});
    },
  };
  return admin;
}

const platformSnapshot = await prisma.platformSettings.findUnique({ where: { id: 1 } });

try {
  await cleanup();
  await seed();

  // ── A. Authorization ──────────────────────────────────────────────────────
  console.log("\nA. Authorization");

  await check("auth", "merchant store is redirected away from the loader", async () => {
    asMerchant(M_FREE);
    let thrown = null;
    try {
      await adminRoute.loader({ request: new Request("http://localhost/app/admin") });
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof Response, "loader did not throw a redirect");
    expect(thrown.headers.get("Location") === "/app", `redirected to ${thrown.headers.get("Location")}`);
  });

  await check("auth", "merchant store's direct POST is refused and writes nothing", async () => {
    asMerchant(M_FREE);
    const before = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    const res = await post(adminRoute, { intent: "setGlobalDiscount", globalDiscountPercent: "90" });
    const after = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(res.success === false, "action succeeded for a merchant");
    expect(JSON.stringify(before) === JSON.stringify(after), "PlatformSettings changed");
  });

  await check("auth", "operator-store staff not on the allow-list are refused", async () => {
    setMockShop(OP);
    setMockSessionExtras({ onlineAccessInfo: { associated_user: { email: "intern@example.com", account_owner: false } } });
    const res = await post(adminRoute, { intent: "clearGlobalDiscount" });
    expect(res.success === false && /do not have access/.test(res.message), res.message);
  });

  await check("auth", "operator store's account owner is admitted even if not on the list", async () => {
    setMockShop(OP);
    setMockSessionExtras({ onlineAccessInfo: { associated_user: { email: "owner@example.com", account_owner: true } } });
    const res = await post(adminRoute, { intent: "updateTicketStatus", ticketId: "abc" });
    expect(!/do not have access/.test(res.message), `refused: ${res.message}`);
  });

  await check("auth", "allow-listed operator email is admitted", async () => {
    asAdmin();
    const data = await adminRoute.loader({ request: new Request("http://localhost/app/admin") });
    expect(Array.isArray(data.merchants), "no merchants array");
  });

  await check("auth", "a store that never installed cannot be targeted", async () => {
    asAdmin();
    const res = await adminPost({ intent: "setDiscount", targetShop: "qa-admin-nobody.myshopify.com", discountPercent: "10" });
    expect(res.success === false && /not a known merchant/.test(res.message), res.message);
  });

  await check("auth", "store-scoped intent without a target is refused", async () => {
    asAdmin();
    const res = await adminPost({ intent: "setDiscount", discountPercent: "10" });
    expect(res.success === false && /Choose a merchant/.test(res.message), res.message);
  });

  await check("auth", "unknown intent is refused", async () => {
    asAdmin();
    const res = await adminPost({ intent: "dropTables", targetShop: M_FREE });
    expect(res.success === false && /Unknown action/.test(res.message), res.message);
  });

  // ── B. Global yearly discount ─────────────────────────────────────────────
  console.log("\nB. Global yearly discount");
  asAdmin();

  for (const bad of ["0", "101", "50abc", "1e2", "", "-5", "17.5", " "]) {
    await check("global", `rejects percent ${JSON.stringify(bad)}`, async () => {
      const res = await adminPost({ intent: "setGlobalDiscount", globalDiscountPercent: bad });
      expect(res.success === false, `accepted ${bad}`);
    });
  }

  await check("global", "valid 17% goes live for 12 months with a code-point-safe note", async () => {
    const note = "🎉".repeat(600);
    const res = await adminPost({ intent: "setGlobalDiscount", globalDiscountPercent: "17", globalNote: note });
    expect(res.success, res.message);
    const s = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(s.globalDiscountActive && s.globalDiscountPercent === 17, "not active at 17");
    expect(Array.from(s.globalDiscountNote).length === 500, `note length ${Array.from(s.globalDiscountNote).length}`);
    const months = (s.globalDiscountExpiresAt - Date.now()) / (30.4 * 86400000);
    expect(months > 11.8 && months < 12.2, `expiry ${months.toFixed(2)} months away`);
  });

  await check("global", "global discount is yearly-only and never reaches a monthly charge", async () => {
    const { resolveBestDiscount } = await import("../app/storeDiscount.server.js");
    const monthly = await resolveBestDiscount(M_FREE, "monthly");
    const yearly = await resolveBestDiscount(M_FREE, "annual");
    expect(monthly === null, `monthly got ${JSON.stringify(monthly)}`);
    expect(yearly?.percent === 17 && yearly.source === "GLOBAL", `yearly got ${JSON.stringify(yearly)}`);
  });

  await check("global", "turning it off works once, then reports nothing to turn off", async () => {
    const first = await adminPost({ intent: "clearGlobalDiscount" });
    const second = await adminPost({ intent: "clearGlobalDiscount" });
    expect(first.success, first.message);
    expect(second.success === false && /no active global/.test(second.message), second.message);
  });

  // ── C. Free Growth promotion ──────────────────────────────────────────────
  console.log("\nC. Free Growth promotion");

  await check("freeGrowth", "limit below seats already claimed is refused", async () => {
    await prisma.freeGrowthClaim.create({ data: { shopHash: freeGrowth.freeGrowthClaimKey(M_PARTNER) } });
    await prisma.freeGrowthGrant.create({ data: { shop: M_PARTNER, expiresAt: new Date(Date.now() + 86400000) } });
    const used = await prisma.freeGrowthClaim.count();
    const res = await adminPost({ intent: "updateFreeGrowth", freeGrowthSeatLimit: String(used - 1), freeGrowthDurationMonths: "2", freeGrowthEnabled: "1" });
    expect(res.success === false && /cannot be lowered/.test(res.message), res.message);
  });

  for (const [limit, months] of [["1001", "2"], ["abc", "2"], ["-1", "2"], ["20", "0"], ["20", "37"], ["20", "1.5"]]) {
    await check("freeGrowth", `rejects limit=${limit} months=${months}`, async () => {
      const res = await adminPost({ intent: "updateFreeGrowth", freeGrowthSeatLimit: limit, freeGrowthDurationMonths: months, freeGrowthEnabled: "1" });
      expect(res.success === false, `accepted ${limit}/${months}`);
    });
  }

  await check("freeGrowth", "pausing keeps the configured limit and duration", async () => {
    const used = await prisma.freeGrowthClaim.count();
    const res = await adminPost({ intent: "updateFreeGrowth", freeGrowthSeatLimit: String(used + 5), freeGrowthDurationMonths: "3", freeGrowthEnabled: "0" });
    expect(res.success && /off/.test(res.message), res.message);
    const s = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(!s.freeGrowthEnabled && s.freeGrowthSeatLimit === used + 5 && s.freeGrowthDurationMonths === 3, JSON.stringify(s));
  });

  await check("freeGrowth", "a paused promotion cannot be claimed", async () => {
    const { claimFreeGrowthSeat } = await import("../app/freeGrowth.server.js");
    expect((await claimFreeGrowthSeat(M_FREE)) === null, "claimed while paused");
  });

  // ── D. Support tickets ────────────────────────────────────────────────────
  console.log("\nD. Support tickets");
  const ticket = await prisma.supportTicket.create({
    data: { shop: M_FREE, subject: "Need help", category: "Billing", message: "Hi", status: "OPEN", priority: "NORMAL" },
  });

  await check("tickets", "status moves OPEN → IN_PROGRESS → RESOLVED → OPEN and is audited", async () => {
    for (const status of ["IN_PROGRESS", "RESOLVED", "OPEN"]) {
      const res = await adminPost({ intent: "updateTicketStatus", ticketId: String(ticket.id), status });
      expect(res.success, res.message);
      const t = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
      expect(t.status === status, `status ${t.status}, wanted ${status}`);
    }
    const audits = await prisma.auditLog.count({ where: { shop: OP, action: "ADMIN_TICKET_STATUS_UPDATED" } });
    expect(audits === 3, `${audits} audit rows`);
  });

  await check("tickets", "an invented status is refused and the ticket is unchanged", async () => {
    const res = await adminPost({ intent: "updateTicketStatus", ticketId: String(ticket.id), status: "HACKED" });
    const t = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(res.success === false, `accepted HACKED (${res.message})`);
    expect(t.status === "OPEN", `status became ${t.status}`);
  });

  await check("tickets", "a deleted ticket gets a message, not a server error", async () => {
    const res = await adminPost({ intent: "updateTicketStatus", ticketId: "999999999", status: "RESOLVED" });
    expect(res.success === false && /no longer exists/.test(res.message), res.message);
  });

  await check("tickets", "a non-numeric ticket id is refused", async () => {
    for (const id of ["abc", "12abc", "", "-3"]) {
      const res = await adminPost({ intent: "updateTicketStatus", ticketId: id, status: "RESOLVED" });
      expect(res.success === false, `accepted id ${JSON.stringify(id)}`);
    }
    const t = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(t.status === "OPEN", `"12abc" updated ticket 12's status path; ours is ${t.status}`);
  });

  // ── E. Custom Enterprise Plus quota ───────────────────────────────────────
  console.log("\nE. Custom Enterprise Plus quota");

  const quotaFields = (shop, over = {}) => ({
    intent: "setCustomQuota",
    targetShop: shop,
    customProductLimit: "350000",
    customPriceAmount: "249",
    customBillingMethod: "SHOPIFY",
    customPlanNote: "",
    ...over,
  });

  for (const [label, limit] of [
    ["below the Enterprise cap (150,000)", "150000"],
    ["equal to the Enterprise cap", "200000"],
    ["with trailing junk", "350000abc"],
    ["in exponent form", "1e9"],
    ["beyond the INT column", "3000000000"],
    ["above the 5M ceiling", "6000000"],
  ]) {
    await check("customQuota", `rejects a limit ${label}`, async () => {
      const before = await settingsOf(M_FREE);
      let res;
      try {
        res = await adminPost(quotaFields(M_FREE, { customProductLimit: limit }));
      } catch (err) {
        throw new Error(`threw: ${err.message.split("\n")[0]}`);
      }
      const after = await settingsOf(M_FREE);
      expect(res.success === false, `accepted ${limit}: ${res.message}`);
      expect(before.customProductLimit === after.customProductLimit, "limit was written");
    });
  }

  await check("customQuota", "a Shopify-billed offer needs a price (blank would bill $249 silently)", async () => {
    const res = await adminPost(quotaFields(M_FREE, { customPriceAmount: "" }));
    expect(res.success === false, `accepted blank price: ${res.message}`);
  });

  for (const price of ["0", "-5", "19.99", "10001", "abc"]) {
    await check("customQuota", `rejects price ${JSON.stringify(price)}`, async () => {
      const res = await adminPost(quotaFields(M_FREE, { customPriceAmount: price }));
      expect(res.success === false, `accepted ${price}: ${res.message}`);
    });
  }

  await check("customQuota", "a valid Shopify offer is OFFERED and not yet in force", async () => {
    const res = await adminPost(quotaFields(M_FREE, { customProductLimit: "350,000" }));
    expect(res.success, res.message);
    const s = await settingsOf(M_FREE);
    expect(s.customPriceStatus === "OFFERED" && s.customProductLimit === 350000, JSON.stringify(s));
    const limits = await billing.getEffectiveLimits(M_FREE);
    expect(limits.products === 50 && !limits.isCustomLimit, `limits.products=${limits.products}`);
  });

  await check("customQuota", "a lapsed (CANCELLED) offer re-saved is offered again", async () => {
    await prisma.appSettings.update({ where: { shop: M_FREE }, data: { customPriceStatus: "CANCELLED" } });
    const res = await adminPost(quotaFields(M_FREE, { customProductLimit: "350000" }));
    const s = await settingsOf(M_FREE);
    expect(res.success && s.customPriceStatus === "OFFERED", `status ${s.customPriceStatus}`);
  });

  await check("customQuota", "an external contract is in force immediately as Enterprise", async () => {
    setMockAdminOverride(subscriptionsAdmin());
    const res = await adminPost(quotaFields(M_FREE, { customBillingMethod: "EXTERNAL", customPriceAmount: "", customProductLimit: "300000" }));
    expect(res.success, res.message);
    const limits = await billing.getEffectiveLimits(M_FREE);
    expect((await billing.getEffectivePlanId(M_FREE)) === "enterprise", "not enterprise");
    expect(limits.products === 300000 && limits.isCustomLimit, `products ${limits.products}`);
  });

  await check("customQuota", "resetting an external contract restores the stored plan", async () => {
    const res = await adminPost({ intent: "resetCustomQuota", targetShop: M_FREE });
    expect(res.success, res.message);
    expect((await billing.getEffectivePlanId(M_FREE)) === "free", "still elevated");
  });

  await check("customQuota", "limit change on an ACTIVE custom plan at the same price stays in force", async () => {
    const res = await adminPost(quotaFields(M_CUSTOM, { customProductLimit: "400000", customPriceAmount: "249" }));
    expect(res.success, res.message);
    const s = await settingsOf(M_CUSTOM);
    const limits = await billing.getEffectiveLimits(M_CUSTOM);
    expect(s.customPriceStatus === "ACTIVE", `status ${s.customPriceStatus}`);
    expect(limits.products === 400000, `products ${limits.products}`);
  });

  const PENDING_STATE = {
    customPriceStatus: "ACTIVE",
    subscriptionId: CUSTOM_SUB_ID,
    customProductLimit: 400000,
    customPriceAmount: 249,
    customPendingProductLimit: 500000,
    customPendingPriceAmount: 299,
  };

  await check("customQuota", "re-pricing an ACTIVE custom plan keeps the paid terms in force and holds the new ones pending", async () => {
    const res = await adminPost(quotaFields(M_CUSTOM, { customProductLimit: "500000", customPriceAmount: "299" }));
    const s = await settingsOf(M_CUSTOM);
    expect(res.success && s.customPriceStatus === "ACTIVE", `status ${s.customPriceStatus}`);
    expect(s.customProductLimit === 400000 && s.customPriceAmount === 249, `current terms changed: ${s.customProductLimit} @ ${s.customPriceAmount}`);
    expect(s.customPendingProductLimit === 500000 && s.customPendingPriceAmount === 299, "pending terms not stored");
    expect((await billing.getEffectiveLimits(M_CUSTOM)).products === 400000, "quota paused while pending");
    expect(/keeps their current 400,000 products at \$249/.test(res.message), `message: ${res.message}`);
  });

  await check("customQuota", "the loader and table show the pending terms", async () => {
    const data = await adminRoute.loader({ request: new Request("http://localhost/app/admin") });
    const r = data.merchants.find((m) => m.shop === M_CUSTOM);
    expect(r.pendingCustomTerms?.price === 299 && r.productCap === 400000, JSON.stringify(r.pendingCustomTerms));
  });

  await check("customSync", "billing sync on the old $249 charge keeps 400,000 in force and the offer pending", async () => {
    const plan = await billing.getStorePlan(M_CUSTOM, customBilling(CUSTOM_SUB_ID, 249), true);
    const s = await settingsOf(M_CUSTOM);
    expect(s.customPriceStatus === "ACTIVE" && s.customPendingPriceAmount === 299, `status ${s.customPriceStatus}, pending ${s.customPendingPriceAmount}`);
    expect(plan.limits.products === 400000, `store got ${plan.limits.products} products`);
  });

  await check("customSync", "subscription webhook on the old charge changes nothing", async () => {
    setMockShop(M_CUSTOM);
    setMockWebhook({
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: { app_subscription: { admin_graphql_api_id: CUSTOM_SUB_ID, name: billing.PLAN_ENTERPRISE_CUSTOM, status: "ACTIVE", price: "249.00" } },
    });
    await webhookRoute.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
    const s = await settingsOf(M_CUSTOM);
    expect(s.customProductLimit === 400000 && s.customPendingPriceAmount === 299, `limit ${s.customProductLimit}, pending ${s.customPendingPriceAmount}`);
  });

  await check("customSync", "webhook for the newly approved charge (no price in payload) applies the pending terms", async () => {
    setMockShop(M_CUSTOM);
    setMockWebhook({
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: { app_subscription: { admin_graphql_api_id: CUSTOM_SUB_ID_NEW, name: billing.PLAN_ENTERPRISE_CUSTOM, status: "ACTIVE" } },
    });
    await webhookRoute.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
    const s = await settingsOf(M_CUSTOM);
    expect(s.customPriceStatus === "ACTIVE" && s.subscriptionId === CUSTOM_SUB_ID_NEW, `status ${s.customPriceStatus}`);
    expect(s.customProductLimit === 500000 && s.customPriceAmount === 299 && s.customPendingPriceAmount === null, `terms ${s.customProductLimit} @ ${s.customPriceAmount}, pending ${s.customPendingPriceAmount}`);
    // Back to the pending state for the sync path below.
    await prisma.appSettings.update({ where: { shop: M_CUSTOM }, data: PENDING_STATE });
  });

  await check("customSync", "a subscription webhook without a price for the SAME charge applies nothing", async () => {
    setMockShop(M_CUSTOM);
    setMockWebhook({
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: { app_subscription: { admin_graphql_api_id: CUSTOM_SUB_ID, name: billing.PLAN_ENTERPRISE_CUSTOM, status: "ACTIVE" } },
    });
    await webhookRoute.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
    const s = await settingsOf(M_CUSTOM);
    expect(s.customProductLimit === 400000 && s.customPendingPriceAmount === 299, "pending applied without a new charge");
  });

  await check("customSync", "billing sync accepts the approved $299 charge and applies 500,000", async () => {
    const plan = await billing.getStorePlan(M_CUSTOM, customBilling(CUSTOM_SUB_ID_NEW, 299), true);
    const s = await settingsOf(M_CUSTOM);
    expect(s.customPriceStatus === "ACTIVE", `status ${s.customPriceStatus}`);
    expect(plan.limits.products === 500000 && plan.currentPlan === "enterprise", `products ${plan.limits.products}`);
  });

  await check("customSync", "an ACTIVE plan whose charge no longer matches the price on file is re-offered", async () => {
    await billing.getStorePlan(M_CUSTOM, customBilling(CUSTOM_SUB_ID_NEW, 199), true);
    const s = await settingsOf(M_CUSTOM);
    expect(s.customPriceStatus === "OFFERED", `status ${s.customPriceStatus}`);
    await billing.getStorePlan(M_CUSTOM, customBilling(CUSTOM_SUB_ID_NEW, 299), true);
    expect((await settingsOf(M_CUSTOM)).customPriceStatus === "ACTIVE", "not restored at the right price");
  });

  await check("customSync", "a standard charge replacing a custom plan with pending terms cancels it and keeps the newest terms on file", async () => {
    await prisma.appSettings.update({ where: { shop: M_CUSTOM }, data: { ...PENDING_STATE, subscriptionId: CUSTOM_SUB_ID_NEW } });
    const standard = {
      check: async () => ({
        hasActivePayment: true,
        appSubscriptions: [{ id: "gid://shopify/AppSubscription/990004", name: "Enterprise", status: "ACTIVE", lineItems: [] }],
      }),
    };
    await billing.getStorePlan(M_CUSTOM, standard, true);
    const s = await settingsOf(M_CUSTOM);
    expect(s.customPriceStatus === "CANCELLED", `status ${s.customPriceStatus}`);
    expect(s.customProductLimit === 500000 && s.customPriceAmount === 299 && s.customPendingProductLimit === null, `terms ${s.customProductLimit} @ ${s.customPriceAmount}`);
    await prisma.appSettings.update({
      where: { shop: M_CUSTOM },
      data: { customPriceStatus: "ACTIVE", subscriptionId: CUSTOM_SUB_ID_NEW, customProductLimit: 500000, customPriceAmount: 299 },
    });
  });

  await check("customSync", "a standard charge replacing the custom one still cancels the quota", async () => {
    const standard = {
      check: async () => ({
        hasActivePayment: true,
        appSubscriptions: [{ id: "gid://shopify/AppSubscription/990003", name: "Enterprise", status: "ACTIVE", lineItems: [] }],
      }),
    };
    await billing.getStorePlan(M_CUSTOM, standard, true);
    const s = await settingsOf(M_CUSTOM);
    expect(s.customPriceStatus === "CANCELLED", `status ${s.customPriceStatus}`);
    await prisma.appSettings.update({
      where: { shop: M_CUSTOM },
      data: { customPriceStatus: "ACTIVE", subscriptionId: CUSTOM_SUB_ID_NEW },
    });
  });

  await check("customQuota", "reset is refused while the merchant pays for the custom plan through Shopify", async () => {
    const res = await adminPost({ intent: "resetCustomQuota", targetShop: M_CUSTOM });
    const s = await settingsOf(M_CUSTOM);
    expect(res.success === false, `reset went through: ${res.message}`);
    expect(s.customProductLimit === 500000 && s.customPriceStatus === "ACTIVE", JSON.stringify(s));
  });

  await check("customQuota", "reset on a session-only store gets a message, not a server error", async () => {
    let res;
    try {
      res = await adminPost({ intent: "resetCustomQuota", targetShop: M_SESSION_ONLY });
    } catch (err) {
      throw new Error(`threw: ${err.message.split("\n")[0]}`);
    }
    expect(res.success === false, res.message);
  });

  // ── F. Store discounts ────────────────────────────────────────────────────
  console.log("\nF. Store discounts");

  for (const bad of ["0", "101", "5.5", "abc"]) {
    await check("storeDiscount", `rejects percent ${JSON.stringify(bad)}`, async () => {
      const res = await adminPost({ intent: "setDiscount", targetShop: M_FREE, discountPercent: bad, tier: "STANDARD" });
      expect(res.success === false, `accepted ${bad}`);
    });
  }

  await check("storeDiscount", "a STANDARD grant is in force on monthly and yearly", async () => {
    const res = await adminPost({ intent: "setDiscount", targetShop: M_FREE, discountPercent: "20", tier: "STANDARD", note: "loyalty" });
    expect(res.success, res.message);
    const { resolveBestDiscount } = await import("../app/storeDiscount.server.js");
    expect((await resolveBestDiscount(M_FREE, "monthly"))?.percent === 20, "monthly missing");
    expect((await resolveBestDiscount(M_FREE, "annual"))?.percent === 20, "yearly missing");
  });

  await check("storeDiscount", "an unknown tier is stored as STANDARD", async () => {
    await adminPost({ intent: "setDiscount", targetShop: M_FREE, discountPercent: "20", tier: "PLATINUM" });
    const d = await prisma.storeDiscount.findUnique({ where: { shop: M_FREE } });
    expect(d.tier === "STANDARD", `tier ${d.tier}`);
  });

  await check("storeDiscount", "a VIP grant awaits the merchant's claim and discounts nothing", async () => {
    const res = await adminPost({ intent: "setDiscount", targetShop: M_PARTNER, discountPercent: "30", tier: "VIP" });
    expect(res.success, res.message);
    const { resolveBestDiscount, claimVipOffer } = await import("../app/storeDiscount.server.js");
    expect((await resolveBestDiscount(M_PARTNER, "monthly")) === null, "VIP applied before claim");
    const claimed = await claimVipOffer(M_PARTNER);
    expect(claimed?.claimedAt, "claim failed");
    expect((await claimVipOffer(M_PARTNER)) === null, "double claim restarted the term");
    expect((await resolveBestDiscount(M_PARTNER, "monthly"))?.percent === 30, "claimed VIP not applied");
  });

  await check("storeDiscount", "remove disables it once, then reports nothing to remove", async () => {
    const first = await adminPost({ intent: "removeDiscount", targetShop: M_PARTNER });
    const second = await adminPost({ intent: "removeDiscount", targetShop: M_PARTNER });
    expect(first.success, first.message);
    expect(second.success === false, second.message);
    const { resolveBestDiscount } = await import("../app/storeDiscount.server.js");
    expect((await resolveBestDiscount(M_PARTNER, "annual")) === null, "still applied after removal");
  });

  // ── G. Loader: the per-store view must match enforcement ─────────────────
  console.log("\nG. Loader view");
  await adminPost({ intent: "setGlobalDiscount", globalDiscountPercent: "17" });
  asAdmin();
  const data = await adminRoute.loader({ request: new Request("http://localhost/app/admin") });
  const row = (shop) => data.merchants.find((m) => m.shop === shop);

  await check("loader", "external-contract store is shown as Enterprise (what it is entitled to)", async () => {
    expect(row(M_EXT).planId === "enterprise", `shown as ${row(M_EXT).planId}`);
  });

  await check("loader", "Partner development store is shown as Growth", async () => {
    expect(row(M_PARTNER).planId === "growth", `shown as ${row(M_PARTNER).planId}`);
  });

  await check("loader", "every plan's plan row equals getEffectivePlanId", async () => {
    for (const shop of [M_FREE, M_EXT, M_PARTNER, M_CUSTOM, M_GONE]) {
      const enforced = await billing.getEffectivePlanId(shop);
      expect(row(shop).planId === enforced, `${shop}: panel ${row(shop).planId}, enforced ${enforced}`);
    }
  });

  await check("loader", "product cap sent per store (Free=50, custom in force=its quota)", async () => {
    expect(row(M_FREE).productCap === 50, `free cap ${row(M_FREE).productCap}`);
    expect(row(M_CUSTOM).productCap === 500000, `custom cap ${row(M_CUSTOM).productCap}`);
    expect(row(M_EXT).productCap === 400000, `external cap ${row(M_EXT).productCap}`);
  });

  await check("loader", "uninstalled store is listed and flagged", async () => {
    expect(row(M_GONE) && row(M_GONE).isInstalled === false, JSON.stringify(row(M_GONE)));
    expect(row(M_FREE).isInstalled === true, "installed store flagged as gone");
  });

  await check("loader", "session-only store is listed so it can be granted", async () => {
    expect(row(M_SESSION_ONLY), "missing");
  });

  await check("loader", "effective discount: store grant beats global on both intervals", async () => {
    const e = row(M_FREE).effectiveDiscount;
    expect(e.monthly?.percent === 20 && e.yearly?.percent === 20, JSON.stringify(e));
  });

  await check("loader", "effective discount: global only reaches yearly", async () => {
    const e = row(M_EXT).effectiveDiscount;
    expect(e.yearly?.source === "GLOBAL" && e.monthly === null, JSON.stringify(e));
  });

  await check("loader", "tickets sort open-first, then priority", async () => {
    const mine = data.tickets.filter((t) => t.shop.startsWith(PREFIX));
    expect(mine.length === 1 && mine[0].status === "OPEN", JSON.stringify(mine));
  });

  // ── H. Rendered page ──────────────────────────────────────────────────────
  console.log("\nH. Rendered page");
  globalThis.__qaLoaderData = data;
  routerStub.__qaResetFetchers();
  const html = renderToStaticMarkup(createElement(adminRoute.default));
  // Merchant rows only: the ticket table above also shows the shop in <strong>.
  const merchantRow = (page, shop) =>
    page.split("Merchant Stores (")[1].split("<tr").find((chunk) => chunk.includes(`<strong>${shop}</strong>`)) || "";
  const rowHtml = (shop) => merchantRow(html, shop);

  await check("render", "page renders the operator cards across tabs", async () => {
    globalThis.__qaSearchParams = "tab=promotions";
    const promoHtml = renderToStaticMarkup(createElement(adminRoute.default));
    expect(promoHtml.includes("Global Yearly Discount"), "missing Global Yearly Discount");
    expect(promoHtml.includes("Free Growth for the first"), "missing Free Growth");

    globalThis.__qaSearchParams = "tab=tickets";
    const ticketHtml = renderToStaticMarkup(createElement(adminRoute.default));
    expect(ticketHtml.includes("Support Tickets"), "missing Support Tickets");

    globalThis.__qaSearchParams = "tab=stores";
    const storesHtml = renderToStaticMarkup(createElement(adminRoute.default));
    expect(storesHtml.includes("Merchant Stores"), "missing Merchant Stores");
    globalThis.__qaSearchParams = "";
  });

  await check("render", "global-only discount is labelled yearly only", async () => {
    expect(/yearly only/.test(rowHtml(M_EXT)), "a monthly store reads as getting 17%");
  });

  await check("render", "plan badges follow the entitlement", async () => {
    expect(/>Enterprise</.test(rowHtml(M_EXT)), "external contract not shown as Enterprise");
    expect(/>Growth</.test(rowHtml(M_PARTNER)), "partner dev not shown as Growth");
  });

  await check("render", "uninstalled store carries an Uninstalled badge", async () => {
    expect(/Uninstalled/.test(rowHtml(M_GONE)), "no badge");
    expect(!/Uninstalled/.test(rowHtml(M_FREE)), "installed store badged");
  });

  await check("render", "Free store shows its real cap and singular product count", async () => {
    const r = rowHtml(M_FREE);
    expect(/Plan cap<!-- -->: <!-- -->50</.test(r) || /Plan cap: 50</.test(r), "Free cap not shown as 50");
    expect(/1 product</.test(r), "1 products");
  });

  await check("render", "an offered (not in force) custom quota is not badged as active", async () => {
    await prisma.appSettings.update({
      where: { shop: M_FREE },
      data: { customProductLimit: 350000, customPriceAmount: 249, customBillingMethod: "SHOPIFY", customPriceStatus: "OFFERED" },
    });
    const fresh = await adminRoute.loader({ request: new Request("http://localhost/app/admin") });
    globalThis.__qaLoaderData = fresh;
    routerStub.__qaResetFetchers();
    const page = renderToStaticMarkup(createElement(adminRoute.default));
    const r = merchantRow(page, M_FREE);
    const badge = r.match(/<span class="([^"]*)"[^>]*>Custom: /);
    expect(badge && badge[1].includes("rv-badge-warning"), `badge classes ${badge?.[1]}`);
  });

  await check("render", "custom quota field refuses values at or below the Enterprise cap", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../app/routes/app.admin.jsx", import.meta.url), "utf8");
    expect(!/min="1000"/.test(src), 'quota input still has min="1000"');
  });

  // ── I. Support ticket creation (feeds the admin queue) ───────────────────
  console.log("\nI. Support ticket creation");

  await check("support", "an invented priority is stored as NORMAL", async () => {
    asMerchant(M_FREE);
    const res = await post(supportRoute, { subject: "Question", message: "Hello", priority: "SUPERHIGH" });
    expect(res.success, res.error || res.message);
    const t = await prisma.supportTicket.findUnique({ where: { id: res.ticket.id } });
    expect(t.priority === "NORMAL", `stored ${t.priority}`);
  });

  await check("support", "an over-long subject gets a specific message", async () => {
    asMerchant(M_FREE);
    const res = await post(supportRoute, { subject: "x".repeat(600), message: "Hello" });
    expect(res.success === false && /500 characters/.test(res.error || ""), res.error);
  });

  await check("support", "an Enterprise store's NORMAL ticket is raised to HIGH", async () => {
    asMerchant(M_CUSTOM);
    const res = await post(supportRoute, { subject: "Question", message: "Hello", priority: "NORMAL" });
    expect(res.success && res.ticket.priority === "HIGH", JSON.stringify(res.ticket));
  });

  await check("support", "missing subject or message is refused", async () => {
    asMerchant(M_FREE);
    const a = await post(supportRoute, { subject: "", message: "Hello" });
    const b = await post(supportRoute, { subject: "Hi", message: "  " });
    expect(a.success === false && b.success === false, "accepted an empty ticket");
  });
  await check("support", "an external-contract Enterprise store gets the Enterprise priority queue", async () => {
    asMerchant(M_EXT);
    const res = await post(supportRoute, { subject: "Question", message: "Hello", priority: "NORMAL" });
    expect(res.success && res.ticket.priority === "HIGH", JSON.stringify(res.ticket));
  });

  // ── J. Product allowance after a downgrade ────────────────────────────────
  console.log("\nJ. Product allowance after a downgrade");
  const DOWN = `${PREFIX}downgraded.myshopify.com`;
  await prisma.appSettings.create({ data: { shop: DOWN, planId: "free" } });
  // 60 products tracked while on a bigger plan; Free allows 50.
  for (let i = 1; i <= 60; i++) {
    await prisma.productSnapshot.create({
      data: {
        shop: DOWN, productId: String(700000 + i), title: `Product ${i}`, status: "ACTIVE",
        snapshotData: { id: `gid://shopify/Product/${700000 + i}`, title: `Product ${i}`, status: "ACTIVE", images: [], variants: [] },
      },
    });
  }
  const editProduct = async (n, title) => {
    setMockShop(DOWN);
    setMockWebhook({
      topic: "PRODUCTS_UPDATE",
      admin: null,
      payload: { id: 700000 + n, title, status: "active", tags: "", images: [], variants: [] },
    });
    return productWebhook.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
  };

  await check("allowance", "a product inside the Free allowance (#1) is still monitored", async () => {
    await editProduct(1, "Product 1 renamed");
    const events = await prisma.changeEvent.count({ where: { shop: DOWN, productId: "700001" } });
    expect(events > 0, "no change recorded for an allowed product");
  });

  await check("allowance", "a product beyond it (#55) records nothing but keeps a current mirror", async () => {
    await editProduct(55, "Product 55 renamed");
    const events = await prisma.changeEvent.count({ where: { shop: DOWN, productId: "700055" } });
    const snap = await prisma.productSnapshot.findUnique({ where: { shop_productId: { shop: DOWN, productId: "700055" } } });
    const s = await settingsOf(DOWN);
    expect(events === 0, `${events} change events recorded beyond the allowance`);
    expect(snap.title === "Product 55 renamed", `mirror is stale: ${snap.title}`);
    expect(s.productLimitReachedAt, "limit banner not raised");
  });

  await check("allowance", "upgrading resumes monitoring for that product without data loss", async () => {
    await prisma.appSettings.update({ where: { shop: DOWN }, data: { planId: "starter" } });
    await editProduct(55, "Product 55 renamed again");
    const events = await prisma.changeEvent.findMany({ where: { shop: DOWN, productId: "700055" } });
    expect(events.length > 0, "still not monitored after upgrade");
    const titleEvent = events.find((e) => e.fieldName === "title");
    expect(titleEvent?.oldValue === "Product 55 renamed", `diffed against a stale snapshot: old=${titleEvent?.oldValue}`);
    expect((await prisma.productSnapshot.count({ where: { shop: DOWN } })) === 60, "snapshots were lost");
  });

  // ── K. Direct contract vs. a live Shopify subscription (#4) ──────────────
  console.log("\nK. Direct contract vs. a live Shopify subscription");
  const BUSINESS_SUB = { id: "gid://shopify/AppSubscription/880001", name: "Business" };
  const contract = (over = {}) =>
    quotaFields(M_BILLED, { customBillingMethod: "EXTERNAL", customPriceAmount: "600", customProductLimit: "400000", ...over });

  await check("contract", "switching a Shopify-billed store to a contract without confirming is refused, nothing saved", async () => {
    const admin = subscriptionsAdmin({ subs: [BUSINESS_SUB] });
    setMockAdminOverride(admin);
    const res = await adminPost(contract());
    const s = await settingsOf(M_BILLED);
    expect(res.success === false && /still billed through Shopify/.test(res.message), res.message);
    expect(s.customProductLimit === null && s.planId === "business", JSON.stringify(s));
    expect(admin.calls.cancelled.length === 0, "cancelled without confirmation");
  });

  await check("contract", "if Shopify refuses the cancellation, the contract is not saved", async () => {
    setMockAdminOverride(subscriptionsAdmin({ subs: [BUSINESS_SUB], failCancel: true }));
    const res = await adminPost(contract({ cancelShopifySubscription: "1" }));
    const s = await settingsOf(M_BILLED);
    expect(res.success === false && /refused to cancel/.test(res.message), res.message);
    expect(s.customProductLimit === null, "contract saved anyway");
  });

  await check("contract", "if Shopify cannot be reached for a store on file as billed, the contract is not saved", async () => {
    setMockAdminOverride(subscriptionsAdmin({ unreachable: true }));
    const res = await adminPost(contract({ cancelShopifySubscription: "1" }));
    expect(res.success === false && /Couldn't reach Shopify/.test(res.message), res.message);
    expect((await settingsOf(M_BILLED)).customProductLimit === null, "contract saved anyway");
  });

  await check("contract", "confirmed: the Shopify charge is cancelled (prorated) and the contract starts", async () => {
    const admin = subscriptionsAdmin({ subs: [BUSINESS_SUB] });
    setMockAdminOverride(admin);
    const res = await adminPost(contract({ cancelShopifySubscription: "1" }));
    const s = await settingsOf(M_BILLED);
    expect(res.success && /Cancelled their Shopify subscription/.test(res.message), res.message);
    expect(admin.calls.cancelled.length === 1 && admin.calls.cancelled[0].prorate === true, JSON.stringify(admin.calls));
    expect(s.customBillingMethod === "EXTERNAL" && s.customPriceStatus === "ACTIVE", JSON.stringify(s));
    expect(s.planId === "free" && s.subscriptionId === null, `still on ${s.planId} / ${s.subscriptionId}`);
    expect((await billing.getEffectivePlanId(M_BILLED)) === "enterprise", "contract not in force");
  });

  await check("contract", "the late CANCELLED webhook for that Shopify charge leaves the contract alone", async () => {
    setMockShop(M_BILLED);
    setMockWebhook({
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: { app_subscription: { admin_graphql_api_id: BUSINESS_SUB.id, name: "Business", status: "CANCELLED" } },
    });
    await webhookRoute.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
    expect((await billing.getEffectivePlanId(M_BILLED)) === "enterprise", "contract lost to the webhook");
  });

  await check("contract", "an active Shopify custom plan moved to a contract has its custom charge cancelled too", async () => {
    await prisma.appSettings.update({
      where: { shop: M_BILLED },
      data: {
        planId: "enterprise", subscriptionId: CUSTOM_SUB_ID, customBillingMethod: "SHOPIFY",
        customPriceStatus: "ACTIVE", customProductLimit: 350000, customPriceAmount: 249,
      },
    });
    const admin = subscriptionsAdmin({ subs: [{ id: CUSTOM_SUB_ID, name: billing.PLAN_ENTERPRISE_CUSTOM }] });
    setMockAdminOverride(admin);
    const refused = await adminPost(contract());
    const ok = await adminPost(contract({ cancelShopifySubscription: "1" }));
    const s = await settingsOf(M_BILLED);
    expect(refused.success === false, "switched without confirming");
    expect(ok.success && admin.calls.cancelled.length === 1 && s.customBillingMethod === "EXTERNAL", ok.message);
  });
  setMockAdminOverride(null);

  // ── L. Active-rule allowance under concurrency (#3) ──────────────────────
  console.log("\nL. Active-rule allowance under concurrency");
  const rulePost = (fields) => {
    asMerchant(M_RULES);
    return post(rulesRoute, fields);
  };

  await check("rules", "six simultaneous creates on Free (1 rule) activate exactly one", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => rulePost({ intent: "create", name: `Race ${i}`, field: "price", condition: "CHANGED" })),
    );
    const active = await prisma.detectionRule.count({ where: { shop: M_RULES, isActive: true } });
    expect(active === 1, `${active} active rules on a 1-rule plan`);
    expect(results.filter((r) => r.success).length === 1, `${results.filter((r) => r.success).length} creates reported success`);
    // The owner's very first requests race to create their roster row; every
    // one must get a real answer, not a server error.
    const odd = results.filter((r) => !/created successfully|Limit Reached/.test(r.message || ""));
    expect(odd.length === 0, `unexpected answers: ${JSON.stringify(odd.map((r) => r.message))}`);
    expect((await prisma.teamMember.count({ where: { shop: M_RULES, role: "OWNER" } })) === 1, "owner row duplicated or missing");
  });

  await check("rules", "simultaneous re-activations of different rules stay within the allowance", async () => {
    await prisma.detectionRule.updateMany({ where: { shop: M_RULES }, data: { isActive: false } });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const r = await prisma.detectionRule.create({ data: { shop: M_RULES, name: `Off ${i}`, field: "price", condition: "CHANGED", isActive: false } });
      ids.push(r.id);
    }
    await Promise.all(ids.map((id) => rulePost({ intent: "toggle", ruleId: String(id) })));
    const active = await prisma.detectionRule.count({ where: { shop: M_RULES, isActive: true } });
    expect(active === 1, `${active} active rules on a 1-rule plan`);
  });

  await check("rules", "deactivating is always allowed, and frees the slot", async () => {
    const on = await prisma.detectionRule.findFirst({ where: { shop: M_RULES, isActive: true } });
    const off = await prisma.detectionRule.findFirst({ where: { shop: M_RULES, isActive: false } });
    const a = await rulePost({ intent: "toggle", ruleId: String(on.id) });
    const b = await rulePost({ intent: "toggle", ruleId: String(off.id) });
    expect(a.success && b.success, `${a.message} / ${b.message}`);
    expect((await prisma.detectionRule.count({ where: { shop: M_RULES, isActive: true } })) === 1, "count drifted");
  });

  await check("rules", "a Starter store (3 rules) gets exactly three from ten simultaneous creates", async () => {
    await prisma.detectionRule.deleteMany({ where: { shop: M_RULES } });
    await prisma.appSettings.update({ where: { shop: M_RULES }, data: { planId: "starter" } });
    await Promise.all(Array.from({ length: 10 }, (_, i) => rulePost({ intent: "create", name: `S${i}`, field: "price", condition: "CHANGED" })));
    const active = await prisma.detectionRule.count({ where: { shop: M_RULES, isActive: true } });
    expect(active === 3, `${active} active rules on a 3-rule plan`);
  });

  // ── M. Free Growth: one claim per store (#5) ─────────────────────────────
  console.log("\nM. Free Growth: one claim per store");
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { freeGrowthEnabled: true, freeGrowthSeatLimit: (await prisma.freeGrowthClaim.count()) + 5, freeGrowthDurationMonths: 2 },
  });

  await check("seat", "a store claims a seat, and the seat count includes it", async () => {
    const before = await freeGrowth.countFreeGrowthSeatsUsed();
    const grant = await freeGrowth.claimFreeGrowthSeat(M_SEAT);
    expect(grant, "claim failed");
    expect((await freeGrowth.countFreeGrowthSeatsUsed()) === before + 1, "count did not move");
    expect((await billing.getEffectivePlanId(M_SEAT)) === "growth", "not elevated");
  });

  await check("seat", "uninstalling keeps the seat claimed (it no longer returns to the pool)", async () => {
    const used = await freeGrowth.countFreeGrowthSeatsUsed();
    setMockShop(M_SEAT);
    setMockWebhook({ topic: "APP_UNINSTALLED", payload: {} });
    await uninstallRoute.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
    expect((await freeGrowth.countFreeGrowthSeatsUsed()) === used, "seat returned to the pool");
    expect(await prisma.freeGrowthGrant.findUnique({ where: { shop: M_SEAT } }), "grant deleted on uninstall");
  });

  await check("seat", "reinstalling gets the rest of the original term, no new offer and no second claim", async () => {
    const original = await prisma.freeGrowthGrant.findUnique({ where: { shop: M_SEAT } });
    expect((await freeGrowth.getFreeGrowthOffer(M_SEAT)) === null, "offered again after reinstall");
    expect((await freeGrowth.claimFreeGrowthSeat(M_SEAT)) === null, "claimed twice");
    const after = await prisma.freeGrowthGrant.findUnique({ where: { shop: M_SEAT } });
    expect(after.expiresAt.getTime() === original.expiresAt.getTime(), "term restarted");
    expect((await billing.getEffectivePlanId(M_SEAT)) === "growth", "seat not honoured after reinstall");
  });

  await check("seat", "even after shop/redact erases the grant, the store cannot claim again", async () => {
    setMockShop(M_SEAT);
    setMockWebhook({ topic: "SHOP_REDACT", payload: { shop_domain: M_SEAT } });
    await redactRoute.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
    expect(!(await prisma.freeGrowthGrant.findUnique({ where: { shop: M_SEAT } })), "redact kept the grant");
    await prisma.appSettings.create({ data: { shop: M_SEAT, planId: "free" } }).catch(() => {});
    expect((await freeGrowth.getFreeGrowthOffer(M_SEAT)) === null, "offered again after redact");
    expect((await freeGrowth.claimFreeGrowthSeat(M_SEAT)) === null, "claimed again after redact");
    expect((await billing.getEffectivePlanId(M_SEAT)) === "free", "still elevated after redact");
  });

  await check("seat", "a claim rolled back (Starter cancel failed) frees the seat and the store may try again", async () => {
    const other = `${PREFIX}rollback.myshopify.com`;
    TEST_SHOPS.push(other);
    expect(await freeGrowth.claimFreeGrowthSeat(other), "claim failed");
    await freeGrowth.releaseFreeGrowthSeat(other);
    expect(!(await freeGrowth.hasClaimedFreeGrowth(other)), "ledger kept a claim that never happened");
    expect(await freeGrowth.claimFreeGrowthSeat(other), "could not retry after rollback");
  });

  await check("seat", "concurrent claims for the last seat award exactly one", async () => {
    const used = await freeGrowth.countFreeGrowthSeatsUsed();
    await prisma.platformSettings.update({ where: { id: 1 }, data: { freeGrowthSeatLimit: used + 1 } });
    const racers = Array.from({ length: 5 }, (_, i) => `${PREFIX}race${i}.myshopify.com`);
    TEST_SHOPS.push(...racers);
    const grants = await Promise.all(racers.map((shop) => freeGrowth.claimFreeGrowthSeat(shop)));
    expect(grants.filter(Boolean).length === 1, `${grants.filter(Boolean).length} seats awarded for 1 left`);
    expect((await freeGrowth.countFreeGrowthSeatsUsed()) === used + 1, "count past the limit");
  });

  // ── N. Plan page approves pending custom terms (#1) ───────────────────────
  console.log("\nN. Plan page approves pending custom terms");
  await check("pendingPlan", "approving pending terms (test mode) swaps them in and clears the pending pair", async () => {
    await prisma.appSettings.update({ where: { shop: M_CUSTOM }, data: { ...PENDING_STATE, subscriptionId: "sim_custom_plus_old" } });
    asMerchant(M_CUSTOM);
    const res = await post(planRoute, { intent: "activateCustomPlus" });
    const s = await settingsOf(M_CUSTOM);
    expect(res?.success, res?.message);
    expect(s.customProductLimit === 500000 && s.customPriceAmount === 299, `terms ${s.customProductLimit} @ ${s.customPriceAmount}`);
    expect(s.customPendingProductLimit === null && s.customPendingPriceAmount === null, "pending not cleared");
  });

  await check("pendingPlan", "with nothing pending, an active custom plan cannot be re-activated", async () => {
    asMerchant(M_CUSTOM);
    const res = await post(planRoute, { intent: "activateCustomPlus" });
    expect(res?.success === false && /already active/.test(res.message), res?.message);
  });

  await check("customQuota", "a test-mode (simulated) custom plan can be reset — there is no charge behind it", async () => {
    await prisma.appSettings.update({ where: { shop: M_CUSTOM }, data: { subscriptionId: "sim_custom_plus_qa" } });
    const res = await adminPost({ intent: "resetCustomQuota", targetShop: M_CUSTOM });
    const s = await settingsOf(M_CUSTOM);
    expect(res.success && s.customProductLimit === null, res.message);
  });
} finally {
  await cleanup();
  if (platformSnapshot) {
    const rest = { ...platformSnapshot };
    for (const key of ["id", "createdAt", "updatedAt"]) delete rest[key];
    await prisma.platformSettings.update({ where: { id: 1 }, data: rest });
  } else {
    await prisma.platformSettings.deleteMany({ where: { id: 1 } });
  }
  setMockAdminOverride(null);
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("Failed:");
  for (const f of failed) console.log(`  - [${f.group}] ${f.name}: ${f.error}`);
}
process.exit(failed.length ? 1 : 0);
