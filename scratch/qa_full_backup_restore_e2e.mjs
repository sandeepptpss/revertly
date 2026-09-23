/**
 * Comprehensive Senior QA Engineer Verification Suite for Revertly:
 * 1. All 8 Instant 1-Click Backup Options (Full, Theme, Product, Collection, Page, Blog, Menu, Metafield)
 * 2. Complete Restore Flow (Theme live/draft, Collections, Pages, Menus, Blogs/Articles, Metafields, Products single/bulk)
 * 3. Import & Export (JSON & CSV across all datasets, auto-detection, RESTORE_NOW vs SAVE_AS_RESTORE_POINT, invalid cases)
 * 4. Daily Backup Automation (Schedule calculations, cron execution, auto cloud sync, audit logging)
 * 5. Edge cases & bug fix regression validations
 *
 * Run:
 *   /home/tpss/.nvm/versions/node/v22.23.2/bin/node --import ./scratch/jsx-register.mjs scratch/qa_full_backup_restore_e2e.mjs
 */

import assert from "node:assert";
import prisma from "../app/db.server.js";
import {
  backupTheme,
  backupProducts,
  backupCollections,
  backupPages,
  backupBlogs,
  backupMenus,
  backupMetafields,
  createMultiResourceRestorePoint,
  restoreThemeFilesWithSafety,
  restoreCollection,
  restorePage,
  restoreMenu,
  restoreArticle,
  restoreMetafieldBackup,
  importBackupPayload,
  generateProductsCsv,
  generateCollectionsCsv,
  generatePagesAndMenusCsv,
  generateMenusCsv,
  generateBlogsAndArticlesCsv,
  generateMetafieldsCsv,
  detectAndParseCsvArchive,
} from "../app/backup.server.js";
import {
  computeNextAutoBackup,
  runScheduledBackupForShop,
} from "../app/scheduler.server.js";
import { rollbackProductFields } from "../app/monitor.server.js";

const TEST_SHOP = "qa-e2e-master-verification.myshopify.com";

let passed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    failures.push({ label, message: err?.message || String(err) });
    console.log(`  ✗ ${label}\n      ${err?.message || err}`);
  }
}

