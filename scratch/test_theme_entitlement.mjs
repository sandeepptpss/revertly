// Theme backup entitlements: who may capture which theme, and what happens
// when the Admin API will not say.
//
// The draft-theme restriction is the only thing separating Growth's theme
// backup from Business's, so it is worth a test that the check denies on every
// path that does not positively confirm the target is the live theme.
//
// Run: node --import ./scratch/jsx-register.mjs scratch/test_theme_entitlement.mjs
import { readFile } from "node:fs/promises";
import { PLAN_LIMITS, checkThemeAccess } from "../app/billing.server.js";
import prisma from "../app/db.server.js";

const SHOP = "theme-entitlement-test.myshopify.com";
const ROUTE = await readFile(
  new URL("../app/routes/app.restore-points.jsx", import.meta.url),
  "utf8",
);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ❌ ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The guard's end marker occurs several times in this route and the first one
// is ABOVE the guard, so indexOf from the start of the file yields a negative
// slice and an empty string — which made every assertion below it pass
// vacuously. Search for the terminator only after the guard begins.
function sliceGuard() {
  const start = ROUTE.indexOf("if (!themeCheck.unlimitedThemes && themeId)");
  if (start === -1) return "";
  const end = ROUTE.indexOf("const rawName = formData.get", start);
  return ROUTE.slice(start, end === -1 ? undefined : end);
}

async function setPlan(planId) {
  await prisma.appSettings.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, planId },
    update: { planId, customProductLimit: null, customPriceStatus: null },
  });
}

console.log("\n════════════════════════════════════════════════════");
console.log("  THEME BACKUP ENTITLEMENTS");
console.log("════════════════════════════════════════════════════\n");

console.log("▶ themeLimit is the single source of truth");

await check("unlimitedThemes is derived, never stored alongside themeLimit", () => {
  for (const [id, limits] of Object.entries(PLAN_LIMITS)) {
    assert(
      !("unlimitedThemes" in limits),
      `${id} still stores unlimitedThemes; it can now disagree with themeLimit`,
    );
  }
  return "no tier stores a second, contradictable copy";
});

await check("Every tier's themeLimit agrees with its themes flag", async () => {
  const rows = [];
  for (const id of ["free", "starter", "growth", "business", "enterprise"]) {
    await setPlan(id);
    const access = await checkThemeAccess(SHOP);
    assert(
      access.allowed === Boolean(PLAN_LIMITS[id].themes),
      `${id}: allowed=${access.allowed} but themes=${PLAN_LIMITS[id].themes}`,
    );
    assert(
      access.allowed === access.themeLimit > 0,
      `${id}: allowed=${access.allowed} but themeLimit=${access.themeLimit}`,
    );
    assert(
      access.unlimitedThemes === (access.themeLimit === Infinity),
      `${id}: unlimitedThemes=${access.unlimitedThemes} but themeLimit=${access.themeLimit}`,
    );
    rows.push(`${id}:${access.themeLimit === Infinity ? "∞" : access.themeLimit}`);
  }
  return rows.join(" ");
});

await check("Theme access starts at Growth, drafts only at Business", async () => {
  await setPlan("starter");
  assert((await checkThemeAccess(SHOP)).allowed === false, "Starter should have no theme access");
  await setPlan("growth");
  const growth = await checkThemeAccess(SHOP);
  assert(growth.allowed && !growth.unlimitedThemes, "Growth should have capped theme access");
  await setPlan("business");
  assert((await checkThemeAccess(SHOP)).unlimitedThemes, "Business should have uncapped theme access");
  return "starter:none growth:capped business:unlimited";
});

console.log("\n▶ The draft-theme guard denies rather than fails open");

await check("An unknown theme role is denied, not permitted", () => {
  // The guard reads the role into a variable and compares outside the try, so
  // a throw leaves it null and the `role !== "MAIN"` test denies. The previous
  // shape returned nothing from the catch and fell through to backupTheme().
  const guard = sliceGuard();
  assert(guard.length > 0, "the draft-theme guard has moved or been removed");
  assert(
    /let role = null;/.test(guard),
    "the role is not captured outside the try block, so a throw skips the check",
  );
  assert(
    /if \(role !== "MAIN"\)/.test(guard),
    "the deny branch does not require a positively confirmed MAIN role",
  );
  assert(
    !/if \(targetTheme && targetTheme\.role !== "MAIN"\)/.test(guard),
    "a missing theme still short-circuits the check and permits the backup",
  );
  return "throw, malformed response and missing theme all deny";
});

await check("The catch block does not silently swallow the failure", () => {
  const guard = sliceGuard();
  assert(!/\/\/ non-fatal/.test(guard), 'the "non-fatal" catch is still present');
  assert(/console\.warn/.test(guard), "a failed role lookup is not logged");
  return "logged, then denied";
});

await check("A null themeId is still allowed through", () => {
  const guard = sliceGuard();
  // fetchThemeBackup falls back to the MAIN theme when given no target, so
  // denying here would break the plain "back up my theme" button on Growth.
  assert(
    /&& themeId\)/.test(guard),
    "the guard no longer exempts a null themeId; Growth's default backup would be blocked",
  );
  return "defaults to the live theme, as fetchThemeBackup does";
});

await prisma.appSettings.deleteMany({ where: { shop: SHOP } }).catch(() => {});
await prisma.$disconnect();

console.log("\n════════════════════════════════════════════════════");
if (failures.length) {
  console.log(`  ${passed} passed, ${failures.length} FAILED`);
  process.exitCode = 1;
} else {
  console.log(`  ${passed} entitlement checks passed`);
}
console.log("════════════════════════════════════════════════════\n");
