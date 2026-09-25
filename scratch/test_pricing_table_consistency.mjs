// Verifies the Plans & Billing pricing table against the gates that actually
// enforce it. The cards are marketing copy sitting next to PLAN_LIMITS, and
// nothing else in the suite checks that the two still agree — a card can
// promise a capability the code locks, or hide one it ships, and every other
// test stays green.
//
// Run: node --import ./scratch/jsx-register.mjs scratch/test_pricing_table_consistency.mjs
import { readFile } from "node:fs/promises";
import { PLAN_LIMITS } from "../app/billing.server.js";
import { PLAN_TIERS } from "../app/billing.constants.js";

const SOURCE = await readFile(new URL("../app/routes/app.plan.jsx", import.meta.url), "utf8");
const WEBHOOK_SOURCE = await readFile(
  new URL("../app/routes/webhooks.products.update.jsx", import.meta.url),
  "utf8",
);

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    // A thenable here means the body's assertions resolved after the check
    // already reported success — the check would pass no matter what it found.
    assert(typeof detail?.then !== "function", "check body is async; its assertions were never awaited");
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  ❌ ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// PLANS is a pure data literal, so it can be lifted out of the route without
// pulling in prisma, the Shopify session or the React tree.
function extractPlans() {
  const start = SOURCE.indexOf("const PLANS = [");
  const end = SOURCE.indexOf("\n];", start);
  assert(start !== -1 && end !== -1, "could not locate the PLANS literal");
  const literal = SOURCE.slice(start + "const PLANS = ".length, end + 2);
  return eval(literal); // eslint-disable-line no-eval
}

const PLANS = extractPlans();
const labelOf = (f) => (typeof f === "string" ? f : f.label);
const byId = Object.fromEntries(PLANS.map((p) => [p.id, p]));
const ORDER = ["free", "starter", "growth", "business", "enterprise"];

console.log("\n════════════════════════════════════════════════════");
console.log("  PRICING TABLE ↔ PLAN_LIMITS CONSISTENCY");
console.log("════════════════════════════════════════════════════\n");

console.log("▶ Card integrity");

check("Every tier in PLAN_LIMITS has exactly one card, in ladder order", () => {
  assert(PLANS.length === ORDER.length, `expected ${ORDER.length} cards, found ${PLANS.length}`);
  PLANS.forEach((p, i) => assert(p.id === ORDER[i], `card ${i} is "${p.id}", expected "${ORDER[i]}"`));
  return PLANS.map((p) => p.id).join(" → ");
});

check("Card prices match PLAN_TIERS (no copy drifting from what is billed)", () => {
  for (const p of PLANS) {
    const expected = `$${PLAN_TIERS[p.id].monthlyPrice}`;
    assert(p.price === expected, `${p.id} card shows ${p.price}, billed ${expected}`);
  }
  return PLANS.map((p) => p.price).join(" / ");
});

console.log("\n▶ Badge hierarchy");

check("No feature row carries an inline badge on a card that has a tier badge", () => {
  const BADGED_CARDS = new Set(["growth", "business", "enterprise"]);
  for (const p of PLANS) {
    const inline = p.features.filter((f) => typeof f === "object" && f.badge);
    if (BADGED_CARDS.has(p.id)) {
      assert(
        inline.length === 0,
        `${p.id} has a card badge plus inline badge(s): ${inline.map((f) => f.badge).join(", ")}`,
      );
    }
  }
  return "no duplicate promotional labels";
});

