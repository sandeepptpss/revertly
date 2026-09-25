/**
 * Final QA cycle (2026-09-25): regression cover for the defects fixed in
 * team access, GDPR webhooks, scheduling, restore-point lifecycle, theme
 * restore gating, product restore and the theme-publish webhook.
 *
 * Run: node --import ./scratch/_qa_route_register.mjs scratch/test_final_cycle_fixes_qa.mjs
 * Uses only fcq-*.myshopify.com shops, cleaned before and after.
 */
import prisma from "../app/db.server.js";
import { setMockShop, setMockSessionExtras, setMockWebhook, LIVE } from "./_qa_mock_admin.mjs";
import { computeNextAutoBackup, runScheduledBackupForShop } from "../app/scheduler.server.js";
import {
  reserveRestorePointSlot,
  restoreThemeFilesWithSafety,
  collectLiveProductsForBackup,
  importBackupPayload,
} from "../app/backup.server.js";
import { buildSnapshot, compareSnapshots } from "../app/monitor.server.js";
import { checkPermission, getAlertRecipients, PERMISSIONS } from "../app/team.server.js";

process.env.SHOPIFY_API_SECRET ||= "fcq-test-secret";
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

const PREFIX = "fcq-";
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
  await prisma.productSnapshot.deleteMany({ where });
  await prisma.orderArchive.deleteMany({ where });
  await prisma.customerArchive.deleteMany({ where }).catch(() => {});
  await prisma.marketingProfile.deleteMany({ where }).catch(() => {});
  await prisma.catalogSyncJob.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.teamMember.deleteMany({ where });
  await prisma.session.deleteMany({ where });
  await prisma.jobLock.deleteMany({ where: { name: { startsWith: `theme-publish:${PREFIX}` } } }).catch(() => {});
  await prisma.appSettings.deleteMany({ where });
}

async function setPlan(shop, planId, extra = {}) {
  await prisma.appSettings.upsert({ where: { shop }, create: { shop, planId, ...extra }, update: { planId, ...extra } });
}
const as = (email, owner = false) =>
  setMockSessionExtras({ onlineAccessInfo: { associated_user: { email, account_owner: owner } } });
const post = (path, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request(`http://localhost${path}`, { method: "POST", body: fd });
};

// ── Team: removal must take access away ─────────────────────────────────────
async function teamRemoval() {
  console.log("\n[1] Removing a team member denies them access");
  const team = await import("../app/routes/app.team.jsx");
  const shop = shopFor("team");
  setMockShop(shop);
  await setPlan(shop, "starter");
  const owner = "owner@fcq.test";
  const staff = "staff@fcq.test";

  as(owner, true);
  let r = await team.action({ request: post("/app/team", { intent: "invite", email: staff, role: "EDITOR" }) });
  check("owner invites an editor", r.success, r.message);

  const editorPerm = await checkPermission(shop, { onlineAccessInfo: { associated_user: { email: staff } } }, PERMISSIONS.RESTORE);
  check("editor can restore", editorPerm.allowed && editorPerm.actor.role === "EDITOR", editorPerm.actor?.role);

  const member = await prisma.teamMember.findFirst({ where: { shop, email: staff } });
  r = await team.action({ request: post("/app/team", { intent: "remove", memberId: String(member.id) }) });
  check("owner removes the editor", r.success, r.message);

  for (const permission of [PERMISSIONS.VIEW, PERMISSIONS.RESTORE, PERMISSIONS.SETTINGS_WRITE, PERMISSIONS.TEAM_MANAGE]) {
    const p = await checkPermission(shop, { onlineAccessInfo: { associated_user: { email: staff } } }, permission);
    check(`removed member is refused ${permission} (was: unlisted → ADMIN)`, !p.allowed && p.actor.role === "NONE",
      `${p.actor?.role} ${p.message}`);
  }
  const msg = (await checkPermission(shop, { onlineAccessInfo: { associated_user: { email: staff } } }, PERMISSIONS.VIEW)).message;
  check("removed member is told they were removed", /removed/i.test(msg), msg);

  const loaded = await team.loader({ request: new Request("http://localhost/app/team") });
  check("removed member is not listed", !loaded.members.some((m) => m.email === staff));
  check("removed member gets no alerts", !(await getAlertRecipients(shop, {})).includes(staff));

  r = await team.action({ request: post("/app/team", { intent: "updateRole", memberId: String(member.id), role: "ADMIN" }) });
  check("a removed member cannot be re-roled through the old id", r.success === false, r.message);

  r = await team.action({ request: post("/app/team", { intent: "invite", email: staff, role: "VIEWER" }) });
  check("re-inviting a removed member works", r.success, r.message);
  const back = await checkPermission(shop, { onlineAccessInfo: { associated_user: { email: staff } } }, PERMISSIONS.VIEW);
  check("re-invited member has exactly the new role", back.allowed && back.actor.role === "VIEWER", back.actor?.role);
  const noRestore = await checkPermission(shop, { onlineAccessInfo: { associated_user: { email: staff } } }, PERMISSIONS.RESTORE);
  check("…and nothing more", !noRestore.allowed);

  // The account owner can never be locked out by a stale row.
  const ownerPerm = await checkPermission(shop, { onlineAccessInfo: { associated_user: { email: owner, account_owner: true } } }, PERMISSIONS.BILLING_MANAGE);
  check("account owner keeps billing access", ownerPerm.allowed);
  setMockSessionExtras({});
}

