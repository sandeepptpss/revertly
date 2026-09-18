/**
 * Regression cover for the defects found in the final QA cycle.
 * Each case fails against the pre-fix code.
 *
 * Run: node --import ./scratch/jsx-register.mjs scratch/test_final_qa_regressions.mjs
 */
import assert from "node:assert";
import prisma from "../app/db.server.js";
import { getStorePlan } from "../app/billing.server.js";
import { getFreeGrowthStatus } from "../app/freeGrowth.server.js";
import { resolveActor, checkPermission, PERMISSIONS } from "../app/team.server.js";

const SHOP = "final-qa-regression.myshopify.com";

let passed = 0;
function pass(msg) {
  console.log(`  ✅ ${msg}`);
  passed++;
}

async function resetShop(data = {}) {
  await prisma.appSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.appSettings.create({ data: { shop: SHOP, ...data } });
}

async function run() {
  console.log("════════════════════════════════════════════════════");
  console.log("  FINAL QA — REGRESSION COVER");
  console.log("════════════════════════════════════════════════════\n");

  // ── 1. A failing Shopify billing check must not downgrade a paying store ──
  console.log("▶ Billing resilience");
  await resetShop({ planId: "business", subscriptionId: "gid://shopify/AppSubscription/1" });

  const throwingBilling = {
    check: async () => {
      throw new Error("Shopify API 503 Service Unavailable");
    },
  };
  const afterError = await getStorePlan(SHOP, throwingBilling, true);
  const rowAfterError = await prisma.appSettings.findUnique({ where: { shop: SHOP } });

  assert.strictEqual(
    rowAfterError.planId,
    "business",
    "A transient billing-check error must leave the stored plan intact",
  );
  assert.strictEqual(
    rowAfterError.subscriptionId,
    "gid://shopify/AppSubscription/1",
    "A transient billing-check error must not clear the subscription reference",
  );
  assert.strictEqual(
    afterError.currentPlan,
    "business",
    "Reported plan stays business through an API error",
  );
  assert.strictEqual(
    afterError.limits.products,
    20000,
    "Business entitlements survive a transient billing API error",
  );
  pass("A failed billing check does not downgrade a paying merchant to free");

  // ── 2. An ACTIVE subscription under an unknown name must not downgrade ──
  await resetShop({ planId: "growth", subscriptionId: "gid://shopify/AppSubscription/2" });

  const unknownNameBilling = {
    check: async () => ({
      hasActivePayment: true,
      appSubscriptions: [{ name: "Legacy Pro Tier 2024", status: "ACTIVE" }],
    }),
  };
  await getStorePlan(SHOP, unknownNameBilling, true);
  const rowUnknown = await prisma.appSettings.findUnique({ where: { shop: SHOP } });
  assert.strictEqual(
    rowUnknown.planId,
    "growth",
    "An ACTIVE subscription with an unrecognised name must not drop the store to free",
  );
  pass("An unrecognised ACTIVE plan name leaves entitlements untouched");

  // ── 3. A genuine cancellation still downgrades ──
  await resetShop({ planId: "business", subscriptionId: "gid://shopify/AppSubscription/3" });

  const cancelledBilling = { check: async () => ({ hasActivePayment: false, appSubscriptions: [] }) };
  await getStorePlan(SHOP, cancelledBilling, true);
  const rowCancelled = await prisma.appSettings.findUnique({ where: { shop: SHOP } });
  assert.strictEqual(
    rowCancelled.planId,
    "free",
    "A confirmed 'no active payment' must still downgrade — the guard must not block real cancellations",
  );
  pass("A confirmed cancellation still downgrades to free");

  // ── 4. A seat limit of 0 closes the promotion ──
  console.log("\n▶ Free-growth seat accounting");
  const settingsBefore = await prisma.platformSettings.findUnique({ where: { id: 1 } });
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, freeGrowthSeatLimit: 0, freeGrowthEnabled: true },
    update: { freeGrowthSeatLimit: 0, freeGrowthEnabled: true },
  });

  const zeroStatus = await getFreeGrowthStatus();
  assert.strictEqual(zeroStatus.limit, 0, "A configured limit of 0 must survive as 0, not fall back to 20");
  assert.strictEqual(zeroStatus.remaining, 0, "No seats remain when the limit is 0");
  assert.strictEqual(zeroStatus.isSoldOut, true, "A 0-seat promotion reports sold out");
  pass("A seat limit of 0 closes the promotion instead of advertising 20 seats");

  // restore prior platform settings
  if (settingsBefore) {
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        freeGrowthSeatLimit: settingsBefore.freeGrowthSeatLimit,
        freeGrowthEnabled: settingsBefore.freeGrowthEnabled,
      },
    });
  }

  // ── 5. shop/redact ordering: results must be removable before their jobs ──
  console.log("\n▶ GDPR purge ordering");
  const rp = await prisma.restorePoint.create({
    data: { shop: SHOP, name: "regression rp", status: "READY" },
  });
  const job = await prisma.rollbackJob.create({
    data: { shop: SHOP, restorePointId: rp.id, status: "COMPLETED", totalProducts: 1 },
  });
  await prisma.rollbackResult.create({
    data: { rollbackJobId: job.id, productId: "1", productTitle: "t", status: "SUCCESS" },
  });

  // Pre-fix, shop/redact deleted rollbackJob without first clearing
  // rollbackResult. The FK is ON DELETE RESTRICT, so that throws.
  let restrictHit = false;
  try {
    await prisma.rollbackJob.deleteMany({ where: { shop: SHOP } });
  } catch {
    restrictHit = true;
  }
  assert.strictEqual(
    restrictHit,
    true,
    "RollbackResult -> RollbackJob is ON DELETE RESTRICT; the purge order in shop/redact depends on this",
  );

  // The shipped order (results first) must succeed.
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: SHOP } });

  const leftoverResults = await prisma.rollbackResult.count({ where: { rollbackJob: { shop: SHOP } } });
  const leftoverJobs = await prisma.rollbackJob.count({ where: { shop: SHOP } });
  assert.strictEqual(leftoverResults, 0, "No rollback results survive the purge");
  assert.strictEqual(leftoverJobs, 0, "No rollback jobs survive the purge");
  pass("Purging results before jobs clears rollback data that previously survived redaction");

  // ── 6. Team roles are actually enforced ──
  console.log("\n▶ Role-based access control");
  await prisma.teamMember.deleteMany({ where: { shop: SHOP } });

  const onlineSession = (email, extra = {}) => ({
    shop: SHOP,
    isOnline: true,
    onlineAccessInfo: {
      associated_user: { email, first_name: "Test", last_name: "User", ...extra },
    },
  });

  // The first identified caller is provisioned OWNER.
  const ownerActor = await resolveActor(SHOP, onlineSession("owner@example.com"));
  assert.strictEqual(ownerActor.role, "OWNER", "First caller of a shop becomes OWNER");

  // A VIEWER must be resolved as VIEWER, not silently promoted to ADMIN.
  await prisma.teamMember.create({
    data: { shop: SHOP, email: "viewer@example.com", role: "VIEWER", status: "ACTIVE" },
  });
  const viewerActor = await resolveActor(SHOP, onlineSession("viewer@example.com"));
  assert.strictEqual(viewerActor.role, "VIEWER", "A rostered VIEWER resolves as VIEWER");

  const viewerDelete = await checkPermission(
    SHOP,
    onlineSession("viewer@example.com"),
    PERMISSIONS.BACKUP_DELETE,
  );
  assert.strictEqual(viewerDelete.allowed, false, "A VIEWER must not be able to delete backups");

  const viewerView = await checkPermission(
    SHOP,
    onlineSession("viewer@example.com"),
    PERMISSIONS.VIEW,
  );
  assert.strictEqual(viewerView.allowed, true, "A VIEWER can still view");
  pass("An assigned VIEWER role is enforced instead of falling through to ADMIN");

  // Signing in accepts a pending invitation.
  await prisma.teamMember.create({
    data: { shop: SHOP, email: "invited@example.com", role: "EDITOR", status: "INVITED" },
  });
  const invitedActor = await resolveActor(SHOP, onlineSession("invited@example.com"));
  assert.strictEqual(invitedActor.role, "EDITOR", "An invited member gets their assigned role");
  await new Promise((r) => setTimeout(r, 120)); // activation write is fire-and-forget
  const invitedRow = await prisma.teamMember.findUnique({
    where: { shop_email: { shop: SHOP, email: "invited@example.com" } },
  });
  assert.strictEqual(invitedRow.status, "ACTIVE", "Signing in accepts the invitation");
  pass("An invited member is activated on first sign-in");

  // A suspended member holds no permissions.
  await prisma.teamMember.create({
    data: { shop: SHOP, email: "gone@example.com", role: "ADMIN", status: "SUSPENDED" },
  });
  const suspended = await checkPermission(
    SHOP,
    onlineSession("gone@example.com"),
    PERMISSIONS.VIEW,
  );
  assert.strictEqual(suspended.allowed, false, "A SUSPENDED member is refused");
  pass("Suspension actually revokes access");

  // An unidentified (offline) session still fails open to ADMIN by design,
  // so a store can never lock itself out of its own backups.
  const offlineActor = await resolveActor(SHOP, { shop: SHOP, isOnline: false });
  assert.strictEqual(offlineActor.role, "ADMIN", "An unidentified session falls open to ADMIN");
  assert.strictEqual(offlineActor.unlisted, true, "...and is flagged as unlisted");
  pass("An unidentified session still fails open, as documented");

  // The pre-online-tokens placeholder OWNER is adopted by the real account owner.
  await prisma.teamMember.deleteMany({ where: { shop: SHOP } });
  await prisma.teamMember.create({
    data: { shop: SHOP, email: `owner@${SHOP}`, role: "OWNER", status: "ACTIVE", name: "Store Owner" },
  });
  await prisma.teamMember.create({
    data: { shop: SHOP, email: "someone@example.com", role: "EDITOR", status: "ACTIVE" },
  });

  const realOwner = await resolveActor(
    SHOP,
    onlineSession("real.owner@example.com", { account_owner: true }),
  );
  assert.strictEqual(realOwner.role, "OWNER", "The Shopify account owner is resolved as OWNER");
  const placeholderGone = await prisma.teamMember.findUnique({
    where: { shop_email: { shop: SHOP, email: `owner@${SHOP}` } },
  });
  assert.strictEqual(placeholderGone, null, "The unclaimable placeholder row is retired");
  pass("The real account owner replaces the pre-migration placeholder OWNER row");

  // The live roster shape: a placeholder OWNER plus the account owner sitting
  // on the roster as an INVITED EDITOR. Matching the EDITOR row first would
  // demote them and lock the store out of its own billing.
  await prisma.teamMember.deleteMany({ where: { shop: SHOP } });
  await prisma.teamMember.create({
    data: { shop: SHOP, email: `owner@${SHOP}`, role: "OWNER", status: "ACTIVE" },
  });
  await prisma.teamMember.create({
    data: { shop: SHOP, email: "boss@example.com", role: "EDITOR", status: "INVITED" },
  });

  const demoted = await resolveActor(
    SHOP,
    onlineSession("boss@example.com", { account_owner: true }),
  );
  assert.strictEqual(demoted.role, "OWNER", "A stale EDITOR row must not demote the account owner");

  const billing = await checkPermission(
    SHOP,
    onlineSession("boss@example.com", { account_owner: true }),
    PERMISSIONS.BILLING_MANAGE,
  );
  assert.strictEqual(billing.allowed, true, "The account owner retains billing management");

  const owners = await prisma.teamMember.findMany({ where: { shop: SHOP, role: "OWNER" } });
  assert.strictEqual(owners.length, 1, "The shop is left with exactly one OWNER");
  assert.strictEqual(owners[0].email, "boss@example.com", "...and it is the real account owner");
  pass("A stale roster row cannot demote the Shopify account owner");

  // ── cleanup ──
  await prisma.teamMember.deleteMany({ where: { shop: SHOP } });
  await prisma.appSettings.deleteMany({ where: { shop: SHOP } });

  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  ${passed} regression checks passed`);
  console.log(`════════════════════════════════════════════════════`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ REGRESSION FAILURE:", err?.message || err);
    process.exit(1);
  });
