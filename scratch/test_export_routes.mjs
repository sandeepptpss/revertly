import assert from "node:assert";
import prisma from "../app/db.server.js";
import { loader as exportLoader } from "../app/routes/app.export.jsx";
import { action as importAction } from "../app/routes/app.import-export.jsx";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

// Test route loader and action
async function runRouteTests() {
  console.log("=== TESTING EXPORT & IMPORT ROUTES ===");

  // 1. Check existing restore point for snapshot export
  const rp = await prisma.restorePoint.findFirst({
    where: { shop: TEST_SHOP },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Using restore point: #${rp?.id || "None"}`);

  // Test Collections CSV loader response
  console.log("\n[1] Testing collections_csv export loader...");
  const colReq = new Request(`http://localhost:3000/app/export?type=collections_csv${rp ? `&rpId=${rp.id}` : ""}`);
  const colRes = await exportLoader({ request: colReq });
  assert.strictEqual(colRes.status, 200);
  assert(colRes.headers.get("Content-Type").includes("text/csv"));
  assert(colRes.headers.get("Content-Disposition").includes("revertly-collections-"));
  const colCsvText = await colRes.text();
  assert(colCsvText.includes("Collection ID"));
  console.log("✓ collections_csv loader responded with valid CSV!");

  // Test Pages CSV loader response
  console.log("\n[2] Testing pages_csv export loader...");
  const pageReq = new Request(`http://localhost:3000/app/export?type=pages_csv${rp ? `&rpId=${rp.id}` : ""}`);
  const pageRes = await exportLoader({ request: pageReq });
  assert.strictEqual(pageRes.status, 200);
  assert(pageRes.headers.get("Content-Type").includes("text/csv"));
  assert(pageRes.headers.get("Content-Disposition").includes("revertly-pages-menus-"));
  const pageCsvText = await pageRes.text();
  assert(pageCsvText.includes("Record Type"));
  console.log("✓ pages_csv loader responded with valid CSV!");

  // Test Blogs CSV loader response
  console.log("\n[3] Testing blogs_csv export loader...");
  const blogReq = new Request(`http://localhost:3000/app/export?type=blogs_csv${rp ? `&rpId=${rp.id}` : ""}`);
  const blogRes = await exportLoader({ request: blogReq });
  assert.strictEqual(blogRes.status, 200);
  assert(blogRes.headers.get("Content-Type").includes("text/csv"));
  assert(blogRes.headers.get("Content-Disposition").includes("revertly-blogs-articles-"));
  const blogCsvText = await blogRes.text();
  assert(blogCsvText.includes("Record Type"));
  console.log("✓ blogs_csv loader responded with valid CSV!");

  // Test Import Action with CSV
  console.log("\n[4] Testing import action with collections CSV...");
  const formData = new FormData();
  formData.append("intent", "import");
  formData.append("importMode", "SAVE_AS_RESTORE_POINT");
  formData.append("backupFileContent", colCsvText);

  const importReq = new Request("http://localhost:3000/app/import-export", {
    method: "POST",
    body: formData,
  });

  const importRes = await importAction({ request: importReq });
  console.log("Import action result:", importRes);
  assert(importRes.success, "Import action should succeed for Collections CSV");
  assert(importRes.restorePoint, "Restore point should be created");
  console.log(`✓ CSV imported via route action: Restore Point #${importRes.restorePoint.id}`);

  // Clean up
  await prisma.restorePoint.delete({ where: { id: importRes.restorePoint.id } });

  console.log("\n=== ALL ROUTE TESTS PASSED SUCCESSFULLY! ===");
}

runRouteTests()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("Route test error:", e);
    prisma.$disconnect();
    process.exit(1);
  });