// ── GDPR webhooks ───────────────────────────────────────────────────────────
async function gdpr() {
  console.log("\n[2] GDPR webhooks");
  const redact = await import("../app/routes/webhooks.customers.redact.jsx");
  const shopRedact = await import("../app/routes/webhooks.shop.redact.jsx");
  const shop = shopFor("gdpr");
  setMockShop(shop);
  const pii = { customer: { id: "gid://shopify/Customer/5", displayName: "Pat Phone", email: null, phone: "+15550100" }, shippingAddress: { address1: "1 Main St" } };
  await prisma.orderArchive.create({
    data: { shop, orderId: "7001", orderNumber: "#7001", customerEmail: null, customerName: "Pat Phone", totalPrice: "10.00", orderData: pii },
  });
  await prisma.orderArchive.create({
    data: { shop, orderId: "7002", orderNumber: "#7002", customerEmail: "other@x.test", customerName: "Keep Me", totalPrice: "5.00", orderData: { customer: { displayName: "Keep Me" } } },
  });
  setMockWebhook({ topic: "CUSTOMERS_REDACT", payload: { customer: { id: 5 }, orders_to_redact: [7001] } });
  await redact.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
  const o1 = await prisma.orderArchive.findFirst({ where: { shop, orderId: "7001" } });
  check("phone-only customer's order named in orders_to_redact is scrubbed",
    o1.customerName === "REDACTED_GDPR" && o1.orderData.customer.phone === null && o1.orderData.shippingAddress === null,
    JSON.stringify({ n: o1.customerName, c: o1.orderData.customer }));
  const o2 = await prisma.orderArchive.findFirst({ where: { shop, orderId: "7002" } });
  check("an unrelated order is untouched", o2.customerName === "Keep Me");

  await prisma.catalogSyncJob.create({ data: { shop } });
  setMockWebhook({ topic: "SHOP_REDACT", payload: {} });
  await shopRedact.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
  check("shop/redact removes catalog sync jobs", (await prisma.catalogSyncJob.count({ where: { shop } })) === 0);
  check("shop/redact removes archived orders", (await prisma.orderArchive.count({ where: { shop } })) === 0);
}

// ── Scheduling ──────────────────────────────────────────────────────────────
async function scheduling() {
  console.log("\n[3] Backup scheduling");
  const at = (iso) => new Date(iso);
  const cases = [
    ["TWICE_DAILY", "02:00", "2026-09-25T20:00:00Z", "2026-09-26T02:00:00.000Z"],
    ["TWICE_DAILY", "02:00", "2026-09-25T13:00:00Z", "2026-09-25T14:00:00.000Z"],
    ["TWICE_DAILY", "02:00", "2026-09-25T01:00:00Z", "2026-09-25T02:00:00.000Z"],
    ["TWICE_DAILY", "00:00", "2026-09-25T23:59:00Z", "2026-09-26T00:00:00.000Z"],
    ["DAILY", "02:00", "2026-09-25T20:00:00Z", "2026-09-26T02:00:00.000Z"],
    ["WEEKLY", "02:00", "2026-09-25T20:00:00Z", "2026-10-02T02:00:00.000Z"],
  ];
  for (const [schedule, time, now, expected] of cases) {
    const next = computeNextAutoBackup(schedule, time, at(now));
    check(`${schedule} ${time} from ${now.slice(11, 16)} → ${expected.slice(0, 16)}`, next.toISOString() === expected, next.toISOString());
  }
  // Every computed slot is in the future, at every minute-of-day for twice-daily.
  let past = 0;
  for (let m = 0; m < 24 * 60; m += 7) {
    const now = new Date(Date.UTC(2026, 8, 25, 0, m));
    for (const slot of ["00:00", "02:00", "04:00", "08:00", "13:30", "23:45"]) {
      if (computeNextAutoBackup("TWICE_DAILY", slot, now) <= now) past++;
    }
  }
  check("twice-daily next slot is never in the past", past === 0, `${past} past slots`);

  // A failing backup backs off rather than staying due.
  const shop = shopFor("backoff");
  await setPlan(shop, "free", { autoBackupSchedule: "DAILY", autoBackupTime: "02:00", nextAutoBackupAt: new Date(Date.now() - 1000) });
  for (let i = 0; i < 2; i++) {
    await prisma.restorePoint.create({ data: { shop, source: "MANUAL", name: `mine ${i}`, status: "READY", backupType: "PRODUCTS" } });
  }
  const res = await runScheduledBackupForShop(shop);
  const after = await prisma.appSettings.findUnique({ where: { shop } });
  check("a failed scheduled backup reports failure", res.success === false, JSON.stringify(res).slice(0, 120));
  check("…and is not due again on the next 5-minute sweep",
    after.nextAutoBackupAt > new Date(Date.now() + 30 * 60 * 1000) && after.nextAutoBackupAt <= new Date(Date.now() + 61 * 60 * 1000),
    String(after.nextAutoBackupAt));
}

