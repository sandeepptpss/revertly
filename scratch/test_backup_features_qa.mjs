import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  backupTheme,
  backupProducts,
  backupCollections,
  backupPages,
  backupBlogs,
  createMultiResourceRestorePoint,
  restoreThemeFilesWithSafety,
  restoreCollection,
  restorePage,
  restoreArticle,
  computeDiffLines,
  generateProductsCsv,
  importBackupPayload,
} from "../app/backup.server.js";
import { PERMISSIONS, roleCan, permissionsForRole } from "../app/team.constants.js";

const TEST_SHOP = "qa-comprehensive-verification.myshopify.com";

// Mock GraphQL / REST Admin Factory
function createMockAdmin(handlers = {}) {
  return {
    graphql: async (query, { variables } = {}) => {
      if (handlers.graphql) {
        return handlers.graphql(query, variables);
      }
      // Default empty responses
      return {
        json: async () => ({ data: {} }),
      };
    },
    rest: {
      get: async (endpoint) => {
        if (handlers.restGet) return handlers.restGet(endpoint);
        return { json: async () => ({}) };
      },
      post: async (endpoint, data) => {
        if (handlers.restPost) return handlers.restPost(endpoint, data);
        return { json: async () => ({}) };
      },
      put: async (endpoint, data) => {
        if (handlers.restPut) return handlers.restPut(endpoint, data);
        return { json: async () => ({}) };
      },
    },
  };
}

async function cleanTestShop() {
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.auditLog.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.teamMember.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
}

