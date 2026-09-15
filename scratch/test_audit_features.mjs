/**
 * End-to-end verification for the audit remediation work.
 *
 * Drives the real server modules against the dev database. Each section uses an
 * isolated test shop and cleans up after itself.
 *
 * Run: source ~/.nvm/nvm.sh && nvm use 22 && node scratch/test_audit_features.mjs
 */
import assert from "node:assert";
import prisma from "../app/db.server.js";

const SHOP_LOCK = "qa-lock-test.myshopify.com";
const SHOP_TEAM = "qa-team-test.myshopify.com";
const SHOP_UPTIME = "qa-uptime-test.myshopify.com";
const SHOP_QA = "qa-suite-test.myshopify.com";
const SHOP_CLOUD = "qa-cloud-test.myshopify.com";
const ALL_SHOPS = [SHOP_LOCK, SHOP_TEAM, SHOP_UPTIME, SHOP_QA, SHOP_CLOUD];

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

async function cleanup() {
  for (const shop of ALL_SHOPS) {
    await prisma.downtimeCheck.deleteMany({ where: { shop } });
    await prisma.monitoredService.deleteMany({ where: { shop } });
    await prisma.qaTestRun.deleteMany({ where: { shop } });
    await prisma.auditLog.deleteMany({ where: { shop } });
    await prisma.teamMember.deleteMany({ where: { shop } });
    await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop } } });
    await prisma.rollbackJob.deleteMany({ where: { shop } });
    await prisma.changeEvent.deleteMany({ where: { shop } });
    await prisma.restorePoint.deleteMany({ where: { shop } });
    await prisma.productSnapshot.deleteMany({ where: { shop } });
    await prisma.appSettings.deleteMany({ where: { shop } });
  }
  await prisma.jobLock.deleteMany({ where: { name: { startsWith: "test:" } } });
}

