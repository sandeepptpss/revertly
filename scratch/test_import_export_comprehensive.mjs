import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  generateProductsCsv,
  fetchThemeBackup,
  fetchCollectionsBackup,
  fetchPagesBackup,
  fetchMenusBackup,
  fetchBlogsAndArticlesBackup,
  fetchLiveProductsBackup,
  importBackupPayload,
  restoreMenu,
} from "../app/backup.server.js";

const TEST_SHOP = "quickstart-749ac396.myshopify.com";

function createMockAdmin() {
  const menusStore = [
    { id: "gid://shopify/Menu/101", title: "Main Menu Live", handle: "main-menu", items: [] },
  ];

  return {
    graphql: async (query, { variables } = {}) => {
      // Mock menu queries & mutations
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
        return {
          json: async () => ({
            data: {
              menuCreate: {
                menu: { id: "gid://shopify/Menu/999", title: variables.title, handle: variables.handle },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("findMenuByHandle")) {
        return {
          json: async () => ({
            data: {
              menus: {
                nodes: menusStore,
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
                  { id: "gid://shopify/Menu/101", title: "Main Menu", handle: "main-menu", items: [] },
                  { id: "gid://shopify/Menu/102", title: "Footer Menu", handle: "footer", items: [] },
                ],
              },
            },
          }),
        };
      }
      // An import stages theme files into a new unpublished theme rather than
      // writing over the live storefront, so the mock has to serve the
      // create + file-upsert pair that path uses.
      if (query.includes("themeCreate")) {
        return {
          json: async () => ({
            data: {
              themeCreate: {
                theme: {
                  id: "gid://shopify/Theme/999",
                  name: variables?.name || variables?.input?.name || "Staging Theme",
                  role: "UNPUBLISHED",
                },
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
                upsertedThemeFiles: (variables?.files || []).map((f) => ({
                  filename: f.filename,
                })),
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("getThemes") || query.includes("theme(")) {
        return {
          json: async () => ({
            data: {
              themes: {
                nodes: [
                  { id: "gid://shopify/Theme/888", name: "Live Dawn Theme", role: "MAIN", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
                ],
              },
              theme: {
                files: {
                  nodes: [
                    { filename: "layout/theme.liquid", size: 100, body: { content: "<html>Live Dawn</html>" } },
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
                  { id: "gid://shopify/Collection/777", title: "Live Summer Collection", handle: "summer" },
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
                  { id: "gid://shopify/Page/666", title: "Live About", handle: "about", body: "About content" },
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
                    id: "gid://shopify/Blog/555",
                    title: "Live News Blog",
                    handle: "news",
                    articles: { nodes: [{ id: "gid://shopify/Article/444", title: "Live Article 1" }] },
                  },
                ],
              },
            },
          }),
        };
      }
      if (query.includes("collectionUpdate") || query.includes("collectionCreate")) {
        return {
          json: async () => ({
            data: {
              collectionUpdate: { collection: { id: "gid://shopify/Collection/777", title: "Updated Col" }, userErrors: [] },
            },
          }),
        };
      }
      if (query.includes("pageUpdate") || query.includes("pageCreate")) {
        return {
          json: async () => ({
            data: {
              pageUpdate: { page: { id: "gid://shopify/Page/666", title: "Updated Page" }, userErrors: [] },
            },
          }),
        };
      }
      if (query.includes("articleUpdate") || query.includes("articleCreate")) {
        return {
          json: async () => ({
            data: {
              articleUpdate: { article: { id: "gid://shopify/Article/444", title: "Updated Art" }, userErrors: [] },
            },
          }),
        };
      }
      // default mock
      return {
        json: async () => ({ data: {} }),
      };
    },
  };
}

// Logic mirror of app.export.jsx to test in pure Node
async function simulateExport({ type, rpIdParam, shop = TEST_SHOP }) {
  const admin = createMockAdmin();
  const cleanShop = shop.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date().toISOString().split("T")[0];

  let targetRp = null;
  if (rpIdParam) {
    const parsedId = parseInt(rpIdParam, 10);
    if (isNaN(parsedId)) {
      return { status: 400, error: "Invalid Restore Point ID" };
    }
    targetRp = await prisma.restorePoint.findFirst({
      where: { id: parsedId, shop },
    });
    if (!targetRp) {
      return { status: 404, error: `Restore Point #${parsedId} not found for this store.` };
    }
  }

  const isSnapshot = Boolean(targetRp);
  const filePrefix = isSnapshot ? `rp${targetRp.id}` : "live";

  if (type === "products_csv") {
    let products = [];
    if (isSnapshot) {
      products = Array.isArray(targetRp.snapshotData) ? targetRp.snapshotData : [];
    } else {
      products = await prisma.productSnapshot.findMany({
        where: { shop, isDeleted: false },
        orderBy: { updatedAt: "desc" },
      });
      if (products.length === 0) {
        products = await fetchLiveProductsBackup(admin, shop);
      }
    }
    const csvContent = generateProductsCsv(products);
    const filename = `revertly-products-${cleanShop}-${filePrefix}-${dateStr}.csv`;
    return { status: 200, filename, contentType: "text/csv; charset=utf-8", content: csvContent, count: products.length };
  }

  if (type === "products_json") {
    let products = [];
    if (isSnapshot) {
      products = Array.isArray(targetRp.snapshotData) ? targetRp.snapshotData : [];
    } else {
      products = await prisma.productSnapshot.findMany({
        where: { shop, isDeleted: false },
        orderBy: { updatedAt: "desc" },
      });
      if (products.length === 0) {
        products = await fetchLiveProductsBackup(admin, shop);
      }
    }
    const payload = {
      _schema: "revertly-products-v1",
      shop,
      source: isSnapshot ? "snapshot" : "live",
      restorePointId: targetRp?.id || undefined,
      restorePointName: targetRp?.name || undefined,
      exportedAt: new Date().toISOString(),
      count: products.length,
      products,
    };
    const filename = `revertly-products-${cleanShop}-${filePrefix}-${dateStr}.json`;
    return { status: 200, filename, contentType: "application/json; charset=utf-8", payload };
  }

  if (type === "themes_json") {
    let themeData = null;
    if (isSnapshot) {
      themeData = targetRp.themeData || null;
    } else {
      themeData = await fetchThemeBackup(admin);
    }
    const payload = {
      _schema: "revertly-themes-v1",
      shop,
      source: isSnapshot ? "snapshot" : "live",
      restorePointId: targetRp?.id || undefined,
      restorePointName: targetRp?.name || undefined,
      exportedAt: new Date().toISOString(),
      theme: themeData,
    };
    const filename = `revertly-theme-${cleanShop}-${filePrefix}-${dateStr}.json`;
    return { status: 200, filename, contentType: "application/json; charset=utf-8", payload };
  }

  if (type === "collections_json") {
    let collections = [];
    if (isSnapshot) {
      collections = Array.isArray(targetRp.collectionData) ? targetRp.collectionData : [];
    } else {
      collections = await fetchCollectionsBackup(admin);
    }
    const payload = {
      _schema: "revertly-collections-v1",
      shop,
      source: isSnapshot ? "snapshot" : "live",
      restorePointId: targetRp?.id || undefined,
      restorePointName: targetRp?.name || undefined,
      exportedAt: new Date().toISOString(),
      count: collections.length,
      collections,
    };
    const filename = `revertly-collections-${cleanShop}-${filePrefix}-${dateStr}.json`;
    return { status: 200, filename, contentType: "application/json; charset=utf-8", payload };
  }

  if (type === "pages_json") {
    let pages = [];
    let menus = [];
    if (isSnapshot) {
      pages = Array.isArray(targetRp.pageData) ? targetRp.pageData : [];
      menus = Array.isArray(targetRp.menuData) ? targetRp.menuData : [];
    } else {
      const [p, m] = await Promise.all([fetchPagesBackup(admin), fetchMenusBackup(admin)]);
      pages = p;
      menus = m;
    }
    const payload = {
      _schema: "revertly-pages-v1",
      shop,
      source: isSnapshot ? "snapshot" : "live",
      restorePointId: targetRp?.id || undefined,
      restorePointName: targetRp?.name || undefined,
      exportedAt: new Date().toISOString(),
      pageCount: pages.length,
      menuCount: menus.length,
      pages,
      menus,
    };
    const filename = `revertly-pages-${cleanShop}-${filePrefix}-${dateStr}.json`;
    return { status: 200, filename, contentType: "application/json; charset=utf-8", payload };
  }

  if (type === "blogs_json") {
    let blogData = null;
    if (isSnapshot) {
      blogData = targetRp.articleData || null;
    } else {
      blogData = await fetchBlogsAndArticlesBackup(admin);
    }
    const payload = {
      _schema: "revertly-blogs-v1",
      shop,
      source: isSnapshot ? "snapshot" : "live",
      restorePointId: targetRp?.id || undefined,
      restorePointName: targetRp?.name || undefined,
      exportedAt: new Date().toISOString(),
      blogs: blogData?.blogs || [],
      articles: blogData?.articles || [],
    };
    const filename = `revertly-blogs-${cleanShop}-${filePrefix}-${dateStr}.json`;
    return { status: 200, filename, contentType: "application/json; charset=utf-8", payload };
  }

  // full_json
  if (isSnapshot) {
    const exportPayload = {
      _schema: "revertly-disaster-recovery-v1",
      app: "Revertly Store Protection & Backups",
      shop,
      source: "snapshot",
      restorePointId: targetRp.id,
      name: targetRp.name,
      description: targetRp.description || "",
      status: targetRp.status,
      backupType: targetRp.backupType,
      createdAt: targetRp.createdAt,
      exportedAt: new Date().toISOString(),
      summary: {
        productsCount: targetRp.productCount,
        themeCount: targetRp.themeCount,
        collectionCount: targetRp.collectionCount,
        pageCount: targetRp.pageCount,
        menuCount: targetRp.menuCount,
        articleCount: targetRp.articleCount || 0,
      },
      storeAssets: {
        products: targetRp.snapshotData || [],
        theme: targetRp.themeData || null,
        collections: targetRp.collectionData || [],
        pages: targetRp.pageData || [],
        menus: targetRp.menuData || [],
        blogsAndArticles: targetRp.articleData || null,
      },
    };
    const filename = `revertly-backup-${cleanShop}-${filePrefix}-${dateStr}.json`;
    return { status: 200, filename, contentType: "application/json; charset=utf-8", payload: exportPayload };
  }

  let products = await prisma.productSnapshot.findMany({ where: { shop, isDeleted: false } });
  if (products.length === 0) {
    products = await fetchLiveProductsBackup(admin, shop);
  }
  const [theme, collections, pages, menus, blogData] = await Promise.all([
    fetchThemeBackup(admin),
    fetchCollectionsBackup(admin),
    fetchPagesBackup(admin),
    fetchMenusBackup(admin),
    fetchBlogsAndArticlesBackup(admin),
  ]);

  const livePayload = {
    _schema: "revertly-disaster-recovery-v1",
    app: "Revertly Store Protection & Backups",
    shop,
    source: "live",
    name: `Live Store Export - ${dateStr}`,
    description: "On-demand export of live Shopify store assets.",
    status: "READY",
    backupType: "FULL",
    exportedAt: new Date().toISOString(),
    summary: {
      productsCount: products.length,
      themeCount: theme ? 1 : 0,
      collectionCount: collections.length,
      pageCount: pages.length,
      menuCount: menus.length,
      articleCount: blogData?.articles?.length || 0,
    },
    storeAssets: {
      products,
      theme,
      collections,
      pages,
      menus,
      blogsAndArticles: blogData,
    },
  };
  const filename = `revertly-live-backup-${cleanShop}-${dateStr}.json`;
  return { status: 200, filename, contentType: "application/json; charset=utf-8", payload: livePayload };
}

async function runComprehensiveVerification() {
  console.log("=== RUNNING COMPREHENSIVE IMPORT & EXPORT VERIFICATION ===");

  // Find a pages backup RP and a full backup RP to test snapshot isolation
  const pagesRp = await prisma.restorePoint.findFirst({
    where: { shop: TEST_SHOP, backupType: "PAGES" },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Using Pages-only RP #${pagesRp?.id} (${pagesRp?.name}) for snapshot isolation testing`);

  const fullRp = await prisma.restorePoint.findFirst({
    where: { shop: TEST_SHOP, backupType: "FULL" },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Using Full RP #${fullRp?.id} (${fullRp?.name}) for full snapshot testing\n`);

  // ── TEST 1: LIVE full_json export (no rpIdParam)
  console.log("[TEST 1] Live full_json export");
  const liveFull = await simulateExport({ type: "full_json", rpIdParam: null });
  assert.strictEqual(liveFull.status, 200);
  assert.strictEqual(liveFull.payload.source, "live", "Source must be 'live'");
  assert.strictEqual(liveFull.payload.restorePointId, undefined, "Live export must not have restorePointId");
  assert(liveFull.filename.includes("-live-backup-"), "Filename must include -live-backup-");
  assert(liveFull.payload.storeAssets.products.length > 0, "Live export includes products");
  assert(liveFull.payload.storeAssets.theme !== null, "Live export includes theme");
  assert(liveFull.payload.storeAssets.collections.length > 0, "Live export includes collections");
  assert(liveFull.payload.storeAssets.pages.length > 0, "Live export includes pages");
  assert(liveFull.payload.storeAssets.menus.length > 0, "Live export includes menus");
  console.log(`✓ Live full_json exported successfully: ${liveFull.filename} (prods: ${liveFull.payload.summary.productsCount}, theme: ${liveFull.payload.summary.themeCount}, cols: ${liveFull.payload.summary.collectionCount}, pages: ${liveFull.payload.summary.pageCount}, menus: ${liveFull.payload.summary.menuCount})`);

  // ── TEST 2: SNAPSHOT full_json export
  console.log("\n[TEST 2] Snapshot full_json export (RP #" + fullRp.id + ")");
  const snapFull = await simulateExport({ type: "full_json", rpIdParam: String(fullRp.id) });
  assert.strictEqual(snapFull.status, 200);
  assert.strictEqual(snapFull.payload.source, "snapshot");
  assert.strictEqual(snapFull.payload.restorePointId, fullRp.id);
  assert(snapFull.filename.includes(`-rp${fullRp.id}-`), `Filename must include -rp${fullRp.id}-`);
  console.log(`✓ Snapshot full_json exported successfully: ${snapFull.filename}`);

  // ── TEST 3: SNAPSHOT isolation test on Pages-only RP (no live leaks)
  console.log("\n[TEST 3] Snapshot isolation: Products export on Pages-only RP #" + pagesRp.id);
  const snapProdsCsv = await simulateExport({ type: "products_csv", rpIdParam: String(pagesRp.id) });
  assert.strictEqual(snapProdsCsv.status, 200);
  assert.strictEqual(snapProdsCsv.count, 0, "Pages RP must have 0 products in CSV export (NO LIVE LEAK)");
  assert(snapProdsCsv.filename.includes(`-rp${pagesRp.id}-`));

  const snapProdsJson = await simulateExport({ type: "products_json", rpIdParam: String(pagesRp.id) });
  assert.strictEqual(snapProdsJson.status, 200);
  assert.strictEqual(snapProdsJson.payload.count, 0, "Pages RP must have 0 products in JSON export (NO LIVE LEAK)");
  assert.strictEqual(snapProdsJson.payload.source, "snapshot");
  assert.strictEqual(snapProdsJson.payload.restorePointId, pagesRp.id);

  const snapThemeJson = await simulateExport({ type: "themes_json", rpIdParam: String(pagesRp.id) });
  assert.strictEqual(snapThemeJson.status, 200);
  assert.strictEqual(snapThemeJson.payload.theme, null, "Pages RP must have null theme (NO LIVE LEAK)");

  const snapColJson = await simulateExport({ type: "collections_json", rpIdParam: String(pagesRp.id) });
  assert.strictEqual(snapColJson.status, 200);
  assert.strictEqual(snapColJson.payload.count, 0, "Pages RP must have 0 collections (NO LIVE LEAK)");

  const snapPagesJson = await simulateExport({ type: "pages_json", rpIdParam: String(pagesRp.id) });
  assert.strictEqual(snapPagesJson.status, 200);
  assert(snapPagesJson.payload.pageCount > 0, "Pages RP has actual pages");
  assert.strictEqual(snapPagesJson.payload.source, "snapshot");
  console.log("✓ Snapshot isolation strictly verified: 0 live data leakage into historical partial snapshots!");

  // ── TEST 4: Invalid restorePoint ID returns 404
  console.log("\n[TEST 4] Invalid / Non-existent restore point ID");
  const missingRp = await simulateExport({ type: "full_json", rpIdParam: "9999999" });
  assert.strictEqual(missingRp.status, 404);
  assert(missingRp.error.includes("not found"));

  const invalidRpId = await simulateExport({ type: "full_json", rpIdParam: "not-a-number" });
  assert.strictEqual(invalidRpId.status, 400);
  console.log("✓ Error handling verified: 404 on missing RP, 400 on invalid ID");

  // ── TEST 5: Menu restoration function
  console.log("\n[TEST 5] Menu restoration functionality");
  const admin = createMockAdmin();
  const menuToRestore = {
    id: "gid://shopify/Menu/101",
    title: "Main Menu",
    handle: "main-menu",
    items: [
      { title: "Home", url: "/", type: "HTTP" },
      { title: "Catalog", url: "/collections/all", type: "HTTP" },
    ],
  };
  const menuRes = await restoreMenu(admin, menuToRestore);
  assert(menuRes.success, "Menu restore succeeded");
  console.log("✓ restoreMenu helper verified:", menuRes.mode, menuRes.menu?.title);

  // ── TEST 6: Re-importing live exported archive as SAVE_AS_RESTORE_POINT
  console.log("\n[TEST 6] Import of live exported backup payload");
  const importRes = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: liveFull.payload,
    mode: "SAVE_AS_RESTORE_POINT",
  });
  assert(importRes.success, "Import succeeded");
  assert(importRes.restorePoint.id > 0, "Restore point created in DB");
  assert.strictEqual(importRes.restorePoint.status, "READY");
  assert.strictEqual(importRes.summary.menus, liveFull.payload.summary.menuCount, "Menu count preserved");
  console.log(`✓ Re-imported successfully as Restore Point #${importRes.restorePoint.id}: ${importRes.message}`);

  // ── TEST 7: Re-importing with RESTORE_NOW (exercises live restoration including menus)
  console.log("\n[TEST 7] Import with RESTORE_NOW (Live restoration pipeline)");
  const restoreNowRes = await importBackupPayload({
    admin,
    shop: TEST_SHOP,
    payload: liveFull.payload,
    mode: "RESTORE_NOW",
  });
  assert(restoreNowRes.success, "RESTORE_NOW succeeded");
  assert(restoreNowRes.summary.restoredLive, "Restored live is true");
  assert(restoreNowRes.summary.liveResults.menus > 0, "Menus were restored");
  assert(restoreNowRes.summary.liveResults.pages > 0, "Pages were restored");
  assert(restoreNowRes.summary.liveResults.collections > 0, "Collections were restored");
  assert(restoreNowRes.summary.liveResults.themeStagingCreated, "Theme staging was created");
  console.log("✓ RESTORE_NOW verified:", restoreNowRes.message);

  // Clean up created restore points from tests
  await prisma.restorePoint.delete({ where: { id: importRes.restorePoint.id } });
  await prisma.restorePoint.delete({ where: { id: restoreNowRes.restorePoint.id } });
  console.log("✓ Test cleanup completed");

  console.log("\n=== ALL COMPREHENSIVE VERIFICATION TESTS PASSED SUCCESSFULLY! ===");
}

runComprehensiveVerification().then(() => prisma.$disconnect()).catch((e) => {
  console.error("FATAL TEST ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
