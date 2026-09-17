import assert from "node:assert";
import prisma from "../app/db.server.js";
import { logAudit } from "../app/team.server.js";
import { seedDefaultDetectionRules } from "../app/monitor.server.js";

console.log("===============================================================");
console.log("    REVERTLY INCIDENTS & RULES LIVE DATA FLOW INTEGRATION      ");
console.log("===============================================================\n");

const TEST_SHOP = "quickstart-749ac396.myshopify.com";
const mockSession = { shop: TEST_SHOP, id: "test-admin-session" };

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    failedTests++;
  }
}

// Emulate app.incidents.jsx loader logic
async function runIncidentsLoader(urlStr) {
  const shop = TEST_SHOP;
  const url = new URL(urlStr, "https://localhost");

  const rawStatus = (url.searchParams.get("status") || "").trim().toUpperCase();
  const validStatuses = ["OPEN", "RESOLVED", "ROLLED_BACK", "IGNORED"];
  const currentStatus = validStatuses.includes(rawStatus) ? rawStatus : "";

  const searchQuery = (url.searchParams.get("q") || "").trim();
  const rawSeverity = (url.searchParams.get("severity") || "").trim().toUpperCase();
  const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const currentSeverity = validSeverities.includes(rawSeverity) ? rawSeverity : "";

  const whereClause = {
    shop,
    ...(currentStatus ? { status: currentStatus } : {}),
    ...(currentSeverity ? { severity: currentSeverity } : {}),
    ...(searchQuery
      ? {
          OR: [
            { name: { contains: searchQuery } },
            { notes: { contains: searchQuery } },
          ],
        }
      : {}),
  };

  const [incidents, totalCount, openCount, resolvedCount, rolledBackCount, ignoredCount] = await Promise.all([
    prisma.incident.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        _count: { select: { changes: true } },
      },
    }),
    prisma.incident.count({ where: { shop } }),
    prisma.incident.count({ where: { shop, status: "OPEN" } }),
    prisma.incident.count({ where: { shop, status: "RESOLVED" } }),
    prisma.incident.count({ where: { shop, status: "ROLLED_BACK" } }),
    prisma.incident.count({ where: { shop, status: "IGNORED" } }),
  ]);

  return {
    incidents,
    currentStatus,
    currentSeverity,
    searchQuery,
    counts: {
      total: totalCount,
      open: openCount,
      resolved: resolvedCount,
      rolledBack: rolledBackCount,
      ignored: ignoredCount,
    },
  };
}

// Emulate app.incidents.jsx action logic
async function runIncidentsAction(intent, incidentId) {
  const shop = TEST_SHOP;
  const id = parseInt(incidentId, 10);
  if (!id || isNaN(id)) return { success: false, message: "Invalid incident ID." };

  const incident = await prisma.incident.findFirst({ where: { id, shop } });
  if (!incident) return { success: false, message: "Incident not found." };

  if (intent === "resolve") {
    await prisma.incident.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await logAudit(shop, mockSession, "INCIDENT_RESOLVE", { incidentId: id, name: incident.name });
    return { success: true, message: `Incident "${incident.name}" marked as resolved.` };
  }

  if (intent === "ignore") {
    await prisma.incident.update({
      where: { id },
      data: { status: "IGNORED", resolvedAt: new Date() },
    });
    await logAudit(shop, mockSession, "INCIDENT_IGNORE", { incidentId: id, name: incident.name });
    return { success: true, message: `Incident "${incident.name}" ignored.` };
  }

  if (intent === "reopen") {
    await prisma.incident.update({
      where: { id },
      data: { status: "OPEN", resolvedAt: null },
    });
    await logAudit(shop, mockSession, "INCIDENT_REOPEN", { incidentId: id, name: incident.name });
    return { success: true, message: `Incident "${incident.name}" reopened as Open.` };
  }

  return { success: false, message: "Action failed." };
}