// ── Restore-point lifecycle ─────────────────────────────────────────────────
async function lifecycle() {
  console.log("\n[4] Restore-point rotation and deletion");
  const shop = shopFor("rotate");
  await setPlan(shop, "free");
  const good = await prisma.restorePoint.create({ data: { shop, source: "SCHEDULED", name: "good (older)", status: "READY", backupType: "PRODUCTS", createdAt: new Date(Date.now() - 86400000) } });
  const bad = await prisma.restorePoint.create({ data: { shop, source: "SCHEDULED", name: "failed (newer)", status: "FAILED", backupType: "PRODUCTS" } });
  const slot = await reserveRestorePointSlot(shop, { source: "SCHEDULED" });
  const ids = new Set((await prisma.restorePoint.findMany({ where: { shop }, select: { id: true } })).map((r) => r.id));
  check("rotation discards a failed automatic point before a good older one", slot.allowed && ids.has(good.id) && !ids.has(bad.id));

  const rps = await import("../app/routes/app.restore-points.jsx");
  setMockShop(shop);
  as("owner-rotate@fcq.test", true);
  const busy = await prisma.restorePoint.create({ data: { shop, source: "MANUAL", name: "being restored", status: "RESTORING", backupType: "PRODUCTS" } });
  let r = await rps.action({ request: post("/app/restore-points", { intent: "delete", rpId: String(busy.id) }) });
  check("a restore point being restored cannot be deleted", r.success === false && (await prisma.restorePoint.findUnique({ where: { id: busy.id } })) !== null, r.message);
  await prisma.$executeRaw`UPDATE RestorePoint SET updatedAt = ${new Date(Date.now() - 2 * 3600000)} WHERE id = ${busy.id}`;
  r = await rps.action({ request: post("/app/restore-points", { intent: "delete", rpId: String(busy.id) }) });
  check("a stale in-progress point (crashed process) can be deleted", r.success === true, r.message);
  r = await rps.action({ request: post("/app/restore-points", { intent: "delete", rpId: String(good.id) }) });
  check("a READY point deletes normally", r.success === true, r.message);
  setMockSessionExtras({});
}

// ── Theme restore ───────────────────────────────────────────────────────────
function themeAdmin(themes, files) {
  return {
    graphql: async (query, opts = {}) => {
      const j = (data) => ({ json: async () => ({ data }) });
      if (query.includes("getThemes")) return j({ themes: { nodes: themes } });
      if (query.includes("ThemeFiles")) {
        const id = opts.variables?.themeId;
        return j({ theme: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: files[id] || [] } } });
      }
      if (query.includes("themeFilesUpsert")) {
        return j({ themeFilesUpsert: { upsertedThemeFiles: (opts.variables?.files || []).map((f) => ({ filename: f.filename })), userErrors: [] } });
      }
      return j({});
    },
  };
}

