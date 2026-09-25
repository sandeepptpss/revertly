import assert from "node:assert";
import prisma from "../app/db.server.js";
import { loader as rpExportLoader } from "../app/routes/app.restore-points_.$id_.export.jsx";
import { loader as vaultExportLoader } from "../app/routes/app.vault_.export.jsx";
import { loader as generalExportLoader } from "../app/routes/app.export.jsx";
import { setMockShop } from "./_qa_mock_admin.mjs";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";
setMockShop(TEST_SHOP);

async function runSiteWideExportQATests() {
  console.log("==================================================================");
  console.log("  SITE-WIDE QA AUDIT: All Export & Download Endpoints in Revertly  ");
  console.log("==================================================================\n");

  const rp = await prisma.restorePoint.findFirst({
    where: { shop: TEST_SHOP, status: "READY" },
    orderBy: { createdAt: "desc" },
  });
  const themeRp = await prisma.restorePoint.findFirst({
    where: { shop: TEST_SHOP, status: "READY", themeCount: { gt: 0 } },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Using reference Restore Point #${rp?.id || "None"} (${rp?.name || "N/A"}), Theme RP #${themeRp?.id}\n`);

  const checks = [
    // 1. Restore Point Detail & Archive Exports
    {
      name: "Restore Point Theme ZIP Export",
      loader: rpExportLoader,
      url: `http://localhost:3000/app/restore-points/${(themeRp || rp).id}/export?format=zip`,
      params: { id: String((themeRp || rp).id) },
      expectedContentType: "application/zip",
      expectedDisposition: ".zip",
    },
    {
      name: "Restore Point JSON Backup Export",
      loader: rpExportLoader,
      url: `http://localhost:3000/app/restore-points/${rp.id}/export`,
      params: { id: String(rp.id) },
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },

    // 2. Data Vault Exports
    {
      name: "Vault Orders Tax Audit CSV Export",
      loader: vaultExportLoader,
      url: `http://localhost:3000/app/vault/export?type=orders_csv`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },
    {
      name: "Vault Dispute Evidence JSON Export",
      loader: vaultExportLoader,
      url: `http://localhost:3000/app/vault/export?type=dispute_json`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Vault Customers CSV Export",
      loader: vaultExportLoader,
      url: `http://localhost:3000/app/vault/export?type=customers_csv`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },

    // 3. Import & Export Hub (All resource types)
    {
      name: "Hub Full Store Backup JSON",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=full_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Hub Products CSV Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=products_csv&rpId=${rp.id}`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },
    {
      name: "Hub Products JSON Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=products_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Hub Themes JSON Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=themes_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Hub Collections CSV Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=collections_csv&rpId=${rp.id}`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },
    {
      name: "Hub Collections JSON Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=collections_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Hub Pages CSV Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=pages_csv&rpId=${rp.id}`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },
    {
      name: "Hub Pages JSON Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=pages_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Hub Blogs & Articles CSV Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=blogs_csv&rpId=${rp.id}`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },
    {
      name: "Hub Blogs & Articles JSON Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=blogs_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
    {
      name: "Hub Navigation Menus CSV Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=menus_csv&rpId=${rp.id}`,
      params: {},
      expectedContentType: "text/csv",
      expectedDisposition: ".csv",
    },
    {
      name: "Hub Navigation Menus JSON Export",
      loader: generalExportLoader,
      url: `http://localhost:3000/app/export?type=menus_json&rpId=${rp.id}`,
      params: {},
      expectedContentType: "application/json",
      expectedDisposition: ".json",
    },
  ];

  let passed = 0;
  for (const c of checks) {
    try {
      const req = new Request(c.url);
      const res = await c.loader({ request: req, params: c.params });
      assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
      const ct = res.headers.get("Content-Type") || "";
      assert(ct.includes(c.expectedContentType), `Expected Content-Type ${c.expectedContentType}, got ${ct}`);
      const cd = res.headers.get("Content-Disposition") || "";
      assert(cd.includes(c.expectedDisposition), `Expected Content-Disposition to include ${c.expectedDisposition}, got ${cd}`);
      console.log(`  ✓ PASS: ${c.name} [HTTP ${res.status}, ${ct.split(";")[0]}, ${cd.split(";")[1]?.trim() || ""}]`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${c.name} -`, err.message || err);
      throw err;
    }
  }

  console.log(`\n==================================================================`);
  console.log(`  SITE-WIDE AUDIT PASSED: ${passed}/${checks.length} Export Endpoints Verified!`);
  console.log(`==================================================================\n`);
}

runSiteWideExportQATests()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("Site-wide QA Test Error:", e);
    prisma.$disconnect();
    process.exit(1);
  });