// Emulate app.rules.jsx action logic
async function runRulesAction(intent, data = {}) {
  const shop = TEST_SHOP;

  if (intent === "create") {
    const { name, field = "price", condition = "CHANGED", threshold = null, minProducts = 1, severity = "HIGH" } = data;
    if (!name) return { success: false, message: "Name required" };
    const created = await prisma.detectionRule.create({
      data: {
        shop,
        name,
        field,
        condition,
        threshold: threshold ? parseFloat(threshold) : null,
        minProducts: minProducts ? parseInt(minProducts, 10) : 1,
        severity,
        isActive: true,
      },
    });
    return { success: true, rule: created };
  }

  if (intent === "toggle") {
    const id = parseInt(data.ruleId, 10);
    const rule = await prisma.detectionRule.findUnique({ where: { id } });
    if (rule && rule.shop === shop) {
      const updated = await prisma.detectionRule.update({
        where: { id },
        data: { isActive: !rule.isActive },
      });
      return { success: true, rule: updated };
    }
    return { success: false, message: "Rule not found" };
  }

  if (intent === "delete") {
    const id = parseInt(data.ruleId, 10);
    const rule = await prisma.detectionRule.findUnique({ where: { id } });
    if (rule && rule.shop === shop) {
      await prisma.incident.updateMany({
        where: { triggeredRuleId: id },
        data: { triggeredRuleId: null },
      });
      await prisma.detectionRule.delete({ where: { id } });
      return { success: true };
    }
    return { success: false, message: "Rule not found" };
  }

  if (intent === "seed_defaults") {
    const created = await seedDefaultDetectionRules(shop);
    return { success: true, count: created.length };
  }

  return { success: false };
}

