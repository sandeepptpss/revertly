import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  generateCollectionsCsv,
  parseCollectionsCsv,
  generatePagesAndMenusCsv,
  parsePagesAndMenusCsv,
  generateBlogsAndArticlesCsv,
  parseBlogsAndArticlesCsv,
  generateProductsCsv,
  detectAndParseCsvArchive,
} from "../app/utils/csv-portability.js";
import { importBackupPayload, restoreCollection, restorePage, restoreMenu, restoreArticle } from "../app/backup.server.js";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

function createMockAdmin() {
  const collectionsStore = [];
  const pagesStore = [];
  const menusStore = [];
  const articlesStore = [];
  const blogsStore = [
    { id: "gid://shopify/Blog/101", title: "Company News", handle: "news" },
    { id: "gid://shopify/Blog/102", title: "Engineering Blog", handle: "engineering" },
  ];

  return {
    graphql: async (query, { variables } = {}) => {
      // 1. Collections
      if (query.includes("collectionUpdate")) {
        return {
          json: async () => ({
            data: {
              collectionUpdate: {
                collection: { id: variables.input.id, title: variables.input.title, handle: variables.input.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("collectionCreate")) {
        const id = `gid://shopify/Collection/mock-${Date.now()}`;
        return {
          json: async () => ({
            data: {
              collectionCreate: {
                collection: { id, title: variables.input.title, handle: variables.input.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("findCollectionByHandle")) {
        return {
          json: async () => ({
            data: { collections: { nodes: [] } },
          }),
        };
      }

      // 2. Pages
      if (query.includes("pageUpdate")) {
        return {
          json: async () => ({
            data: {
              pageUpdate: {
                page: { id: variables.id, title: variables.page.title, handle: variables.page.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("pageCreate")) {
        const id = `gid://shopify/Page/mock-${Date.now()}`;
        return {
          json: async () => ({
            data: {
              pageCreate: {
                page: { id, title: variables.page.title, handle: variables.page.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("findPageByHandle")) {
        return {
          json: async () => ({
            data: { pages: { nodes: [] } },
          }),
        };
      }

      // 3. Menus
      if (query.includes("menuUpdate")) {
        return {
          json: async () => ({
            data: {
              menuUpdate: {
                menu: { id: variables.id, title: variables.title, handle: variables.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("menuCreate")) {
        const id = `gid://shopify/Menu/mock-${Date.now()}`;
        return {
          json: async () => ({
            data: {
              menuCreate: {
                menu: { id, title: variables.title, handle: variables.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("findMenuByHandle") || query.includes("getMenus")) {
        return {
          json: async () => ({
            data: { menus: { nodes: menusStore } },
          }),
        };
      }

      // 4. Articles & Blogs
      if (query.includes("articleUpdate")) {
        return {
          json: async () => ({
            data: {
              articleUpdate: {
                article: { id: variables.id, title: variables.article.title, handle: variables.article.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("articleCreate")) {
        const id = `gid://shopify/Article/mock-${Date.now()}`;
        return {
          json: async () => ({
            data: {
              articleCreate: {
                article: { id, title: variables.article.title, handle: variables.article.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("getBlogsForArticleRestore") || query.includes("getFirstBlog") || query.includes("blogs(")) {
        return {
          json: async () => ({
            data: { blogs: { nodes: blogsStore } },
          }),
        };
      }

      // Fallback
      return { json: async () => ({ data: {} }) };
    },
  };
}

async function runPortabilitySuite() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("   CSV & JSON PORTABILITY & RESTORATION TEST SUITE");
  console.log("════════════════════════════════════════════════════════════════\n");

  const admin = createMockAdmin();

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: COLLECTIONS (Smart & Manual) CSV Export & Import & Restore
  // ───────────────────────────────────────────────────────────────────────────
  console.log("▶ [TEST 1] Collections CSV (Smart & Manual)");
  const sampleCollections = [
    {
      id: "gid://shopify/Collection/101",
      title: 'Summer "Hot Deals" & Clearance',
      handle: "summer-hot-deals",
      descriptionHtml: "<p>Best summer, hot & sunny deals!</p>\n<p>Limited stock.</p>",
      sortOrder: "PRICE_ASC",
      templateSuffix: "summer-sale",
      image: { url: "https://cdn.shopify.com/summer.jpg", altText: "Sunny Deals" },
      ruleSet: {
        appliedDisjunctively: true,
        rules: [
          { column: "TAG", relation: "EQUALS", condition: "summer" },
          { column: "VARIANT_PRICE", relation: "GREATER_THAN", condition: "50.00" },
        ],
      },
    },
    {
      id: "gid://shopify/Collection/102",
      title: "Featured Manual Essentials",
      handle: "featured-essentials",
      descriptionHtml: "<p>Curated hand-picked items.</p>",
      sortOrder: "MANUAL",
      templateSuffix: "",
      image: null,
      ruleSet: null,
    },
  ];

  // 1.1 Generate CSV
  const colCsv = generateCollectionsCsv(sampleCollections);
  assert(colCsv.startsWith("\uFEFF"), "Collections CSV must have UTF-8 BOM");
  assert(colCsv.includes('Summer ""Hot Deals"" & Clearance'), "Double quotes inside collection title properly escaped");
  assert(colCsv.includes("PRICE_ASC"), "Sort order PRICE_ASC preserved");
  assert(colCsv.includes("SMART"), "Smart collection type identified");
  assert(colCsv.includes("MANUAL"), "Manual collection type identified");
  assert(colCsv.includes("ANY"), "Disjunctive match condition ANY preserved");
  console.log("  ✓ 1.1 Collections CSV generation passed");

  // 1.2 Detect & Parse CSV
  const detectedCols = detectAndParseCsvArchive(colCsv);
  assert.strictEqual(detectedCols.type, "COLLECTIONS");
  assert.strictEqual(detectedCols.summary.collections, 2);
  assert.strictEqual(detectedCols.data.collections.length, 2);

  const parsedSmart = detectedCols.data.collections[0];
  assert.strictEqual(parsedSmart.title, 'Summer "Hot Deals" & Clearance');
  assert.strictEqual(parsedSmart.handle, "summer-hot-deals");
  assert.strictEqual(parsedSmart.sortOrder, "PRICE_ASC");
  assert.strictEqual(parsedSmart.image?.url, "https://cdn.shopify.com/summer.jpg");
  assert.strictEqual(parsedSmart.ruleSet?.appliedDisjunctively, true);
  assert.strictEqual(parsedSmart.ruleSet?.rules?.length, 2);
  assert.strictEqual(parsedSmart.ruleSet?.rules[0].column, "TAG");
  assert.strictEqual(parsedSmart.ruleSet?.rules[0].condition, "summer");

  const parsedManual = detectedCols.data.collections[1];
  assert.strictEqual(parsedManual.title, "Featured Manual Essentials");
  assert.strictEqual(parsedManual.sortOrder, "MANUAL");
  assert.strictEqual(parsedManual.ruleSet, null);
  console.log("  ✓ 1.2 Collections CSV parsing & ruleSet reconstruction passed");

  // 1.3 Stage as Restore Point
  const rpCol = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: {
      name: "Collections CSV Backup",
      backupType: "COLLECTIONS",
      collections: detectedCols.data.collections,
    },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpCol.success, "Collections imported into restore point");
  assert.strictEqual(rpCol.restorePoint.collectionCount, 2);
  assert.strictEqual(rpCol.restorePoint.backupType, "COLLECTIONS");
  console.log(`  ✓ 1.3 Staged as Restore Point #${rpCol.restorePoint.id}`);

  // 1.4 Live restore of parsed collections
  for (const c of detectedCols.data.collections) {
    const res = await restoreCollection(admin, c);
    assert(res.success, `Collection ${c.title} restored`);
  }
  console.log("  ✓ 1.4 Collections live restore executed successfully");

  // Cleanup
  await prisma.restorePoint.delete({ where: { id: rpCol.restorePoint.id } });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: PAGES & NAVIGATION MENUS CSV Export & Import & Restore
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [TEST 2] Pages & Navigation Menus CSV");
  const samplePages = [
    {
      id: "gid://shopify/Page/201",
      title: "Privacy & Terms of Service",
      handle: "privacy-terms",
      body: "<h2>Terms & Conditions</h2>\n<p>Your privacy is \"critical\" to us.</p>",
      templateSuffix: "legal",
      isPublished: true,
    },
    {
      id: "gid://shopify/Page/202",
      title: "Draft Coming Soon",
      handle: "coming-soon",
      body: "<p>Work in progress.</p>",
      templateSuffix: "",
      isPublished: false,
    },
  ];

  const sampleMenus = [
    {
      id: "gid://shopify/Menu/301",
      title: "Main Navigation",
      handle: "main-menu",
      items: [
        { id: "gid://shopify/MenuItem/1", title: "Home", url: "/", type: "HTTP" },
        {
          id: "gid://shopify/MenuItem/2",
          title: "Shop",
          url: "/collections",
          type: "COLLECTION",
          items: [
            { id: "gid://shopify/MenuItem/3", title: "Summer Deals", url: "/collections/summer", type: "COLLECTION" },
          ],
        },
      ],
    },
  ];

  // 2.1 Generate CSV
  const pmCsv = generatePagesAndMenusCsv(samplePages, sampleMenus);
  assert(pmCsv.startsWith("\uFEFF"), "Pages & Menus CSV must have UTF-8 BOM");
  assert(pmCsv.includes("PAGE"), "Contains PAGE record type");
  assert(pmCsv.includes("MENU"), "Contains MENU record type");
  assert(pmCsv.includes('Your privacy is ""critical"" to us.'), "Escaped quotes in HTML body");
  assert(pmCsv.includes("Summer Deals"), "Preserves nested menu items structure");
  console.log("  ✓ 2.1 Pages & Menus CSV generation passed");

  // 2.2 Detect & Parse CSV
  const detectedPM = detectAndParseCsvArchive(pmCsv);
  assert.strictEqual(detectedPM.type, "PAGES");
  assert.strictEqual(detectedPM.summary.pages, 2);
  assert.strictEqual(detectedPM.summary.menus, 1);

  const parsedPages = detectedPM.data.pages;
  assert.strictEqual(parsedPages.length, 2);
  assert.strictEqual(parsedPages[0].title, "Privacy & Terms of Service");
  assert.strictEqual(parsedPages[0].isPublished, true);
  assert.strictEqual(parsedPages[1].isPublished, false);

  const parsedMenus = detectedPM.data.menus;
  assert.strictEqual(parsedMenus.length, 1);
  assert.strictEqual(parsedMenus[0].title, "Main Navigation");
  assert.strictEqual(parsedMenus[0].items.length, 2);
  assert.strictEqual(parsedMenus[0].items[1].items.length, 1);
  assert.strictEqual(parsedMenus[0].items[1].items[0].title, "Summer Deals");
  console.log("  ✓ 2.2 Pages & Menus CSV parsing passed");

  // 2.3 Stage as Restore Point
  const rpPM = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: {
      name: "Pages & Menus CSV Backup",
      backupType: "PAGES",
      pages: parsedPages,
      menus: parsedMenus,
    },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpPM.success);
  assert.strictEqual(rpPM.restorePoint.pageCount, 2);
  assert.strictEqual(rpPM.restorePoint.menuCount, 1);
  console.log(`  ✓ 2.3 Staged as Restore Point #${rpPM.restorePoint.id}`);

  // 2.4 Live restore of parsed pages & menus
  for (const page of parsedPages) {
    const res = await restorePage(admin, page);
    assert(res.success, `Page ${page.title} restored`);
  }
  for (const menu of parsedMenus) {
    const res = await restoreMenu(admin, menu);
    assert(res.success, `Menu ${menu.title} restored`);
  }
  console.log("  ✓ 2.4 Pages & Menus live restore executed successfully");

  // Cleanup
  await prisma.restorePoint.delete({ where: { id: rpPM.restorePoint.id } });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: BLOGS & ARTICLES CSV Export & Import & Restore
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [TEST 3] Blogs & Articles CSV");
  const sampleBlogs = [
    {
      id: "gid://shopify/Blog/101",
      title: "Company News",
      handle: "news",
      commentPolicy: "MODERATED",
      templateSuffix: "",
    },
  ];

  const sampleArticles = [
    {
      id: "gid://shopify/Article/401",
      blogTitle: "Company News",
      blogHandle: "news",
      title: 'Our 2026 Vision: "AI & Growth"',
      handle: "vision-2026",
      author: "Jane Doe",
      tags: ["company", "strategy", "2026"],
      isPublished: true,
      publishedAt: "2026-01-15T09:00:00Z",
      templateSuffix: "featured-article",
      summary: "A brief look into what's ahead.",
      body: "<p>Comprehensive details on our strategic roadmap.</p>",
      image: { url: "https://cdn.shopify.com/vision.png", altText: "Vision Roadmap" },
    },
    {
      id: "gid://shopify/Article/402",
      blogTitle: "Engineering Blog",
      blogHandle: "engineering",
      title: "Scaling Distributed Backups",
      handle: "scaling-backups",
      author: "Dev Team",
      tags: ["tech", "engineering"],
      isPublished: false,
      publishedAt: "",
      templateSuffix: "",
      summary: "Draft technical write-up.",
      body: "<p>Architectural breakdown of replication pipelines.</p>",
      image: null,
    },
  ];

  // 3.1 Generate CSV
  const blogCsv = generateBlogsAndArticlesCsv(sampleBlogs, sampleArticles);
  assert(blogCsv.startsWith("\uFEFF"), "Blogs CSV must have UTF-8 BOM");
  assert(blogCsv.includes("ARTICLE"), "Contains ARTICLE record type");
  assert(blogCsv.includes("BLOG"), "Contains BLOG record type");
  assert(blogCsv.includes('Our 2026 Vision: ""AI & Growth""'), "Escaped quotes in article title");
  assert(blogCsv.includes("Company News"), "Preserves blog title association");
  console.log("  ✓ 3.1 Blogs & Articles CSV generation passed");

  // 3.2 Detect & Parse CSV
  const detectedBlogs = detectAndParseCsvArchive(blogCsv);
  assert.strictEqual(detectedBlogs.type, "BLOGS");
  assert.strictEqual(detectedBlogs.summary.articles, 2);

  const parsedArticles = detectedBlogs.data.articles;
  assert.strictEqual(parsedArticles.length, 2);
  assert.strictEqual(parsedArticles[0].title, 'Our 2026 Vision: "AI & Growth"');
  assert.strictEqual(parsedArticles[0].blogHandle, "news");
  assert.deepStrictEqual(parsedArticles[0].tags, ["company", "strategy", "2026"]);
  assert.strictEqual(parsedArticles[0].isPublished, true);
  assert.strictEqual(parsedArticles[1].isPublished, false);

  const parsedBlogs = detectedBlogs.data.blogs;
  assert(parsedBlogs.some((b) => b.handle === "news"));
  assert(parsedBlogs.some((b) => b.handle === "engineering"));
  console.log("  ✓ 3.2 Blogs & Articles CSV parsing & blog resolution passed");

  // 3.3 Stage as Restore Point
  const rpBlog = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: {
      name: "Blogs CSV Backup",
      backupType: "BLOGS",
      blogs: parsedBlogs,
      articles: parsedArticles,
    },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpBlog.success);
  assert.strictEqual(rpBlog.restorePoint.articleCount, 2);
  assert.strictEqual(rpBlog.restorePoint.backupType, "BLOGS");
  console.log(`  ✓ 3.3 Staged as Restore Point #${rpBlog.restorePoint.id}`);

  // 3.4 Live restore of parsed articles with blog handle mapping
  for (const art of parsedArticles) {
    const res = await restoreArticle(admin, art);
    assert(res.success, `Article ${art.title} restored`);
  }
  console.log("  ✓ 3.4 Blogs & Articles live restore executed successfully");

  // Cleanup
  await prisma.restorePoint.delete({ where: { id: rpBlog.restorePoint.id } });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: CSV Validation & Error Handling
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [TEST 4] CSV Validation & Descriptive Error Messages");

  // 4.1 Empty file
  assert.throws(
    () => detectAndParseCsvArchive(""),
    /empty/i,
    "Empty CSV correctly rejected"
  );
  console.log("  ✓ 4.1 Empty CSV rejection verified");

  // 4.2 Non-backup CSV
  const randomCsv = '"First Name","Last Name","Phone"\r\n"John","Doe","555-1234"';
  assert.throws(
    () => detectAndParseCsvArchive(randomCsv),
    /Unrecognized CSV format/i,
    "Unrecognized headers correctly rejected"
  );
  console.log("  ✓ 4.2 Unrecognized headers rejection verified");

  // 4.3 Headers only, no rows
  const headerOnlyCsv = '"Collection ID","Title","Handle"\r\n';
  assert.throws(
    () => detectAndParseCsvArchive(headerOnlyCsv),
    /no recognizable data rows/i,
    "Header-only CSV correctly rejected"
  );
  console.log("  ✓ 4.3 Header-only CSV rejection verified");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Direct Live Restore Mode (RESTORE_NOW) for CSV Archives
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ [TEST 5] Complete Live Restore (mode=RESTORE_NOW) for CSV Archives");

  const liveRestoreColsResult = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: {
      name: "Immediate Live Restore",
      collections: detectedCols.data.collections,
    },
    mode: "RESTORE_NOW",
  });
  assert(liveRestoreColsResult.success);
  assert.strictEqual(liveRestoreColsResult.summary.restoredLive, true);
  assert.strictEqual(liveRestoreColsResult.summary.liveResults.collections, 2);
  console.log("  ✓ 5.1 Direct Live Restore applied Collections successfully");

  await prisma.restorePoint.delete({ where: { id: liveRestoreColsResult.restorePoint.id } });

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("   ALL 5 TEST SUITES COMPLETED WITH 100% SUCCESS!");
  console.log("════════════════════════════════════════════════════════════════\n");
}

runPortabilitySuite()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("Test Suite Failed:", e);
    prisma.$disconnect();
    process.exit(1);
  });
