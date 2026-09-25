/**
 * Final QA: plan entitlements, end to end.
 *
 * The expected values below are written from the Plans & Billing cards, not
 * read from PLAN_LIMITS, so a flag that drifts from what the merchant was sold
 * fails here instead of quietly passing against itself.
 *
 *   [A] every plan × every gate, through the server helpers routes call
 *   [B] every way a store's entitlement is raised (free-Growth seat, Partner
 *       dev store, external Enterprise contract, custom quota) and the ways it
 *       must not be (expired seat, OFFERED/CANCELLED quota, unknown plan name)
 *   [C] upgrade / downgrade / interval switch / cancel through getStorePlan,
 *       including the cases that must never downgrade (API error, unknown name)
 *   [D] allowance edges: restore points (manual vs automatic), active rules,
 *       rule evaluation after a downgrade, retention pruning
 *   [E] route level: the real loaders and actions, per plan, with a stubbed
 *       Shopify session carrying an account-owner identity
 *
 * Run: node --import ./scratch/_qa_route_register.mjs scratch/test_plan_entitlements_final_qa.mjs
 * Uses only plan-qa-*.myshopify.com shops, cleaned before and after.
 */
import prisma from "../app/db.server.js";
import { setMockShop, setMockSessionExtras } from "./_qa_mock_admin.mjs";
import {
  PLAN_TIERS,
  getEffectivePlanId,
  getEffectiveLimits,
  getStorePlan,
  checkFeatureAccess,
  checkThemeAccess,
  checkVaultAccess,
  checkMarketingBackupAccess,
  checkRuleLimit,
  checkRestorePointLimit,
  normalizePlanId,
} from "../app/billing.server.js";
import { reserveRestorePointSlot, enforceBackupRetentionPolicy } from "../app/backup.server.js";
import { checkDetectionRules } from "../app/monitor.server.js";

// Cloud OAuth state is signed with the app secret, and the settings loader
// (correctly) refuses to run without one. Plain node does not load .env.
process.env.SHOPIFY_API_SECRET ||= "plan-qa-test-secret";

// No test may send a real email, Slack message or storefront probe.
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

const PREFIX = "plan-qa-";
const shopFor = (tag) => `${PREFIX}${tag}.myshopify.com`;

let passed = 0;
const failures = [];
function check(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const where = { shop: { startsWith: PREFIX } };
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: where } }).catch(() => {});
  await prisma.rollbackJob.deleteMany({ where }).catch(() => {});
  await prisma.restorePoint.deleteMany({ where });
  await prisma.changeEvent.deleteMany({ where }).catch(() => {});
  await prisma.incident.deleteMany({ where }).catch(() => {});
  await prisma.detectionRule.deleteMany({ where });
  await prisma.freeGrowthGrant.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.teamMember.deleteMany({ where }).catch(() => {});
  await prisma.uptimeService?.deleteMany({ where }).catch(() => {});
  await prisma.qaRun?.deleteMany({ where }).catch(() => {});
  await prisma.appSettings.deleteMany({ where });
}

async function setPlan(shop, planId, extra = {}) {
  await prisma.appSettings.upsert({
    where: { shop },
    create: { shop, planId, ...extra },
    update: { planId, ...extra },
  });
}