async function themeRestore() {
  console.log("\n[5] Theme restore");
  const shop = shopFor("theme-safety");
  await setPlan(shop, "business");
  const MAIN = "gid://shopify/Theme/900";
  const DRAFT = "gid://shopify/Theme/901";
  const admin = themeAdmin(
    [{ id: MAIN, name: "Live", role: "MAIN" }, { id: DRAFT, name: "Draft", role: "UNPUBLISHED" }],
    {
      [MAIN]: [{ filename: "layout/theme.liquid", size: 4, body: { content: "live" } }],
      [DRAFT]: [{ filename: "layout/theme.liquid", size: 5, body: { content: "draft" } }],
    },
  );
  const res = await restoreThemeFilesWithSafety({
    admin, shop, themeId: DRAFT, themeName: "Draft", mode: "live",
    files: [{ filename: "layout/theme.liquid", content: "restored" }],
  });
  const safety = await prisma.restorePoint.findFirst({ where: { shop, source: "PRE_RESTORE" } });
  check("live restore into a draft snapshots that draft for undo (not the live theme)",
    res.success && safety?.themeData?.activeTheme?.id === DRAFT, `${res.message} / ${safety?.themeData?.activeTheme?.id}`);

  // Route gate: Growth restores its live theme only.
  const detail = await import("../app/routes/app.restore-points_.$id.jsx");
  for (const [plan, themeId, allowed] of [
    ["growth", "gid://shopify/Theme/901", false],
    ["growth", "gid://shopify/Theme/900", true],
    ["business", "gid://shopify/Theme/901", true],
  ]) {
    const s = shopFor(`theme-gate-${plan}-${themeId.slice(-3)}`);
    setMockShop(s);
    as(`owner-${plan}@fcq.test`, true);
    await setPlan(s, plan);
    const rp = await prisma.restorePoint.create({
      data: {
        shop: s, source: "MANUAL", name: "theme snap", status: "READY", backupType: "THEMES", themeCount: 1,
        themeData: { activeTheme: { id: themeId, name: "Snap" }, files: [{ filename: "layout/theme.liquid", content: "x" }] },
      },
    });
    const r = await detail.action({ request: post(`/app/restore-points/${rp.id}`, { intent: "restore_theme", mode: "live" }), params: { id: String(rp.id) } });
    const gated = r?.success === false && /not currently live|could not confirm/i.test(r.message || "");
    check(`${plan}: live restore of theme ${themeId.slice(-3)} ${allowed ? "passes the plan gate" : "is refused"}`,
      allowed ? !gated : gated, r?.message);
    if (!allowed) {
      const d = await detail.action({ request: post(`/app/restore-points/${rp.id}`, { intent: "restore_theme", mode: "draft" }), params: { id: String(rp.id) } });
      check(`${plan}: restore to a draft copy is still offered`, !/not currently live|could not confirm|requires/i.test(d?.message || ""), d?.message);
    }
  }
  setMockSessionExtras({});
}

// ── Product restore: metafield-only difference ──────────────────────────────
async function productMetafieldRestore() {
  console.log("\n[6] Product restore with only a metafield difference");
  const detail = await import("../app/routes/app.restore-points_.$id.jsx");
  const shop = shopFor("mf-restore");
  setMockShop(shop);
  as("owner-mf@fcq.test", true);
  await setPlan(shop, "free");
  const base = { id: "gid://shopify/Product/42", title: "Mug", status: "ACTIVE", vendor: "V", tags: "a", handle: "mug", bodyHtml: "", templateSuffix: "", variants: [] };
  await prisma.productSnapshot.create({
    data: { shop, productId: "42", title: "Mug", status: "ACTIVE", snapshotData: { ...base, metafields: [{ namespace: "custom", key: "care", value: "hand wash", type: "single_line_text_field" }] } },
  });
  const rp = await prisma.restorePoint.create({
    data: {
      shop, source: "MANUAL", name: "mf snap", status: "READY", backupType: "PRODUCTS", productCount: 1,
      snapshotData: [{ productId: "42", title: "Mug", snapshotData: { ...base, metafields: [{ namespace: "custom", key: "care", value: "dishwasher safe", type: "single_line_text_field" }] } }],
    },
  });
  await detail.action({ request: post(`/app/restore-points/${rp.id}`, { intent: "restore_single_product", productId: "42" }), params: { id: String(rp.id) } });
  const result = await prisma.rollbackResult.findFirst({ where: { rollbackJob: { shop } }, orderBy: { id: "desc" } });
  check("a metafield-only difference is restored, not SKIPPED", result?.status === "SUCCESS" && result?.restoredFields?.metafields >= 1,
    JSON.stringify({ s: result?.status, f: result?.restoredFields, e: result?.errorMessage }));
  setMockSessionExtras({});
}

