import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  generateCollectionsCsv,
  generatePagesAndMenusCsv,
  generateBlogsAndArticlesCsv,
  detectAndParseCsvArchive,
} from "../app/utils/csv-portability.js";
import { importBackupPayload, restoreCollection, restorePage, restoreMenu, restoreArticle } from "../app/backup.server.js";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

function createMockAdmin() {
  const blogs = [
    { id: "gid://shopify/Blog/101", title: "Main News", handle: "news" },
    { id: "gid://shopify/Blog/102", title: "Tech Insights", handle: "tech" },
  ];

  return {
    graphql: async (query, { variables } = {}) => {
      if (query.includes("collectionUpdate")) {
        return { json: async () => ({ data: { collectionUpdate: { collection: { id: variables.input.id, title: variables.input.title }, userErrors: [] } } }) };
      }
      if (query.includes("collectionCreate")) {
        return { json: async () => ({ data: { collectionCreate: { collection: { id: "gid://shopify/Collection/mock-new", title: variables.input.title }, userErrors: [] } } }) };
      }
      if (query.includes("pageUpdate")) {
        return { json: async () => ({ data: { pageUpdate: { page: { id: variables.id, title: variables.page.title }, userErrors: [] } } }) };
      }
      if (query.includes("pageCreate")) {
        return { json: async () => ({ data: { pageCreate: { page: { id: "gid://shopify/Page/mock-new", title: variables.page.title }, userErrors: [] } } }) };
      }
      if (query.includes("menuUpdate")) {
        return { json: async () => ({ data: { menuUpdate: { menu: { id: variables.id, title: variables.title }, userErrors: [] } } }) };
      }
      if (query.includes("menuCreate")) {
        return { json: async () => ({ data: { menuCreate: { menu: { id: "gid://shopify/Menu/mock-new", title: variables.title }, userErrors: [] } } }) };
      }
      if (query.includes("articleUpdate")) {
        return { json: async () => ({ data: { articleUpdate: { article: { id: variables.id, title: variables.article.title }, userErrors: [] } } }) };
      }
      if (query.includes("articleCreate")) {
        return { json: async () => ({ data: { articleCreate: { article: { id: "gid://shopify/Article/mock-new", title: variables.article.title }, userErrors: [] } } }) };
      }
      if (query.includes("getBlogsForArticleRestore") || query.includes("getFirstBlog") || query.includes("blogs(")) {
        return { json: async () => ({ data: { blogs: { nodes: blogs } } }) };
      }
      return { json: async () => ({ data: {} }) };
    },
  };
}