// ── The plan cards, as sold ──────────────────────────────────────────────────
const INF = Infinity;
const SPEC = {
  free: {
    price: 0, yearly: 0,
    products: 50, restorePoints: 2, rules: 1, retentionDays: 7, vaultOrders: 0, marketingProfiles: 0, themeLimit: 0,
    on: [],
  },
  starter: {
    price: 9, yearly: 108,
    products: 1000, restorePoints: 10, rules: 3, retentionDays: 30, vaultOrders: 0, marketingProfiles: 0, themeLimit: 0,
    on: ["uptimeMonitoring", "qaSuites", "ga4Monitoring", "teamRoles", "cloudSync"],
  },
  growth: {
    price: 24, yearly: 288,
    products: 5000, restorePoints: 50, rules: 10, retentionDays: 90, vaultOrders: 2500, marketingProfiles: 10000, themeLimit: 1,
    on: ["uptimeMonitoring", "qaSuites", "ga4Monitoring", "teamRoles", "cloudSync",
      "bulkRollback", "metafieldBackup", "marketingBackup", "themes"],
  },
  business: {
    price: 49, yearly: 588,
    products: 30000, restorePoints: 100, rules: INF, retentionDays: 180, vaultOrders: 15000, marketingProfiles: 50000, themeLimit: INF,
    on: ["uptimeMonitoring", "qaSuites", "ga4Monitoring", "teamRoles", "cloudSync",
      "bulkRollback", "metafieldBackup", "marketingBackup", "themes",
      "marketingFlows", "circuitBreaker", "slack"],
  },
  enterprise: {
    price: 99, yearly: 990,
    products: 200000, restorePoints: INF, rules: INF, retentionDays: 365, vaultOrders: 100000, marketingProfiles: 250000, themeLimit: INF,
    on: ["uptimeMonitoring", "qaSuites", "ga4Monitoring", "teamRoles", "cloudSync",
      "bulkRollback", "metafieldBackup", "marketingBackup", "themes",
      "marketingFlows", "circuitBreaker", "slack"],
  },
};
const ALL_FLAGS = [
  "uptimeMonitoring", "qaSuites", "ga4Monitoring", "teamRoles", "cloudSync", "bulkRollback",
  "metafieldBackup", "marketingBackup", "themes", "marketingFlows", "circuitBreaker", "slack",
];
const PLANS = Object.keys(SPEC);

// ── [A] Matrix ───────────────────────────────────────────────────────────────
async function partA() {
  console.log("\n[A] Every plan × every gate");
  for (const plan of PLANS) {
    const shop = shopFor(`a-${plan}`);
    await setPlan(shop, plan);
    const spec = SPEC[plan];

    check(`${plan}: price $${spec.price}/mo, $${spec.yearly}/yr`,
      PLAN_TIERS[plan].monthlyPrice === spec.price && PLAN_TIERS[plan].yearlyPrice === spec.yearly,
      `${PLAN_TIERS[plan].monthlyPrice}/${PLAN_TIERS[plan].yearlyPrice}`);
    check(`${plan}: effective plan is itself`, (await getEffectivePlanId(shop)) === plan);

    const limits = await getEffectiveLimits(shop);
    for (const key of ["products", "restorePoints", "rules", "retentionDays", "vaultOrders", "marketingProfiles"]) {
      check(`${plan}: ${key} = ${spec[key]}`, limits[key] === spec[key], `got ${limits[key]}`);
    }

    const wrong = [];
    for (const flag of ALL_FLAGS) {
      const expected = spec.on.includes(flag);
      const got = (await checkFeatureAccess(shop, flag)).allowed;
      if (got !== expected) wrong.push(`${flag}: expected ${expected}, got ${got}`);
    }
    check(`${plan}: all ${ALL_FLAGS.length} capability gates match the card`, wrong.length === 0, wrong.join("; "));

    const theme = await checkThemeAccess(shop);
    check(`${plan}: theme access ${spec.on.includes("themes")} / limit ${spec.themeLimit}`,
      theme.allowed === spec.on.includes("themes") && theme.themeLimit === spec.themeLimit &&
        theme.unlimitedThemes === (spec.themeLimit === INF),
      JSON.stringify(theme));

    const vault = await checkVaultAccess(shop);
    check(`${plan}: vault ${spec.vaultOrders > 0 ? spec.vaultOrders : "locked"}`,
      vault.allowed === spec.vaultOrders > 0 && vault.maxOrders === spec.vaultOrders, JSON.stringify(vault));

    const mkt = await checkMarketingBackupAccess(shop);
    check(`${plan}: marketing backup ${mkt.allowed}, flows ${mkt.flowsIncluded}`,
      mkt.allowed === spec.on.includes("marketingBackup") &&
        mkt.flowsIncluded === spec.on.includes("marketingFlows") &&
        mkt.maxProfiles === spec.marketingProfiles, JSON.stringify(mkt));

    const rl = await checkRuleLimit(shop);
    const rp = await checkRestorePointLimit(shop);
    check(`${plan}: empty store may add a rule and a restore point`, rl.allowed && rp.allowed);
  }

  check("every plan above Free costs more than the one below it",
    PLANS.every((p, i) => i === 0 || PLAN_TIERS[p].monthlyPrice > PLAN_TIERS[PLANS[i - 1]].monthlyPrice));
  check("every capability on a plan is also on every plan above it",
    PLANS.every((p, i) => i === 0 || SPEC[PLANS[i - 1]].on.every((f) => SPEC[p].on.includes(f))));
}

