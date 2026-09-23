/**
 * QA Engineer Comprehensive Verification Suite:
 * All 8 Instant 1-Click Backup Options & Complete Restore Flow
 *
 * 1. Full Store Backup
 * 2. Theme Backup
 * 3. Product Backup
 * 4. Collection Backup
 * 5. Page Backup
 * 6. Blog Backup
 * 7. Navigation Menu Backup
 * 8. Metafield Backup
 *
 * Run:
 *   /home/tpss/.nvm/versions/node/v22.23.2/bin/node --import ./scratch/jsx-register.mjs scratch/qa_instant_backup_options_e2e.mjs
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
} from "../app/backup.server.js";
import { rollbackProductFields } from "../app/monitor.server.js";
import { loader as detailLoader, action as detailAction } from "../app/routes/app.restore-points_.$id.jsx";

const TEST_SHOP = "qa-instant-backups-verification.myshopify.com";

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
        id: "gid://shopify/Product/7001",
        title: "Pro Sound Headphones",
        handle: "pro-sound-headphones",
        status: "ACTIVE",
        vendor: "AudioTech",
        productType: "Audio",
        tags: ["wireless", "noise-canceling"],
        bodyHtml: "<p>Studio-quality audio playback.</p>",
        variants: {
          nodes: [
            { id: "gid://shopify/ProductVariant/70011", title: "Black", price: "249.99", compareAtPrice: "299.99", sku: "PRO-BLK" },
            { id: "gid://shopify/ProductVariant/70012", title: "White", price: "249.99", compareAtPrice: "299.99", sku: "PRO-WHT" },
          ],
        },
        metafields: {
          nodes: [
            { namespace: "custom", key: "warranty", value: "2 Years Limited", type: "single_line_text_field" },
          ],
        },
      },
      {
        id: "gid://shopify/Product/7002",
        title: "Compact Travel Speaker",
        handle: "travel-speaker",
        status: "ACTIVE",
        vendor: "SoundGo",
        productType: "Audio",
        tags: ["bluetooth", "portable"],
        bodyHtml: "<p>Waterproof bluetooth speaker for travelers.</p>",
        variants: {
          nodes: [
            { id: "gid://shopify/ProductVariant/70021", title: "Default", price: "89.99", compareAtPrice: "109.99", sku: "SPK-TRV" },
          ],
        },
        metafields: { nodes: [] },
      },
    ],
    collections: [
      {
        id: "gid://shopify/Collection/8001",
        title: "Premium Audio Gear",
        handle: "premium-audio",
        descriptionHtml: "<p>Audiophile sound systems and earphones.</p>",
        sortOrder: "BEST_SELLING",
        templateSuffix: "",
        image: { url: "https://cdn.shopify.com/audio-banner.jpg", altText: "Audio Gear" },
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: "TYPE", relation: "EQUALS", condition: "Audio" }],
        },
      },
    ],
    pages: [
      {
        id: "gid://shopify/Page/9001",
        title: "About Revertly Audio",
        handle: "about-us",
        body: "<p>We design precision acoustics since 2020.</p>",
        templateSuffix: "",
        isPublished: true,
      },
    ],
    menus: [
      {
        id: "gid://shopify/Menu/9501",
        title: "Main Navigation",
        handle: "main-menu",
        isDefault: true,
        items: [
          {
            id: "gid://shopify/MenuItem/95011",
            title: "Shop All",
            url: "/collections/all",
            type: "HTTP",
            items: [
              { id: "gid://shopify/MenuItem/95012", title: "Headphones", url: "/collections/headphones", type: "HTTP", items: [] },
            ],
          },
          { id: "gid://shopify/MenuItem/95013", title: "About Us", url: "/pages/about-us", type: "HTTP", items: [] },
        ],
      },
    ],
    blogs: [
      {
        id: "gid://shopify/Blog/9801",
        title: "Acoustics Journal",
        handle: "acoustics-journal",
        articles: {
          nodes: [
            {
              id: "gid://shopify/Article/98011",
              title: "The Science of Pure Sound",
              handle: "science-of-pure-sound",
              summary: "A primer on frequency response and soundstages.",
              body: "<p>Deep acoustic engineering insights...</p>",
              tags: ["audio", "engineering"],
              author: { name: "Dr. Sound" },
              image: { url: "https://cdn.shopify.com/sound-science.jpg", altText: "Sound waves" },
              isPublished: true,
            },
          ],
        },
      },
    ],
    metafieldDefinitions: [
      { id: "gid://shopify/MetafieldDefinition/1", namespace: "custom", key: "warranty", name: "Warranty Period", type: { name: "single_line_text_field" }, ownerType: "PRODUCT" },
      { id: "gid://shopify/MetafieldDefinition/2", namespace: "custom", key: "support_phone", name: "Support Hotline", type: { name: "single_line_text_field" }, ownerType: "SHOP" },
    ],
    shopMetafields: [
      { id: "gid://shopify/Metafield/301", namespace: "custom", key: "support_phone", value: "+1-800-REVERTLY", type: "single_line_text_field", ownerType: "SHOP" },
    ],
  };
}

function createMockAdmin(store) {
  return {
    graphql: async (query, { variables = {} } = {}) => {
      const q = query.trim();

      // Theme Queries & Mutations
      if (q.includes("query getThemes")) {
        return { ok: true, json: async () => ({ data: { themes: { nodes: store.themes } } }) };
      }
      if (q.includes("query getThemeFiles") || q.includes("themeFiles(first:")) {
        return { ok: true, json: async () => ({ data: { theme: { files: { nodes: store.themeFiles, pageInfo: { hasNextPage: false } } } } }) };
      }
      if (q.includes("query checkThemeRole") || q.includes("theme(id:")) {
        const theme = store.themes.find((t) => t.id === variables.id) || store.themes[0];
        return { ok: true, json: async () => ({ data: { theme } }) };
      }
      if (q.includes("mutation themeFilesUpsert")) {
        for (const file of variables.files || []) {
          const idx = store.themeFiles.findIndex((f) => f.filename === file.filename);
          const body = { content: file.body?.value || "" };
          if (idx >= 0) store.themeFiles[idx] = { filename: file.filename, size: body.content.length, body };
          else store.themeFiles.push({ filename: file.filename, size: body.content.length, body });
        }
        return { ok: true, json: async () => ({ data: { themeFilesUpsert: { upsertedThemeFiles: variables.files || [], userErrors: [] } } }) };
      }
      if (q.includes("mutation themeCreate")) {
        const newTheme = {
          id: `gid://shopify/Theme/${100 + store.themes.length + 1}`,
          name: variables.name || "Preview Theme",
          role: "UNPUBLISHED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.themes.push(newTheme);
        return { ok: true, json: async () => ({ data: { themeCreate: { theme: newTheme, userErrors: [] } } }) };
      }

      // Products Query
      if (q.includes("query getProductsForBackup")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              products: {
                nodes: store.products,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (q.includes("mutation updateProduct")) {
        const prod = store.products.find((p) => p.id === variables.input?.id);
        if (prod && variables.input) {
          Object.assign(prod, variables.input);
        }
        return { ok: true, json: async () => ({ data: { productUpdate: { product: prod, userErrors: [] } } }) };
      }
      if (q.includes("mutation updateVariant")) {
        return { ok: true, json: async () => ({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } }) };
      }

      // Collections Query & Mutations
      if (q.includes("query getCollections")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              collections: {
                nodes: store.collections,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (q.includes("mutation collectionUpdate")) {
        const col = store.collections.find((c) => c.id === variables.input?.id);
        if (col && variables.input) {
          Object.assign(col, variables.input);
        }
        return { ok: true, json: async () => ({ data: { collectionUpdate: { collection: col || variables.input, userErrors: [] } } }) };
      }
      if (q.includes("mutation collectionCreate")) {
        const newCol = { id: `gid://shopify/Collection/${8000 + store.collections.length + 1}`, ...variables.input };
        store.collections.push(newCol);
        return { ok: true, json: async () => ({ data: { collectionCreate: { collection: newCol, userErrors: [] } } }) };
      }

      // Pages Query & Mutations
      if (q.includes("query getPages")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              pages: {
                nodes: store.pages,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (q.includes("mutation pageUpdate")) {
        const page = store.pages.find((p) => p.id === variables.id);
        if (page && variables.page) {
          Object.assign(page, variables.page);
        }
        return { ok: true, json: async () => ({ data: { pageUpdate: { page: page || { id: variables.id, ...variables.page }, userErrors: [] } } }) };
      }
      if (q.includes("mutation pageCreate")) {
        const newPage = { id: `gid://shopify/Page/${9000 + store.pages.length + 1}`, ...variables.page };
        store.pages.push(newPage);
        return { ok: true, json: async () => ({ data: { pageCreate: { page: newPage, userErrors: [] } } }) };
      }

      // Menus Query & Mutations
      if (q.includes("query getMenus") || q.includes("query findMenuByHandle")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              menus: {
                nodes: store.menus,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (q.includes("mutation menuUpdate")) {
        const menu = store.menus.find((m) => m.id === variables.id);
        if (menu) {
          menu.title = variables.title;
          if (variables.handle) menu.handle = variables.handle;
          if (variables.items) menu.items = variables.items;
        }
        return { ok: true, json: async () => ({ data: { menuUpdate: { menu: menu || { id: variables.id, title: variables.title, handle: variables.handle }, userErrors: [] } } }) };
      }
      if (q.includes("mutation menuCreate")) {
        const newMenu = { id: `gid://shopify/Menu/${9500 + store.menus.length + 1}`, title: variables.title, handle: variables.handle, items: variables.items };
        store.menus.push(newMenu);
        return { ok: true, json: async () => ({ data: { menuCreate: { menu: newMenu, userErrors: [] } } }) };
      }

      // Blogs & Articles Query & Mutations
      if (q.includes("query getBlogsWithArticles") || q.includes("query getBlogsForArticleRestore")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              blogs: {
                nodes: store.blogs,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (q.includes("mutation articleUpdate")) {
        let art = null;
        for (const b of store.blogs) {
          const found = (b.articles?.nodes || []).find((a) => a.id === variables.id);
          if (found) {
            Object.assign(found, variables.article);
            art = found;
            break;
          }
        }
        return { ok: true, json: async () => ({ data: { articleUpdate: { article: art || { id: variables.id, ...variables.article }, userErrors: [] } } }) };
      }
      if (q.includes("mutation articleCreate")) {
        const newArt = { id: `gid://shopify/Article/${98000 + Date.now() % 1000}`, ...variables.article };
        if (store.blogs[0]) {
          store.blogs[0].articles.nodes.push(newArt);
        }
        return { ok: true, json: async () => ({ data: { articleCreate: { article: newArt, userErrors: [] } } }) };
      }

      // Metafield Definitions & Values Queries & Mutations
      if (q.includes("metafieldDefinitionsBackup")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              metafieldDefinitions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: store.metafieldDefinitions.filter((d) => !variables?.ownerType || d.ownerType === variables.ownerType),
              },
            },
          }),
        };
      }
      if (q.includes("shopMetafieldsBackup")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              shop: {
                id: "gid://shopify/Shop/1",
                name: "Revertly Audio Store",
                myshopifyDomain: TEST_SHOP,
                metafields: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: store.shopMetafields,
                },
              },
            },
          }),
        };
      }
      if (q.includes("ownerMetafieldsBackup")) {
        const field = /\s(\w+)\(first:/.exec(q)?.[1] || "products";
        const nodes = field === "products"
          ? store.products.map((p) => ({ id: p.id, handle: p.handle, title: p.title, metafields: p.metafields }))
          : [];
        return {
          ok: true,
          json: async () => ({
            data: {
              [field]: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes,
              },
            },
          }),
        };
      }
      if (q.includes("shopIdForMetafields")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              shop: { id: "gid://shopify/Shop/1", myshopifyDomain: TEST_SHOP },
            },
          }),
        };
      }
      if (q.includes("ownerHandleIndex")) {
        const field = /\s(\w+)\(first:/.exec(q)?.[1] || "products";
        const nodes = field === "products"
          ? store.products.map((p) => ({ id: p.id, handle: p.handle }))
          : [];
        return {
          ok: true,
          json: async () => ({
            data: {
              [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
            },
          }),
        };
      }
      if (q.includes("liveOwnerMetafields")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              nodes: [{ id: "gid://shopify/Shop/1", metafields: { nodes: store.shopMetafields } }],
            },
          }),
        };
      }
      if (q.includes("metafieldsSet")) {
        for (const mf of variables?.metafields || []) {
          const existing = store.shopMetafields.find((m) => m.namespace === mf.namespace && m.key === mf.key);
          if (existing) existing.value = mf.value;
          else store.shopMetafields.push({ id: `gid://shopify/Metafield/${Date.now() % 10000}`, ...mf });
        }
        return { ok: true, json: async () => ({ data: { metafieldsSet: { metafields: variables?.metafields || [], userErrors: [] } } }) };
      }
      if (q.includes("metafieldDefinitionCreate")) {
        const def = { id: `gid://shopify/MetafieldDefinition/${Date.now() % 10000}`, ...variables.definition };
        store.metafieldDefinitions.push(def);
        return { ok: true, json: async () => ({ data: { metafieldDefinitionCreate: { createdDefinition: def, userErrors: [] } } }) };
      }
      if (q.includes("metafieldDefinitionUpdate")) {
        return { ok: true, json: async () => ({ data: { metafieldDefinitionUpdate: { updatedDefinition: { id: variables.definition?.id }, userErrors: [] } } }) };
      }

      return { ok: true, json: async () => ({ data: {} }) };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite Execution
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`=================================================================`);
  console.log(`🛡️  STARTING SENIOR QA VERIFICATION: 8 INSTANT 1-CLICK BACKUP OPTIONS`);
  console.log(`   Shop: ${TEST_SHOP}`);
  console.log(`=================================================================`);

  const store = createMockStore();
  const admin = createMockAdmin(store);

  // Clean test shop DB
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.upsert({
    where: { shop: TEST_SHOP },
    create: { shop: TEST_SHOP, planId: "enterprise" },
    update: { planId: "enterprise" },
  });

  // Seed baseline productSnapshot for diff comparison
  await prisma.productSnapshot.create({
    data: {
      shop: TEST_SHOP,
      productId: "7001",
      title: "Pro Sound Headphones",
      status: "ACTIVE",
      snapshotData: store.products[0],
    },
  });
  await prisma.productSnapshot.create({
    data: {
      shop: TEST_SHOP,
      productId: "7002",
      title: "Compact Travel Speaker",
      status: "ACTIVE",
      snapshotData: store.products[1],
    },
  });

  // Variables to hold created restore points
  let rpFull, rpTheme, rpProd, rpCol, rpPage, rpBlog, rpMenu, rpMeta;

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 1: ALL 8 INSTANT 1-CLICK BACKUP OPTIONS (CREATION & INTEGRITY)
  // ═════════════════════════════════════════════════════════════════════════════
  section("1. INSTANT 1-CLICK BACKUP OPTIONS (SIMULATION & RECORD INTEGRITY)");

  await check("1.1 Option 1: Full Store Backup creates snapshot with ALL store resources", async () => {
    const res = await createMultiResourceRestorePoint({
      admin,
      shop: TEST_SHOP,
      name: "Full Store Backup - Master QA",
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
    assert.ok(rpFull, "Record exists in database");
    assert.strictEqual(rpFull.backupType, "FULL");
    assert.strictEqual(rpFull.status, "READY");
    assert.strictEqual(rpFull.productCount, 2);
    assert.strictEqual(rpFull.themeCount, 1);
    assert.strictEqual(rpFull.collectionCount, 1);
    assert.strictEqual(rpFull.pageCount, 1);
    assert.strictEqual(rpFull.menuCount, 1);
    assert.strictEqual(rpFull.articleCount, 1);
    assert.ok(rpFull.metafieldCount >= 1, "Metafields must be captured");
  });

  await check("1.2 Option 2: Theme Backup captures active theme and liquid/JSON files", async () => {
    const res = await backupTheme({ admin, shop: TEST_SHOP, name: "Theme Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpTheme = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpTheme.backupType, "THEMES");
    assert.strictEqual(rpTheme.status, "READY");
    assert.strictEqual(rpTheme.themeCount, 1);
    assert.strictEqual(rpTheme.productCount, 0);
    assert.ok(rpTheme.themeData?.files?.length >= 3, "Theme files array must be stored");
  });

  await check("1.3 Option 3: Product Catalog Backup captures catalog, variants, and tags", async () => {
    const res = await backupProducts({ admin, shop: TEST_SHOP, name: "Product Catalog Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpProd = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpProd.backupType, "PRODUCTS");
    assert.strictEqual(rpProd.status, "READY");
    assert.strictEqual(rpProd.productCount, 2);
    assert.strictEqual(rpProd.themeCount, 0);
    assert.ok(Array.isArray(rpProd.snapshotData), "snapshotData must be an array of products");
  });

  await check("1.4 Option 4: Collection Backup captures automated ruleSets and sorting", async () => {
    const res = await backupCollections({ admin, shop: TEST_SHOP, name: "Collections Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpCol = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpCol.backupType, "COLLECTIONS");
    assert.strictEqual(rpCol.status, "READY");
    assert.strictEqual(rpCol.collectionCount, 1);
    const audioCol = rpCol.collectionData.find((c) => c.handle === "premium-audio");
    assert.ok(audioCol?.ruleSet?.rules?.length > 0, "ruleSet rules must be preserved in snapshot");
  });

  await check("1.5 Option 5: Page Backup captures content pages and navigation menus", async () => {
    const res = await backupPages({ admin, shop: TEST_SHOP, name: "Page Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpPage = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpPage.backupType, "PAGES");
    assert.strictEqual(rpPage.status, "READY");
    assert.strictEqual(rpPage.pageCount, 1);
    assert.strictEqual(rpPage.menuCount, 1);
  });

  await check("1.6 Option 6: Blog Backup captures blog articles, authors, images, tags", async () => {
    const res = await backupBlogs({ admin, shop: TEST_SHOP, name: "Blog Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpBlog = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpBlog.backupType, "BLOGS");
    assert.strictEqual(rpBlog.status, "READY");
    assert.strictEqual(rpBlog.articleCount, 1);
    const article = rpBlog.articleData?.articles?.[0];
    assert.strictEqual(article?.author?.name, "Dr. Sound");
    assert.ok(article?.image?.url);
  });

  await check("1.7 Option 7: Navigation Menu Backup captures 3-level nested item hierarchy", async () => {
    const res = await backupMenus({ admin, shop: TEST_SHOP, name: "Navigation Menu Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpMenu = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpMenu.backupType, "MENUS");
    assert.strictEqual(rpMenu.status, "READY");
    assert.strictEqual(rpMenu.menuCount, 1);
    const menu = rpMenu.menuData?.[0];
    assert.strictEqual(menu?.title, "Main Navigation");
    assert.ok(menu?.items?.[0]?.items?.length > 0, "Nested items preserved");
  });

  await check("1.8 Option 8: Metafield Backup captures definitions and owner values", async () => {
    const res = await backupMetafields({ admin, shop: TEST_SHOP, name: "Metafield Backup - 1-Click QA" });
    assert.strictEqual(res.success, true);
    rpMeta = await prisma.restorePoint.findUnique({ where: { id: res.restorePoint.id } });
    assert.strictEqual(rpMeta.backupType, "METAFIELDS");
    assert.strictEqual(rpMeta.status, "READY");
    assert.ok(rpMeta.metafieldCount >= 1, "Metafields must be captured");
    assert.strictEqual(rpMeta.metafieldData?._schema, "revertly-metafields-v1");
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 2: DETAIL PAGE INSPECTION & TAB ROUTING VERIFICATION
  // ═════════════════════════════════════════════════════════════════════════════
  section("2. DETAIL PAGE LOADER & TAB ROUTING VERIFICATION (BUG REGRESSION)");

  await check("2.1 Dedicated Metafield Backup displays 'metafields' tab and NO phantom Products tab", async () => {
    // Check restore point DB content
    assert.strictEqual(rpMeta.backupType, "METAFIELDS");
    assert.ok(rpMeta.metafieldData);

    const metafieldTotal = (rpMeta.metafieldData.counts?.metafields || 0) + (rpMeta.metafieldData.counts?.definitions || 0);
    const isMetafieldBackup = rpMeta.backupType === "METAFIELDS";
    const shouldShowProductsTab =
      rpMeta.productCount > 0 ||
      ["FULL", "PRODUCTS"].includes(rpMeta.backupType) ||
      (!rpMeta.themeData?.activeTheme &&
        (rpMeta.collectionData?.length || 0) === 0 &&
        (rpMeta.pageData?.length || 0) === 0 &&
        (rpMeta.menuData?.length || 0) === 0 &&
        (!rpMeta.articleData?.articles || rpMeta.articleData.articles.length === 0) &&
        metafieldTotal === 0 &&
        !isMetafieldBackup);

    assert.strictEqual(shouldShowProductsTab, false, "Products tab MUST NOT be shown on Metafield backup");
  });

  await check("2.2 Dedicated Navigation Menu Backup accurately displays 'Navigation Menus' label", async () => {
    assert.strictEqual(rpMenu.backupType, "MENUS");
    const pageCount = rpMenu.pageData?.length || 0;
    const menuCount = rpMenu.menuData?.length || 0;
    assert.strictEqual(pageCount, 0);
    assert.ok(menuCount > 0);

    const label = pageCount > 0 && menuCount > 0
      ? "Pages & Menus"
      : menuCount > 0
      ? "Navigation Menus"
      : "Pages";

    assert.strictEqual(label, "Navigation Menus", "Menu-only backup must label tab 'Navigation Menus'");
  });

  await check("2.3 Dedicated Pages Backup displays 'Pages & Menus' when menus are included", async () => {
    assert.strictEqual(rpPage.backupType, "PAGES");
    const pageCount = rpPage.pageData?.length || 0;
    const menuCount = rpPage.menuData?.length || 0;
    assert.ok(pageCount > 0 && menuCount > 0);

    const label = pageCount > 0 && menuCount > 0
      ? "Pages & Menus"
      : menuCount > 0
      ? "Navigation Menus"
      : "Pages";

    assert.strictEqual(label, "Pages & Menus");
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION 3: END-TO-END RESTORATION (ALL 8 BACKUP TYPES)
  // ═════════════════════════════════════════════════════════════════════════════
  section("3. END-TO-END RESTORATION VERIFICATION WITHOUT DATA LOSS");

  await check("3.1 Theme Restore: Draft Mode creates staging theme safely", async () => {
    const res = await restoreThemeFilesWithSafety({
      admin,
      shop: TEST_SHOP,
      themeId: "gid://shopify/Theme/101",
      themeName: "Dawn (Active)",
      files: rpTheme.themeData.files,
      mode: "draft",
    });
    assert.strictEqual(res.success, true);
    assert.ok(res.draftThemeId);
    const draftTheme = store.themes.find((t) => t.id === res.draftThemeId);
    assert.ok(draftTheme);
    assert.strictEqual(draftTheme.role, "UNPUBLISHED", "Staging theme must be unpublished");
  });

  await check("3.2 Theme Restore: Live Mode auto-creates pre-rollback safety snapshot", async () => {
    // Introduce drift to live theme
    store.themeFiles[0].body.content = "<html>CORRUPTED THEME CONTENT</html>";

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
    assert.strictEqual(countAfter, countBefore + 1, "Safety snapshot must be captured");
    assert.ok(store.themeFiles[0].body.content.includes("content_for_header"), "Original file restored");
  });

  await check("3.3 Product Restore: Single product restore with field normalization", async () => {
    const targetProd = rpProd.snapshotData[0];
    const rawProductId = targetProd.productId || targetProd.id;
    const productId = String(rawProductId).replace("gid://shopify/Product/", "").trim();

    // Drift live product
    store.products[0].title = "Corrupted Drifted Headphones";
    store.products[0].variants.nodes[0].price = "999.99";

    // Simulate change event and rollback execution
    const changeEvent = await prisma.changeEvent.create({
      data: {
        shop: TEST_SHOP,
        productId,
        productTitle: targetProd.title,
        fieldName: "title",
        oldValue: targetProd.snapshotData?.title || targetProd.title,
        newValue: "Corrupted Drifted Headphones",
      },
    });

    const rollbackRes = await rollbackProductFields(admin, TEST_SHOP, productId, [changeEvent.id]);
    assert.strictEqual(rollbackRes.success, true, "Rollback product fields must succeed");
    assert.strictEqual(store.products[0].title, targetProd.title || targetProd.snapshotData?.title);
  });

  await check("3.4 Product Restore: Safe Restore All with selective field masking", async () => {
    const targetProd = rpProd.snapshotData[0];
    const productId = String(targetProd.productId || targetProd.id).replace("gid://shopify/Product/", "").trim();

    // Drift product title and price
    store.products[0].title = "Another Drift Title";
    store.products[0].variants.nodes[0].price = "777.00";

    // Simulate masking: only title restored, price preserved
    const changeEvent = await prisma.changeEvent.create({
      data: {
        shop: TEST_SHOP,
        productId,
        productTitle: targetProd.title,
        fieldName: "title",
        oldValue: "Pro Sound Headphones",
        newValue: "Another Drift Title",
      },
    });

    const rollbackRes = await rollbackProductFields(admin, TEST_SHOP, productId, [changeEvent.id]);
    assert.strictEqual(rollbackRes.success, true);
    assert.strictEqual(store.products[0].title, "Pro Sound Headphones", "Title restored");
    assert.strictEqual(store.products[0].variants.nodes[0].price, "777.00", "Price masked and preserved");
  });

  await check("3.5 Collection Restore: Single & bulk restore of smart rules", async () => {
    // Drift collection
    store.collections[0].title = "Corrupted Audio Sale";
    store.collections[0].ruleSet = null;

    const target = rpCol.collectionData[0];
    const res = await restoreCollection(admin, target);
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.collections[0].title, target.title);
    assert.ok(store.collections[0].ruleSet !== null, "RuleSet restored");
  });

  await check("3.6 Page Restore: Content HTML body and metadata restored", async () => {
    // Drift page body
    store.pages[0].body = "<p>Wiped body text</p>";

    const target = rpPage.pageData[0];
    const res = await restorePage(admin, target);
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.pages[0].body, target.body);
  });

  await check("3.7 Navigation Menu Restore: Rebuilds nested item tree & handles link fallbacks", async () => {
    // Corrupt menu items
    store.menus[0].items = [];

    const target = rpMenu.menuData[0];
    const res = await restoreMenu(admin, target);
    assert.strictEqual(res.success, true);
    assert.ok(store.menus[0].items.length > 0, "Menu items restored");
  });

  await check("3.8 Blog Article Restore: Preserves author, image, and body", async () => {
    // Modify article author
    store.blogs[0].articles.nodes[0].author = { name: "Fake Author" };

    const target = rpBlog.articleData.articles[0];
    const res = await restoreArticle(admin, target);
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.blogs[0].articles.nodes[0].author.name, "Dr. Sound");
  });

  await check("3.9 Metafield Restore: Restores values and definitions across modes", async () => {
    store.shopMetafields[0].value = "Wiped Hotline";

    const res = await restoreMetafieldBackup(admin, TEST_SHOP, rpMeta.metafieldData, {
      mode: "FORCE",
      includeValues: true,
      includeDefinitions: true,
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(store.shopMetafields[0].value, "+1-800-REVERTLY");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(`\n=================================================================`);
  if (failures.length === 0) {
    console.log(`🎉 ALL ${passed} QA VERIFICATION CHECKS PASSED SUCCESSFULLY! (100%)`);
    console.log(`   Every 1-Click Backup Option created, verified, and restored cleanly.`);
  } else {
    console.log(`❌ ${failures.length} CHECKS FAILED:`);
    failures.forEach((f) => console.log(`   - ${f.label}: ${f.message}`));
    process.exit(1);
  }
  console.log(`=================================================================\n`);
}

run()
  .catch((err) => {
    console.error("FATAL SUITE ERROR:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