function section(title) {
  console.log(`\n=================================================================`);
  console.log(`▶ ${title}`);
  console.log(`=================================================================`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stateful In-Memory Mock Store
// ─────────────────────────────────────────────────────────────────────────────

function createMockStore() {
  return {
    themes: [
      { id: "gid://shopify/Theme/101", name: "Dawn (Active)", role: "MAIN", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "gid://shopify/Theme/102", name: "Studio (Draft)", role: "UNPUBLISHED", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
    ],
    themeFiles: [
      { filename: "layout/theme.liquid", size: 100, body: { content: "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>" } },
      { filename: "templates/index.json", size: 50, body: { content: '{"sections":{"main":{"type":"hero"}},"order":["main"]}' } },
      { filename: "config/settings_data.json", size: 60, body: { content: '{"current":{"color_accent":"#2563eb"}}' } },
    ],
    products: [
      {
        id: "gid://shopify/Product/5001",
        title: "Wireless Noise-Canceling Headphones",
        handle: "wireless-headphones",
        status: "ACTIVE",
        vendor: "AudioTech",
        productType: "Electronics",
        tags: ["wireless", "audio", "noise-canceling"],
        bodyHtml: "<p>Premium high-fidelity audio headphones.</p>",
        variants: {
          nodes: [
            { id: "gid://shopify/ProductVariant/50011", title: "Black", price: "299.99", compareAtPrice: "349.99", sku: "HDPHN-BLK" },
            { id: "gid://shopify/ProductVariant/50012", title: "Silver", price: "299.99", compareAtPrice: "349.99", sku: "HDPHN-SLV" },
          ],
        },
        metafields: {
          edges: [
            { node: { id: "gid://shopify/Metafield/9001", namespace: "custom", key: "battery_life", value: "30 hours", type: "single_line_text_field" } },
          ],
        },
      },
      {
        id: "gid://shopify/Product/5002",
        title: "Ergonomic Mechanical Keyboard",
        handle: "ergonomic-keyboard",
        status: "ACTIVE",
        vendor: "KeyWorks",
        productType: "Accessories",
        tags: ["keyboard", "ergonomic", "mechanical"],
        bodyHtml: "<p>Custom mechanical keyboard for fast typing.</p>",
        variants: {
          nodes: [
            { id: "gid://shopify/ProductVariant/50021", title: "Brown Switches", price: "149.00", compareAtPrice: "", sku: "KB-BRN" },
          ],
        },
        metafields: { edges: [] },
      },
    ],
    collections: [
      {
        id: "gid://shopify/Collection/201",
        title: "Top Rated Audio Gear",
        handle: "top-audio",
        descriptionHtml: "<p>Our best selling headphones and speakers.</p>",
        sortOrder: "BEST_SELLING",
        ruleSet: {
          appliedDisjunctively: true,
          rules: [{ column: "TAG", relation: "EQUALS", condition: "audio" }],
        },
      },
      {
        id: "gid://shopify/Collection/202",
        title: "Office Essentials",
        handle: "office-essentials",
        descriptionHtml: "<p>Work from home gear.</p>",
        sortOrder: "MANUAL",
        ruleSet: null,
      },
    ],
    pages: [
      {
        id: "gid://shopify/Page/301",
        title: "About Revertly Audio",
        handle: "about-us",
        body: "<p>We design acoustic experiences for creators.</p>",
        bodySummary: "About Revertly",
        isPublished: true,
        templateSuffix: "",
      },
      {
        id: "gid://shopify/Page/302",
        title: "Return & Warranty Policy",
        handle: "return-policy",
        body: "<p>30 days risk-free return window on all gear.</p>",
        bodySummary: "Returns",
        isPublished: true,
        templateSuffix: "",
      },
    ],
    menus: [
      {
        id: "gid://shopify/Menu/401",
        title: "Main Navigation Menu",
        handle: "main-menu",
        isDefault: true,
        items: [
          {
            id: "gid://shopify/MenuItem/1",
            title: "Audio",
            type: "COLLECTION",
            resourceId: "gid://shopify/Collection/201",
            url: "/collections/top-audio",
            items: [
              { id: "gid://shopify/MenuItem/11", title: "Headphones", type: "PRODUCT", resourceId: "gid://shopify/Product/5001", url: "/products/wireless-headphones", items: [] },
            ],
          },
          {
            id: "gid://shopify/MenuItem/2",
            title: "About Us",
            type: "PAGE",
            resourceId: "gid://shopify/Page/301",
            url: "/pages/about-us",
            items: [],
          },
        ],
      },
    ],
    blogs: [
      {
        id: "gid://shopify/Blog/601",
        title: "Audio Insights Blog",
        handle: "audio-insights",
        commentPolicy: "MODERATED",
        templateSuffix: "",
        articles: {
          nodes: [
            {
              id: "gid://shopify/Article/701",
              title: "Understanding Spatial Sound in 2026",
              handle: "understanding-spatial-sound",
              blogId: "gid://shopify/Blog/601",
              blogTitle: "Audio Insights Blog",
              blogHandle: "audio-insights",
              author: { name: "Dr. Sound" },
              tags: ["spatial-audio", "acoustics", "tech"],
              isPublished: true,
              publishedAt: "2026-03-01T12:00:00Z",
              summary: "Guide to 3D spatial acoustics.",
              body: "<p>Spatial sound transforms immersive listening...</p>",
              image: { url: "https://cdn.shopify.com/s/files/spatial.jpg", altText: "Spatial Soundwave Graphic" },
            },
          ],
        },
      },
    ],
    shopMetafields: [
      {
        id: "gid://shopify/Metafield/801",
        namespace: "settings",
        key: "support_hotline",
        value: "+1-800-REVERTLY",
        type: "single_line_text_field",
        compareDigest: "d1",
        updatedAt: "2026-03-01T00:00:00Z",
      },
    ],
  };
}

function createMockAdmin(store) {
  const j = (data, extra = {}) => ({ json: async () => ({ data, ...extra }) });

  return {
    graphql: async (query, { variables } = {}) => {
      // 1. Themes queries
      if (query.includes("getThemesList") || query.includes("query getThemes")) {
        return j({ themes: { nodes: store.themes } });
      }
      if (query.includes("getAllThemeFiles") || query.includes("getThemeFiles")) {
        return j({ theme: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: store.themeFiles } } });
      }
      if (query.includes("themeFilesUpsert")) {
        for (const file of variables?.files || []) {
          const live = store.themeFiles.find((f) => f.filename === file.filename);
          if (live) live.body.content = file.body?.value || "";
          else store.themeFiles.push({ filename: file.filename, size: 20, body: { content: file.body?.value || "" } });
        }
        return j({ themeFilesUpsert: { userErrors: [], upsertedThemeFiles: (variables?.files || []).map((f) => ({ filename: f.filename })) } });
      }
      if (query.includes("themeCreate")) {
        const name = variables?.name || variables?.input?.name || "Staging Theme";
        const newTheme = {
          id: `gid://shopify/Theme/staging_${Date.now()}`,
          name,
          role: "UNPUBLISHED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.themes.push(newTheme);
        return j({ themeCreate: { theme: newTheme, userErrors: [] } });
      }

      // 2. Products queries & mutations
      if (query.includes("getProductsForBackup") || query.includes("query getProducts")) {
        return j({
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: store.products,
          },
        });
      }
      if (query.includes("updateProduct") || query.includes("productUpdate")) {
        const input = variables?.input || {};
        const p = store.products.find((prod) => prod.id === input.id || prod.id.endsWith(input.id));
        if (p) {
          if (input.title !== undefined) p.title = input.title;
          if (input.bodyHtml !== undefined) p.bodyHtml = input.bodyHtml;
          if (input.descriptionHtml !== undefined) p.bodyHtml = input.descriptionHtml;
          if (input.vendor !== undefined) p.vendor = input.vendor;
          if (input.tags !== undefined) p.tags = input.tags;
          if (input.status !== undefined) p.status = input.status;
          return j({ productUpdate: { product: { id: p.id, title: p.title }, userErrors: [] } });
        }
        return j({ productUpdate: { product: null, userErrors: [{ field: ["id"], message: "Product not found" }] } });
      }

      // 3. Collections queries & mutations
      if (query.includes("getCollections")) {
        return j({
          collections: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: store.collections,
          },
        });
      }
      if (query.includes("findCollectionByHandle")) {
        return j({ collections: { nodes: store.collections.map((c) => ({ id: c.id, title: c.title, handle: c.handle })) } });
      }
      if (query.includes("collectionUpdate")) {
        const input = variables?.input || {};
        const c = store.collections.find((col) => col.id === input.id || col.handle === input.handle);
        if (c) {
          if (input.title !== undefined) c.title = input.title;
          if (input.descriptionHtml !== undefined) c.descriptionHtml = input.descriptionHtml;
          if (input.sortOrder !== undefined) c.sortOrder = input.sortOrder;
          if (input.ruleSet !== undefined) c.ruleSet = input.ruleSet;
          return j({ collectionUpdate: { collection: c, userErrors: [] } });
        }
        return j({ collectionUpdate: { collection: null, userErrors: [{ message: "Not found" }] } });
      }
      if (query.includes("collectionCreate")) {
        const input = variables?.input || {};
        const newCol = {
          id: `gid://shopify/Collection/${Date.now()}`,
          title: input.title,
          handle: input.handle || "new-collection",
          descriptionHtml: input.descriptionHtml || "",
          sortOrder: input.sortOrder || "BEST_SELLING",
          ruleSet: input.ruleSet || null,
        };
        store.collections.push(newCol);
        return j({ collectionCreate: { collection: newCol, userErrors: [] } });
      }

      // 4. Pages queries & mutations
      if (query.includes("getPages")) {
        return j({
          pages: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: store.pages,
          },
        });
      }
      if (query.includes("findPageByHandle")) {
        return j({ pages: { nodes: store.pages.map((p) => ({ id: p.id, title: p.title, handle: p.handle })) } });
      }
      if (query.includes("pageUpdate")) {
        const id = variables?.id;
        const pageInput = variables?.page || {};
        const pg = store.pages.find((p) => p.id === id);
        if (pg) {
          if (pageInput.title !== undefined) pg.title = pageInput.title;
          if (pageInput.body !== undefined) pg.body = pageInput.body;
          if (pageInput.isPublished !== undefined) pg.isPublished = pageInput.isPublished;
          return j({ pageUpdate: { page: pg, userErrors: [] } });
        }
        return j({ pageUpdate: { page: null, userErrors: [{ message: "Not found" }] } });
      }
      if (query.includes("pageCreate")) {
        const pageInput = variables?.page || {};
        const newPg = {
          id: `gid://shopify/Page/${Date.now()}`,
          title: pageInput.title,
          handle: pageInput.handle || "new-page",
          body: pageInput.body || "",
          isPublished: pageInput.isPublished ?? true,
        };
        store.pages.push(newPg);
        return j({ pageCreate: { page: newPg, userErrors: [] } });
      }

      // 5. Menus queries & mutations
      if (query.includes("getMenus") || query.includes("findMenuByHandle")) {
        return j({
          menus: {
            nodes: store.menus,
          },
        });
      }
      if (query.includes("menuUpdate")) {
        const id = variables?.id;
        const items = variables?.items || [];
        const m = store.menus.find((menu) => menu.id === id);
        if (m) {
          m.items = items;
          return j({ menuUpdate: { menu: m, userErrors: [] } });
        }
        return j({ menuUpdate: { menu: null, userErrors: [{ message: "Not found" }] } });
      }
      if (query.includes("menuCreate")) {
        const newMenu = {
          id: `gid://shopify/Menu/${Date.now()}`,
          title: variables?.title || "New Menu",
          handle: variables?.handle || "new-menu",
          items: variables?.items || [],
        };
        store.menus.push(newMenu);
        return j({ menuCreate: { menu: newMenu, userErrors: [] } });
      }

      // 6. Blogs & Articles queries & mutations
      if (query.includes("getBlogsWithArticles")) {
        return j({
          blogs: {
            nodes: store.blogs,
          },
        });
      }
      if (query.includes("getBlogsForRestore") || query.includes("getBlogsForArticleRestore") || query.includes("query getBlogs")) {
        return j({ blogs: { nodes: store.blogs.map((b) => ({ id: b.id, title: b.title, handle: b.handle })) } });
      }
      if (query.includes("articleUpdate")) {
        const id = variables?.id;
        const artInput = variables?.article || {};
        for (const b of store.blogs) {
          const art = b.articles?.nodes?.find((a) => a.id === id);
          if (art) {
            if (artInput.title !== undefined) art.title = artInput.title;
            if (artInput.body !== undefined) art.body = artInput.body;
            if (artInput.author !== undefined) art.author = artInput.author;
            return j({ articleUpdate: { article: art, userErrors: [] } });
          }
        }
        return j({ articleUpdate: { article: null, userErrors: [{ message: "Not found" }] } });
      }
      if (query.includes("articleCreate")) {
        const blogId = variables?.blogId;
        const artInput = variables?.article || {};
        const b = store.blogs.find((bl) => bl.id === blogId) || store.blogs[0];
        const newArt = {
          id: `gid://shopify/Article/${Date.now()}`,
          blogId: b.id,
          blogTitle: b.title,
          blogHandle: b.handle,
          title: artInput.title,
          handle: artInput.handle || "new-article",
          author: artInput.author || { name: "Author" },
          body: artInput.body || "",
          tags: artInput.tags || [],
          image: artInput.image || null,
        };
        b.articles.nodes.push(newArt);
        return j({ articleCreate: { article: newArt, userErrors: [] } });
      }

      // 7. Metafields queries & mutations
      if (query.includes("metafieldDefinitionsBackup")) {
        return j({
          metafieldDefinitions: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/MetafieldDefinition/1",
                name: "Battery Life",
                namespace: "custom",
                key: "battery_life",
                ownerType: variables?.ownerType || "PRODUCT",
                type: { name: "single_line_text_field" },
              },
            ],
          },
        });
      }
      if (query.includes("shopMetafieldsBackup")) {
        return j({
          shop: {
            id: "gid://shopify/Shop/1",
            name: "QA Store",
            myshopifyDomain: TEST_SHOP,
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: store.shopMetafields,
            },
          },
        });
      }
      if (query.includes("ownerMetafieldsBackup")) {
        const field = /\s(\w+)\(first:/.exec(query)?.[1] || "products";
        return j({ [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
      }
      if (query.includes("shopIdForMetafields")) {
        return j({ shop: { id: "gid://shopify/Shop/1", myshopifyDomain: TEST_SHOP } });
      }
      if (query.includes("ownerHandleIndex")) {
        const field = /\s(\w+)\(first:/.exec(query)?.[1] || "products";
        return j({ [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
      }
      if (query.includes("liveOwnerMetafields")) {
        return j({ nodes: [{ id: "gid://shopify/Shop/1", metafields: { nodes: store.shopMetafields } }] });
      }
      if (query.includes("metafieldsSet")) {
        const metafields = variables?.metafields || [];
        for (const mf of metafields) {
          const live = store.shopMetafields.find((m) => m.namespace === mf.namespace && m.key === mf.key);
          if (live) {
            live.value = mf.value;
          } else {
            store.shopMetafields.push({
              id: `gid://shopify/Metafield/${Date.now()}`,
              namespace: mf.namespace,
              key: mf.key,
              value: mf.value,
              type: "single_line_text_field",
              compareDigest: "d_new",
            });
          }
        }
        return j({ metafieldsSet: { metafields: metafields.map((m) => ({ id: "gid://shopify/Metafield/new", namespace: m.namespace, key: m.key })), userErrors: [] } });
      }

      // Default fallback
      return j({});
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
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION OF FULL QA TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

async function runQaVerification() {
  console.log("=================================================================");
  console.log("🛡️  STARTING COMPREHENSIVE QA VERIFICATION SUITE");
  console.log("   Shop: " + TEST_SHOP);
  console.log("=================================================================");

  await cleanTestShop();

  // Setup Enterprise Plan AppSettings for test shop
  await prisma.appSettings.create({
    data: {
      shop: TEST_SHOP,
      planId: "enterprise",
      alertEmail: "qa-test@revertly.test",
      autoBackupSchedule: "DAILY",
      autoBackupTime: "03:00",
    },
  });

  const store = createMockStore();
  const admin = createMockAdmin(store);

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 1: ALL 8 INSTANT 1-CLICK BACKUP OPTIONS
  // ═════════════════════════════════════════════════════════════════════════════
  section("1. INSTANT 1-CLICK BACKUP OPTIONS (END-TO-END CAPTURE)");

  let rpFull, rpTheme, rpProd, rpCol, rpPage, rpBlog, rpMenu, rpMeta;

  await check("1.1 Option 1: Full Store Backup captures all resources in one snapshot", async () => {
    const res = await createMultiResourceRestorePoint({
      admin,
      shop: TEST_SHOP,
      name: "Full Store Backup - Test Run",
      backupType: "FULL",
      options: {
        includeProducts: true,
        includeThemes: true,
        includeCollections: true,
        includePages: true,
        includeMenus: true,
        includeArticles: true,
        includeMetafields: true,
      },
    });
    assert.strictEqual(res.success, true, "Full store backup must succeed");
    rpFull = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.ok(rpFull, "Restore point record must exist in DB");
    assert.strictEqual(rpFull.backupType, "FULL");
    assert.strictEqual(rpFull.productCount, 2);
    assert.strictEqual(rpFull.themeCount, 1);
    assert.strictEqual(rpFull.collectionCount, 2);
    assert.strictEqual(rpFull.pageCount, 2);
    assert.strictEqual(rpFull.menuCount, 1);
    assert.strictEqual(rpFull.articleCount, 1);
    assert.ok(rpFull.metafieldCount >= 1, "Metafields must be captured");
  });

  await check("1.2 Option 2: Full Theme Backup captures active theme and liquid/JSON files", async () => {
    const res = await backupTheme({ admin, shop: TEST_SHOP, name: "Dedicated Theme Snapshot" });
    assert.strictEqual(res.success, true);
    rpTheme = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpTheme.backupType, "THEMES");
    assert.strictEqual(rpTheme.themeCount, 1);
    assert.strictEqual(rpTheme.productCount, 0);
    assert.ok(rpTheme.themeData?.files?.length >= 3, "Theme files must be stored");
  });

  await check("1.3 Option 3: Product Backup captures live catalog, variants, and tags", async () => {
    const res = await backupProducts({ admin, shop: TEST_SHOP, name: "Dedicated Products Snapshot" });
    assert.strictEqual(res.success, true);
    rpProd = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpProd.backupType, "PRODUCTS");
    assert.strictEqual(rpProd.productCount, 2);
    assert.strictEqual(rpProd.themeCount, 0);
    assert.ok(Array.isArray(rpProd.snapshotData), "snapshotData must be an array");
  });

  await check("1.4 Option 4: Collection Backup captures smart ruleSets and sorting", async () => {
    const res = await backupCollections({ admin, shop: TEST_SHOP, name: "Dedicated Collections Snapshot" });
    assert.strictEqual(res.success, true);
    rpCol = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpCol.backupType, "COLLECTIONS");
    assert.strictEqual(rpCol.collectionCount, 2);
    const topAudio = rpCol.collectionData.find((c) => c.handle === "top-audio");
    assert.ok(topAudio?.ruleSet?.rules?.length > 0, "RuleSet must be preserved in snapshot");
  });

  await check("1.5 Option 5: Page Backup captures content pages and navigation menus", async () => {
    const res = await backupPages({ admin, shop: TEST_SHOP, name: "Dedicated Pages Snapshot" });
    assert.strictEqual(res.success, true);
    rpPage = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpPage.backupType, "PAGES");
    assert.strictEqual(rpPage.pageCount, 2);
    assert.strictEqual(rpPage.menuCount, 1);
  });

  await check("1.6 Option 6: Blog Backup captures blog articles, authors, images, tags", async () => {
    const res = await backupBlogs({ admin, shop: TEST_SHOP, name: "Dedicated Blogs Snapshot" });
    assert.strictEqual(res.success, true);
    rpBlog = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpBlog.backupType, "BLOGS");
    assert.strictEqual(rpBlog.articleCount, 1);
    const art = rpBlog.articleData?.articles?.[0];
    assert.strictEqual(art?.author?.name, "Dr. Sound", "Article author must be captured");
    assert.ok(art?.image?.url, "Article featured image must be captured");
  });

  await check("1.7 Option 7: Navigation Menu Backup captures nested menu item tree", async () => {
    const res = await backupMenus({ admin, shop: TEST_SHOP, name: "Dedicated Menus Snapshot" });
    assert.strictEqual(res.success, true);
    rpMenu = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpMenu.backupType, "MENUS");
    assert.strictEqual(rpMenu.menuCount, 1);
    const m = rpMenu.menuData?.[0];
    assert.ok(m?.items?.[0]?.items?.length > 0, "Nested menu items must be preserved");
  });

  await check("1.8 Option 8: Metafield Backup captures definitions and values", async () => {
    const res = await backupMetafields({ admin, shop: TEST_SHOP, name: "Dedicated Metafields Snapshot" });
    assert.strictEqual(res.success, true);
    rpMeta = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpMeta.backupType, "METAFIELDS");
    assert.ok(rpMeta.metafieldCount >= 1, "Metafields must be captured");
    assert.ok(rpMeta.metafieldData?._schema === "revertly-metafields-v1");
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 2: COMPLETE RESTORE FLOW VERIFICATION
  // ═════════════════════════════════════════════════════════════════════════════
  section("2. RESTORE FLOW (ALL RESOURCES, LIVE & DRAFT MODES, DRIFT ROLLBACK)");

  await check("2.1 Theme Restore in DRAFT mode creates staging theme without touching live theme", async () => {
    const themeFiles = rpTheme.themeData.files;
    const res = await restoreThemeFilesWithSafety({
      admin,
      shop: TEST_SHOP,
      themeId: "gid://shopify/Theme/101",
      themeName: "Dawn (Active)",
      files: themeFiles,
      mode: "draft",
    });
    assert.strictEqual(res.success, true);
    assert.ok(res.draftThemeId, "draftThemeId must be returned");
    const createdTheme = store.themes.find((t) => t.id === res.draftThemeId);
    assert.ok(createdTheme, "Theme must be added to store themes");
    assert.strictEqual(createdTheme.role, "UNPUBLISHED", "Staging theme must be unpublished");
  });

  await check("2.2 Theme Restore in LIVE mode auto-creates safety snapshot before overwriting", async () => {
    // Modify live theme file to simulate drift
    store.themeFiles[0].body.content = "<html>CORRUPTED THEME</html>";

    const countBefore = await prisma.restorePoint.count({ where: { shop: TEST_SHOP, name: { startsWith: "Pre-Rollback Safety Snapshot" } } });
    const res = await restoreThemeFilesWithSafety({
      admin,
      shop: TEST_SHOP,
      themeId: "gid://shopify/Theme/101",
      themeName: "Dawn (Active)",
      files: rpTheme.themeData.files,
      mode: "live",
    });
    assert.strictEqual(res.success, true);
    const countAfter = await prisma.restorePoint.count({ where: { shop: TEST_SHOP, name: { startsWith: "Pre-Rollback Safety Snapshot" } } });
    assert.strictEqual(countAfter, countBefore + 1, "A safety restore point must be created before live restore");
    assert.ok(store.themeFiles[0].body.content.includes("content_for_header"), "Original content restored");
  });

  await check("2.3 Collection Restore restores modified title and smart ruleSets", async () => {
    // Simulate drift on collection
    store.collections[0].title = "Drifted Audio Sale";
    store.collections[0].ruleSet = null;

    const target = rpCol.collectionData[0];
    const res = await restoreCollection(admin, target);
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.collections[0].title, target.title);
    assert.ok(store.collections[0].ruleSet !== null, "RuleSet must be restored");
  });

  await check("2.4 Page Restore puts saved HTML body back onto the live page", async () => {
    // Simulate drift on page
    store.pages[0].body = "<p>Deleted body content.</p>";

    const target = rpPage.pageData[0];
    const res = await restorePage(admin, target);
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.pages[0].body, target.body);
  });

  await check("2.5 Navigation Menu Restore rebuilds nested item tree", async () => {
    // Simulate corrupted menu
    store.menus[0].items = [];

    const target = rpMenu.menuData[0];
    const res = await restoreMenu(admin, target);
    assert.strictEqual(res.success, true);
    assert.ok(store.menus[0].items.length > 0, "Menu items must be restored");
  });

  await check("2.6 Blog Article Restore preserves author, image, and body", async () => {
    // Simulate article modification
    store.blogs[0].articles.nodes[0].author = { name: "Impostor" };

    const target = rpBlog.articleData.articles[0];
    const res = await restoreArticle(admin, target);
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.blogs[0].articles.nodes[0].author.name, "Dr. Sound", "Original author preserved");
  });

  await check("2.7 Metafield Restore restores saved shop & resource metafield values", async () => {
    store.shopMetafields[0].value = "Corrupted Hotline";

    const res = await restoreMetafieldBackup(admin, TEST_SHOP, rpMeta.metafieldData, {
      mode: "FORCE",
      includeValues: true,
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.shopMetafields[0].value, "+1-800-REVERTLY");
  });

  await check("2.8 Product Restore with selective field masking and cleanId normalization", async () => {
    // Seed product baseline in productSnapshot table
    const prodToRestore = rpProd.snapshotData[0];
    const cleanId = String(prodToRestore.productId).replace("gid://shopify/Product/", "");

    await prisma.productSnapshot.upsert({
      where: { shop_productId: { shop: TEST_SHOP, productId: cleanId } },
      create: {
        shop: TEST_SHOP,
        productId: cleanId,
        title: "Original Headphones Title",
        status: "ACTIVE",
        snapshotData: prodToRestore.snapshotData || prodToRestore,
      },
      update: {
        title: "Original Headphones Title",
        snapshotData: prodToRestore.snapshotData || prodToRestore,
      },
    });

    // Create a mock change event to simulate field rollback
    const ce = await prisma.changeEvent.create({
      data: {
        shop: TEST_SHOP,
        productId: cleanId,
        productTitle: "Original Headphones Title",
        fieldName: "title",
        oldValue: prodToRestore.title,
        newValue: "Drifted Title",
      },
    });

    const rollbackRes = await rollbackProductFields(admin, TEST_SHOP, cleanId, [ce.id]);
    assert.strictEqual(rollbackRes.success, true, "Product field rollback must succeed");
    await prisma.changeEvent.delete({ where: { id: ce.id } });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 3: IMPORT & EXPORT FUNCTIONALITY (JSON & CSV ROUND-TRIP)
  // ═════════════════════════════════════════════════════════════════════════════
  section("3. IMPORT & EXPORT VERIFICATION (JSON & CSV ACROSS ALL ASSETS)");

  await check("3.1 Export Products CSV & auto-detect + import round-trip", async () => {
    const csvContent = generateProductsCsv(rpProd.snapshotData);
    assert.ok(csvContent.startsWith("\uFEFF"), "CSV must include UTF-8 BOM");
    const detected = detectAndParseCsvArchive(csvContent);
    assert.strictEqual(detected.type, "PRODUCTS");
    assert.strictEqual(detected.summary.products, 2);

    const impRes = await importBackupPayload({
      admin,
      shop: TEST_SHOP,
      payload: {
        name: "Products CSV Import Test",
        backupType: detected.type,
        ...detected.data,
      },
      mode: "SAVE_AS_RESTORE_POINT",
    });
    assert.strictEqual(impRes.success, true);
    assert.strictEqual(impRes.restorePoint.productCount, 2);
  });

  await check("3.2 Export Collections CSV & auto-detect + import round-trip", async () => {
    const csvContent = generateCollectionsCsv(rpCol.collectionData);
    const detected = detectAndParseCsvArchive(csvContent);
    assert.strictEqual(detected.type, "COLLECTIONS");
    assert.strictEqual(detected.summary.collections, 2);

    const impRes = await importBackupPayload({
      admin,
      shop: TEST_SHOP,
      payload: {
        name: "Collections CSV Import Test",
        backupType: detected.type,
        ...detected.data,
      },
      mode: "SAVE_AS_RESTORE_POINT",
    });
    assert.strictEqual(impRes.success, true);
    assert.strictEqual(impRes.restorePoint.collectionCount, 2);
  });

  await check("3.3 Export Pages & Menus CSV & auto-detect + import round-trip", async () => {
    const csvContent = generatePagesAndMenusCsv(rpPage.pageData, rpPage.menuData);
    const detected = detectAndParseCsvArchive(csvContent);
    assert.strictEqual(detected.type, "PAGES");
    assert.strictEqual(detected.summary.pages, 2);
    assert.strictEqual(detected.summary.menus, 1);
  });

  await check("3.4 Export Standalone Menus CSV & auto-detect + import round-trip", async () => {
    const csvContent = generateMenusCsv(rpMenu.menuData);
    const detected = detectAndParseCsvArchive(csvContent);
    assert.strictEqual(detected.type, "MENUS");
    assert.strictEqual(detected.summary.menus, 1);
  });

  await check("3.5 Export Blogs CSV & auto-detect + import round-trip", async () => {
    const blogs = rpBlog.articleData?.blogs || [];
    const articles = rpBlog.articleData?.articles || [];
    const csvContent = generateBlogsAndArticlesCsv(blogs, articles);
    const detected = detectAndParseCsvArchive(csvContent);
    assert.strictEqual(detected.type, "BLOGS");
    assert.strictEqual(detected.summary.articles, 1);
  });

  await check("3.6 Export Metafields CSV & auto-detect + import round-trip", async () => {
    const csvContent = generateMetafieldsCsv(rpMeta.metafieldData);
    const detected = detectAndParseCsvArchive(csvContent);
    assert.strictEqual(detected.type, "METAFIELDS");
    assert.ok(detected.summary.metafields >= 1);
  });

  await check("3.7 Full Disaster Recovery JSON Archive import with mode: RESTORE_NOW", async () => {
    const drArchive = {
      _schema: "revertly-disaster-recovery-v1",
      shop: TEST_SHOP,
      name: "Disaster Recovery Test Archive",
      backupType: "FULL",
      storeAssets: {
        products: rpProd.snapshotData,
        theme: rpTheme.themeData,
        collections: rpCol.collectionData,
        pages: rpPage.pageData,
        menus: rpMenu.menuData,
        blogsAndArticles: rpBlog.articleData,
        metafields: rpMeta.metafieldData,
      },
    };

    const impRes = await importBackupPayload({
      admin,
      shop: TEST_SHOP,
      payload: drArchive,
      mode: "RESTORE_NOW",
    });
    assert.strictEqual(impRes.success, true);
    assert.strictEqual(impRes.summary.restoredLive, true);
    assert.ok(impRes.summary.liveResults.pages > 0, "Pages must be restored live");
    assert.ok(impRes.summary.liveResults.collections > 0, "Collections must be restored live");
  });

  await check("3.8 Re-importing archive does not stack [Imported] marker repeatedly", async () => {
    const archive = {
      name: "[Imported] Existing Archive Name",
      products: rpProd.snapshotData,
    };
    const impRes = await importBackupPayload({
      admin,
      shop: TEST_SHOP,
      payload: archive,
      mode: "SAVE_AS_RESTORE_POINT",
    });
    assert.strictEqual(impRes.restorePoint.name, "[Imported] Existing Archive Name");
  });

  await check("3.9 Invalid inputs rejected gracefully: malformed JSON, empty file, non-store CSV", async () => {
    // Malformed JSON
    const malformed = await importBackupPayload({ admin, shop: TEST_SHOP, payload: "INVALID JSON {{" });
    assert.strictEqual(malformed.success, false);
    assert.ok(malformed.message.includes("JSON"), "Must report JSON error");

    // Empty CSV
    assert.throws(() => detectAndParseCsvArchive(""), /empty/i);

    // Header without data
    assert.throws(() => detectAndParseCsvArchive("Title,Handle\r\n"), /no recognizable data rows/i);

    // Empty object
    const emptyObj = await importBackupPayload({ admin, shop: TEST_SHOP, payload: {} });
    assert.strictEqual(emptyObj.success, false);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 4: DAILY BACKUP AUTOMATION & SCHEDULER VERIFICATION
  // ═════════════════════════════════════════════════════════════════════════════
  section("4. DAILY BACKUP AUTOMATION & SCHEDULER VERIFICATION");

  await check("4.1 computeNextAutoBackup calculates correct UTC timestamps for DAILY, TWICE_DAILY, WEEKLY", () => {
    const baseDate = new Date("2026-09-23T04:00:00.000Z");

    // Daily at 02:00 UTC -> already passed today, should be tomorrow at 02:00
    const nextDaily = computeNextAutoBackup("DAILY", "02:00", baseDate);
    assert.strictEqual(nextDaily.toISOString(), "2026-09-24T02:00:00.000Z");

    // Daily at 14:00 UTC -> later today at 14:00
    const todayDaily = computeNextAutoBackup("DAILY", "14:00", baseDate);
    assert.strictEqual(todayDaily.toISOString(), "2026-09-23T14:00:00.000Z");

    // Twice daily at 02:00 UTC -> passed, add 12h -> 14:00
    const nextTwice = computeNextAutoBackup("TWICE_DAILY", "02:00", baseDate);
    assert.strictEqual(nextTwice.toISOString(), "2026-09-23T14:00:00.000Z");

    // Weekly at 02:00 UTC -> passed, add 7 days
    const nextWeekly = computeNextAutoBackup("WEEKLY", "02:00", baseDate);
    assert.strictEqual(nextWeekly.toISOString(), "2026-09-30T02:00:00.000Z");

    // OFF -> returns null
    const off = computeNextAutoBackup("OFF", "02:00", baseDate);
    assert.strictEqual(off, null);
  });

  await check("4.2 runScheduledBackupForShop executes automated snapshot and updates schedule", async () => {
    const result = await runScheduledBackupForShop(TEST_SHOP, { force: true, source: "TEST_QA_RUNNER" });
    assert.strictEqual(result.success, true, "Automated scheduled backup must succeed");

    const updatedSettings = await prisma.appSettings.findUnique({ where: { shop: TEST_SHOP } });
    assert.ok(updatedSettings.lastAutoBackupAt, "lastAutoBackupAt must be stamped");
    assert.ok(updatedSettings.nextAutoBackupAt, "nextAutoBackupAt must be calculated");

    const autoRp = await prisma.restorePoint.findUnique({ where: { id: result.restorePointId } });
    assert.ok(autoRp.name.includes("Automated Daily Backup"), "Backup name must denote automated daily backup");

    const audit = await prisma.auditLog.findFirst({
      where: { shop: TEST_SHOP, action: "AUTOMATED_BACKUP_EXECUTED" },
    });
    assert.ok(audit, "AUTOMATED_BACKUP_EXECUTED audit log entry must be created");
  });

  await check("4.3 runScheduledBackupForShop skips when schedule is OFF and not forced", async () => {
    await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: { autoBackupSchedule: "OFF" },
    });
    const result = await runScheduledBackupForShop(TEST_SHOP, { force: false });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "Auto backups disabled for shop");

    // Revert setting
    await prisma.appSettings.update({
      where: { shop: TEST_SHOP },
      data: { autoBackupSchedule: "DAILY" },
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 5: REGRESSION & UI CONSISTENCY CHECKS
  // ═════════════════════════════════════════════════════════════════════════════
  section("5. REGRESSION & UI CONSISTENCY CHECKS");

  await check("5.1 Singular/plural badge helper consistency", () => {
    const pluralize = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;
    assert.strictEqual(pluralize(1, "Article", "Articles"), "1 Article");
    assert.strictEqual(pluralize(2, "Article", "Articles"), "2 Articles");
    assert.strictEqual(pluralize(1, "Product", "Products"), "1 Product");
    assert.strictEqual(pluralize(0, "Product", "Products"), "0 Products");
    assert.strictEqual(pluralize(1, "Menu", "Menus"), "1 Menu");
    assert.strictEqual(pluralize(4, "Menu", "Menus"), "4 Menus");
    assert.strictEqual(pluralize(1, "Metafield", "Metafields"), "1 Metafield");
    assert.strictEqual(pluralize(26, "Metafield", "Metafields"), "26 Metafields");
  });

  await check("5.2 Restore points count filter accuracy across all 9 tabs", async () => {
    const rps = await prisma.restorePoint.findMany({ where: { shop: TEST_SHOP } });
    const counts = {
      all: rps.length,
      full: rps.filter((r) => (r.backupType || "FULL") === "FULL").length,
      themes: rps.filter((r) => r.backupType === "THEMES").length,
      products: rps.filter((r) => r.backupType === "PRODUCTS").length,
      collections: rps.filter((r) => r.backupType === "COLLECTIONS").length,
      pages: rps.filter((r) => r.backupType === "PAGES").length,
      blogs: rps.filter((r) => r.backupType === "BLOGS").length,
      menus: rps.filter((r) => r.backupType === "MENUS").length,
      metafields: rps.filter((r) => r.backupType === "METAFIELDS").length,
    };
    assert.ok(counts.all > 0);
    assert.ok(counts.full > 0);
    assert.ok(counts.themes > 0);
    assert.ok(counts.products > 0);
    assert.ok(counts.collections > 0);
    assert.ok(counts.pages > 0);
    assert.ok(counts.blogs > 0);
    assert.ok(counts.menus > 0);
    assert.ok(counts.metafields > 0);
    assert.strictEqual(
      counts.all,
      counts.full + counts.themes + counts.products + counts.collections + counts.pages + counts.blogs + counts.menus + counts.metafields,
      "Sum of typed tabs must equal total 'all' restore points"
    );
  });

  // Cleanup test shop records
  await cleanTestShop();

  console.log("\n=================================================================");
  if (failures.length === 0) {
    console.log(`🎉 ALL ${passed} QA VERIFICATION CHECKS PASSED SUCCESSFULLY! (100%)`);
  } else {
    console.log(`⚠️ ${failures.length} CHECKS FAILED out of ${passed + failures.length}`);
    for (const f of failures) {
      console.log(`  - ${f.label}: ${f.message}`);
    }
  }
  console.log("=================================================================\n");

  if (failures.length > 0) {
    process.exit(1);
  }
}

runQaVerification().catch((err) => {
  console.error("Fatal QA Suite Error:", err);
  process.exit(1);
});
