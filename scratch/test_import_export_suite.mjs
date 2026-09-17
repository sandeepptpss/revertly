import assert from "node:assert";
import prisma from "../app/db.server.js";
import { importBackupPayload, generateProductsCsv } from "../app/backup.server.js";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

function createMockAdmin() {
  return {
    graphql: async (query, { variables } = {}) => {
      if (query.includes("getThemes") || query.includes("theme(")) {
        return {
          json: async () => ({
            data: {
              themes: {
                nodes: [
                  { id: "gid://shopify/Theme/123", name: "Dawn Live", role: "MAIN", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
                ],
              },
              theme: {
                files: {
                  nodes: [
                    { filename: "layout/theme.liquid", size: 100, body: { content: "<html>Live</html>" } },
                  ],
                },
              },
            },
          }),
        };
      }
      if (query.includes("getCollections")) {
        return {
          json: async () => ({
            data: {
              collections: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: "gid://shopify/Collection/999", title: "Live Summer Collection", handle: "summer" },
                ],
              },
            },
          }),
        };
      }
      if (query.includes("getPages")) {
        return {
          json: async () => ({
            data: {
              pages: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: "gid://shopify/Page/555", title: "Live About Us", handle: "about-us", body: "Live About" },
                ],
              },
            },
          }),
        };
      }
      if (query.includes("getMenus")) {
        return {
          json: async () => ({
            data: {
              menus: {
                nodes: [
                  { id: "gid://shopify/Menu/777", title: "Live Main Menu", handle: "main-menu", items: [] },
                ],
              },
            },
          }),
        };
      }
      if (query.includes("getArticlesAndBlogs")) {
        return {
          json: async () => ({
            data: {
              blogs: {
                nodes: [
                  {
                    id: "gid://shopify/Blog/111",
                    title: "Live News",
                    handle: "news",
                    articles: { nodes: [{ id: "gid://shopify/Article/222", title: "Live Post" }] },
                  },
                ],
              },
            },
          }),
        };
      }
      if (query.includes("getProductsForBackup")) {
        return {
          json: async () => ({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: "gid://shopify/Product/333", title: "Live Product Alpha", handle: "alpha", variants: { nodes: [] } },
                ],
              },
            },
          }),
        };
      }
      // default mock mutation
      return {
        json: async () => ({ data: {} }),
      };
    },
  };
}