// ── [B] Elevation sources ────────────────────────────────────────────────────
async function partB() {
  console.log("\n[B] Entitlement elevation and its limits");
  const future = new Date(Date.now() + 30 * 86400000);
  const past = new Date(Date.now() - 86400000);

  const cases = [
    { tag: "seat-free", plan: "free", grant: future, expect: "growth" },
    { tag: "seat-starter", plan: "starter", grant: future, expect: "growth" },
    { tag: "seat-business", plan: "business", grant: future, expect: "business" },
    { tag: "seat-expired", plan: "free", grant: past, expect: "free" },
    { tag: "partner-free", plan: "free", extra: { isPartnerDevelopment: true }, expect: "growth" },
    { tag: "partner-enterprise", plan: "enterprise", extra: { isPartnerDevelopment: true }, expect: "enterprise" },
    { tag: "external-active", plan: "free", extra: { customBillingMethod: "EXTERNAL", customPriceStatus: "ACTIVE", customProductLimit: 400000 }, expect: "enterprise" },
    { tag: "external-cancel", plan: "free", extra: { customBillingMethod: "EXTERNAL", customPriceStatus: "CANCELLED", customProductLimit: 400000 }, expect: "free" },
    { tag: "unknown-name", plan: "platinum", expect: "free" },
    { tag: "legacy-pro", plan: "pro", expect: "growth" },
  ];
  for (const c of cases) {
    const shop = shopFor(`b-${c.tag}`);
    await setPlan(shop, c.plan, c.extra || {});
    if (c.grant) {
      await prisma.freeGrowthGrant.upsert({
        where: { shop }, create: { shop, expiresAt: c.grant }, update: { expiresAt: c.grant },
      });
    }
    const eff = await getEffectivePlanId(shop);
    check(`${c.tag}: stored ${c.plan} → entitled ${c.expect}`, eff === c.expect, `got ${eff}`);
    // The gates must agree with the plan they report.
    const theme = (await checkFeatureAccess(shop, "themes")).allowed;
    check(`${c.tag}: gates follow the entitlement (themes ${SPEC[c.expect].on.includes("themes")})`,
      theme === SPEC[c.expect].on.includes("themes"));
  }

  const quota = [
    { tag: "quota-active-ent", plan: "enterprise", status: "ACTIVE", expect: 400000 },
    { tag: "quota-offered-ent", plan: "enterprise", status: "OFFERED", expect: 200000 },
    { tag: "quota-cancel-ent", plan: "enterprise", status: "CANCELLED", expect: 200000 },
    { tag: "quota-active-growth", plan: "growth", status: "ACTIVE", expect: 5000 },
  ];
  for (const q of quota) {
    const shop = shopFor(`b-${q.tag}`);
    await setPlan(shop, q.plan, { customProductLimit: 400000, customPriceStatus: q.status, customBillingMethod: "SHOPIFY" });
    const limits = await getEffectiveLimits(shop);
    check(`${q.tag}: product cap ${q.expect}`, limits.products === q.expect, `got ${limits.products}`);
  }

  check("normalizePlanId trims and lowercases", normalizePlanId("  Business ") === "business");
  check("normalizePlanId(null) is free", normalizePlanId(null) === "free");
}

// ── [C] Billing transitions ──────────────────────────────────────────────────
function billingReturning(subs, { throws = false } = {}) {
  return {
    check: async () => {
      if (throws) throw new Error("Shopify 503");
      return { hasActivePayment: subs.length > 0, appSubscriptions: subs };
    },
  };
}
const sub = (name, extra = {}) => ({ id: `gid://shopify/AppSubscription/${name.length}${Math.round(Math.random() * 1e6)}`, name, status: "ACTIVE", trialDays: 0, createdAt: new Date().toISOString(), lineItems: [], ...extra });

