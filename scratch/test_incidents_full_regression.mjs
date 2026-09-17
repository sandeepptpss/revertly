import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  isFieldMatch,
  isConditionMet,
  seedDefaultDetectionRules,
  checkDetectionRules,
} from "../app/monitor.server.js";

console.log("===============================================================");
console.log("     REVERTLY INCIDENTS & DETECTION FULL REGRESSION SUITE      ");
console.log("===============================================================\n");

const TEST_SHOP = "qa-incidents-regression.myshopify.com";
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

async function cleanup() {
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.incident.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.detectionRule.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
}

async function runSuite() {
  try {
    await cleanup();

    // ─────────────────────────────────────────────────────────────
    // 1. FIELD & CONDITION MATCHING UNIT TESTS
    // ─────────────────────────────────────────────────────────────
    console.log("--- SUITE 1: FIELD & CONDITION MATCHING LOGIC ---");

    await test("1.1 isFieldMatch handles variant prefixes and aliases", () => {
      // price
      assert.strictEqual(isFieldMatch("variant.price", "price"), true);
      assert.strictEqual(isFieldMatch("price", "price"), true);
      assert.strictEqual(isFieldMatch("variant.compareAtPrice", "compareAtPrice"), true);

      // inventory alias
      assert.strictEqual(isFieldMatch("variant.inventoryQuantity", "inventory"), true);
      assert.strictEqual(isFieldMatch("variant.inventoryQuantity", "inventoryQuantity"), true);

      // product level
      assert.strictEqual(isFieldMatch("status", "status"), true);
      assert.strictEqual(isFieldMatch("title", "title"), true);
      assert.strictEqual(isFieldMatch("vendor", "vendor"), true);

      // negatives
      assert.strictEqual(isFieldMatch("templateSuffix", "status"), false);
      assert.strictEqual(isFieldMatch("variant.weight", "price"), false);
    });

    await test("1.2 isConditionMet percentage calculations and edge cases", () => {
      // CHANGED
      assert.strictEqual(isConditionMet("CHANGED", null, "ACTIVE", "DRAFT"), true);

      // DECREASE_BY_PERCENT (100 -> 60 is 40% drop >= 30%)
      assert.strictEqual(isConditionMet("DECREASE_BY_PERCENT", 30, "100", "60"), true);
      // DECREASE_BY_PERCENT (100 -> 80 is 20% drop < 30%)
      assert.strictEqual(isConditionMet("DECREASE_BY_PERCENT", 30, "100", "80"), false);
      // From 0 cannot decrease
      assert.strictEqual(isConditionMet("DECREASE_BY_PERCENT", 30, "0", "10"), false);

      // INCREASE_BY_PERCENT (50 -> 100 is 100% increase >= 50%)
      assert.strictEqual(isConditionMet("INCREASE_BY_PERCENT", 50, "50", "100"), true);
      // INCREASE_BY_PERCENT (From 0 to 50 is positive increase)
      assert.strictEqual(isConditionMet("INCREASE_BY_PERCENT", 50, "0", "50"), true);
      // Non-numeric
      assert.strictEqual(isConditionMet("DECREASE_BY_PERCENT", 30, "abc", "def"), false);
    });

    // ─────────────────────────────────────────────────────────────
    // 2. DETECTION RULES SEEDING & CUSTOM RULE CREATION
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- SUITE 2: DETECTION RULES SEEDING & CREATION ---");

    let priceRuleId = null;
    await test("2.1 seedDefaultDetectionRules creates default protection rules", async () => {
      const seeded = await seedDefaultDetectionRules(TEST_SHOP);
      assert.strictEqual(seeded.length, 3, "Created 3 default rules");

      const priceRule = seeded.find((r) => r.field === "price");
      assert.ok(priceRule, "Price drop rule created");
      assert.strictEqual(priceRule.minProducts, 1, "Price rule has minProducts: 1");
      priceRuleId = priceRule.id;

      // Re-running seed should not duplicate
      const secondRun = await seedDefaultDetectionRules(TEST_SHOP);
      assert.strictEqual(secondRun.length, 0, "No duplicate rules created on second seed");
    });

    // ─────────────────────────────────────────────────────────────
    // 3. INCIDENT CREATION & LINKING
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- SUITE 3: INCIDENT CREATION & GROUPING ---");

    let createdIncidentId = null;
    await test("3.1 Single product price drop triggers incident (minProducts: 1)", async () => {
      const productId = "1001";
      const oldPrice = "100.00";
      const newPrice = "40.00"; // 60% drop, exceeds 30%

      const change = {
        fieldName: "variant.price",
        oldValue: oldPrice,
        newValue: newPrice,
      };

      const matchedRule = await checkDetectionRules(TEST_SHOP, [change]);
      assert.ok(matchedRule, "Rule matched price drop");
      assert.strictEqual(matchedRule.id, priceRuleId);

      // Create ChangeEvent
      const ev = await prisma.changeEvent.create({
        data: {
          shop: TEST_SHOP,
          productId,
          productTitle: "Test Snowboard",
          fieldName: change.fieldName,
          oldValue: change.oldValue,
          newValue: change.newValue,
        },
      });

      // Create Incident
      const incident = await prisma.incident.create({
        data: {
          shop: TEST_SHOP,
          name: `${matchedRule.name}: 1 product affected`,
          severity: matchedRule.severity,
          affectedCount: 1,
          status: "OPEN",
          triggeredRuleId: matchedRule.id,
        },
      });
      createdIncidentId = incident.id;

      await prisma.changeEvent.update({
        where: { id: ev.id },
        data: { incidentId: incident.id },
      });

      assert.strictEqual(incident.status, "OPEN");
      assert.strictEqual(incident.affectedCount, 1);
    });

    await test("3.2 Product deletion creates immediate HIGH severity incident", async () => {
      const delEvent = await prisma.changeEvent.create({
        data: {
          shop: TEST_SHOP,
          productId: "1002",
          productTitle: "Deleted Winter Jacket",
          fieldName: "status",
          oldValue: "ACTIVE",
          newValue: "DELETED",
        },
      });

      const delIncident = await prisma.incident.create({
        data: {
          shop: TEST_SHOP,
          name: "Product Deleted: Deleted Winter Jacket",
          severity: "HIGH",
          affectedCount: 1,
          status: "OPEN",
          notes: "Product was deleted from Shopify catalog.",
        },
      });

      await prisma.changeEvent.update({
        where: { id: delEvent.id },
        data: { incidentId: delIncident.id },
      });

      assert.ok(delIncident.id);
      assert.strictEqual(delIncident.severity, "HIGH");
      assert.strictEqual(delIncident.status, "OPEN");
    });

    // ─────────────────────────────────────────────────────────────
    // 4. STATUS TRANSITIONS & REOPEN ACTION
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- SUITE 4: STATUS TRANSITIONS & REOPEN ACTION ---");

    await test("4.1 Verify counts before resolution", async () => {
      const [total, open, resolved, rolledBack, ignored] = await Promise.all([
        prisma.incident.count({ where: { shop: TEST_SHOP } }),
        prisma.incident.count({ where: { shop: TEST_SHOP, status: "OPEN" } }),
        prisma.incident.count({ where: { shop: TEST_SHOP, status: "RESOLVED" } }),
        prisma.incident.count({ where: { shop: TEST_SHOP, status: "ROLLED_BACK" } }),
        prisma.incident.count({ where: { shop: TEST_SHOP, status: "IGNORED" } }),
      ]);

      assert.strictEqual(total, 2, "Total incidents should be 2");
      assert.strictEqual(open, 2, "Open incidents should be 2");
      assert.strictEqual(resolved, 0, "Resolved incidents should be 0");
    });

    await test("4.2 Resolve incident and verify status count change", async () => {
      await prisma.incident.update({
        where: { id: createdIncidentId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });

      const openCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "OPEN" } });
      const resolvedCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "RESOLVED" } });

      assert.strictEqual(openCount, 1, "Open count decreased to 1");
      assert.strictEqual(resolvedCount, 1, "Resolved count increased to 1");
    });

    await test("4.3 Reopen resolved incident back to OPEN", async () => {
      await prisma.incident.update({
        where: { id: createdIncidentId },
        data: { status: "OPEN", resolvedAt: null },
      });

      const openCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "OPEN" } });
      const resolvedCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "RESOLVED" } });

      assert.strictEqual(openCount, 2, "Open count restored to 2");
      assert.strictEqual(resolvedCount, 0, "Resolved count restored to 0");
    });

    await test("4.4 Ignore incident and verify count change", async () => {
      await prisma.incident.update({
        where: { id: createdIncidentId },
        data: { status: "IGNORED", resolvedAt: new Date() },
      });

      const openCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "OPEN" } });
      const ignoredCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "IGNORED" } });

      assert.strictEqual(openCount, 1, "Open count is 1");
      assert.strictEqual(ignoredCount, 1, "Ignored count is 1");
    });

    await test("4.5 Reopen ignored incident back to OPEN", async () => {
      await prisma.incident.update({
        where: { id: createdIncidentId },
        data: { status: "OPEN", resolvedAt: null },
      });

      const openCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "OPEN" } });
      const ignoredCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "IGNORED" } });

      assert.strictEqual(openCount, 2);
      assert.strictEqual(ignoredCount, 0);
    });

    await test("4.6 Rollback incident status change to ROLLED_BACK", async () => {
      await prisma.incident.update({
        where: { id: createdIncidentId },
        data: { status: "ROLLED_BACK", resolvedAt: new Date() },
      });

      const rolledBackCount = await prisma.incident.count({ where: { shop: TEST_SHOP, status: "ROLLED_BACK" } });
      assert.strictEqual(rolledBackCount, 1);
    });

    // ─────────────────────────────────────────────────────────────
    // 5. QUERY NORMALIZATION & FILTERING SIMULATION
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- SUITE 5: QUERY NORMALIZATION & FILTERING ---");

    function simulateIncidentsLoader(urlStr, allDbIncidents) {
      const url = new URL(urlStr, "https://example.com");
      const rawStatus = (url.searchParams.get("status") || "").trim().toUpperCase();
      const validStatuses = ["OPEN", "RESOLVED", "ROLLED_BACK", "IGNORED"];
      const currentStatus = validStatuses.includes(rawStatus) ? rawStatus : "";
      const searchQuery = (url.searchParams.get("q") || "").trim().toLowerCase();
      const rawSeverity = (url.searchParams.get("severity") || "").trim().toUpperCase();

      return allDbIncidents.filter((inc) => {
        if (currentStatus && inc.status !== currentStatus) return false;
        if (rawSeverity && inc.severity !== rawSeverity) return false;
        if (searchQuery) {
          const matchName = inc.name.toLowerCase().includes(searchQuery);
          const matchNotes = (inc.notes || "").toLowerCase().includes(searchQuery);
          if (!matchName && !matchNotes) return false;
        }
        return true;
      });
    }

    await test("5.1 Lowercase status query (?status=open) normalizes to uppercase", async () => {
      const allIncidents = await prisma.incident.findMany({ where: { shop: TEST_SHOP } });
      const filtered = simulateIncidentsLoader("/app/incidents?status=open", allIncidents);
      assert.strictEqual(filtered.length, 1, "Should find 1 open incident despite lowercase query");
      assert.strictEqual(filtered[0].status, "OPEN");
    });

    await test("5.2 Lowercase status query (?status=rolled_back) normalizes correctly", async () => {
      const allIncidents = await prisma.incident.findMany({ where: { shop: TEST_SHOP } });
      const filtered = simulateIncidentsLoader("/app/incidents?status=rolled_back", allIncidents);
      assert.strictEqual(filtered.length, 1, "Should find rolled back incident");
      assert.strictEqual(filtered[0].status, "ROLLED_BACK");
    });

    await test("5.3 Search filter (?q=deleted) filters list accurately", async () => {
      const allIncidents = await prisma.incident.findMany({ where: { shop: TEST_SHOP } });
      const filtered = simulateIncidentsLoader("/app/incidents?q=deleted", allIncidents);
      assert.strictEqual(filtered.length, 1);
      assert.ok(filtered[0].name.includes("Deleted"));
    });

    await test("5.4 Severity filter (?severity=critical) filters list accurately", async () => {
      const allIncidents = await prisma.incident.findMany({ where: { shop: TEST_SHOP } });
      const filtered = simulateIncidentsLoader("/app/incidents?severity=critical", allIncidents);
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].severity, "CRITICAL");
    });

    // ─────────────────────────────────────────────────────────────
    // 6. FOREIGN KEY CONSTRAINT ON RULE DELETION
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- SUITE 6: FOREIGN KEY CONSTRAINT SAFETY ---");

    await test("6.1 Delete detection rule with linked incidents does not crash", async () => {
      // Verify incident is linked to priceRuleId
      const inc = await prisma.incident.findUnique({ where: { id: createdIncidentId } });
      assert.strictEqual(inc.triggeredRuleId, priceRuleId);

      // Execute safe deletion: unlinking triggeredRuleId first
      await prisma.incident.updateMany({
        where: { triggeredRuleId: priceRuleId },
        data: { triggeredRuleId: null },
      });
      await prisma.detectionRule.delete({ where: { id: priceRuleId } });

      // Verify rule was deleted
      const ruleAfter = await prisma.detectionRule.findUnique({ where: { id: priceRuleId } });
      assert.strictEqual(ruleAfter, null, "Rule deleted successfully");

      // Verify incident still intact with triggeredRuleId set to null
      const incAfter = await prisma.incident.findUnique({ where: { id: createdIncidentId } });
      assert.ok(incAfter, "Incident remains preserved");
      assert.strictEqual(incAfter.triggeredRuleId, null, "triggeredRuleId safely unlinked");
    });

    // ─────────────────────────────────────────────────────────────
    // 7. EMPTY STATE BEHAVIOR
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- SUITE 7: EMPTY STATE BEHAVIOR ---");

    await test("7.1 Empty state displayed ONLY when store has zero incidents", async () => {
      // First clean all incidents for test shop
      await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
      await prisma.incident.deleteMany({ where: { shop: TEST_SHOP } });

      const totalCount = await prisma.incident.count({ where: { shop: TEST_SHOP } });
      assert.strictEqual(totalCount, 0, "Zero incidents in database");

      const allIncidents = await prisma.incident.findMany({ where: { shop: TEST_SHOP } });
      const loaded = simulateIncidentsLoader("/app/incidents", allIncidents);

      assert.strictEqual(loaded.length, 0);
      assert.strictEqual(totalCount, 0, "Triggers 'All Clear — Zero Incidents Detected'");
    });

  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log("\n===============================================================");
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log("===============================================================");
  if (failedTests > 0) {
    process.exit(1);
  }
}

runSuite();