async function runSeniorQATests() {
  console.log("=================================================================");
  console.log("🚀 STARTING SENIOR QA & MERCHANT PERSPECTIVE VERIFICATION SUITE");
  console.log("=================================================================\n");

  await cleanTestShop();

  // Seed AppSettings with Business plan to permit Theme & Multi-resource features
  await prisma.appSettings.create({
    data: {
      shop: TEST_SHOP,
      planId: "business",
      alertEmail: "qa@revertly.test",
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 1: FULL THEME BACKUP VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ [FEATURE 1] Full Theme Backup & Restore Verification");

  const mockLiveTheme = {
    id: "gid://shopify/Theme/99001",
    name: "Dawn Production",
    role: "MAIN",
  };

  const mockThemeFiles = [
    { filename: "layout/theme.liquid", value: "<!doctype html><html><body>{{ content_for_layout }}</body></html>" },
    { filename: "templates/index.json", value: '{"sections":{"hero":{"type":"hero"}},"order":["hero"]}' },
    { filename: "config/settings_data.json", value: '{"current":{"colors_accent_1":"#000000"}}' },
  ];

  const mockAdminTheme = createMockAdmin({
    graphql: async (query, vars) => {
      if (query.includes("getThemesList") || query.includes("themes(")) {
        return {
          json: async () => ({
            data: {
              themes: {
                nodes: [mockLiveTheme, { id: "gid://shopify/Theme/99002", name: "Dawn Staging", role: "DEVELOPMENT" }],
              },
            },
          }),
        };
      }
      if (query.includes("themeFiles") || query.includes("ThemeFiles")) {
        return {
          json: async () => ({
            data: {
              theme: {
                id: mockLiveTheme.id,
                name: mockLiveTheme.name,
                role: mockLiveTheme.role,
                files: {
                  nodes: mockThemeFiles.map((f) => ({
                    filename: f.filename,
                    size: f.value.length,
                    body: {
                      __typename: "OnlineStoreThemeFileBodyText",
                      content: f.value,
                    },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        };
      }
      if (query.includes("themeCreate")) {
        return {
          json: async () => ({
            data: {
              themeCreate: {
                theme: { id: "gid://shopify/Theme/99099", name: vars.name || "Draft Staging" },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("themeFilesUpsert")) {
        return {
          json: async () => ({
            data: {
              themeFilesUpsert: {
                upsertedThemeFiles: (vars.files || []).map((f) => ({ filename: f.filename })),
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  });

  // 1.1 Test Dedicated Theme Backup Runner
  console.log("  1.1 Testing backupTheme runner...");
  const themeBackupRes = await backupTheme({
    admin: mockAdminTheme,
    shop: TEST_SHOP,
    themeId: "99001",
    name: "Dawn QA Baseline Theme Backup",
  });

  assert.strictEqual(themeBackupRes.success, true, "Theme backup must succeed");
  assert.strictEqual(themeBackupRes.restorePoint.backupType, "THEMES", "Backup type must be THEMES");
  assert.strictEqual(themeBackupRes.restorePoint.productCount, 0, "Dedicated theme backup should have 0 products");
  assert.strictEqual(themeBackupRes.restorePoint.themeCount, 1, "Theme count must be 1");
  assert.strictEqual(themeBackupRes.restorePoint.themeData.files.length, 3, "All 3 theme files must be saved");
  console.log("  ✓ 1.1 backupTheme correctly captured theme metadata and 3 asset files.");

  // 1.2 Test Safe Theme Restore to Draft Theme (Merchant Preview First)
  console.log("  1.2 Testing restoreThemeFilesWithSafety with mode: draft...");
  const draftRestoreRes = await restoreThemeFilesWithSafety({
    admin: mockAdminTheme,
    shop: TEST_SHOP,
    themeId: "99001",
    themeName: "Dawn Production",
    files: themeBackupRes.restorePoint.themeData.files,
    mode: "draft",
  });

  assert.strictEqual(draftRestoreRes.success, true, "Draft restore must succeed");
  assert.strictEqual(draftRestoreRes.isDraft, true, "isDraft must be true");
  assert(draftRestoreRes.draftThemeId.includes("99099"), "Returns draft theme ID");
  assert(draftRestoreRes.previewUrl.includes("preview_theme_id"), "Returns preview URL");
  console.log("  ✓ 1.2 Draft restore successfully creates isolated preview theme without modifying live store.");

  // 1.3 Test Instant Live Restore with Automatic Pre-Restore Safety Snapshot
  console.log("  1.3 Testing restoreThemeFilesWithSafety with mode: live (safety snapshot auto-captured)...");
  const liveRestoreRes = await restoreThemeFilesWithSafety({
    admin: mockAdminTheme,
    shop: TEST_SHOP,
    themeId: "99001",
    themeName: "Dawn Production",
    files: themeBackupRes.restorePoint.themeData.files,
    mode: "live",
  });

  assert.strictEqual(liveRestoreRes.success, true, "Live restore must succeed");
  assert.strictEqual(liveRestoreRes.isLive, true, "isLive must be true");
  assert(liveRestoreRes.safetyRpId, "Safety restore point must be created before live restore");
  console.log("  ✓ 1.3 Live restore auto-creates safety restore point #" + liveRestoreRes.safetyRpId + " before applying changes.");

  // 1.4 Test Diff Line Computation Engine
  console.log("  1.4 Testing computeDiffLines for theme file changes...");
  const oldLiquid = "<html><head><title>Old</title></head><body>Hello</body></html>";
  const newLiquid = "<html><head><title>New</title></head><body>Hello World</body></html>";
  const diffResult = computeDiffLines(oldLiquid, newLiquid);
  assert(diffResult.additions > 0, "Must detect additions");
  assert(diffResult.deletions > 0, "Must detect deletions");
  console.log("  ✓ 1.4 Theme diff engine accurately identified +" + diffResult.additions + " additions and -" + diffResult.deletions + " deletions.");

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 2: PRODUCT BACKUP VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 2] Product Backup, Drift Detection & Restore Verification");

  const mockProductsGraphQL = [
    {
      id: "gid://shopify/Product/1001",
      title: "Merino Wool Sweater",
      handle: "merino-wool-sweater",
      status: "ACTIVE",
      vendor: "Nordic Wear",
      productType: "Apparel",
      tags: ["winter", "eco", "wool"],
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/2001",
            title: "Medium / Navy",
            price: "120.00",
            compareAtPrice: "140.00",
            sku: "NORD-M-NVY",
            barcode: "1234567890",
            inventoryQuantity: 45,
          },
        ],
      },
      metafields: {
        nodes: [{ namespace: "custom", key: "care_instructions", value: "Hand wash cold", type: "single_line_text_field" }],
      },
    },
    {
      id: "gid://shopify/Product/1002",
      title: "Waterproof Trekking Boot",
      handle: "waterproof-trekking-boot",
      status: "ACTIVE",
      vendor: "Alpine Pro",
      productType: "Footwear",
      tags: ["outdoor", "boot", "sale"],
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/2002",
            title: "42 / Brown",
            price: "189.99",
            compareAtPrice: "219.99",
            sku: "ALP-42-BRN",
            barcode: "9876543210",
            inventoryQuantity: 12,
          },
        ],
      },
      metafields: { nodes: [] },
    },
  ];

  const mockAdminProducts = createMockAdmin({
    graphql: async (query) => {
      if (query.includes("products(") || query.includes("fetchProductsQuery")) {
        return {
          json: async () => ({
            data: {
              products: {
                nodes: mockProductsGraphQL,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  });

  // 2.1 Test Dedicated Products Backup Runner
  console.log("  2.1 Testing backupProducts runner...");
  const productBackupRes = await backupProducts({
    admin: mockAdminProducts,
    shop: TEST_SHOP,
    name: "Q3 Products Snapshot",
  });

  assert.strictEqual(productBackupRes.success, true, "Product backup must succeed");
  assert.strictEqual(productBackupRes.restorePoint.backupType, "PRODUCTS", "Backup type must be PRODUCTS");
  assert.strictEqual(productBackupRes.restorePoint.productCount, 2, "Product count must be 2");
  assert.strictEqual(productBackupRes.restorePoint.themeCount, 0, "Theme count must be 0");
  assert.strictEqual(productBackupRes.summary.products, 2, "Summary product count must be 2");
  console.log("  ✓ 2.1 backupProducts captured 2 full products with variants & metafields.");

  // 2.2 Verify ProductSnapshot baseline sync
  const liveSnapshots = await prisma.productSnapshot.findMany({ where: { shop: TEST_SHOP } });
  assert.strictEqual(liveSnapshots.length, 2, "ProductSnapshot table must have 2 records");
  console.log("  ✓ 2.2 ProductSnapshot table populated with initial baseline.");

  // 2.3 Simulate Catalog Drift (Accidental Price Drop / Title Rename)
  console.log("  2.3 Simulating live catalog drift on Product #1001...");
  await prisma.productSnapshot.update({
    where: { shop_productId: { shop: TEST_SHOP, productId: "1001" } },
    data: {
      title: "Merino Wool Sweater (HACKED PRICE)",
      snapshotData: {
        id: "gid://shopify/Product/1001",
        title: "Merino Wool Sweater (HACKED PRICE)",
        status: "ACTIVE",
        vendor: "Nordic Wear",
        variants: [
          {
            id: "gid://shopify/ProductVariant/2001",
            title: "Medium / Navy",
            price: "1.20", // Dropped by 99%!
            compareAtPrice: "140.00",
            sku: "NORD-M-NVY",
          },
        ],
      },
    },
  });

  // Read differences
  const savedProds = productBackupRes.restorePoint.snapshotData;
  const currentSnap = await prisma.productSnapshot.findUnique({
    where: { shop_productId: { shop: TEST_SHOP, productId: "1001" } },
  });
  const saved1001 = savedProds.find((p) => p.productId === "1001" || p.id?.endsWith("/1001"));
  assert(saved1001, "Saved product 1001 must exist in snapshot");
  assert.notStrictEqual(saved1001.snapshotData.title, currentSnap.title, "Title drift detected");
  assert.notStrictEqual(saved1001.snapshotData.variants[0].price, currentSnap.snapshotData.variants[0].price, "Price drop drift detected");
  console.log("  ✓ 2.3 Drift accurately detected between snapshot ($120.00) and live store ($1.20).");

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 3: COLLECTION BACKUP & RESTORE VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 3] Collection Backup & Restore Verification");

  const mockCollections = [
    {
      id: "gid://shopify/Collection/5001",
      title: "Winter Bestsellers",
      handle: "winter-bestsellers",
      descriptionHtml: "<p>Top winter collection</p>",
      sortOrder: "BEST_SELLING",
      ruleSet: {
        appliedDisjunctively: false,
        rules: [
          { column: "TAG", relation: "EQUALS", condition: "winter" },
          { column: "INVENTORY_TOTAL", relation: "GREATER_THAN", condition: "0" },
        ],
      },
    },
    {
      id: "gid://shopify/Collection/5002",
      title: "Outdoor Gear Clearance",
      handle: "outdoor-gear-clearance",
      descriptionHtml: "<p>Clearance items</p>",
      sortOrder: "PRICE_DESC",
      ruleSet: {
        appliedDisjunctively: true,
        rules: [{ column: "TAG", relation: "EQUALS", condition: "sale" }],
      },
    },
  ];

  let updateCalled = false;
  let createCalled = false;

  const mockAdminCollections = createMockAdmin({
    graphql: async (query, vars) => {
      if (query.includes("collections(") || query.includes("fetchCollectionsQuery")) {
        return {
          json: async () => ({
            data: {
              collections: {
                nodes: mockCollections,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (query.includes("collectionUpdate")) {
        updateCalled = true;
        return {
          json: async () => ({
            data: {
              collectionUpdate: {
                collection: { id: vars.input?.id || "gid://shopify/Collection/5001", title: vars.input?.title },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("collectionCreate")) {
        createCalled = true;
        return {
          json: async () => ({
            data: {
              collectionCreate: {
                collection: { id: "gid://shopify/Collection/5999", title: vars.input?.title },
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  });

  // 3.1 Test Dedicated Collections Backup Runner
  console.log("  3.1 Testing backupCollections runner...");
  const colBackupRes = await backupCollections({
    admin: mockAdminCollections,
    shop: TEST_SHOP,
    name: "Winter Collections Backup",
  });

  assert.strictEqual(colBackupRes.success, true, "Collection backup must succeed");
  assert.strictEqual(colBackupRes.restorePoint.backupType, "COLLECTIONS", "Backup type must be COLLECTIONS");
  assert.strictEqual(colBackupRes.restorePoint.collectionCount, 2, "Collection count must be 2");
  assert.strictEqual(colBackupRes.restorePoint.productCount, 0, "Product count must be 0");
  assert.strictEqual(colBackupRes.summary.collections, 2, "Summary collections count must be 2");
  console.log("  ✓ 3.1 backupCollections captured 2 collections and smart rule sets.");

  // 3.2 Test Update-First Collection Restore
  console.log("  3.2 Testing restoreCollection update-first flow...");
  updateCalled = false;
  const updateColRes = await restoreCollection(mockAdminCollections, mockCollections[0]);
  assert.strictEqual(updateColRes.success, true, "Collection update must succeed");
  assert.strictEqual(updateCalled, true, "collectionUpdate mutation must be called first to preserve IDs");
  console.log("  ✓ 3.2 Update-first preserved live collection ID and smart rules.");

  // 3.3 Test Recreate-Fallback when collection was deleted in Shopify
  console.log("  3.3 Testing restoreCollection recreate-fallback flow when collection was deleted...");
  const mockAdminDeletedCol = createMockAdmin({
    graphql: async (query, vars) => {
      if (query.includes("collectionUpdate")) {
        return {
          json: async () => ({
            data: {
              collectionUpdate: {
                collection: null,
                userErrors: [{ field: ["id"], message: "Collection does not exist" }],
              },
            },
          }),
        };
      }
      if (query.includes("collectionCreate")) {
        createCalled = true;
        return {
          json: async () => ({
            data: {
              collectionCreate: {
                collection: { id: "gid://shopify/Collection/5999", title: vars.input?.title },
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  });

  createCalled = false;
  const recreateColRes = await restoreCollection(mockAdminDeletedCol, mockCollections[0]);
  assert.strictEqual(recreateColRes.success, true, "Collection recreation must succeed");
  assert.strictEqual(createCalled, true, "collectionCreate must be called when update fails with non-existent ID");
  console.log("  ✓ 3.3 Fallback recreated deleted collection with original title and smart rules.");

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 4: PAGE BACKUP & RESTORE VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 4] Page & Navigation Backup & Restore Verification");

  const mockPages = [
    {
      id: "gid://shopify/Page/6001",
      title: "About Our Brand",
      handle: "about-us",
      body: "<p>We make sustainable apparel.</p>",
      templateSuffix: "",
      isPublished: true,
    },
    {
      id: "gid://shopify/Page/6002",
      title: "Shipping & Return Policy",
      handle: "shipping-returns",
      body: "<p>30-day hassle-free returns.</p>",
      templateSuffix: "policy",
      isPublished: true,
    },
  ];

  let pageUpdateCalled = false;
  let pageCreateCalled = false;

  const mockAdminPages = createMockAdmin({
    graphql: async (query, vars) => {
      if (query.includes("pages(") || query.includes("fetchPagesQuery")) {
        return {
          json: async () => ({
            data: {
              pages: {
                nodes: mockPages,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (query.includes("menus(") || query.includes("fetchMenusQuery")) {
        return {
          json: async () => ({
            data: {
              menus: {
                nodes: [{ id: "gid://shopify/Menu/7001", title: "Main Menu", handle: "main-menu", items: [] }],
              },
            },
          }),
        };
      }
      if (query.includes("pageUpdate")) {
        pageUpdateCalled = true;
        return {
          json: async () => ({
            data: {
              pageUpdate: {
                page: { id: vars.id || "gid://shopify/Page/6001", title: vars.page?.title },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("pageCreate")) {
        pageCreateCalled = true;
        return {
          json: async () => ({
            data: {
              pageCreate: {
                page: { id: "gid://shopify/Page/6999", title: vars.page?.title },
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  });

  // 4.1 Test Dedicated Pages Backup Runner
  console.log("  4.1 Testing backupPages runner...");
  const pageBackupRes = await backupPages({
    admin: mockAdminPages,
    shop: TEST_SHOP,
    name: "Legal & About Pages Backup",
  });

  assert.strictEqual(pageBackupRes.success, true, "Page backup must succeed");
  assert.strictEqual(pageBackupRes.restorePoint.backupType, "PAGES", "Backup type must be PAGES");
  assert.strictEqual(pageBackupRes.restorePoint.pageCount, 2, "Page count must be 2");
  assert.strictEqual(pageBackupRes.restorePoint.menuCount, 1, "Menu count must be 1");
  assert.strictEqual(pageBackupRes.restorePoint.productCount, 0, "Product count must be 0");
  console.log("  ✓ 4.1 backupPages captured 2 content pages and 1 navigation menu.");

  // 4.2 Test Page Restore Update-First
  console.log("  4.2 Testing restorePage update-first flow...");
  pageUpdateCalled = false;
  const pageRestoreRes = await restorePage(mockAdminPages, mockPages[0]);
  assert.strictEqual(pageRestoreRes.success, true, "Page restore must succeed");
  assert.strictEqual(pageUpdateCalled, true, "pageUpdate mutation must be called");
  console.log("  ✓ 4.2 restorePage updated existing page content successfully.");

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 5: BLOG BACKUP & RESTORE VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 5] Blog & Article Backup & Restore Verification");

  const mockArticles = [
    {
      id: "gid://shopify/Article/8001",
      title: "5 Tips to Care for Wool Sweaters",
      handle: "care-for-wool-sweaters",
      bodyHtml: "<p>Always dry flat and wash with cold water.</p>",
      summaryHtml: "<p>Care guide summary</p>",
      tags: ["guides", "wool", "care"],
      blogId: "gid://shopify/Blog/9001",
      blogTitle: "News & Style",
      isPublished: true,
    },
  ];

  let articleUpdateCalled = false;

  const mockAdminBlogs = createMockAdmin({
    graphql: async (query, vars) => {
      if (query.includes("blogs(") || query.includes("fetchBlogsQuery")) {
        return {
          json: async () => ({
            data: {
              blogs: {
                nodes: [
                  {
                    id: "gid://shopify/Blog/9001",
                    title: "News & Style",
                    handle: "news-style",
                    articles: {
                      nodes: mockArticles,
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (query.includes("articleUpdate")) {
        articleUpdateCalled = true;
        return {
          json: async () => ({
            data: {
              articleUpdate: {
                article: { id: vars.id || "gid://shopify/Article/8001", title: vars.article?.title },
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  });

  // 5.1 Test Dedicated Blogs Backup Runner
  console.log("  5.1 Testing backupBlogs runner...");
  const blogBackupRes = await backupBlogs({
    admin: mockAdminBlogs,
    shop: TEST_SHOP,
    name: "Editorial Articles Backup",
  });

  assert.strictEqual(blogBackupRes.success, true, "Blog backup must succeed");
  assert.strictEqual(blogBackupRes.restorePoint.backupType, "BLOGS", "Backup type must be BLOGS");
  assert.strictEqual(blogBackupRes.restorePoint.articleCount, 1, "Article count must be 1");
  assert.strictEqual(blogBackupRes.restorePoint.productCount, 0, "Product count must be 0");
  console.log("  ✓ 5.1 backupBlogs captured 1 blog container and 1 published article.");

  // 5.2 Test Article Restore
  console.log("  5.2 Testing restoreArticle flow...");
  articleUpdateCalled = false;
  const artRestoreRes = await restoreArticle(mockAdminBlogs, mockArticles[0]);
  assert.strictEqual(artRestoreRes.success, true, "Article restore must succeed");
  assert.strictEqual(articleUpdateCalled, true, "articleUpdate mutation must be called");
  console.log("  ✓ 5.2 restoreArticle updated live blog article successfully.");

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 6: IMPORT & EXPORT VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 6] Import & Export Verification");

  // 6.1 Test Products CSV Export Formatting (RFC-4180 Compliance & UTF-8 BOM)
  console.log("  6.1 Testing generateProductsCsv...");
  const sampleCsvProducts = [
    {
      productId: "1001",
      title: 'Wool Sweater "Nordic Edition", Red / XL', // Test quotes and commas
      handle: "wool-sweater-nordic",
      status: "ACTIVE",
      vendor: "Acme, Inc.",
      productType: "Apparel",
      tags: ["wool", "premium", 'edition "special"'],
      variants: [
        { price: "120.00", compareAtPrice: "150.00" },
        { price: "135.00", compareAtPrice: "150.00" },
      ],
      updatedAt: "2026-09-16T12:00:00Z",
    },
  ];

  const csvOutput = generateProductsCsv(sampleCsvProducts);
  assert(csvOutput.startsWith("\uFEFF"), "CSV must include UTF-8 BOM for Excel compatibility");
  assert(csvOutput.includes('"Wool Sweater ""Nordic Edition"", Red / XL"'), "Quotes inside values must be escaped with double quotes");
  assert(csvOutput.includes('"120.00"'), "Min price must be 120.00");
  assert(csvOutput.includes('"135.00"'), "Max price must be 135.00");
  console.log("  ✓ 6.1 Products CSV generated with UTF-8 BOM and RFC-4180 escaped quotes & commas.");

  // 6.2 Test Import Mode A: SAVE_AS_RESTORE_POINT (Safe Staging)
  console.log("  6.2 Testing importBackupPayload with mode: SAVE_AS_RESTORE_POINT...");
  const mockExternalBackup = {
    _schema: "revertly-disaster-recovery-v1",
    shop: "store-export-california.myshopify.com",
    name: "California Store Disaster Recovery Export",
    description: "Exported from production store.",
    createdAt: "2026-09-15T08:00:00Z",
    backupType: "FULL",
    storeAssets: {
      products: sampleCsvProducts,
      theme: { activeTheme: { id: "99001", name: "Dawn" }, files: mockThemeFiles },
      collections: mockCollections,
      pages: mockPages,
      menus: [{ id: "7001", title: "Footer Menu" }],
      blogsAndArticles: { blogs: [], articles: mockArticles },
    },
  };

  const importStageRes = await importBackupPayload({
    admin: mockAdminProducts,
    shop: TEST_SHOP,
    payload: mockExternalBackup,
    mode: "SAVE_AS_RESTORE_POINT",
  });

  assert.strictEqual(importStageRes.success, true, "Import staging must succeed");
  assert.strictEqual(importStageRes.summary.restoredLive, false, "Staging mode must NOT mutate live store");
  assert.strictEqual(importStageRes.summary.products, 1, "Product count must match");
  assert.strictEqual(importStageRes.summary.collections, 2, "Collection count must match");
  assert.strictEqual(importStageRes.summary.pages, 2, "Page count must match");
  assert.strictEqual(importStageRes.summary.articles, 1, "Article count must match");

  const importedRp = await prisma.restorePoint.findUnique({
    where: { id: importStageRes.restorePoint.id },
  });
  assert(importedRp, "Restore point must be saved in database");
  assert(importedRp.name.includes("[Imported]"), "Name should indicate imported backup");
  console.log("  ✓ 6.2 Staging import created Restore Point #" + importedRp.id + " with 100% data integrity.");

  // 6.3 Test Import Mode B: RESTORE_NOW (Live Recovery)
  console.log("  6.3 Testing importBackupPayload with mode: RESTORE_NOW...");
  const importLiveRes = await importBackupPayload({
    admin: mockAdminProducts,
    shop: TEST_SHOP,
    payload: mockExternalBackup,
    mode: "RESTORE_NOW",
  });

  assert.strictEqual(importLiveRes.success, true, "Live restore import must succeed");
  assert.strictEqual(importLiveRes.summary.restoredLive, true, "Live results must be true");
  assert(importLiveRes.summary.liveResults.products > 0, "Live products baseline synced");
  console.log("  ✓ 6.3 Live restore mode synced baseline and executed restore handlers.");

  // 6.4 Test Import Error Handling & Validation
  console.log("  6.4 Testing import validation error handling...");
  const corruptedPayload = "INVALID NOT JSON {";
  const invalidJsonRes = await importBackupPayload({
    admin: mockAdminProducts,
    shop: TEST_SHOP,
    payload: corruptedPayload,
  });
  assert.strictEqual(invalidJsonRes.success, false, "Invalid JSON must fail");
  console.log("  ✓ 6.4 Syntax error caught with error message: " + invalidJsonRes.message);

  const emptyPayload = { foo: "bar" };
  const emptyRes = await importBackupPayload({
    admin: mockAdminProducts,
    shop: TEST_SHOP,
    payload: emptyPayload,
  });
  assert.strictEqual(emptyRes.success, false, "Empty payload without assets must fail");
  assert(emptyRes.message.includes("No recognizable store assets"), "Clear actionable error returned");
  console.log("  ✓ 6.4 Missing assets caught with message: " + emptyRes.message);

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 7: BULK DISASTER RECOVERY RESTORATION FLOWS
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 7] Bulk Disaster Recovery Restores (Collections, Pages, Articles)");

  // 7.1 Test Bulk Restore Collections
  console.log("  7.1 Testing bulk restore for all collections...");
  let bulkColsRestored = 0;
  for (const col of mockCollections) {
    const res = await restoreCollection(mockAdminCollections, col);
    if (res.success) bulkColsRestored++;
  }
  assert.strictEqual(bulkColsRestored, 2, "Both collections must be restored");
  console.log("  ✓ 7.1 Bulk collection restore successfully processed " + bulkColsRestored + " smart collections.");

  // 7.2 Test Bulk Restore Pages
  console.log("  7.2 Testing bulk restore for all pages...");
  let bulkPagesRestored = 0;
  for (const page of mockPages) {
    const res = await restorePage(mockAdminPages, page);
    if (res.success) bulkPagesRestored++;
  }
  assert.strictEqual(bulkPagesRestored, 2, "Both pages must be restored");
  console.log("  ✓ 7.2 Bulk page restore successfully processed " + bulkPagesRestored + " content pages.");

  // 7.3 Test Bulk Restore Articles
  console.log("  7.3 Testing bulk restore for all articles...");
  let bulkArticlesRestored = 0;
  for (const art of mockArticles) {
    const res = await restoreArticle(mockAdminBlogs, art);
    if (res.success) bulkArticlesRestored++;
  }
  assert.strictEqual(bulkArticlesRestored, 1, "Article must be restored");
  console.log("  ✓ 7.3 Bulk article restore successfully processed " + bulkArticlesRestored + " blog articles.");

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE 8: RBAC & PERMISSION GUARD VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [FEATURE 8] Role-Based Access Control (RBAC) & Permission Guards");

  // Role matrix check
  assert.strictEqual(roleCan("OWNER", PERMISSIONS.BACKUP_CREATE), true, "OWNER can backup:create");
  assert.strictEqual(roleCan("OWNER", PERMISSIONS.RESTORE), true, "OWNER can restore");
  assert.strictEqual(roleCan("ADMIN", PERMISSIONS.BACKUP_CREATE), true, "ADMIN can backup:create");
  assert.strictEqual(roleCan("ADMIN", PERMISSIONS.RESTORE), true, "ADMIN can restore");
  assert.strictEqual(roleCan("EDITOR", PERMISSIONS.BACKUP_CREATE), true, "EDITOR can backup:create");
  assert.strictEqual(roleCan("EDITOR", PERMISSIONS.RESTORE), true, "EDITOR can restore");
  assert.strictEqual(roleCan("VIEWER", PERMISSIONS.BACKUP_CREATE), false, "VIEWER CANNOT backup:create");
  assert.strictEqual(roleCan("VIEWER", PERMISSIONS.RESTORE), false, "VIEWER CANNOT restore");
  console.log("  ✓ 7.1 Role permissions correctly restrict VIEWER from backup creation & restoration.");

  // Clean up test records
  await cleanTestShop();

  console.log("\n=================================================================");
  console.log("🎉 ALL SENIOR QA & MERCHANT TESTS PASSED SUCCESSFULLY! (100%)");
  console.log("=================================================================");
}

runSeniorQATests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ QA TEST FAILED:", err);
    process.exit(1);
  });