async function partC() {
  console.log("\n[C] Upgrade / downgrade / cancel through getStorePlan");
  const shop = shopFor("c-transitions");
  await setPlan(shop, "free");

  let r = await getStorePlan(shop, billingReturning([sub("Starter")]));
  check("free → Starter: entitled starter", r.currentPlan === "starter" && r.limits.restorePoints === 10);
  check("free → Starter: stored plan updated", (await prisma.appSettings.findUnique({ where: { shop } })).planId === "starter");

  r = await getStorePlan(shop, billingReturning([sub("Business (Annual)")]));
  const row = await prisma.appSettings.findUnique({ where: { shop } });
  check("Starter → Business annual: entitled business", r.currentPlan === "business" && r.limits.slack === true);
  check("Starter → Business annual: interval ANNUAL stored", row.billingInterval === "ANNUAL" && r.billingInterval === "ANNUAL");

  r = await getStorePlan(shop, billingReturning([sub("Growth")]));
  check("Business → Growth (downgrade): entitled growth, Slack/circuit breaker gone",
    r.currentPlan === "growth" && !r.limits.slack && !r.limits.circuitBreaker && r.limits.themeLimit === 1);
  check("Business → Growth: interval back to monthly",
    (await prisma.appSettings.findUnique({ where: { shop } })).billingInterval === "EVERY_30_DAYS");
  check("after downgrade, server gates agree (Slack denied)", !(await checkFeatureAccess(shop, "slack")).allowed);

  r = await getStorePlan(shop, billingReturning([], { throws: true }));
  check("billing API error never downgrades", r.currentPlan === "growth" &&
    (await prisma.appSettings.findUnique({ where: { shop } })).planId === "growth");

  r = await getStorePlan(shop, billingReturning([sub("Revertly Mega Plan")]));
  check("unrecognised active subscription never downgrades", r.currentPlan === "growth");

  r = await getStorePlan(shop, billingReturning([]));
  check("cancelled (no active payment) → Free", r.currentPlan === "free" &&
    (await prisma.appSettings.findUnique({ where: { shop } })).planId === "free");
  check("after cancel, Starter-tier gates are closed", !(await checkFeatureAccess(shop, "uptimeMonitoring")).allowed);

  // A simulated test-mode plan is not reconciled against Shopify.
  const sim = shopFor("c-simulated");
  await setPlan(sim, "business", { subscriptionId: "sim_business_1" });
  r = await getStorePlan(sim, billingReturning([]));
  check("simulated subscription is not downgraded by an empty billing check", r.currentPlan === "business");

  // Free-Growth seat on top of a cancelled plan, then expiry.
  const seat = shopFor("c-seat");
  await setPlan(seat, "free");
  await prisma.freeGrowthGrant.create({ data: { shop: seat, expiresAt: new Date(Date.now() + 86400000) } });
  r = await getStorePlan(seat, billingReturning([]));
  check("seat: Growth entitlement, paid plan Free", r.currentPlan === "growth" && r.paidPlan === "free" && r.freeGrowth?.isActive);
  r = await getStorePlan(seat, billingReturning([sub("Enterprise")]));
  check("seat superseded by Enterprise", r.currentPlan === "enterprise" && r.freeGrowth?.supersededByPaidPlan);
  await getStorePlan(seat, billingReturning([]));
  await prisma.freeGrowthGrant.update({ where: { shop: seat }, data: { expiresAt: new Date(Date.now() - 1000) } });
  r = await getStorePlan(seat, billingReturning([]));
  check("seat expired: back to Free everywhere", r.currentPlan === "free" && (await getEffectivePlanId(seat)) === "free");

  // Custom Enterprise Plus: only the dedicated subscription accepts the offer.
  const custom = shopFor("c-custom");
  await setPlan(custom, "free", { customProductLimit: 500000, customPriceStatus: "OFFERED", customBillingMethod: "SHOPIFY" });
  r = await getStorePlan(custom, billingReturning([sub("Enterprise")]));
  check("standard Enterprise does not activate a custom offer", r.limits.products === 200000 &&
    (await prisma.appSettings.findUnique({ where: { shop: custom } })).customPriceStatus === "OFFERED");
  r = await getStorePlan(custom, billingReturning([sub("Enterprise Plus (Custom)")]));
  check("Enterprise Plus (Custom) activates the quota", r.limits.products === 500000 && r.isCustomSubscription);
  r = await getStorePlan(custom, billingReturning([sub("Business")]));
  check("switching to Business cancels the custom quota", r.limits.products === 30000 &&
    (await prisma.appSettings.findUnique({ where: { shop: custom } })).customPriceStatus === "CANCELLED");
}