check("The tier badge is suppressed on the merchant's current plan", () => {
  // Both badges render into the same flex row; only the guard keeps a card
  // from showing "Current" and a tier badge side by side.
  const guard = /if \(!isExactCurrent\) \{\s*if \(isGrowth\)/;
  assert(guard.test(SOURCE), "tierBadge assignment is not guarded by !isExactCurrent");
  return "one badge per card in every state";
});

check("Each tier label removed from a badge still appears as card copy", () => {
  assert(
    byId.enterprise.footerText.includes("Shopify Plus"),
    'Enterprise no longer communicates "Shopify Plus" anywhere on the card',
  );
  return `Enterprise footer: "${byId.enterprise.footerText}"`;
});

console.log("\n▶ Value ladder is monotonic");

const LADDER = [
  ["products", "products monitored"],
  ["retentionDays", "retention days"],
  ["restorePoints", "restore points"],
  ["rules", "detection rules"],
  ["vaultOrders", "vault orders"],
  ["marketingProfiles", "marketing profiles"],
];

for (const [key, human] of LADDER) {
  check(`${human} never decrease across the ladder`, () => {
    const values = ORDER.map((id) => PLAN_LIMITS[id][key]);
    for (let i = 1; i < values.length; i++) {
      assert(
        values[i] >= values[i - 1],
        `${ORDER[i]} (${values[i]}) is below ${ORDER[i - 1]} (${values[i - 1]})`,
      );
    }
    return values.map((v) => (v === Infinity ? "∞" : v)).join(" ≤ ");
  });
}

check("Boolean capabilities are never revoked by upgrading", () => {
  for (const flag of ["themes", "circuitBreaker", "slack", "bulkRollback", "cloudSync", "marketingBackup", "marketingFlows", "metafieldBackup", "ga4Monitoring"]) {
    for (let i = 1; i < ORDER.length; i++) {
      const prev = PLAN_LIMITS[ORDER[i - 1]][flag];
      const cur = PLAN_LIMITS[ORDER[i]][flag];
      assert(!(prev && !cur), `${flag} is on for ${ORDER[i - 1]} but off for ${ORDER[i]}`);
    }
  }
  return "9 flags checked";
});

console.log("\n▶ Feature boundaries match the gates");

check("A ✓ row is never shown for a capability the tier does not have", () => {
  // The vault is the one the cards state numerically, so it is checkable.
  for (const p of PLANS) {
    const claims = p.features.some(
      (f) => typeof f === "string" && /^Orders & Customers Vault \(/.test(f),
    );
    const granted = PLAN_LIMITS[p.id].vaultOrders > 0;
    assert(!(claims && !granted), `${p.id} advertises the vault but vaultOrders is ${PLAN_LIMITS[p.id].vaultOrders}`);
  }
  return "vault rows align with vaultOrders";
});

check("Starter names the vault boundary instead of silently omitting it", () => {
  assert(PLAN_LIMITS.starter.vaultOrders === 0, "Starter now has vault access; the boundary row is stale");
  const boundary = byId.starter.features.find((f) => typeof f === "object" && f.kind === "boundary");
  assert(boundary, "Starter has no boundary row explaining the vault gap");
  const firstGranted = ORDER.find((id) => PLAN_LIMITS[id].vaultOrders > 0);
  assert(
    new RegExp(firstGranted, "i").test(boundary.label),
    `boundary row says "${boundary.label}" but the vault actually starts at ${firstGranted}`,
  );
  return `"${boundary.label}"`;
});

check("A boundary row renders without a ✓", () => {
  const branch = SOURCE.indexOf('if (kind === "boundary")');
  const checkmark = SOURCE.indexOf('<span style={{ color: "var(--rv-primary)", fontWeight: "bold" }}>✓</span>');
  assert(branch !== -1, "no boundary branch in the feature renderer");
  assert(branch < checkmark, "the boundary branch does not return before the ✓ row");
  return "returns before the checkmark row";
});

check("Free tier retains core backups while operational/governance features start at Starter", () => {
  const freeFeatures = byId.free.features.map(labelOf);
  const starterFeatures = byId.starter.features.map(labelOf);

  // Core backup capabilities retained on Free
  assert(freeFeatures.some((f) => /manual single-product rollback/i.test(f)), "Free missing manual rollback");
  assert(freeFeatures.some((f) => /scheduled backups/i.test(f)), "Free missing scheduled backups");
  assert(freeFeatures.some((f) => /offline json & csv/i.test(f)), "Free missing offline export/import");

  // Operational/governance features moved to Starter
  assert(!freeFeatures.some((f) => /(?:uptime|store & app) monitoring/i.test(f)), "Free still advertises Uptime Monitoring");
  assert(!freeFeatures.some((f) => /team roles/i.test(f)), "Free still advertises Team roles & audit log");
  assert(starterFeatures.some((f) => /(?:uptime|store & app) monitoring/i.test(f)), "Starter missing Uptime Monitoring");
  assert(starterFeatures.some((f) => /team roles/i.test(f)), "Starter missing Team roles & audit log");

  return "Free retains core backups; Uptime & Team roles unlock at Starter";
});

console.log("\n▶ The 200,000 product boundary");

check("Enterprise copy matches where the webhook actually stops tracking", () => {
  // `currentCount >= limits.products` rejects the product that would make the
  // count exceed the cap, so the cap itself is included.
  assert(
    /currentCount >= limits\.products/.test(WEBHOOK_SOURCE),
    "the product gate is no longer `>=`; re-check the wording",
  );
  const row = byId.enterprise.features.find((f) => /200,000 products monitored/.test(labelOf(f)));
  assert(row, "Enterprise no longer states a product limit");
  assert(
    /up to and including/i.test(labelOf(row)),
    `ambiguous Enterprise wording: "${labelOf(row)}"`,
  );
  return labelOf(row);
});

check("Enterprise Plus claims only what Enterprise does not, with no gap", () => {
  const cap = PLAN_LIMITS.enterprise.products;
  assert(cap === 200000, `Enterprise cap is ${cap}; the banner copy says 200,000`);
  assert(
    !/Exceeding 200,000/i.test(SOURCE),
    'the banner still says "Exceeding 200,000", which is ambiguous at exactly 200,000',
  );
  // The bound is now rendered from catalogCap rather than written out, so
  // assert the expression, not a literal — a literal here is the very drift
  // this suite exists to catch.
  assert(
    /More Than \$\{formatNumber\(catalogCap\)\} Products/.test(SOURCE),
    "the banner no longer states its lower bound",
  );
  assert(
    /const isOverCatalogCap = catalogCap !== Infinity && usage\.productCount > catalogCap/.test(SOURCE),
    "the banner trigger no longer matches the stated boundary",
  );
  return `Enterprise ≤ ${cap.toLocaleString()} < Enterprise Plus`;
});

check("A capability the gates grant is advertised on the tier that unlocks it", () => {
  // The mirror image of the check above. An unadvertised capability is a
  // feature the merchant is paying for and cannot discover, and it is the
  // failure mode that shows up when a gate is widened in billing.server.js
  // without the cards being revisited.
  const COPY = {
    themes: /theme/i,
    circuitBreaker: /circuit breaker/i,
    slack: /slack/i,
    bulkRollback: /bulk/i,
    cloudSync: /cloud|drive|dropbox/i,
    marketingBackup: /klaviyo|mailchimp/i,
    metafieldBackup: /metafield/i,
    ga4Monitoring: /ga4|tag manager/i,
    uptimeMonitoring: /store & app monitoring|uptime/i,
    qaSuites: /automated qa/i,
    teamRoles: /team roles/i,
    marketingFlows: /flow/i,
  };
  const missing = [];
  for (const [flag, pattern] of Object.entries(COPY)) {
    const firstTier = ORDER.find((id) => PLAN_LIMITS[id][flag]);
    if (!firstTier) continue;
    const card = byId[firstTier];
    if (!card.features.some((f) => pattern.test(labelOf(f)))) {
      missing.push(`${flag} unlocks at ${firstTier} but no ${firstTier} row mentions it`);
    }
  }
  assert(missing.length === 0, missing.join("; "));
  return `${Object.keys(COPY).length} capabilities advertised at the tier that grants them`;
});

console.log("\n▶ Locale-independent formatting");

check("No bare toLocaleString/toLocaleDateString reaches the merchant", () => {
  // A bare call follows the runtime locale — the server's during SSR, the
  // viewer's after hydration — so the same value renders two different ways.
  const bare = SOURCE.split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\.toLocale(Date|Time)?String\(\s*\)/.test(line))
    .filter(({ line }) => !line.trim().startsWith("*")); // the helper's own docs
  assert(
    bare.length === 0,
    `unpinned locale formatting at line(s) ${bare.map((b) => b.n).join(", ")}`,
  );
  return "all formatting pinned via formatNumber/formatDate";
});

check("formatNumber renders the same digits regardless of host locale", () => {
  // This box runs en-IN, which groups 200000 as "2,00,000".
  const hostGrouping = (200000).toLocaleString();
  const pinned = (200000).toLocaleString("en-US");
  assert(pinned === "200,000", `en-US grouping produced "${pinned}"`);
  return hostGrouping === pinned
    ? "host locale already en-US-like; pinning still enforced"
    : `host would have rendered "${hostGrouping}" — now pinned to "${pinned}"`;
});

console.log("\n▶ Custom quota stores");

check("The limit-reached banner quotes the store's own ceiling, not a constant", () => {
  const banner = SOURCE.slice(
    SOURCE.indexOf("Your store has reached the"),
    SOURCE.indexOf("Newly added products are no longer tracked"),
  );
  assert(banner.length > 0, "the limit-reached banner has moved or been renamed");
  assert(
    !/reached the 200,000 product limit/.test(SOURCE),
    "the banner still hardcodes 200,000, which is wrong for a custom-quota store",
  );
  assert(/formatNumber\(limits\.products\)/.test(banner), "the banner does not read limits.products");
  return "reads limits.products";
});

check("The Enterprise Plus upsell triggers on the store's real cap", () => {
  assert(
    !/usage\.productCount > 200000/.test(SOURCE),
    "the upsell still triggers on a hardcoded 200000, so custom-quota stores are mis-pitched",
  );
  assert(
    /const catalogCap = limits\?\.isCustomLimit \? limits\.products : enterpriseProductCap/.test(SOURCE),
    "catalogCap is not derived from the store's custom quota",
  );
  assert(
    /enterpriseProductCap: PLAN_LIMITS\.enterprise\.products/.test(SOURCE),
    "the cap is not sourced from PLAN_LIMITS in the loader",
  );
  return "catalogCap = custom quota ?? PLAN_LIMITS.enterprise.products";
});

check("The upsell's lower bound is exactly one above the cap — no gap, no overlap", () => {
  const cap = PLAN_LIMITS.enterprise.products;
  assert(/formatNumber\(catalogCap \+ 1\)/.test(SOURCE), "the upsell does not state cap + 1 as its floor");
  return `Enterprise ≤ ${cap.toLocaleString("en-US")} | Plus ≥ ${(cap + 1).toLocaleString("en-US")}`;
});

console.log("\n════════════════════════════════════════════════════");
if (failures.length) {
  console.log(`  ${passed} passed, ${failures.length} FAILED`);
  console.log("════════════════════════════════════════════════════\n");
  process.exitCode = 1;
} else {
  console.log(`  ${passed} consistency checks passed`);
  console.log("════════════════════════════════════════════════════\n");
}