async function run() {
  try {
    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 1: LOADER VERIFICATION ON QUICKSTART STORE
    // ─────────────────────────────────────────────────────────────
    console.log("--- TEST GROUP 1: INCIDENTS LOADER ON LIVE DB ---");

    let initialData;
    await test("1.1 Incidents loader returns accurate counts and incidents", async () => {
      initialData = await runIncidentsLoader("https://localhost/app/incidents");
      assert.ok(initialData, "Loader returned data");
      assert.strictEqual(typeof initialData.counts.total, "number");
      assert.ok(initialData.counts.total >= 1, "At least 1 incident exists");
      assert.ok(Array.isArray(initialData.incidents));
      console.log(`     Counts -> Total: ${initialData.counts.total}, Open: ${initialData.counts.open}, Resolved: ${initialData.counts.resolved}, RolledBack: ${initialData.counts.rolledBack}, Ignored: ${initialData.counts.ignored}`);
    });

    const targetIncident = initialData.incidents[0];
    assert.ok(targetIncident, "Target incident exists for testing actions");
    const targetIncidentId = targetIncident.id;

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 2: STATUS CASING & FILTER NORMALIZATION
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- TEST GROUP 2: STATUS CASING & FILTER NORMALIZATION ---");

    await test("2.1 Lowercase status query (?status=open) normalizes to OPEN", async () => {
      const data = await runIncidentsLoader("https://localhost/app/incidents?status=open");
      assert.strictEqual(data.currentStatus, "OPEN", "currentStatus normalized to uppercase OPEN");
      assert.strictEqual(data.incidents.length, data.counts.open, "Incident count matches open count");
    });

    await test("2.2 Lowercase status query (?status=resolved) normalizes to RESOLVED", async () => {
      const data = await runIncidentsLoader("https://localhost/app/incidents?status=resolved");
      assert.strictEqual(data.currentStatus, "RESOLVED", "currentStatus normalized to uppercase RESOLVED");
    });

    await test("2.3 Invalid status query (?status=junk) safely falls back to all", async () => {
      const data = await runIncidentsLoader("https://localhost/app/incidents?status=junk");
      assert.strictEqual(data.currentStatus, "", "Safely defaults to empty status");
    });

    await test("2.4 Search query filters incidents", async () => {
      const data = await runIncidentsLoader(`https://localhost/app/incidents?q=${encodeURIComponent(targetIncident.name.substring(0, 8))}`);
      assert.ok(data.incidents.length >= 1, "Found matching incident by search query");
    });

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 3: ACTION HANDLERS & STATUS TRANSITIONS
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- TEST GROUP 3: ACTION HANDLERS & STATUS TRANSITIONS ---");

    await test("3.1 Action: Resolve incident", async () => {
      const res = await runIncidentsAction("resolve", targetIncidentId);
      assert.strictEqual(res.success, true, "Resolve succeeded");

      const inc = await prisma.incident.findUnique({ where: { id: targetIncidentId } });
      assert.strictEqual(inc.status, "RESOLVED");
      assert.ok(inc.resolvedAt);

      const audit = await prisma.auditLog.findFirst({
        where: { shop: TEST_SHOP, action: "INCIDENT_RESOLVE" },
        orderBy: { createdAt: "desc" },
      });
      assert.ok(audit, "Audit log created for INCIDENT_RESOLVE");
    });

    await test("3.2 Action: Reopen incident back to OPEN", async () => {
      const res = await runIncidentsAction("reopen", targetIncidentId);
      assert.strictEqual(res.success, true, "Reopen succeeded");

      const inc = await prisma.incident.findUnique({ where: { id: targetIncidentId } });
      assert.strictEqual(inc.status, "OPEN");
      assert.strictEqual(inc.resolvedAt, null);

      const audit = await prisma.auditLog.findFirst({
        where: { shop: TEST_SHOP, action: "INCIDENT_REOPEN" },
        orderBy: { createdAt: "desc" },
      });
      assert.ok(audit, "Audit log created for INCIDENT_REOPEN");
    });

    await test("3.3 Action: Ignore incident", async () => {
      const res = await runIncidentsAction("ignore", targetIncidentId);
      assert.strictEqual(res.success, true, "Ignore succeeded");

      const inc = await prisma.incident.findUnique({ where: { id: targetIncidentId } });
      assert.strictEqual(inc.status, "IGNORED");
    });

    await test("3.4 Action: Reopen ignored incident back to OPEN", async () => {
      const res = await runIncidentsAction("reopen", targetIncidentId);
      assert.strictEqual(res.success, true);

      const inc = await prisma.incident.findUnique({ where: { id: targetIncidentId } });
      assert.strictEqual(inc.status, "OPEN");
    });

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 4: DETECTION RULES & SAFE DELETION
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- TEST GROUP 4: DETECTION RULES & SAFE DELETION ---");

    let tempRuleId = null;
    await test("4.1 Create custom rule with minProducts: 1 and condition: CHANGED", async () => {
      const res = await runRulesAction("create", {
        name: "Temporary Integration Rule",
        field: "title",
        condition: "CHANGED",
        minProducts: "1",
        severity: "MEDIUM",
      });
      assert.strictEqual(res.success, true, "Rule created");
      tempRuleId = res.rule.id;
    });

    await test("4.2 Toggle rule active status", async () => {
      assert.ok(tempRuleId);
      const res = await runRulesAction("toggle", { ruleId: tempRuleId });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.rule.isActive, false);
    });

    await test("4.3 Safe rule deletion (foreign key protection)", async () => {
      assert.ok(tempRuleId);
      await prisma.incident.update({
        where: { id: targetIncidentId },
        data: { triggeredRuleId: tempRuleId },
      });

      const res = await runRulesAction("delete", { ruleId: tempRuleId });
      assert.strictEqual(res.success, true, "Rule deleted safely");

      const ruleAfter = await prisma.detectionRule.findUnique({ where: { id: tempRuleId } });
      assert.strictEqual(ruleAfter, null, "Rule removed from DB");

      const incAfter = await prisma.incident.findUnique({ where: { id: targetIncidentId } });
      assert.ok(incAfter, "Incident preserved");
      assert.strictEqual(incAfter.triggeredRuleId, null, "Incident triggeredRuleId safely unlinked");
    });

  } finally {
    await prisma.$disconnect();
  }

  console.log("\n===============================================================");
  console.log(`TOTAL INTEGRATION TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log("===============================================================");
  if (failedTests > 0) process.exit(1);
}

run();