// ── [D] Allowance edges ──────────────────────────────────────────────────────
async function partD() {
  console.log("\n[D] Allowances at the boundary");
  const shop = shopFor("d-free");
  await setPlan(shop, "free");
  const mk = (source, name, extra = {}) =>
    prisma.restorePoint.create({ data: { shop, source, name, status: "READY", backupType: "PRODUCTS", ...extra } });

  await mk("SCHEDULED", "auto 1");
  await mk("SCHEDULED", "auto 2");
  let lim = await checkRestorePointLimit(shop);
  check("Free with 2 automatic points: a manual one is still allowed", lim.allowed, JSON.stringify(lim));
  let slot = await reserveRestorePointSlot(shop, { source: "MANUAL" });
  check("reserving a manual slot rotates the oldest automatic point", slot.allowed && slot.rotated === 1, JSON.stringify(slot));
  await mk("MANUAL", "mine 1");
  await mk("MANUAL", "mine 2");
  await prisma.restorePoint.deleteMany({ where: { shop, source: "SCHEDULED" } });
  lim = await checkRestorePointLimit(shop);
  check("Free with 2 manual points: full", !lim.allowed);
  slot = await reserveRestorePointSlot(shop, { source: "SCHEDULED" });
  check("a scheduled backup never deletes the merchant's own points", !slot.allowed &&
    (await prisma.restorePoint.count({ where: { shop, source: "MANUAL" } })) === 2);
  slot = await reserveRestorePointSlot(shop, { source: "PRE_RESTORE" });
  check("a pre-restore safety point is always allowed", slot.allowed);

  // Upgrade lifts the ceiling at once.
  await setPlan(shop, "starter");
  check("upgrade to Starter: allowed again immediately", (await checkRestorePointLimit(shop)).allowed);

  // Rules: allowance on active rules, evaluation capped after downgrade.
  const rshop = shopFor("d-rules");
  await setPlan(rshop, "business");
  for (let i = 0; i < 4; i++) {
    await prisma.detectionRule.create({
      data: { shop: rshop, name: `rule ${i}`, field: "price", condition: "CHANGED", isActive: true, severity: "HIGH" },
    });
  }
  check("Business: 4 active rules, more allowed", (await checkRuleLimit(rshop)).allowed);
  await setPlan(rshop, "starter");
  const rl = await checkRuleLimit(rshop);
  check("downgrade to Starter: cannot add/activate a 4th… 5th rule", !rl.allowed && rl.limit === 3);
  // Evaluation must only consider the first 3 active rules; a matching change
  // on the 4th rule's field alone must not raise an incident.
  const fourth = await prisma.detectionRule.findFirst({ where: { shop: rshop }, orderBy: { id: "desc" } });
  await prisma.detectionRule.update({ where: { id: fourth.id }, data: { field: "vendor" } });
  const inc = await checkDetectionRules(rshop, [
    { productId: "1", productTitle: "x", fieldName: "vendor", oldValue: "a", newValue: "b" },
  ]).catch((e) => ({ error: e.message }));
  check("downgraded store: rules beyond the allowance are not evaluated", !inc || inc.error === undefined && !inc.id,
    JSON.stringify(inc)?.slice(0, 160));

  // Retention: never prune a point that is mid-restore.
  const ret = shopFor("d-retention");
  await setPlan(ret, "free");
  const old = new Date(Date.now() - 40 * 86400000);
  const restoring = await prisma.restorePoint.create({ data: { shop: ret, source: "MANUAL", name: "old restoring", status: "RESTORING", backupType: "PRODUCTS", createdAt: old } });
  const creating = await prisma.restorePoint.create({ data: { shop: ret, source: "SCHEDULED", name: "old creating", status: "CREATING", backupType: "PRODUCTS", createdAt: old } });
  const expired = await prisma.restorePoint.create({ data: { shop: ret, source: "SCHEDULED", name: "old ready", status: "READY", backupType: "PRODUCTS", createdAt: old } });
  for (let i = 0; i < 2; i++) {
    await prisma.restorePoint.create({ data: { shop: ret, source: "MANUAL", name: `new ${i}`, status: "READY", backupType: "PRODUCTS" } });
  }
  const res = await enforceBackupRetentionPolicy(ret);
  const left = new Set((await prisma.restorePoint.findMany({ where: { shop: ret }, select: { id: true } })).map((r) => r.id));
  check("retention prunes an expired READY point", !left.has(expired.id), JSON.stringify(res));
  check("retention never deletes a point that is being restored", left.has(restoring.id));
  check("retention never deletes a point that is still being captured", left.has(creating.id));
}