// ── Mirror shape and import allowance ───────────────────────────────────────
async function mirrorAndImport() {
  console.log("\n[7] Product mirror written by backups, and the import allowance");
  const shop = shopFor("mirror");
  const product = {
    id: "gid://shopify/Product/77", title: "Tee", status: "ACTIVE", vendor: "Acme", productType: "Shirt",
    tags: ["cotton", "summer"], handle: "tee", bodyHtml: "<p>x</p>", templateSuffix: "", publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z",
    images: { nodes: [] }, metafields: { nodes: [] },
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "S", price: "10.00", compareAtPrice: null, sku: "T", inventoryQuantity: 3, barcode: "", inventoryItem: { measurement: { weight: { value: 0.5, unit: "KILOGRAMS" } } } }] },
  };
  const admin = {
    graphql: async () => ({ json: async () => ({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [product] } } }) }),
  };
  await collectLiveProductsForBackup(admin, shop);
  const row = await prisma.productSnapshot.findFirst({ where: { shop, productId: "77" } });
  check("mirror stores tags as the webhook does (\"cotton, summer\")", row?.snapshotData?.tags === "cotton, summer", JSON.stringify(row?.snapshotData?.tags));
  check("mirror stores publishedAt", Boolean(row?.publishedAt) && Boolean(row?.snapshotData?.publishedAt));
  const changes = compareSnapshots(row.snapshotData, buildSnapshot(product));
  check("the next product update after a backup records no false changes", changes.length === 0, JSON.stringify(changes));

  const ishop = shopFor("import-cap");
  await setPlan(ishop, "free");
  const many = Array.from({ length: 60 }, (_, i) => ({ productId: String(9000 + i), title: `P${i}`, snapshotData: { id: `gid://shopify/Product/${9000 + i}`, title: `P${i}`, status: "ACTIVE", variants: [] } }));
  const imp = await importBackupPayload({ admin: null, shop: ishop, payload: { products: many }, mode: "RESTORE_NOW" });
  const monitored = await prisma.productSnapshot.count({ where: { shop: ishop } });
  check("import into a Free store monitors at most 50 products", monitored === 50, `monitored=${monitored} ${imp.message}`);
  check("…and says how many were left unmonitored", imp.summary?.liveResults?.productsOverAllowance === 10 && /not monitored/i.test(imp.message || ""), imp.message);
  const again = await importBackupPayload({ admin: null, shop: ishop, payload: { products: many.slice(0, 5) }, mode: "RESTORE_NOW" });
  check("re-importing already-monitored products still refreshes them", again.summary?.liveResults?.products === 5, JSON.stringify(again.summary?.liveResults));
}

// ── themes/publish webhook ──────────────────────────────────────────────────
async function themePublish() {
  console.log("\n[8] themes/publish webhook");
  const hook = await import("../app/routes/webhooks.themes.publish.jsx");
  const shop = shopFor("publish");
  setMockShop(shop);
  await setPlan(shop, "growth");
  const call = () => hook.action({ request: new Request("http://localhost/webhooks", { method: "POST" }) });
  setMockWebhook({ topic: "THEMES_PUBLISH", payload: { id: 900, name: "Dawn" } });

  let res = await call();
  check("first delivery creates a safety snapshot", res.status === 200 && (await prisma.restorePoint.count({ where: { shop, source: "THEME_PUBLISH" } })) === 1);
  const point = await prisma.restorePoint.findFirst({ where: { shop, source: "THEME_PUBLISH" } });
  check("…holding the theme's files", point?.themeData?.files?.length === LIVE.themeFiles.length);
  res = await call();
  check("a redelivery does not create a second snapshot", (await prisma.restorePoint.count({ where: { shop, source: "THEME_PUBLISH" } })) === 1, await res.text());

  const empty = shopFor("publish-empty");
  setMockShop(empty);
  await setPlan(empty, "growth");
  setMockWebhook({ topic: "THEMES_PUBLISH", payload: { id: 900, name: "Dawn" }, admin: null });
  await call();
  check("no admin client → no empty READY snapshot", (await prisma.restorePoint.count({ where: { shop: empty } })) === 0);

  const free = shopFor("publish-free");
  setMockShop(free);
  await setPlan(free, "free");
  setMockWebhook({ topic: "THEMES_PUBLISH", payload: { id: 900, name: "Dawn" } });
  await call();
  check("Free store: no theme snapshot", (await prisma.restorePoint.count({ where: { shop: free } })) === 0);
}

async function main() {
  console.log("=".repeat(78));
  console.log("  FINAL QA CYCLE — FIX REGRESSIONS");
  console.log("=".repeat(78));
  await cleanup();
  try {
    await teamRemoval();
    await gdpr();
    await scheduling();
    await lifecycle();
    await themeRestore();
    await productMetafieldRestore();
    await mirrorAndImport();
    await themePublish();
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