// ───────────────────────────────────────────── Feature 1: cron auth + locking
async function testCronAndLocking() {
  console.log("\n▶ Feature 1 — Automated backups: cron auth & job locking");

  const { assertCronAuth, acquireJobLock, releaseJobLock, withJobLock } = await import(
    "../app/cron.server.js"
  );

  const req = (url, headers = {}) => new Request(url, { headers });

  await test("fails closed with 503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = assertCronAuth(req("https://x.test/api/cron/backups"));
    assert.ok(res, "expected a denial Response");
    assert.strictEqual(res.status, 503);
  });

  await test("rejects an unauthenticated request with 401", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = assertCronAuth(req("https://x.test/api/cron/backups"));
    assert.ok(res);
    assert.strictEqual(res.status, 401);
  });

  await test("rejects a wrong secret with 401", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = assertCronAuth(req("https://x.test/api/cron/backups", { "x-cron-secret": "nope" }));
    assert.strictEqual(res.status, 401);
  });

  await test("accepts the correct secret via header", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = assertCronAuth(req("https://x.test/api/cron/backups", { "x-cron-secret": "s3cret-value" }));
    assert.strictEqual(res, null);
  });

  await test("accepts the correct secret via ?token=", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = assertCronAuth(req("https://x.test/api/cron/backups?token=s3cret-value"));
    assert.strictEqual(res, null);
  });

  await test("a second acquirer is refused while the lock is held", async () => {
    const got1 = await acquireJobLock("test:lock-a", 60_000);
    assert.strictEqual(got1, true, "first acquisition should succeed");
    const got2 = await acquireJobLock("test:lock-a", 60_000);
    assert.strictEqual(got2, false, "second acquisition must be refused");
    await releaseJobLock("test:lock-a");
  });

  await test("an expired lock can be taken over", async () => {
    await prisma.jobLock.create({
      data: {
        name: "test:lock-expired",
        owner: "some-dead-instance",
        lockedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const got = await acquireJobLock("test:lock-expired", 60_000);
    assert.strictEqual(got, true, "a lapsed lock must be reclaimable");
    await releaseJobLock("test:lock-expired");
  });

  await test("withJobLock skips the body when the lock is held", async () => {
    await acquireJobLock("test:lock-b", 60_000);
    let ran = false;
    const res = await withJobLock("test:lock-b", 60_000, async () => {
      ran = true;
      return { ok: true };
    });
    assert.strictEqual(ran, false, "body must not run");
    assert.strictEqual(res.skipped, true);
    await prisma.jobLock.deleteMany({ where: { name: "test:lock-b" } });
  });

  await test("withJobLock releases the lock afterwards", async () => {
    await withJobLock("test:lock-c", 60_000, async () => "done");
    const remaining = await prisma.jobLock.count({ where: { name: "test:lock-c" } });
    assert.strictEqual(remaining, 0, "lock should be released");
  });

  await test("withJobLock releases the lock even when the body throws", async () => {
    await withJobLock("test:lock-d", 60_000, async () => {
      throw new Error("boom");
    }).catch(() => {});
    const remaining = await prisma.jobLock.count({ where: { name: "test:lock-d" } });
    assert.strictEqual(remaining, 0, "lock must not leak on error");
  });
}

// ───────────────────────────────────────────── Feature 7: cloud sync transport
async function testCloudSync() {
  console.log("\n▶ Feature 7 — Google Drive & Dropbox");

  const { serializeRestorePoint, getCloudProviderStatus, isProviderConfigured, syncRestorePointToCloud } =
    await import("../app/cloudSync.server.js");

  await prisma.appSettings.create({ data: { shop: SHOP_CLOUD } });

  const rp = await prisma.restorePoint.create({
    data: {
      shop: SHOP_CLOUD,
      name: "Cloud Test Point",
      status: "READY",
      productCount: 2,
      snapshotData: [
        {
          productId: "5001",
          title: "Wool Coat",
          snapshotData: {
            id: "gid://shopify/Product/5001",
            title: "Wool Coat",
            metafields: [{ namespace: "custom", key: "care", value: "dry clean", type: "single_line_text_field" }],
          },
        },
        { productId: "5002", title: "Linen Shirt", snapshotData: { id: "gid://shopify/Product/5002", title: "Linen Shirt" } },
      ],
    },
  });

  await prisma.changeEvent.create({
    data: {
      shop: SHOP_CLOUD,
      productId: "5001",
      productTitle: "Wool Coat",
      fieldName: "variant.price",
      oldValue: "200.00",
      newValue: "20.00",
      changedAt: new Date(Date.now() - 1000),
    },
  });

  await test("serialized export carries real product data (the productData bug)", async () => {
    const json = JSON.parse(await serializeRestorePoint(rp.id));
    const products = json.restorePoint.snapshotData;
    assert.ok(Array.isArray(products), "snapshotData must be an array");
    assert.strictEqual(products.length, 2, "both products must be exported");
    assert.strictEqual(products[0].title, "Wool Coat");
  });

  await test("serialized export includes product metafields", async () => {
    const json = JSON.parse(await serializeRestorePoint(rp.id));
    const mf = json.restorePoint.snapshotData[0].snapshotData.metafields;
    assert.ok(Array.isArray(mf) && mf.length === 1, "metafields must survive export");
    assert.strictEqual(mf[0].key, "care");
  });

  await test("change events export fieldName, not undefined", async () => {
    const json = JSON.parse(await serializeRestorePoint(rp.id));
    const ev = json.changeEventsSnapshot[0];
    assert.ok(ev, "expected a change event");
    assert.strictEqual(ev.fieldName, "variant.price");
    assert.ok(!("field" in ev) || ev.field !== undefined);
  });

  await test("provider status reports unconfigured providers honestly", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const statuses = getCloudProviderStatus();
    const gd = statuses.find((s) => s.id === "GOOGLE_DRIVE");
    assert.strictEqual(gd.configured, false);
    assert.ok(gd.missingEnv.includes("GOOGLE_CLIENT_ID"));
    assert.strictEqual(isProviderConfigured("GOOGLE_DRIVE"), false);
  });

  await test("sync refuses when the provider is not connected", async () => {
    const res = await syncRestorePointToCloud(SHOP_CLOUD, rp.id);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /not connected/i);
  });

  await test("sync refuses a restore point belonging to another shop", async () => {
    await prisma.appSettings.update({
      where: { shop: SHOP_CLOUD },
      data: { cloudSyncConnected: true, cloudSyncProvider: "GOOGLE_DRIVE" },
    });
    process.env.GOOGLE_CLIENT_ID = "test-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";

    const otherRp = await prisma.restorePoint.create({
      data: { shop: "someone-else.myshopify.com", name: "Not Yours", status: "READY" },
    });
    const res = await syncRestorePointToCloud(SHOP_CLOUD, otherRp.id);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /not found/i);

    await prisma.restorePoint.delete({ where: { id: otherRp.id } });
  });

  await test("a failed upload records FAILED rather than a false SYNCED", async () => {
    // Connected with credentials present but no usable token: the upload must
    // fail and the failure must be visible on the restore point.
    const res = await syncRestorePointToCloud(SHOP_CLOUD, rp.id);
    assert.strictEqual(res.success, false, "upload should fail without a token");

    const after = await prisma.restorePoint.findUnique({ where: { id: rp.id } });
    assert.strictEqual(after.cloudSyncStatus, "FAILED");
    assert.strictEqual(after.cloudSyncedAt, null, "must not claim a sync time");
  });

  await test("token columns exist in the database", async () => {
    const cols = await prisma.$queryRawUnsafe("SHOW COLUMNS FROM `AppSettings`");
    const names = cols.map((c) => c.Field);
    for (const c of ["cloudSyncAccessToken", "cloudSyncRefreshToken", "cloudSyncTokenExpiry"]) {
      assert.ok(names.includes(c), `${c} missing from AppSettings`);
    }
  });

  await test("signed OAuth state round-trips and rejects tampering", async () => {
    process.env.SHOPIFY_API_SECRET = "unit-test-secret";
    const { createOAuthState, verifyOAuthState } = await import("../app/cloudOAuth.server.js");

    const state = createOAuthState(SHOP_CLOUD, "GOOGLE_DRIVE");
    const ok = verifyOAuthState(state, "GOOGLE_DRIVE");
    assert.strictEqual(ok.shop, SHOP_CLOUD);

    // Forged state for a different shop must not verify.
    const forged = Buffer.from(
      JSON.stringify({ shop: "victim.myshopify.com", provider: "GOOGLE_DRIVE", exp: Date.now() + 60000 }),
    ).toString("base64url");
    assert.throws(() => verifyOAuthState(`${forged}.deadbeef`, "GOOGLE_DRIVE"), /signature/i);

    // Provider must match what was requested.
    assert.throws(() => verifyOAuthState(state, "DROPBOX"), /provider/i);
  });
}