// ── [E] Routes ───────────────────────────────────────────────────────────────
function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}
const post = (path, fields) => new Request(`http://localhost${path}`, { method: "POST", body: form(fields) });
const get = (path) => new Request(`http://localhost${path}`);

async function callRoute(fn, request, params = {}) {
  try {
    const out = await fn({ request, params });
    if (out instanceof Response) return { status: out.status, body: await out.text().catch(() => "") };
    return out;
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, thrown: true, body: await thrown.text().catch(() => "") };
    return { crashed: thrown?.message || String(thrown) };
  }
}

async function partE() {
  console.log("\n[E] Route-level gates, per plan");
  const qa = await import("../app/routes/app.qa.jsx");
  const team = await import("../app/routes/app.team.jsx");
  const monitoring = await import("../app/routes/app.monitoring.jsx");
  const vault = await import("../app/routes/app.vault.jsx");
  const settings = await import("../app/routes/app.settings.jsx");
  const marketing = await import("../app/routes/app.marketing.jsx");
  const rps = await import("../app/routes/app.restore-points.jsx");
  const rules = await import("../app/routes/app.rules.jsx");
  const appShell = await import("../app/routes/app.jsx");

  const denied = (r) => r && r.success === false && typeof r.message === "string" && /plan|upgrade|growth|starter|business/i.test(r.message);

  for (const plan of PLANS) {
    const shop = shopFor(`e-${plan}`);
    setMockShop(shop);
    setMockSessionExtras({
      onlineAccessInfo: { associated_user: { email: `owner@${PREFIX}${plan}.test`, account_owner: true, first_name: "Q", last_name: "A" } },
    });
    await setPlan(shop, plan);
    const spec = SPEC[plan];
    const has = (f) => spec.on.includes(f);
    console.log(`  — ${plan}`);

    const shell = await callRoute(appShell.loader, get("/app"));
    check(`${plan}: app shell reports plan tier ${plan}`, shell?.planTier === plan, JSON.stringify(shell?.planTier ?? shell));

    // QA suites (Starter+)
    const qaL = await callRoute(qa.loader, get("/app/qa"));
    check(`${plan}: QA page locked=${!has("qaSuites")}`, qaL?.locked === !has("qaSuites"), JSON.stringify(qaL)?.slice(0, 120));
    if (!has("qaSuites")) {
      const qaA = await callRoute(qa.action, post("/app/qa", { intent: "run" }));
      check(`${plan}: QA run refused by the server`, denied(qaA), JSON.stringify(qaA)?.slice(0, 160));
    }

    // Team roles (Starter+)
    const teamL = await callRoute(team.loader, get("/app/team"));
    check(`${plan}: team page locked=${!has("teamRoles")}`, teamL?.teamLocked === !has("teamRoles"), JSON.stringify(teamL)?.slice(0, 120));
    const inv = await callRoute(team.action, post("/app/team", { intent: "invite", email: `staff-${plan}@example.com`, role: "VIEWER" }));
    check(`${plan}: invite ${has("teamRoles") ? "accepted" : "refused"}`,
      has("teamRoles") ? inv?.success === true : denied(inv), JSON.stringify(inv)?.slice(0, 160));

    // Uptime monitoring (Starter+)
    const monL = await callRoute(monitoring.loader, get("/app/monitoring"));
    check(`${plan}: monitoring uptimeLocked=${!has("uptimeMonitoring")}`, monL?.uptimeLocked === !has("uptimeMonitoring"), JSON.stringify(monL)?.slice(0, 120));
    if (!has("uptimeMonitoring")) {
      const add = await callRoute(monitoring.action, post("/app/monitoring", { intent: "add", name: "x", url: "https://example.com" }));
      check(`${plan}: adding an uptime service refused by the server`, denied(add), JSON.stringify(add)?.slice(0, 160));
    }

    // Vault (Growth+)
    const vL = await callRoute(vault.loader, get("/app/vault"));
    check(`${plan}: vault loader maxOrders/locked follows plan`,
      has("themes") ? vL?.maxOrders === spec.vaultOrders : vL && !vL.crashed && vL.maxOrders !== spec.vaultOrders + 1,
      JSON.stringify(vL)?.slice(0, 160));
    if (spec.vaultOrders === 0) {
      const vs = await callRoute(vault.action, post("/app/vault", { intent: "sync_all" }));
      check(`${plan}: vault sync refused by the server`, denied(vs), JSON.stringify(vs)?.slice(0, 160));
    }

    // Settings: Slack / circuit breaker (Business+), cloud (Starter+)
    const sL = await callRoute(settings.loader, get("/app/settings"));
    check(`${plan}: settings flags slack=${has("slack")} cb=${has("circuitBreaker")} cloud=${has("cloudSync")}`,
      sL?.hasSlackAccess === has("slack") && sL?.hasCircuitBreakerAccess === has("circuitBreaker") && sL?.hasCloudSyncAccess === has("cloudSync"),
      JSON.stringify({ s: sL?.hasSlackAccess, c: sL?.hasCircuitBreakerAccess, k: sL?.hasCloudSyncAccess, e: sL?.crashed }));
    check(`${plan}: settings loader sends no cloud token to the browser`,
      !JSON.stringify(sL || {}).match(/cloudSyncAccessToken|cloudSyncRefreshToken|klaviyoApiKey|mailchimpApiKey/));
    if (!has("slack")) {
      const ts = await callRoute(settings.action, post("/app/settings", { intent: "testSlack", slackWebhookUrl: "https://hooks.slack.com/services/T/B/X" }));
      check(`${plan}: Slack test refused by the server`, denied(ts), JSON.stringify(ts)?.slice(0, 160));
    }

    // Marketing (Growth+)
    const mL = await callRoute(marketing.loader, get("/app/marketing"));
    check(`${plan}: marketing loader reports plan ${plan}`, mL?.plan === plan, JSON.stringify(mL)?.slice(0, 120));
    if (!has("marketingBackup")) {
      const mb = await callRoute(marketing.action, post("/app/marketing", { intent: "backupAll" }));
      check(`${plan}: marketing capture refused by the server`, mb?.success === false, JSON.stringify(mb)?.slice(0, 160));
    }

    // Restore points hub: theme / metafield gates
    const rL = await callRoute(rps.loader, get("/app/restore-points"));
    check(`${plan}: hub theme=${has("themes")} limit=${spec.themeLimit} metafields=${has("metafieldBackup")}`,
      rL?.hasThemeAccess === has("themes") && rL?.themeLimit === spec.themeLimit && rL?.hasMetafieldAccess === has("metafieldBackup"),
      JSON.stringify({ t: rL?.hasThemeAccess, l: rL?.themeLimit, m: rL?.hasMetafieldAccess, e: rL?.crashed }));
    if (!has("themes")) {
      const bt = await callRoute(rps.action, post("/app/restore-points", { intent: "backupTheme" }));
      check(`${plan}: theme backup refused by the server`, denied(bt), JSON.stringify(bt)?.slice(0, 160));
    }
    if (plan === "growth") {
      // Growth covers the live theme only; the mock store's only theme is MAIN,
      // so a made-up draft id cannot be confirmed and must be refused.
      const draft = await callRoute(rps.action, post("/app/restore-points", { intent: "backupTheme", themeId: "gid://shopify/Theme/777" }));
      check("growth: a non-live theme backup is refused", draft?.success === false, JSON.stringify(draft)?.slice(0, 160));
    }

    // Rules allowance through the action
    let created = 0;
    let lastRes = null;
    for (let i = 0; i < Math.min(spec.rules === INF ? 12 : spec.rules + 1, 12); i++) {
      lastRes = await callRoute(rules.action, post("/app/rules", { intent: "create", name: `r${i}`, field: "price", condition: "CHANGED" }));
      if (lastRes?.success) created++;
    }
    if (spec.rules === INF) {
      check(`${plan}: unlimited rules (12 created)`, created === 12, `created=${created}`);
    } else {
      check(`${plan}: exactly ${spec.rules} active rules, the next refused`, created === spec.rules && lastRes?.success === false,
        `created=${created} last=${JSON.stringify(lastRes)?.slice(0, 120)}`);
    }
  }
  setMockSessionExtras({});
}

async function main() {
  console.log("=".repeat(78));
  console.log("  PLAN ENTITLEMENTS — FINAL QA");
  console.log("=".repeat(78));
  await cleanup();
  try {
    await partA();
    await partB();
    await partC();
    await partD();
    await partE();
  } finally {
    await cleanup();
  }
  console.log("\n" + "=".repeat(78));
  console.log(`  RESULT: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
  console.log("=".repeat(78));
  await prisma.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("HARNESS CRASH:", e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(2);
});
