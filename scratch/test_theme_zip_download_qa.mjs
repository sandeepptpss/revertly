import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import prisma from "../app/db.server.js";
import { loader as exportLoader } from "../app/routes/app.restore-points_.$id_.export.jsx";
import { setMockShop } from "./_qa_mock_admin.mjs";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";
setMockShop(TEST_SHOP);

async function runQAVerification() {
  console.log("=================================================");
  console.log("  QA VERIFICATION: Theme ZIP & Backup Downloads  ");
  console.log("=================================================\n");

  // [1] Verify Restore Point #1928 in Database
  console.log("[1] Verifying Restore Point #1928...");
  const rp = await prisma.restorePoint.findFirst({
    where: { id: 1928, shop: TEST_SHOP },
  });
  assert(rp, "Restore Point #1928 must exist in database");
  assert(rp.themeData, "Restore Point #1928 must contain themeData");
  const files = rp.themeData.files || [];
  console.log(`  ✓ Restore Point #${rp.id} found: "${rp.name}"`);
  console.log(`  ✓ Contains ${files.length} theme files`);
  assert(files.length > 0, "Theme files array must not be empty");

  // [2] Verify Theme ZIP Export Endpoint
  console.log("\n[2] Testing Theme ZIP Export Loader (/app/restore-points/1928/export?format=zip)...");
  const zipReq = new Request(`http://localhost:3000/app/restore-points/1928/export?format=zip`);
  const zipRes = await exportLoader({ request: zipReq, params: { id: "1928" } });

  assert.strictEqual(zipRes.status, 200, "ZIP export should respond with HTTP 200");
  assert.strictEqual(zipRes.headers.get("Content-Type"), "application/zip", "Content-Type must be application/zip");
  
  const disposition = zipRes.headers.get("Content-Disposition");
  assert(disposition, "Content-Disposition header must be set");
  assert(disposition.includes("shopify-theme-"), `Filename should start with shopify-theme-: ${disposition}`);
  assert(disposition.includes(".zip"), `Filename should end with .zip: ${disposition}`);
  console.log(`  ✓ Status: ${zipRes.status}`);
  console.log(`  ✓ Content-Type: ${zipRes.headers.get("Content-Type")}`);
  console.log(`  ✓ Content-Disposition: ${disposition}`);

  const zipArrayBuffer = await zipRes.arrayBuffer();
  const zipBuffer = Buffer.from(zipArrayBuffer);
  console.log(`  ✓ Archive Size: ${(zipBuffer.length / 1024).toFixed(1)} KB`);
  assert(zipBuffer.length > 100000, "ZIP buffer should contain substantial theme data");

  // [3] Verify ZIP Archive Validity with unzip tool
  console.log("\n[3] Testing ZIP archive integrity and unzip extraction...");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "revertly-qa-theme-"));
  const zipPath = path.join(tempDir, "theme.zip");
  fs.writeFileSync(zipPath, zipBuffer);

  // Test integrity
  execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
  console.log("  ✓ PKZIP integrity test passed (-t)");

  // Extract files
  const outDir = path.join(tempDir, "extracted");
  execFileSync("unzip", ["-qq", "-o", zipPath, "-d", outDir], { stdio: "pipe" });

  const extractedListing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  console.log(`  ✓ Extracted ${extractedListing.length} files from archive`);
  assert.strictEqual(extractedListing.length, files.length, "Extracted file count must match snapshot file count");

  // Verify critical theme files exist and are not empty
  const themeLiquidPath = path.join(outDir, "layout/theme.liquid");
  assert(fs.existsSync(themeLiquidPath), "layout/theme.liquid must exist in extracted theme");
  const themeLiquidContent = fs.readFileSync(themeLiquidPath, "utf8");
  assert(themeLiquidContent.length > 50, "layout/theme.liquid must not be empty");
  console.log(`  ✓ layout/theme.liquid verified (${themeLiquidContent.length} bytes)`);

  // Cleanup temp dir
  fs.rmSync(tempDir, { recursive: true, force: true });

  // [4] Verify Offline Backup JSON Export
  console.log("\n[4] Testing JSON Offline Backup Loader (/app/restore-points/1928/export)...");
  const jsonReq = new Request(`http://localhost:3000/app/restore-points/1928/export`);
  const jsonRes = await exportLoader({ request: jsonReq, params: { id: "1928" } });
  assert.strictEqual(jsonRes.status, 200, "JSON export should respond with HTTP 200");
  assert(jsonRes.headers.get("Content-Type").includes("application/json"), "Content-Type must be application/json");
  const jsonText = await jsonRes.text();
  const parsed = JSON.parse(jsonText);
  assert.strictEqual(parsed.restorePointId, 1928, "Parsed JSON must have restorePointId: 1928");
  assert(parsed.storeAssets.theme, "Parsed JSON must contain theme storeAssets");
  console.log(`  ✓ JSON export verified: ${(jsonText.length / 1024).toFixed(1)} KB payload`);

  console.log("\n=================================================");
  console.log("  ALL QA CHECKS PASSED: Theme ZIP & Backup OK!   ");
  console.log("=================================================\n");
}

runQAVerification()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("QA Test Error:", err);
    prisma.$disconnect();
    process.exit(1);
  });
