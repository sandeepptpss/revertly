/**
 * End-to-end QA for the "Instant 1-Click Backup Options" hub.
 *
 * Covers, for every one of the eight 1-click options:
 *   capture -> verify the stored snapshot really holds the live data
 *   restore -> verify the live store ends up matching the snapshot
 *   export  -> import round trip (JSON archive and every CSV dataset)
 *
 * The mock admin below is a *stateful* fake store: mutations mutate `STORE`,
 * so a restore assertion checks what actually landed rather than that a
 * mutation was merely called.
 *
 * Run: node --import ./scratch/jsx-register.mjs scratch/test_backup_restore_e2e_qa.mjs
 *      (plain `node` works too — this suite imports no .jsx)
 */
import assert from "node:assert";
import fs from "node:fs";
import prisma from "../app/db.server.js";
import { formatMetafieldError } from "../app/routes/app.restore-points_.$id.jsx";
import {
  fetchThemeBackup,
  fetchCollectionsBackup,
  fetchPagesBackup,
  fetchMenusBackup,
  fetchBlogsAndArticlesBackup,
  fetchMetafieldsBackup,
  fetchLiveProductsBackup,
  backupTheme,
  backupProducts,
  backupCollections,
  backupPages,
  backupBlogs,
  backupMenus,
  backupMetafields,
  createMultiResourceRestorePoint,
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

const TEST_SHOP = "qa-e2e-backup-hub.myshopify.com";

let passed = 0;
const failures = [];
let metafieldRestoreErrors = [];
const impExpSource = fs.readFileSync(new URL("../app/routes/app.import-export.jsx", import.meta.url), "utf8");

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
  console.log(`\n▶ ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stateful mock store
// ─────────────────────────────────────────────────────────────────────────────

function freshStore() {
  return {
    themes: [
      { id: "gid://shopify/Theme/900", name: "Dawn", role: "MAIN", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
    ],
    themeFiles: [
      { filename: "layout/theme.liquid", size: 40, body: { content: "<html>ORIGINAL</html>" } },
      { filename: "config/settings_data.json", size: 30, body: { content: '{"current":"Default, with a comma"}' } },
    ],
    collections: [
      {
        id: "gid://shopify/Collection/1",
        title: 'Summer "Sale", 2026',
        handle: "summer-sale",
        descriptionHtml: "<p>Line one\nLine two</p>",
        templateSuffix: "",
        image: { id: "gid://shopify/Image/1", url: "https://cdn/img1.png", altText: "Alt" },
        sortOrder: "BEST_SELLING",
        ruleSet: { appliedDisjunctively: true, rules: [{ column: "TAG", relation: "EQUALS", condition: "summer" }] },
      },
    ],
    pages: [
      { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us", body: "<p>Hello,\nworld</p>", bodySummary: "Hello", templateSuffix: "", isPublished: true },
    ],
    menus: [
      {
        id: "gid://shopify/Menu/1",
        title: "Main menu",
        handle: "main-menu",
        isDefault: true,
        items: [
          { id: "i1", title: "Home", url: "/", type: "FRONTPAGE", resourceId: null, tags: [], items: [] },
          {
            id: "i2", title: "Shop", url: "/collections/all", type: "COLLECTION",
            resourceId: "gid://shopify/Collection/1", tags: [],
            items: [{ id: "i2a", title: "Summer", url: "/collections/summer-sale", type: "COLLECTION", resourceId: "gid://shopify/Collection/1", tags: [] }],
          },
        ],
      },
    ],
    blogs: [
      {
        id: "gid://shopify/Blog/1", title: "News", handle: "news", commentPolicy: "MODERATED", templateSuffix: "",
        articles: {
          nodes: [
            {
              id: "gid://shopify/Article/1", title: "Hello World", handle: "hello-world",
              body: "<p>Body</p>", summary: "<p>Sum</p>", tags: ["a", "b"], templateSuffix: "",
              isPublished: true, publishedAt: "2026-03-01T00:00:00Z",
              author: { name: "Jane Merchant" },
              image: { url: "https://cdn/article-hero.png", altText: "Hero" },
            },
          ],
        },
      },
    ],
    products: [
      {
        id: "gid://shopify/Product/1", title: 'Tee, "Basic"', status: "ACTIVE", vendor: "Acme", productType: "Shirt",
        tags: ["cotton"], handle: "tee-basic", bodyHtml: "<p>Nice tee</p>", templateSuffix: "", publishedAt: "2026-01-01T00:00:00Z",
        images: { nodes: [] }, metafields: { nodes: [] },
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "S", price: "19.99", compareAtPrice: null, sku: "TEE-S", inventoryQuantity: 4, barcode: "" }] },
      },
    ],
    shopMetafields: [
      { id: "gid://shopify/Metafield/1", namespace: "custom", key: "store_promise", type: "single_line_text_field", value: "Free shipping", compareDigest: "d1", updatedAt: "2026-03-01T00:00:00Z" },
    ],
    // Records of what mutations were asked to write, for restore assertions.
    written: { articles: [], pages: [], collections: [], menus: [], metafields: [], themeFiles: [] },
  };
}

let STORE = freshStore();

function createMockAdmin() {
  const j = (data, extra = {}) => ({ json: async () => ({ data, ...extra }) });

  return {
    graphql: async (query, { variables } = {}) => {
      // ── Reads ───────────────────────────────────────────────────────────
      if (query.includes("getThemes") || query.includes("getThemesList")) {
        return j({ themes: { nodes: STORE.themes } });
      }
      if (query.includes("getAllThemeFiles") || query.includes("getThemeFiles")) {
        return j({ theme: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: STORE.themeFiles } } });
      }
      if (query.includes("getCollections")) {
        return j({ collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: STORE.collections } });
      }
      if (query.includes("findCollectionByHandle")) {
        return j({ collections: { nodes: STORE.collections.map((c) => ({ id: c.id, title: c.title, handle: c.handle })) } });
      }
      if (query.includes("getPages")) {
        return j({ pages: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: STORE.pages } });
      }
      if (query.includes("findPageByHandle")) {
        return j({ pages: { nodes: STORE.pages.map((p) => ({ id: p.id, title: p.title, handle: p.handle })) } });
      }
      if (query.includes("getMenus") || query.includes("findMenuByHandle")) {
        return j({ menus: { nodes: STORE.menus } });
      }
      if (query.includes("getBlogsWithArticles")) {
        // Shopify returns only the fields the query selects. Projecting here is
        // what makes "the backup silently drops a field" observable at all.
        const wantsAuthor = /\bauthor\b/.test(query);
        const wantsImage = /\bimage\s*\{/.test(query);
        return j({
          blogs: {
            nodes: STORE.blogs.map((b) => ({
              ...b,
              articles: {
                nodes: b.articles.nodes.map((a) => {
                  const projected = { ...a };
                  if (!wantsAuthor) delete projected.author;
                  if (!wantsImage) delete projected.image;
                  return projected;
                }),
              },
            })),
          },
        });
      }
      if (query.includes("getBlogsForRestore") || query.includes("getBlogsForArticleRestore")) {
        return j({ blogs: { nodes: STORE.blogs.map((b) => ({ id: b.id, title: b.title, handle: b.handle })) } });
      }
      if (query.includes("getProductsForBackup")) {
        // Real cursor pagination at Shopify's page size, so a fetcher that
        // stops early is caught rather than handed the whole catalog at once.
        const PAGE = 50;
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.products.slice(start, start + PAGE);
        const end = start + slice.length;
        return j({
          products: {
            pageInfo: { hasNextPage: end < STORE.products.length, endCursor: end < STORE.products.length ? String(end) : null },
            nodes: slice,
          },
        });
      }

      // ── Metafields ──────────────────────────────────────────────────────
      if (query.includes("metafieldDefinitionsBackup")) {
        return j({ metafieldDefinitions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
      }
      if (query.includes("shopMetafieldsBackup")) {
        return j({
          shop: {
            id: "gid://shopify/Shop/1", name: "QA Store", myshopifyDomain: TEST_SHOP,
            metafields: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: STORE.shopMetafields },
          },
        });
      }
      if (query.includes("ownerMetafieldsBackup")) {
        // Every non-SHOP owner type: no metafields in this fixture.
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
      if (query.includes("metafieldsSet")) {
        const inputs = variables?.metafields || [];
        // Reject one specific key so the error-reporting path is exercised.
        const bad = inputs.find((m) => m.key === "broken_key");
        if (bad) {
          return j({ metafieldsSet: { metafields: [], userErrors: [{ field: ["metafields"], message: "Value type mismatch for key broken_key", code: "INVALID_VALUE" }] } });
        }
        STORE.written.metafields.push(...inputs);
        return j({ metafieldsSet: { metafields: inputs.map((m) => ({ id: "gid://shopify/Metafield/new", namespace: m.namespace, key: m.key })), userErrors: [] } });
      }

      // ── Mutations ───────────────────────────────────────────────────────
      if (query.includes("themeFilesUpsert")) {
        STORE.written.themeFiles.push(...(variables?.files || []));
        for (const f of variables?.files || []) {
          const live = STORE.themeFiles.find((t) => t.filename === f.filename);
          if (live) live.body.content = f.body.value;
        }
        return j({ themeFilesUpsert: { upsertedThemeFiles: (variables?.files || []).map((f) => ({ filename: f.filename })), userErrors: [] } });
      }
      if (query.includes("collectionUpdate")) {
        const input = variables?.input || {};
        STORE.written.collections.push(input);
        const live = STORE.collections.find((c) => c.id === input.id);
        if (live) Object.assign(live, input);
        return j({ collectionUpdate: { collection: { id: input.id, title: input.title, handle: input.handle }, userErrors: [] } });
      }
      if (query.includes("collectionCreate")) {
        STORE.written.collections.push(variables?.input || {});
        return j({ collectionCreate: { collection: { id: "gid://shopify/Collection/new", ...variables?.input }, userErrors: [] } });
      }
      if (query.includes("pageUpdate")) {
        STORE.written.pages.push(variables?.page || {});
        const live = STORE.pages.find((p) => p.id === variables?.id);
        if (live) Object.assign(live, variables.page);
        return j({ pageUpdate: { page: { id: variables?.id, ...variables?.page }, userErrors: [] } });
      }
      if (query.includes("pageCreate")) {
        STORE.written.pages.push(variables?.page || {});
        return j({ pageCreate: { page: { id: "gid://shopify/Page/new", ...variables?.page }, userErrors: [] } });
      }
      if (query.includes("menuUpdate")) {
        STORE.written.menus.push({ mode: "update", ...variables });
        const live = STORE.menus.find((m) => m.id === variables?.id);
        if (live) live.items = variables.items;
        return j({ menuUpdate: { menu: { id: variables?.id, title: variables?.title, handle: variables?.handle }, userErrors: [] } });
      }
      if (query.includes("menuCreate")) {
        STORE.written.menus.push({ mode: "create", ...variables });
        return j({ menuCreate: { menu: { id: "gid://shopify/Menu/new", title: variables?.title, handle: variables?.handle }, userErrors: [] } });
      }
      if (query.includes("articleUpdate")) {
        STORE.written.articles.push({ mode: "update", ...(variables?.article || {}) });
        return j({ articleUpdate: { article: { id: variables?.id, title: variables?.article?.title }, userErrors: [] } });
      }
      if (query.includes("articleCreate")) {
        STORE.written.articles.push({ mode: "create", ...(variables?.article || {}) });
        return j({ articleCreate: { article: { id: "gid://shopify/Article/new", title: variables?.article?.title }, userErrors: [] } });
      }
      if (query.includes("blogCreate")) {
        return j({ blogCreate: { blog: { id: "gid://shopify/Blog/new", ...(variables?.blog || {}) }, userErrors: [] } });
      }
      if (query.includes("themeCreate")) {
        return j({ themeCreate: { theme: { id: "gid://shopify/Theme/staging", name: variables?.name || variables?.input?.name, role: "UNPUBLISHED" }, userErrors: [] } });
      }

      return j({});
    },
  };
}

async function resetShop({ planId = "business" } = {}) {
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
  // Product capture is bounded by the plan's allowance, so the plan has to be
  // real for these assertions to mean anything.
  await prisma.appSettings.upsert({
    where: { shop: TEST_SHOP },
    create: { shop: TEST_SHOP, planId },
    update: { planId },
  });
  STORE = freshStore();
}

async function cleanupShop() {
  await resetShop();
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=================================================================");
  console.log("  Revertly — 1-Click Backup Options: end-to-end QA");
  console.log("=================================================================");

  await resetShop();
  const admin = createMockAdmin();

  // ── 1. Capture fidelity for each 1-click option ───────────────────────────
  section("[1] Capture fidelity — each 1-click backup stores what is live");

  const themeRes = await backupTheme({ admin, shop: TEST_SHOP });
  await check("1.1 Theme Backup captures the active theme and all its files", () => {
    assert.ok(themeRes.success, themeRes.message);
    const td = themeRes.restorePoint.themeData;
    assert.equal(td.activeTheme.name, "Dawn");
    assert.equal(td.files.length, STORE.themeFiles.length);
    assert.equal(td.files[0].content, "<html>ORIGINAL</html>");
    assert.equal(themeRes.restorePoint.backupType, "THEMES");
  });

  const prodRes = await backupProducts({ admin, shop: TEST_SHOP });
  await check("1.2 Product Backup captures live catalog with variants", () => {
    assert.ok(prodRes.success, prodRes.message);
    const items = prodRes.restorePoint.snapshotData;
    assert.equal(items.length, 1);
    assert.equal(items[0].snapshotData.title, 'Tee, "Basic"');
    assert.equal(items[0].snapshotData.variants[0].price, "19.99");
    assert.equal(prodRes.restorePoint.productCount, 1);
  });

  const colRes = await backupCollections({ admin, shop: TEST_SHOP });
  await check("1.3 Collection Backup captures smart ruleSets", () => {
    assert.ok(colRes.success, colRes.message);
    const cols = colRes.restorePoint.collectionData;
    assert.equal(cols.length, 1);
    assert.equal(cols[0].ruleSet.rules[0].condition, "summer");
    assert.equal(cols[0].ruleSet.appliedDisjunctively, true);
  });

  const pageRes = await backupPages({ admin, shop: TEST_SHOP });
  await check("1.4 Page Backup captures pages and their navigation menus", () => {
    assert.ok(pageRes.success, pageRes.message);
    assert.equal(pageRes.restorePoint.pageData.length, 1);
    assert.equal(pageRes.restorePoint.menuData.length, 1);
    assert.equal(pageRes.restorePoint.backupType, "PAGES");
  });

  const menuRes = await backupMenus({ admin, shop: TEST_SHOP });
  await check("1.5 Navigation Menu Backup captures nested item hierarchy + resourceId", () => {
    assert.ok(menuRes.success, menuRes.message);
    const menus = menuRes.restorePoint.menuData;
    assert.equal(menus.length, 1);
    assert.equal(menus[0].items.length, 2);
    assert.equal(menus[0].items[1].items.length, 1, "nested child item must be captured");
    assert.equal(menus[0].items[1].resourceId, "gid://shopify/Collection/1");
    assert.equal(menuRes.restorePoint.backupType, "MENUS");
  });

  const blogRes = await backupBlogs({ admin, shop: TEST_SHOP });
  await check("1.6 Blog Backup captures article body, tags and publish state", () => {
    assert.ok(blogRes.success, blogRes.message);
    const arts = blogRes.restorePoint.articleData.articles;
    assert.equal(arts.length, 1);
    assert.equal(arts[0].body, "<p>Body</p>");
    assert.deepEqual(arts[0].tags, ["a", "b"]);
  });

  await check("1.6b Blog Backup captures the article AUTHOR", () => {
    const art = blogRes.restorePoint.articleData.articles[0];
    assert.ok(art.author, "article.author is missing from the captured snapshot");
    const name = typeof art.author === "object" ? art.author.name : art.author;
    assert.equal(name, "Jane Merchant");
  });

  await check("1.6c Blog Backup captures the article featured IMAGE", () => {
    const art = blogRes.restorePoint.articleData.articles[0];
    assert.ok(art.image?.url, "article.image is missing from the captured snapshot");
    assert.equal(art.image.url, "https://cdn/article-hero.png");
  });

  const mfRes = await backupMetafields({ admin, shop: TEST_SHOP });
  await check("1.7 Metafield Backup captures shop metafields + counts", () => {
    assert.ok(mfRes.success, mfRes.message);
    const doc = mfRes.restorePoint.metafieldData;
    assert.equal(doc.counts.metafields, 1);
    assert.equal(doc.owners[0].metafields[0].key, "store_promise");
    assert.equal(mfRes.restorePoint.backupType, "METAFIELDS");
  });

  const fullRes = await createMultiResourceRestorePoint({
    admin, shop: TEST_SHOP, name: "Full", backupType: "FULL",
    options: { includeProducts: true, includeThemes: true, includeCollections: true, includePages: true, includeMenus: true, includeArticles: true, includeMetafields: true },
  });
  await check("1.8 Full Store Backup captures every resource in one snapshot", () => {
    assert.ok(fullRes.success, fullRes.message);
    const s = fullRes.summary;
    assert.equal(s.themes, 1);
    assert.equal(s.collections, 1);
    assert.equal(s.pages, 1);
    assert.equal(s.menus, 1);
    assert.equal(s.articles, 1);
    assert.equal(s.metafields, 1);
    assert.equal(s.products, 1);
  });

  // ── 2. Product Backup freshness ──────────────────────────────────────────
  section("[2] Product Backup freshness — reads live Shopify, not the stale mirror");

  // A product edited in Shopify while the products/update webhook is lagging:
  // the mirror still holds the old title, so a backup that trusts the mirror
  // captures yesterday's catalog and the merchant restores from it believing
  // it is current.
  STORE.products[0].title = "Tee, Renamed In Shopify";
  const staleRes = await backupProducts({ admin, shop: TEST_SHOP });
  await check("2.1 Product Backup captures the live Shopify title, not the stale mirror", () => {
    const stored = staleRes.restorePoint.snapshotData[0].snapshotData.title;
    assert.equal(stored, "Tee, Renamed In Shopify", `snapshot captured "${stored}"`);
    assert.equal(staleRes.summary.productSource, "live");
  });

  await check("2.2 The live read also self-heals the drifted mirror", async () => {
    const row = await prisma.productSnapshot.findUnique({
      where: { shop_productId: { shop: TEST_SHOP, productId: "1" } },
    });
    assert.equal(row.title, "Tee, Renamed In Shopify", "mirror was not refreshed by the live read");
  });
  STORE.products[0].title = 'Tee, "Basic"';

  await check("2.3 Whole catalog is captured — no silent stop at 250 products", async () => {
    const big = freshStore();
    big.products = Array.from({ length: 640 }, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`, title: `Bulk Product ${i + 1}`, status: "ACTIVE",
      vendor: "Acme", productType: "Shirt", tags: [], handle: `bulk-${i + 1}`,
      bodyHtml: "", templateSuffix: "", publishedAt: null, updatedAt: "2026-03-01T00:00:00Z",
      images: { nodes: [] }, metafields: { nodes: [] },
      variants: { nodes: [{ id: `gid://shopify/ProductVariant/${i + 1}`, title: "S", price: "5.00", compareAtPrice: null, sku: `S${i}`, inventoryQuantity: 1, barcode: "" }] },
    }));
    const prev = STORE;
    STORE = big;
    try {
      const res = await backupProducts({ admin, shop: TEST_SHOP });
      assert.equal(res.summary.products, 640, "catalog was truncated");
      assert.equal(res.summary.productsTruncated, false);
      assert.equal(res.restorePoint.productCount, 640);
    } finally {
      STORE = prev;
      await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
    }
  });

  await check("2.4 A failed live read falls back to the mirror rather than writing an empty snapshot", async () => {
    await prisma.productSnapshot.create({
      data: { shop: TEST_SHOP, productId: "777", title: "Baseline Only", status: "ACTIVE", snapshotData: { title: "Baseline Only" } },
    });
    const failing = {
      graphql: async (query, opts) =>
        query.includes("getProductsForBackup")
          ? { json: async () => ({ errors: [{ message: "Internal error" }] }) }
          : admin.graphql(query, opts),
    };
    const res = await backupProducts({ admin: failing, shop: TEST_SHOP });
    assert.equal(res.summary.products, 1, "fallback did not return the baseline");
    assert.equal(res.summary.productSource, "mirror");
    assert.match(res.restorePoint.description, /local baseline/i, "fallback was not disclosed to the merchant");
    await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  });

  await check("2.5 A live capture is bounded by the plan's product allowance and says so", async () => {
    await prisma.appSettings.update({ where: { shop: TEST_SHOP }, data: { planId: "free" } });
    const big = freshStore();
    big.products = Array.from({ length: 260 }, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`, title: `Capped ${i + 1}`, status: "ACTIVE",
      vendor: "Acme", productType: "Shirt", tags: [], handle: `capped-${i + 1}`,
      bodyHtml: "", templateSuffix: "", publishedAt: null, updatedAt: "2026-03-01T00:00:00Z",
      images: { nodes: [] }, metafields: { nodes: [] }, variants: { nodes: [] },
    }));
    const prev = STORE;
    STORE = big;
    try {
      const res = await backupProducts({ admin, shop: TEST_SHOP });
      assert.equal(res.summary.products, 100, "free plan allowance of 100 products was not applied");
      assert.equal(res.summary.productsTruncated, true, "a capped capture must report itself as partial");
      assert.match(res.restorePoint.description, /Partial capture/i);
    } finally {
      STORE = prev;
      await prisma.appSettings.update({ where: { shop: TEST_SHOP }, data: { planId: "business" } });
      await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
    }
  });

  // Re-seed the mirror so later sections see the original fixture.
  await backupProducts({ admin, shop: TEST_SHOP });

  // ── 3. Restore flows ─────────────────────────────────────────────────────
  section("[3] Restore — the live store ends up matching the snapshot");

  STORE.collections[0].title = "VANDALISED";
  const colRestore = await restoreCollection(admin, colRes.restorePoint.collectionData[0]);
  await check("3.1 Collection restore puts the saved title and rules back", () => {
    assert.ok(colRestore.success, colRestore.message);
    assert.equal(STORE.collections[0].title, 'Summer "Sale", 2026');
    const w = STORE.written.collections.at(-1);
    assert.equal(w.ruleSet.rules[0].condition, "summer");
  });

  STORE.pages[0].body = "VANDALISED";
  const pageRestore = await restorePage(admin, pageRes.restorePoint.pageData[0]);
  await check("3.2 Page restore puts the saved body back", () => {
    assert.ok(pageRestore.success, pageRestore.message);
    assert.equal(STORE.pages[0].body, "<p>Hello,\nworld</p>");
  });

  STORE.menus[0].items = [];
  const menuRestore = await restoreMenu(admin, menuRes.restorePoint.menuData[0]);
  await check("3.3 Menu restore rebuilds the nested item tree", () => {
    assert.ok(menuRestore.success, menuRestore.message);
    assert.equal(STORE.menus[0].items.length, 2);
    assert.equal(STORE.menus[0].items[1].items.length, 1, "nested child item was lost on restore");
  });

  const artRestore = await restoreArticle(admin, blogRes.restorePoint.articleData.articles[0]);
  await check("3.4 Article restore succeeds", () => {
    assert.ok(artRestore.success, artRestore.message);
  });

  await check("3.4b Article restore preserves the original author", () => {
    const w = STORE.written.articles.at(-1);
    const name = typeof w.author === "object" ? w.author?.name : w.author;
    assert.equal(name, "Jane Merchant", `article restored with author "${name}" instead of the original`);
  });

  await check("3.4c Article restore preserves the featured image", () => {
    const w = STORE.written.articles.at(-1);
    assert.ok(w.image?.url, "article restore dropped the featured image");
    assert.equal(w.image.url, "https://cdn/article-hero.png");
  });

  const mfRestore = await restoreMetafieldBackup(admin, TEST_SHOP, mfRes.restorePoint.metafieldData, { mode: "FORCE" });
  await check("3.5 Metafield restore writes the saved values back", () => {
    assert.ok(mfRestore.success, mfRestore.message);
    assert.equal(mfRestore.summary.metafieldsWritten, 1);
    assert.equal(STORE.written.metafields.at(-1).key, "store_promise");
  });

  await check("3.6 Metafield restore surfaces a failing metafield in summary.errors", async () => {
    const doc = JSON.parse(JSON.stringify(mfRes.restorePoint.metafieldData));
    doc.owners[0].metafields.push({ namespace: "custom", key: "broken_key", type: "number_integer", value: "not-a-number" });
    const res = await restoreMetafieldBackup(admin, TEST_SHOP, doc, { mode: "FORCE" });
    const errs = res.summary.errors || [];
    assert.ok(errs.length > 0, "expected at least one metafield error to report");
    metafieldRestoreErrors = errs;
  });

  await check("3.7 Rollback History renders metafield errors as readable text, not [object Object]", () => {
    assert.ok(metafieldRestoreErrors.length > 0, "no errors captured by 3.6");
    for (const e of metafieldRestoreErrors) {
      const rendered = formatMetafieldError(e);
      assert.ok(
        rendered && !/\[object Object\]/.test(rendered),
        `metafield error rendered as "${rendered}"`,
      );
      assert.ok(
        /broken_key|mismatch|Unknown/i.test(rendered),
        `rendered error "${rendered}" does not identify the failing metafield`,
      );
    }
  });

  // ── 4. JSON archive export -> import round trip ───────────────────────────
  section("[4] JSON archive export → import round trip");

  const full = await prisma.restorePoint.findUnique({ where: { id: fullRes.restorePoint.id } });
  const jsonArchive = {
    _schema: "revertly-disaster-recovery-v1",
    shop: TEST_SHOP,
    name: full.name,
    description: full.description,
    backupType: full.backupType,
    createdAt: full.createdAt,
    storeAssets: {
      products: full.snapshotData || [],
      theme: full.themeData || null,
      collections: full.collectionData || [],
      pages: full.pageData || [],
      menus: full.menuData || [],
      blogsAndArticles: full.articleData || null,
      metafields: full.metafieldData || null,
    },
  };

  const imported = await importBackupPayload({ admin, shop: TEST_SHOP, payload: JSON.stringify(jsonArchive), mode: "SAVE_AS_RESTORE_POINT" });
  await check("4.1 Full JSON archive imports with every asset count preserved", () => {
    assert.ok(imported.success, imported.message);
    const rp = imported.restorePoint;
    assert.equal(rp.productCount, full.productCount);
    assert.equal(rp.collectionCount, full.collectionCount);
    assert.equal(rp.pageCount, full.pageCount);
    assert.equal(rp.menuCount, full.menuCount);
    assert.equal(rp.articleCount, full.articleCount);
    assert.equal(rp.metafieldCount, full.metafieldCount);
    assert.equal(rp.backupType, "FULL");
  });

  await check("4.2 Re-importing an imported archive does not stack [Imported] markers", async () => {
    assert.ok(imported.restorePoint.name.startsWith("[Imported]"));
  });
  const reimported = await importBackupPayload({
    admin, shop: TEST_SHOP,
    payload: { ...jsonArchive, name: imported.restorePoint.name },
    mode: "SAVE_AS_RESTORE_POINT",
  });
  await check("4.2b Marker is applied exactly once", () => {
    assert.ok(reimported.success, reimported.message);
    assert.equal((reimported.restorePoint.name.match(/\[Imported\]/g) || []).length, 1);
  });

  // ── 5. CSV export -> detect -> import round trip, per dataset ─────────────
  section("[5] CSV export → auto-detect → import round trip");

  const csvCases = [
    {
      label: "Products",
      csv: generateProductsCsv(full.snapshotData || []),
      expectType: "PRODUCTS",
      verify: (rp) => assert.equal(rp.productCount, 1),
    },
    {
      label: "Collections",
      csv: generateCollectionsCsv(full.collectionData || []),
      expectType: "COLLECTIONS",
      verify: (rp) => assert.equal(rp.collectionCount, 1),
    },
    {
      label: "Pages & Menus",
      csv: generatePagesAndMenusCsv(full.pageData || [], full.menuData || []),
      expectType: "PAGES",
      verify: (rp) => {
        assert.equal(rp.pageCount, 1);
        assert.equal(rp.menuCount, 1);
      },
    },
    {
      label: "Navigation Menus",
      csv: generateMenusCsv(full.menuData || []),
      expectType: "MENUS",
      verify: (rp) => assert.equal(rp.menuCount, 1),
    },
    {
      label: "Blogs & Articles",
      csv: generateBlogsAndArticlesCsv(full.articleData?.blogs || [], full.articleData?.articles || []),
      expectType: "BLOGS",
      verify: (rp) => assert.equal(rp.articleCount, 1),
    },
    {
      label: "Metafields",
      csv: generateMetafieldsCsv(full.metafieldData),
      expectType: "METAFIELDS",
      verify: (rp) => assert.equal(rp.metafieldCount, 1),
    },
  ];

  for (const c of csvCases) {
    let detected;
    try {
      detected = detectAndParseCsvArchive(c.csv);
    } catch (err) {
      failures.push({ label: `5.x ${c.label} CSV detected`, message: err.message });
      console.log(`  ✗ 5.x ${c.label} CSV detected\n      ${err.message}`);
      continue;
    }
    await check(`5.x ${c.label} CSV auto-detects as ${c.expectType}`, () => {
      assert.equal(detected.type, c.expectType);
    });

    const res = await importBackupPayload({
      admin, shop: TEST_SHOP,
      payload: { name: `${c.label} CSV Archive`, backupType: detected.type, ...detected.data },
      mode: "SAVE_AS_RESTORE_POINT",
    });
    await check(`5.x ${c.label} CSV imports with correct counts`, () => {
      assert.ok(res.success, res.message);
      c.verify(res.restorePoint);
    });
  }

  // Round-trip content fidelity for the trickiest fields.
  await check("5.7 Collections CSV survives embedded quotes, commas and newlines", () => {
    const parsed = detectAndParseCsvArchive(generateCollectionsCsv(full.collectionData || []));
    const col = parsed.data.collections[0];
    assert.equal(col.title, 'Summer "Sale", 2026');
    assert.equal(col.descriptionHtml, "<p>Line one\nLine two</p>");
    assert.equal(col.ruleSet.rules[0].condition, "summer");
    assert.equal(col.ruleSet.appliedDisjunctively, true);
  });

  await check("5.8 Menus CSV survives the nested item tree", () => {
    const parsed = detectAndParseCsvArchive(generateMenusCsv(full.menuData || []));
    const menu = parsed.data.menus[0];
    assert.equal(menu.items.length, 2);
    assert.equal(menu.items[1].items.length, 1);
  });

  await check("5.9 Blogs CSV carries the article author across the round trip", () => {
    const parsed = detectAndParseCsvArchive(
      generateBlogsAndArticlesCsv(full.articleData?.blogs || [], full.articleData?.articles || []),
    );
    const art = parsed.data.articles[0];
    assert.ok(art.author && String(art.author).trim(), "Author column round-tripped empty");
    assert.equal(art.author, "Jane Merchant");
  });

  // ── 6. Invalid / adversarial input ───────────────────────────────────────
  section("[6] Invalid input handling");

  const badJson = await importBackupPayload({ admin, shop: TEST_SHOP, payload: "NOT JSON {{{", mode: "SAVE_AS_RESTORE_POINT" });
  await check("6.1 Malformed JSON is rejected with a clear message", () => {
    assert.equal(badJson.success, false);
    assert.match(badJson.message, /Failed to import backup archive/);
  });

  const emptyArchive = await importBackupPayload({ admin, shop: TEST_SHOP, payload: { storeAssets: {} }, mode: "SAVE_AS_RESTORE_POINT" });
  await check("6.2 Archive with no recognizable assets is rejected", () => {
    assert.equal(emptyArchive.success, false);
    assert.match(emptyArchive.message, /No recognizable store assets/);
  });

  await check("6.3 Unrecognised CSV headers are rejected with guidance", () => {
    assert.throws(
      () => detectAndParseCsvArchive("Foo,Bar\r\n1,2"),
      /Unrecognized CSV format/,
    );
  });

  await check("6.4 Empty CSV is rejected", () => {
    assert.throws(() => detectAndParseCsvArchive("   "), /empty/i);
  });

  await check("6.5 A CSV with headers but no data rows is rejected", () => {
    assert.throws(() => detectAndParseCsvArchive('"Collection ID","Title"'), /no recognizable data rows/i);
  });

  const nullPayload = await importBackupPayload({ admin, shop: TEST_SHOP, payload: null, mode: "SAVE_AS_RESTORE_POINT" });
  await check("6.6 Null payload is rejected without throwing", () => {
    assert.equal(nullPayload.success, false);
  });

  // ── 7. Import in RESTORE_NOW mode ────────────────────────────────────────
  section("[7] Import with immediate live restore");

  STORE.written = { articles: [], pages: [], collections: [], menus: [], metafields: [], themeFiles: [] };
  const liveImport = await importBackupPayload({ admin, shop: TEST_SHOP, payload: jsonArchive, mode: "RESTORE_NOW" });
  await check("7.1 RESTORE_NOW applies every asset type live", () => {
    assert.ok(liveImport.success, liveImport.message);
    const lr = liveImport.summary.liveResults;
    assert.equal(lr.collections, 1, "collections not restored");
    assert.equal(lr.pages, 1, "pages not restored");
    assert.equal(lr.menus, 1, "menus not restored");
    assert.equal(lr.articles, 1, "articles not restored");
    assert.equal(lr.products, 1, "product baseline not synced");
  });

  await check("7.2 RESTORE_NOW stages theme files to a draft, never the live theme", () => {
    assert.equal(liveImport.summary.liveResults.themeStagingCreated, true);
    // The live theme content must be untouched by an import.
    assert.equal(STORE.themeFiles[0].body.content, "<html>ORIGINAL</html>");
  });

  // ── 8. Plan gating on the import door ────────────────────────────────────
  section("[8] Metafield plan gate is enforced on import, not only backup/restore");

  await check("8.1 Import route consults checkFeatureAccess before importing metafields", () => {
    assert.match(impExpSource, /checkFeatureAccess\(shop,\s*["']metafieldBackup["']\)/,
      "app.import-export.jsx never checks the metafieldBackup entitlement");
  });

  await check("8.2 A metafields-only archive is refused without the entitlement", () => {
    assert.match(impExpSource, /contains only metafields/,
      "no refusal path for a metafields-only archive on an unentitled plan");
  });

  await check("8.3 A mixed archive still imports its other assets", () => {
    assert.match(impExpSource, /metafieldsSkippedForPlan/,
      "no partial-import path for a mixed archive on an unentitled plan");
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=================================================================");
  if (failures.length === 0) {
    console.log(`  ALL ${passed} CHECKS PASSED`);
  } else {
    console.log(`  ${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log(`   ✗ ${f.label}\n       ${f.message}`);
  }
  console.log("=================================================================");

  await cleanupShop();
  await prisma.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("SUITE CRASHED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