// ───────────────────────────────────────────── Feature 8: multi-user
async function testMultiUser() {
  console.log("\n▶ Feature 8 — Multi-user support");

  const { resolveActor, checkPermission, getAlertRecipients, assertNotLastOwner, logAudit } =
    await import("../app/team.server.js");
  const { roleCan, PERMISSIONS } = await import("../app/team.constants.js");

  await test("role matrix denies VIEWER destructive actions", () => {
    assert.strictEqual(roleCan("VIEWER", PERMISSIONS.VIEW), true);
    assert.strictEqual(roleCan("VIEWER", PERMISSIONS.RESTORE), false);
    assert.strictEqual(roleCan("VIEWER", PERMISSIONS.BACKUP_DELETE), false);
  });

  await test("EDITOR may restore but not manage team or billing", () => {
    assert.strictEqual(roleCan("EDITOR", PERMISSIONS.RESTORE), true);
    assert.strictEqual(roleCan("EDITOR", PERMISSIONS.TEAM_MANAGE), false);
    assert.strictEqual(roleCan("EDITOR", PERMISSIONS.BILLING_MANAGE), false);
  });

  await test("only OWNER may manage billing", () => {
    assert.strictEqual(roleCan("OWNER", PERMISSIONS.BILLING_MANAGE), true);
    assert.strictEqual(roleCan("ADMIN", PERMISSIONS.BILLING_MANAGE), false);
  });

  await test("first caller is auto-provisioned as OWNER", async () => {
    const actor = await resolveActor(SHOP_TEAM, { shop: SHOP_TEAM, email: "founder@store.com", firstName: "Ada" });
    assert.strictEqual(actor.role, "OWNER");
    assert.strictEqual(actor.provisioned, true);

    const count = await prisma.teamMember.count({ where: { shop: SHOP_TEAM } });
    assert.strictEqual(count, 1);
  });

  await test("a VIEWER is refused a restore", async () => {
    await prisma.teamMember.create({
      data: { shop: SHOP_TEAM, email: "viewer@store.com", role: "VIEWER", status: "ACTIVE" },
    });
    const res = await checkPermission(SHOP_TEAM, { shop: SHOP_TEAM, email: "viewer@store.com" }, PERMISSIONS.RESTORE);
    assert.strictEqual(res.allowed, false);
    assert.match(res.message, /VIEWER/);
  });

  await test("an EDITOR is allowed a restore", async () => {
    await prisma.teamMember.create({
      data: { shop: SHOP_TEAM, email: "editor@store.com", role: "EDITOR", status: "ACTIVE" },
    });
    const res = await checkPermission(SHOP_TEAM, { shop: SHOP_TEAM, email: "editor@store.com" }, PERMISSIONS.RESTORE);
    assert.strictEqual(res.allowed, true);
  });

  await test("a SUSPENDED member is downgraded to read-only", async () => {
    await prisma.teamMember.create({
      data: { shop: SHOP_TEAM, email: "gone@store.com", role: "ADMIN", status: "SUSPENDED" },
    });
    const res = await checkPermission(SHOP_TEAM, { shop: SHOP_TEAM, email: "gone@store.com" }, PERMISSIONS.RESTORE);
    assert.strictEqual(res.allowed, false, "a suspended admin must not restore");
  });

  await test("the last owner cannot be removed", async () => {
    const owner = await prisma.teamMember.findFirst({ where: { shop: SHOP_TEAM, role: "OWNER" } });
    const guard = await assertNotLastOwner(SHOP_TEAM, owner.id);
    assert.strictEqual(guard.ok, false);
    assert.match(guard.message, /only owner/i);
  });

  await test("a second owner makes the first removable", async () => {
    const second = await prisma.teamMember.create({
      data: { shop: SHOP_TEAM, email: "coowner@store.com", role: "OWNER", status: "ACTIVE" },
    });
    const owner = await prisma.teamMember.findFirst({ where: { shop: SHOP_TEAM, role: "OWNER" } });
    const guard = await assertNotLastOwner(SHOP_TEAM, owner.id);
    assert.strictEqual(guard.ok, true);
    await prisma.teamMember.delete({ where: { id: second.id } });
  });

  await test("alerts fan out to opted-in members, de-duplicated", async () => {
    await prisma.teamMember.updateMany({
      where: { shop: SHOP_TEAM, email: "editor@store.com" },
      data: { alertsEnabled: true, status: "ACTIVE" },
    });
    await prisma.teamMember.updateMany({
      where: { shop: SHOP_TEAM, email: "viewer@store.com" },
      data: { alertsEnabled: false },
    });

    const settings = { alertEmail: "Founder@store.com" };
    const recipients = await getAlertRecipients(SHOP_TEAM, settings);

    assert.ok(recipients.includes("editor@store.com"), "opted-in member must receive alerts");
    assert.ok(!recipients.includes("viewer@store.com"), "opted-out member must not");
    assert.strictEqual(
      recipients.filter((r) => r === "founder@store.com").length,
      1,
      "the shop alert email must not be duplicated against the roster",
    );
  });

  await test("audit entries are written with the acting user", async () => {
    const actor = { email: "editor@store.com", member: { name: "Ed" } };
    await logAudit(SHOP_TEAM, actor, "PRODUCT_RESTORE_BULK", {
      resourceType: "Product",
      resourceId: 42,
      details: { targetCount: 3 },
    });
    const log = await prisma.auditLog.findFirst({
      where: { shop: SHOP_TEAM, action: "PRODUCT_RESTORE_BULK" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(log, "audit entry should exist");
    assert.strictEqual(log.userEmail, "editor@store.com");
    assert.strictEqual(log.resourceId, "42");
  });
}

// ───────────────────────────────────────────── Feature 11: uptime monitoring
async function testUptime() {
  console.log("\n▶ Feature 11 — Downtime monitoring");

  const { validateServiceUrl, checkService, ensureDefaultServices, runDueServiceChecks } =
    await import("../app/uptime.server.js");

  await prisma.appSettings.create({ data: { shop: SHOP_UPTIME } });

  await test("SSRF guard rejects loopback", async () => {
    const r = await validateServiceUrl("http://127.0.0.1/health");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /private|loopback/i);
  });

  await test("SSRF guard rejects localhost by name", async () => {
    const r = await validateServiceUrl("http://localhost:3000/");
    assert.strictEqual(r.ok, false);
  });

  await test("SSRF guard rejects cloud metadata address", async () => {
    const r = await validateServiceUrl("http://169.254.169.254/latest/meta-data/");
    assert.strictEqual(r.ok, false);
  });

  await test("SSRF guard rejects private ranges", async () => {
    for (const u of ["http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.9/"]) {
      const r = await validateServiceUrl(u);
      assert.strictEqual(r.ok, false, `${u} should be rejected`);
    }
  });

  await test("SSRF guard rejects non-standard ports", async () => {
    const r = await validateServiceUrl("https://example.com:8080/");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /port/i);
  });

  await test("SSRF guard rejects non-http schemes", async () => {
    const r = await validateServiceUrl("file:///etc/passwd");
    assert.strictEqual(r.ok, false);
  });

  await test("SSRF guard accepts a public https URL", async () => {
    const r = await validateServiceUrl("https://example.com/health");
    assert.strictEqual(r.ok, true);
  });

  await test("an unreachable service is recorded DOWN", async () => {
    const svc = await prisma.monitoredService.create({
      data: {
        shop: SHOP_UPTIME,
        name: "Broken Service",
        // Blocked by the guard, so no network call is made and it fails fast.
        url: "http://127.0.0.1/health",
        serviceType: "CUSTOM",
      },
    });
    const res = await checkService(svc);
    assert.strictEqual(res.status, "DOWN");

    const check = await prisma.downtimeCheck.findFirst({ where: { serviceId: svc.id } });
    assert.ok(check, "a DowntimeCheck row must be written");
    assert.strictEqual(check.isUp, false);

    const updated = await prisma.monitoredService.findUnique({ where: { id: svc.id } });
    assert.strictEqual(updated.status, "DOWN");
    assert.ok(updated.lastCheckAt, "lastCheckAt must be stamped");
  });

  await test("uptime percent reflects the check history", async () => {
    const svc = await prisma.monitoredService.findFirst({ where: { shop: SHOP_UPTIME, name: "Broken Service" } });
    assert.strictEqual(svc.uptimePercent, 0, "all checks failed, so uptime is 0%");
  });

  await test("default services are seeded once, idempotently", async () => {
    const first = await ensureDefaultServices(SHOP_QA);
    assert.ok(first.created > 0, "expected seeding on first call");
    const second = await ensureDefaultServices(SHOP_QA);
    assert.strictEqual(second.created, 0, "second call must not duplicate");

    await prisma.downtimeCheck.deleteMany({ where: { shop: SHOP_QA } });
    await prisma.monitoredService.deleteMany({ where: { shop: SHOP_QA } });
  });

  await test("the sweep only checks services that are due", async () => {
    await prisma.monitoredService.updateMany({
      where: { shop: SHOP_UPTIME },
      data: { lastCheckAt: new Date(), checkIntervalMinutes: 60 },
    });
    const res = await runDueServiceChecks();
    const ourService = res.results.find((r) => r.name === "Broken Service");
    assert.strictEqual(ourService, undefined, "a recently-checked service must be skipped");
  });
}

// ───────────────────────────────────────────── Feature 10: QA suite
async function testQaSuite() {
  console.log("\n▶ Feature 10 — Automated QA testing");

  const { runQaSuite } = await import("../app/qa.server.js");

  await prisma.appSettings.create({
    data: {
      shop: SHOP_QA,
      planId: "enterprise",
      autoBackupSchedule: "DAILY",
      autoBackupTime: "02:00",
      nextAutoBackupAt: new Date(Date.now() + 3600_000),
    },
  });

  await test("an unhealthy store fails the baseline and backup checks", async () => {
    const res = await runQaSuite(SHOP_QA);
    const baseline = res.checks.find((c) => c.id === "baseline_snapshot");
    const backup = res.checks.find((c) => c.id === "restore_point_integrity");

    assert.strictEqual(baseline.status, "FAIL", "no snapshots means FAIL");
    assert.strictEqual(backup.status, "FAIL", "no restore points means FAIL");
    assert.strictEqual(res.status, "FAILED");
    assert.ok(res.healthScore < 60, `score should be low, got ${res.healthScore}`);
  });

  await test("remediation guidance is provided for failures", async () => {
    const run = await prisma.qaTestRun.findFirst({ where: { shop: SHOP_QA }, orderBy: { testedAt: "desc" } });
    const failing = run.testResults.filter((c) => c.status !== "PASS");
    assert.ok(failing.length > 0);
    assert.ok(failing.every((c) => c.remediation), "every non-passing check needs a fix hint");
  });

  await test("a healthy store passes the baseline and backup checks", async () => {
    await prisma.productSnapshot.create({
      data: {
        shop: SHOP_QA,
        productId: "9001",
        title: "Healthy Product",
        status: "ACTIVE",
        snapshotData: { id: "gid://shopify/Product/9001", title: "Healthy Product" },
      },
    });
    await prisma.restorePoint.create({
      data: {
        shop: SHOP_QA,
        name: "Fresh Backup",
        status: "READY",
        productCount: 1,
        snapshotData: [
          { productId: "9001", title: "Healthy Product", snapshotData: { id: "gid://shopify/Product/9001" } },
        ],
      },
    });
    await prisma.detectionRule.create({
      data: { shop: SHOP_QA, name: "Price crash", field: "price", condition: "DECREASE_BY_PERCENT", threshold: 30 },
    });

    const res = await runQaSuite(SHOP_QA);
    const baseline = res.checks.find((c) => c.id === "baseline_snapshot");
    const backup = res.checks.find((c) => c.id === "restore_point_integrity");

    assert.strictEqual(baseline.status, "PASS");
    assert.strictEqual(backup.status, "PASS");
    assert.ok(res.healthScore > 60, `score should recover, got ${res.healthScore}`);
  });

  await test("a corrupt backup payload is detected", async () => {
    await prisma.restorePoint.deleteMany({ where: { shop: SHOP_QA } });
    await prisma.restorePoint.create({
      data: { shop: SHOP_QA, name: "Corrupt Backup", status: "READY", productCount: 5, snapshotData: undefined },
    });

    const res = await runQaSuite(SHOP_QA);
    const backup = res.checks.find((c) => c.id === "restore_point_integrity");
    assert.strictEqual(backup.status, "FAIL", "a backup with no payload must FAIL");
    assert.match(backup.message, /no readable product payload/i);
  });

  await test("an out-of-range detection rule threshold is caught", async () => {
    await prisma.detectionRule.create({
      data: { shop: SHOP_QA, name: "Impossible", field: "price", condition: "DECREASE_BY_PERCENT", threshold: 500 },
    });
    const res = await runQaSuite(SHOP_QA);
    const rules = res.checks.find((c) => c.id === "detection_rules");
    assert.strictEqual(rules.status, "FAIL");
    assert.match(rules.message, /never trigger/i);
  });

  await test("a stalled scheduler is detected", async () => {
    await prisma.appSettings.update({
      where: { shop: SHOP_QA },
      data: { nextAutoBackupAt: new Date(Date.now() - 6 * 3600_000) },
    });
    const res = await runQaSuite(SHOP_QA);
    const sched = res.checks.find((c) => c.id === "backup_schedule");
    assert.strictEqual(sched.status, "FAIL");
    assert.match(sched.message, /has not run/i);
  });

  await test("runs are persisted with a score and results", async () => {
    const runs = await prisma.qaTestRun.findMany({ where: { shop: SHOP_QA } });
    assert.ok(runs.length >= 5, `expected several persisted runs, got ${runs.length}`);
    assert.ok(Array.isArray(runs[0].testResults));
    assert.ok(typeof runs[0].healthScore === "number");
  });

  await prisma.detectionRule.deleteMany({ where: { shop: SHOP_QA } });
}

// ───────────────────────────────────────────── Features 4 & 5
async function testStorageAndRetention() {
  console.log("\n▶ Features 4 & 5 — Storage reporting and retention");

  const { calculateStoreStorageUsage, enforceBackupRetentionPolicy } = await import(
    "../app/backup.server.js"
  );
  const { getPlanLimits } = await import("../app/billing.server.js");

  await test("enterprise retention is a full 365 days", () => {
    assert.strictEqual(getPlanLimits("enterprise").retentionDays, 365);
  });

  await test("storage usage counts every payload column", async () => {
    const shop = SHOP_LOCK;
    await prisma.appSettings.create({ data: { shop, planId: "enterprise" } });
    await prisma.restorePoint.create({
      data: {
        shop,
        name: "Sized Backup",
        status: "READY",
        snapshotData: [{ productId: "1", title: "x".repeat(500) }],
        menuData: [{ title: "y".repeat(500) }],
        orderData: [{ id: "z".repeat(500) }],
      },
    });

    const usage = await calculateStoreStorageUsage(shop);
    // menuData/orderData were previously ignored, undercounting by ~1KB.
    assert.ok(usage.totalBytes > 1400, `expected all columns counted, got ${usage.totalBytes}`);
    assert.strictEqual(usage.isUnlimited, true);
    assert.ok(usage.formattedSize.match(/MB|GB/));
  });

  await test("retention prunes history past the plan window but keeps the newest two", async () => {
    const shop = SHOP_LOCK;
    const old = new Date(Date.now() - 400 * 86400_000);

    for (let i = 0; i < 4; i++) {
      await prisma.restorePoint.create({
        data: { shop, name: `Ancient ${i}`, status: "READY", createdAt: old },
      });
    }
    await prisma.changeEvent.create({
      data: { shop, productId: "1", productTitle: "Old", fieldName: "price", changedAt: old },
    });

    const before = await prisma.restorePoint.count({ where: { shop } });
    const res = await enforceBackupRetentionPolicy(shop);
    const after = await prisma.restorePoint.count({ where: { shop } });

    assert.strictEqual(res.retentionDays, 365);
    assert.ok(res.deletedRestorePoints > 0, "expired points should be pruned");
    assert.strictEqual(res.deletedChangeEvents, 1);
    assert.ok(after >= 2, "the two newest restore points are always retained");
    assert.ok(after < before);
  });

  await test("retention sweeps shops with backups switched off", async () => {
    const { enforceRetentionForAllShops } = await import("../app/scheduler.server.js");
    await prisma.appSettings.update({
      where: { shop: SHOP_LOCK },
      data: { autoBackupSchedule: "OFF" },
    });

    const res = await enforceRetentionForAllShops();
    assert.ok(res.sweptShops > 0, "shops with backups off must still be swept");
  });
}

async function main() {
  console.log("═".repeat(70));
  console.log(" Revertly — audit remediation verification");
  console.log("═".repeat(70));

  await cleanup();

  await testCronAndLocking();
  await testCloudSync();
  await testMultiUser();
  await testUptime();
  await testQaSuite();
  await testStorageAndRetention();

  await cleanup();
  await prisma.$disconnect();

  console.log("\n" + "═".repeat(70));
  console.log(` Passed: ${passed}   Failed: ${failed}`);
  console.log("═".repeat(70));

  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  • ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("\nFATAL:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