// We also need to mock authenticate.admin if calling loaders/actions directly
// Let's create a test harness
async function runTests() {
  console.log("=== STARTING IMPORT & EXPORT VERIFICATION SUITE ===");

  // Check current restore points in DB
  const rps = await prisma.restorePoint.findMany({
    where: { shop: TEST_SHOP },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Found ${rps.length} existing restore points for ${TEST_SHOP}`);
  for (const r of rps.slice(0, 5)) {
    console.log(`- RP #${r.id}: "${r.name}" (${r.backupType}) prods:${r.productCount}, themes:${r.themeCount}, cols:${r.collectionCount}, pages:${r.pageCount}, arts:${r.articleCount}`);
  }

  // 1. Test CSV Generation
  console.log("\n[TEST 1] CSV Generation with variants and tags");
  const sampleProducts = [
    {
      id: "gid://shopify/Product/1",
      title: 'T-Shirt "Vintage"',
      handle: "t-shirt-vintage",
      status: "ACTIVE",
      vendor: "Acme",
      productType: "Apparel",
      tags: ["summer", "sale"],
      variants: [{ price: "19.99" }, { price: "24.99" }],
      updatedAt: "2026-09-17T10:00:00Z",
    },
    {
      productId: "gid://shopify/Product/2",
      snapshotData: {
        title: "Cap",
        handle: "cap",
        status: "DRAFT",
        vendor: "Acme",
        productType: "Accessories",
        tags: "hat, casual",
        variants: [{ price: "12.00" }],
      },
    },
  ];
  const csv = generateProductsCsv(sampleProducts);
  assert(csv.includes("T-Shirt \"\"Vintage\"\""), "CSV handles quotes");
  assert(csv.includes("19.99"), "CSV contains min price");
  assert(csv.includes("24.99"), "CSV contains max price");
  assert(csv.includes("summer, sale"), "CSV contains tags");
  console.log("✓ CSV Generation works properly!");

  // 2. Test Import logic with various JSON payloads
  console.log("\n[TEST 2] Import Backup Payload - Full Archive into Restore Point");
  const fullBackupPayload = {
    _schema: "revertly-disaster-recovery-v1",
    shop: "external-store.myshopify.com",
    name: "Complete External Backup",
    createdAt: "2026-08-01T00:00:00Z",
    storeAssets: {
      products: [
        { id: "gid://shopify/Product/901", title: "Imported Widget", handle: "widget", status: "ACTIVE", variants: [{ price: "10" }] },
      ],
      theme: {
        activeTheme: { id: "gid://shopify/Theme/1", name: "Imported Theme" },
        files: [{ filename: "layout/theme.liquid", content: "<html>Imported</html>" }],
      },
      collections: [
        { id: "gid://shopify/Collection/902", title: "Imported Gear", handle: "imported-gear" },
      ],
      pages: [
        { id: "gid://shopify/Page/903", title: "Imported FAQ", handle: "imported-faq", body: "FAQ body" },
      ],
      menus: [
        { id: "gid://shopify/Menu/904", title: "Imported Main Menu", handle: "main", items: [] },
      ],
      blogsAndArticles: {
        blogs: [{ id: "gid://shopify/Blog/905", title: "Blog 1" }],
        articles: [{ id: "gid://shopify/Article/906", title: "Article 1" }],
      },
    },
  };

  const importResult1 = await importBackupPayload({
    admin: createMockAdmin(),
    shop: TEST_SHOP,
    payload: fullBackupPayload,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  console.log("Import Result 1 (Save as RP):", importResult1.success, importResult1.message);
  assert(importResult1.success, "Full archive imported as restore point");
  assert(importResult1.restorePoint.productCount === 1, "Product count matches");
  assert(importResult1.restorePoint.themeCount === 1, "Theme count matches");
  assert(importResult1.restorePoint.collectionCount === 1, "Collection count matches");
  assert(importResult1.restorePoint.pageCount === 1, "Page count matches");
  assert(importResult1.restorePoint.menuCount === 1, "Menu count matches");
  assert(importResult1.restorePoint.articleCount === 1, "Article count matches");

  // Clean up created restore point
  await prisma.restorePoint.delete({ where: { id: importResult1.restorePoint.id } });
  console.log("✓ Full archive import and RP staging verified!");

  // 3. Test Import with standalone products array
  console.log("\n[TEST 3] Import Backup Payload - Standalone Products Array");
  const rawProductsArray = [
    { id: "gid://shopify/Product/9991", title: "Raw Product 1" },
    { id: "gid://shopify/Product/9992", title: "Raw Product 2" },
  ];
  const importResult2 = await importBackupPayload({
    admin: createMockAdmin(),
    shop: TEST_SHOP,
    payload: rawProductsArray,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  console.log("Import Result 2 (Raw Array):", importResult2.success, importResult2.message);
  assert(importResult2.success, "Raw products array imported");
  assert(importResult2.restorePoint.productCount === 2, "Product count 2");
  assert(importResult2.restorePoint.backupType === "PRODUCTS", "BackupType is PRODUCTS");
  await prisma.restorePoint.delete({ where: { id: importResult2.restorePoint.id } });
  console.log("✓ Standalone products array import verified!");

  // 4. Test Import with standalone Pages JSON
  console.log("\n[TEST 4] Import Standalone Pages JSON Export");
  const pagesExport = {
    _schema: "revertly-pages-v1",
    shop: TEST_SHOP,
    pages: [{ id: "gid://shopify/Page/100", title: "Standalone Page", handle: "standalone-page" }],
    menus: [{ id: "gid://shopify/Menu/200", title: "Footer Menu", handle: "footer" }],
  };
  const importResult3 = await importBackupPayload({
    admin: createMockAdmin(),
    shop: TEST_SHOP,
    payload: pagesExport,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  console.log("Import Result 3 (Pages Export):", importResult3.success, importResult3.message);
  assert(importResult3.success, "Pages export imported");
  assert(importResult3.restorePoint.pageCount === 1, "Page count is 1");
  assert(importResult3.restorePoint.menuCount === 1, "Menu count is 1");
  assert(importResult3.restorePoint.backupType === "PAGES", "BackupType is PAGES");
  await prisma.restorePoint.delete({ where: { id: importResult3.restorePoint.id } });
  console.log("✓ Standalone pages import verified!");

  // 5. Test Import with Empty or Invalid JSON
  console.log("\n[TEST 5] Import with Empty / Non-backup JSON");
  const invalidJson = { foo: "bar", number: 123 };
  const importResult4 = await importBackupPayload({
    admin: createMockAdmin(),
    shop: TEST_SHOP,
    payload: invalidJson,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  console.log("Import Result 4 (Invalid JSON):", importResult4.success, importResult4.message);
  assert(!importResult4.success, "Invalid JSON should be rejected");
  console.log("✓ Invalid JSON rejection verified!");

  console.log("\n=== ALL DIRECT UNIT TESTS FINISHED ===");
}

runTests().then(() => prisma.$disconnect()).catch((e) => {
  console.error("Test failure:", e);
  prisma.$disconnect();
  process.exit(1);
});