async function runE2E() {
  console.log("==================================================================");
  console.log("   COMPLETE END-TO-END WORKFLOW VERIFICATION");
  console.log("   (Export → Import → Staging → Live Restore → Validation)");
  console.log("==================================================================\n");

  const admin = createMockAdmin();

  // ═════════════════════════════════════════════════════════════════
  // 1. COLLECTIONS WORKFLOW
  // ═════════════════════════════════════════════════════════════════
  console.log("▶ [1/3] Collections (Smart & Manual) Workflow");
  const originalCollections = [
    {
      id: "gid://shopify/Collection/101",
      title: 'Summer "VIP" Collection, Edition 2026',
      handle: "summer-vip-2026",
      descriptionHtml: "<p>Exclusive collection for VIP members with, commas & quotes.</p>",
      sortOrder: "BEST_SELLING",
      templateSuffix: "vip-summer",
      image: { url: "https://cdn.shopify.com/vip.jpg", altText: "VIP Summer" },
      ruleSet: {
        appliedDisjunctively: true,
        rules: [
          { column: "TAG", relation: "EQUALS", condition: "vip" },
          { column: "VENDOR", relation: "EQUALS", condition: "Acme" },
        ],
      },
    },
    {
      id: "gid://shopify/Collection/102",
      title: "Manual Best Sellers",
      handle: "manual-best-sellers",
      descriptionHtml: "<p>Manually curated favorites.</p>",
      sortOrder: "MANUAL",
      templateSuffix: "",
      image: null,
      ruleSet: null,
    },
  ];

  // Export as CSV
  const colCsv = generateCollectionsCsv(originalCollections);
  assert(colCsv.includes("Summer \"\"VIP\"\" Collection, Edition 2026"));

  // Export as JSON
  const colJson = JSON.stringify({
    _schema: "revertly-collections-v1",
    collections: originalCollections,
  });

  // Import CSV
  const detectedColCsv = detectAndParseCsvArchive(colCsv);
  assert.strictEqual(detectedColCsv.type, "COLLECTIONS");
  assert.strictEqual(detectedColCsv.data.collections.length, 2);

  const rpColCsv = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: { backupType: "COLLECTIONS", collections: detectedColCsv.data.collections },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpColCsv.success);
  assert.strictEqual(rpColCsv.restorePoint.collectionCount, 2);

  // Restore imported collections live
  for (const c of detectedColCsv.data.collections) {
    const res = await restoreCollection(admin, c);
    assert(res.success, `Restored collection ${c.title}`);
  }
  console.log("  ✓ Collections CSV: Export → Import → Stage (RP #" + rpColCsv.restorePoint.id + ") → Live Restore verified!");

  // Import JSON
  const rpColJson = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: JSON.parse(colJson),
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpColJson.success);
  assert.strictEqual(rpColJson.restorePoint.collectionCount, 2);
  console.log("  ✓ Collections JSON: Export → Import → Stage (RP #" + rpColJson.restorePoint.id + ") verified!");

  // Clean up
  await prisma.restorePoint.deleteMany({
    where: { id: { in: [rpColCsv.restorePoint.id, rpColJson.restorePoint.id] } },
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. PAGES & NAVIGATION MENUS WORKFLOW
  // ═════════════════════════════════════════════════════════════════
  console.log("\n▶ [2/3] Pages & Navigation Menus Workflow");
  const originalPages = [
    {
      id: "gid://shopify/Page/201",
      title: 'About Us: "Our Legacy & Team"',
      handle: "about-us-legacy",
      body: "<p>Established in 2020.\r\nWe build high-availability software, tools & backups.</p>",
      templateSuffix: "about-template",
      isPublished: true,
    },
    {
      id: "gid://shopify/Page/202",
      title: "Contact Support",
      handle: "contact-support",
      body: "<p>24/7 emergency merchant hotline.</p>",
      templateSuffix: "",
      isPublished: false,
    },
  ];

  const originalMenus = [
    {
      id: "gid://shopify/Menu/301",
      title: "Header Main Menu",
      handle: "main-menu",
      items: [
        { id: "gid://shopify/MenuItem/1", title: "Home", url: "/", type: "HTTP" },
        {
          id: "gid://shopify/MenuItem/2",
          title: "Products",
          url: "/collections/all",
          type: "COLLECTION",
          items: [{ id: "gid://shopify/MenuItem/3", title: "Deals", url: "/collections/deals", type: "COLLECTION" }],
        },
      ],
    },
  ];

  // Export as CSV
  const pmCsv = generatePagesAndMenusCsv(originalPages, originalMenus);
  assert(pmCsv.includes("About Us: \"\"Our Legacy & Team\"\""));

  // Export as JSON
  const pmJson = JSON.stringify({
    _schema: "revertly-pages-v1",
    pages: originalPages,
    menus: originalMenus,
  });

  // Import CSV
  const detectedPmCsv = detectAndParseCsvArchive(pmCsv);
  assert.strictEqual(detectedPmCsv.type, "PAGES");
  assert.strictEqual(detectedPmCsv.data.pages.length, 2);
  assert.strictEqual(detectedPmCsv.data.menus.length, 1);

  const rpPmCsv = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: { backupType: "PAGES", pages: detectedPmCsv.data.pages, menus: detectedPmCsv.data.menus },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpPmCsv.success);
  assert.strictEqual(rpPmCsv.restorePoint.pageCount, 2);
  assert.strictEqual(rpPmCsv.restorePoint.menuCount, 1);

  // Restore imported pages & menus live
  for (const p of detectedPmCsv.data.pages) {
    const res = await restorePage(admin, p);
    assert(res.success, `Restored page ${p.title}`);
  }
  for (const m of detectedPmCsv.data.menus) {
    const res = await restoreMenu(admin, m);
    assert(res.success, `Restored menu ${m.title}`);
  }
  console.log("  ✓ Pages & Menus CSV: Export → Import → Stage (RP #" + rpPmCsv.restorePoint.id + ") → Live Restore verified!");

  // Import JSON
  const rpPmJson = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: JSON.parse(pmJson),
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpPmJson.success);
  assert.strictEqual(rpPmJson.restorePoint.pageCount, 2);
  assert.strictEqual(rpPmJson.restorePoint.menuCount, 1);
  console.log("  ✓ Pages & Menus JSON: Export → Import → Stage (RP #" + rpPmJson.restorePoint.id + ") verified!");

  // Clean up
  await prisma.restorePoint.deleteMany({
    where: { id: { in: [rpPmCsv.restorePoint.id, rpPmJson.restorePoint.id] } },
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. BLOGS & ARTICLES WORKFLOW
  // ═════════════════════════════════════════════════════════════════
  console.log("\n▶ [3/3] Blogs & Articles Workflow");
  const originalBlogs = [
    {
      id: "gid://shopify/Blog/101",
      title: "Main News",
      handle: "news",
      commentPolicy: "MODERATED",
      templateSuffix: "",
    },
    {
      id: "gid://shopify/Blog/102",
      title: "Tech Insights",
      handle: "tech",
      commentPolicy: "AUTO_PUBLISH",
      templateSuffix: "tech-blog",
    },
  ];

  const originalArticles = [
    {
      id: "gid://shopify/Article/401",
      blogTitle: "Main News",
      blogHandle: "news",
      title: 'Q3 Product Release: "Revertly 2.0"',
      handle: "q3-product-release",
      author: "Alex Morgan",
      tags: ["news", "product", "release, 2026"],
      isPublished: true,
      publishedAt: "2026-09-01T12:00:00Z",
      templateSuffix: "featured",
      summary: "Exciting announcement on new backup capabilities.",
      body: "<p>We have shipped CSV & JSON multi-format portability!</p>",
      image: { url: "https://cdn.shopify.com/q3.png", altText: "Q3 Release Banner" },
    },
    {
      id: "gid://shopify/Article/402",
      blogTitle: "Tech Insights",
      blogHandle: "tech",
      title: "RFC-4180 CSV Parsing in Production",
      handle: "rfc-4180-csv",
      author: "Core Tech",
      tags: ["engineering", "architecture"],
      isPublished: false,
      publishedAt: "",
      templateSuffix: "",
      summary: "Deep dive into state machine parsers.",
      body: "<p>Handling newlines and double quotes gracefully.</p>",
      image: null,
    },
  ];

  // Export as CSV
  const blogCsv = generateBlogsAndArticlesCsv(originalBlogs, originalArticles);
  assert(blogCsv.includes("Q3 Product Release: \"\"Revertly 2.0\"\""));

  // Export as JSON
  const blogJson = JSON.stringify({
    _schema: "revertly-blogs-v1",
    blogs: originalBlogs,
    articles: originalArticles,
  });

  // Import CSV
  const detectedBlogCsv = detectAndParseCsvArchive(blogCsv);
  assert.strictEqual(detectedBlogCsv.type, "BLOGS");
  assert.strictEqual(detectedBlogCsv.data.articles.length, 2);

  const rpBlogCsv = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: { backupType: "BLOGS", blogs: detectedBlogCsv.data.blogs, articles: detectedBlogCsv.data.articles },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpBlogCsv.success);
  assert.strictEqual(rpBlogCsv.restorePoint.articleCount, 2);

  // Restore imported articles live
  for (const art of detectedBlogCsv.data.articles) {
    const res = await restoreArticle(admin, art);
    assert(res.success, `Restored article ${art.title}`);
  }
  console.log("  ✓ Blogs & Articles CSV: Export → Import → Stage (RP #" + rpBlogCsv.restorePoint.id + ") → Live Restore verified!");

  // Import JSON
  const rpBlogJson = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: JSON.parse(blogJson),
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(rpBlogJson.success);
  assert.strictEqual(rpBlogJson.restorePoint.articleCount, 2);
  console.log("  ✓ Blogs & Articles JSON: Export → Import → Stage (RP #" + rpBlogJson.restorePoint.id + ") verified!");

  // Clean up
  await prisma.restorePoint.deleteMany({
    where: { id: { in: [rpBlogCsv.restorePoint.id, rpBlogJson.restorePoint.id] } },
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. VALIDATION & ERROR MESSAGES
  // ═════════════════════════════════════════════════════════════════
  console.log("\n▶ [Validation] Error Detection & Graceful Reporting");

  // Bad CSV 1: Empty
  try {
    detectAndParseCsvArchive("   \n   \r\n  ");
    assert.fail("Should throw on whitespace");
  } catch (err) {
    assert(err.message.includes("empty"), `Error message: ${err.message}`);
  }

  // Bad CSV 2: Irrelevant columns
  try {
    detectAndParseCsvArchive('"Car Make","Model","Year"\r\n"Toyota","Camry","2022"');
    assert.fail("Should throw on unrecognized headers");
  } catch (err) {
    assert(err.message.includes("Unrecognized CSV format"), `Error message: ${err.message}`);
  }

  // Bad CSV 3: Valid headers but no titles in rows
  try {
    detectAndParseCsvArchive('"Collection ID","Title","Handle"\r\n"101","","handle-only"');
    assert.fail("Should throw when no titles found");
  } catch (err) {
    assert(err.message.includes("No valid collections"), `Error message: ${err.message}`);
  }

  // Bad JSON
  const badJsonRes = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: { unsupportedField: "test" },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert.strictEqual(badJsonRes.success, false);
  assert(badJsonRes.message.includes("No recognizable store assets"));

  console.log("  ✓ All validation rules and descriptive error messages verified!");

  console.log("\n==================================================================");
  console.log("   ALL WORKFLOWS AND VALIDATIONS VERIFIED SUCCESSFULLY!");
  console.log("==================================================================\n");
}

runE2E()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("E2E Test Failed:", e);
    prisma.$disconnect();
    process.exit(1);
  });
