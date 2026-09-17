import assert from "node:assert";
import prisma from "../app/db.server.js";
import { generateProductsCsv, importBackupPayload } from "../app/backup.server.js";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

async function testEdgeCases() {
  console.log("=== TESTING CSV & IMPORT CORNER CASES ===");

  // Corner Case 1: Products with weird titles, empty variants, null fields
  console.log("\n[CORNER 1] CSV handling of empty, null, and special characters");
  const edgeProducts = [
    {
      productId: "1001",
      title: 'Item with "Quotes", commas, and \n newlines',
      handle: "item-quotes",
      status: "ACTIVE",
      vendor: null,
      productType: undefined,
      tags: null,
      variants: [],
      updatedAt: null,
    },
    {
      productId: "1002",
      snapshotData: {
        id: "gid://shopify/Product/1002",
        title: "No Variant Pricing Product",
        handle: "no-pricing",
        status: "DRAFT",
        tags: ["one", "two", 'three, "four"'],
        variants: [{ price: "0" }, { price: "99.95" }],
      },
    },
    {
      // Malformed object
    },
  ];

  const csv = generateProductsCsv(edgeProducts);
  assert(csv.startsWith("\uFEFF"), "CSV starts with UTF-8 BOM");
  assert(csv.includes('""Quotes""'), "Quotes are escaped as double quotes");
  assert(csv.includes("99.95"), "Max price 99.95 is present");
  console.log("✓ CSV edge cases handled safely without throwing!");

  // Corner Case 2: Import backup with varied casing or legacy schemas
  console.log("\n[CORNER 2] Import with legacy/different backup schema structures");
  const legacyBackup = {
    app: "Revertly",
    createdAt: "2025-01-01T00:00:00Z",
    products: [
      { id: "1", title: "Legacy Prod 1" },
    ],
    collections: [
      { id: "2", title: "Legacy Col 1", handle: "leg-col" },
    ],
    pages: [
      { id: "3", title: "Legacy Page 1", handle: "leg-page" },
    ],
  };

  const legacyRes = await importBackupPayload({
    admin: { graphql: async () => ({ json: async () => ({ data: {} }) }) },
    shop: TEST_SHOP,
    payload: legacyBackup,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(legacyRes.success, "Legacy backup imported successfully");
  assert.strictEqual(legacyRes.restorePoint.productCount, 1);
  assert.strictEqual(legacyRes.restorePoint.collectionCount, 1);
  assert.strictEqual(legacyRes.restorePoint.pageCount, 1);
  await prisma.restorePoint.delete({ where: { id: legacyRes.restorePoint.id } });
  console.log("✓ Legacy backup structure handled cleanly!");

  // Corner Case 3: Import with string payload (pre-parsed JSON vs JSON string)
  console.log("\n[CORNER 3] Import with stringified payload");
  const stringPayload = JSON.stringify({
    products: [{ id: "99", title: "Stringified Product" }],
  });
  const stringRes = await importBackupPayload({
    admin: { graphql: async () => ({ json: async () => ({ data: {} }) }) },
    shop: TEST_SHOP,
    payload: stringPayload,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(stringRes.success, "Stringified payload parsed and imported");
  assert.strictEqual(stringRes.restorePoint.productCount, 1);
  await prisma.restorePoint.delete({ where: { id: stringRes.restorePoint.id } });
  console.log("✓ Stringified payload import verified!");

  console.log("\n=== ALL CORNER CASE TESTS PASSED! ===");
}

testEdgeCases().then(() => prisma.$disconnect()).catch((err) => {
  console.error("Corner case test failed:", err);
  prisma.$disconnect();
  process.exit(1);
});
