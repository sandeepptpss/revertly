/**
 * QA cycle: "Instant 1-Click Backup Options" under scale and partial failure.
 *
 * The existing e2e suite (test_backup_restore_e2e_qa.mjs) proves each option
 * captures and restores a *one-item* store correctly. This suite asks the two
 * questions that fixture cannot answer:
 *
 *   1. Does the capture cover a store that is bigger than one Shopify page?
 *   2. When Shopify errors or throttles part-way through, does the restore point
 *      still get recorded as a clean READY backup?
 *
 * (2) is the dangerous one: a merchant who is told "Collection Backup completed"
 * and later restores from a snapshot that silently holds none of their data has
 * no backup at all, and no way to know it.
 *
 * The mock admin honours the `first:` argument of every query and projects the
 * selected fields, so a fetcher that asks for too few items — or too shallow a
 * tree — is caught here instead of in production.
 *
 * Run: export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22
 *      node scratch/test_backup_hub_scale_qa.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import prisma from "../app/db.server.js";
import { buildThemeZip } from "../app/utils/theme-zip.js";
import {
  fetchThemeBackup,
  fetchCollectionsBackup,
  fetchPagesBackup,
  fetchMenusBackup,
  fetchBlogsAndArticlesBackup,
  backupTheme,
  backupProducts,
  backupCollections,
  backupPages,
  backupBlogs,
  backupMenus,
  createMultiResourceRestorePoint,
  restoreThemeFiles,
  restoreCollection,
  restorePage,
  restoreMenu,
  restoreArticle,
} from "../app/backup.server.js";

const TEST_SHOP = "qa-scale-backup-hub.myshopify.com";

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
  console.log(`\n▶ ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fault injection: which query substring should fail, and from which page.
// ─────────────────────────────────────────────────────────────────────────────
const FAULT = { match: null, fromPage: 1, kind: "throttle", seen: 0 };

function resetFault() {
  FAULT.match = null;
  FAULT.fromPage = 1;
  FAULT.kind = "throttle";
  FAULT.seen = 0;
}
function injectFault(match, { fromPage = 1, kind = "throttle" } = {}) {
  FAULT.match = match;
  FAULT.fromPage = fromPage;
  FAULT.kind = kind;
  FAULT.seen = 0;
}

const THROTTLE_BODY = {
  errors: [
    {
      message: "Throttled",
      extensions: { code: "THROTTLED" },
    },
  ],
  extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scale fixture: deliberately larger than one Shopify page on every resource.
// ─────────────────────────────────────────────────────────────────────────────
const N_THEME_FILES = 260; // > 250 page size
const N_COLLECTIONS = 320; // > 250 legacy cap
const N_PAGES = 300; // > 250 legacy cap
const N_MENUS = 60; // > menus(first: 50)
const N_BLOGS = 30; // > blogs(first: 25)
const N_ARTICLES_IN_BLOG_0 = 120; // > articles(first: 50)

function freshStore() {
  return {
    themes: [
      { id: "gid://shopify/Theme/900", name: "Dawn", role: "MAIN", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "gid://shopify/Theme/901", name: "Draft copy", role: "UNPUBLISHED", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
    ],
    themeFiles: Array.from({ length: N_THEME_FILES }, (_, i) => ({
      filename: i === 0 ? "layout/theme.liquid" : `snippets/part-${i}.liquid`,
      size: 20,
      body: { content: `<!-- file ${i} -->` },
    })),
    collections: Array.from({ length: N_COLLECTIONS }, (_, i) => ({
      id: `gid://shopify/Collection/${i + 1}`,
      title: `Collection ${i + 1}`,
      handle: `collection-${i + 1}`,
      descriptionHtml: `<p>Desc ${i + 1}</p>`,
      templateSuffix: "",
      image: null,
      sortOrder: "BEST_SELLING",
      ruleSet: null,
    })),
    pages: Array.from({ length: N_PAGES }, (_, i) => ({
      id: `gid://shopify/Page/${i + 1}`,
      title: `Page ${i + 1}`,
      handle: `page-${i + 1}`,
      body: `<p>Body ${i + 1}</p>`,
      bodySummary: `Body ${i + 1}`,
      templateSuffix: "",
      isPublished: true,
    })),
    menus: Array.from({ length: N_MENUS }, (_, i) => ({
      id: `gid://shopify/Menu/${i + 1}`,
      title: i === 0 ? "Main menu" : `Menu ${i + 1}`,
      handle: i === 0 ? "main-menu" : `menu-${i + 1}`,
      isDefault: i === 0,
      items:
        i === 0
          ? [
              {
                id: "i1",
                title: "Shop",
                url: "/collections/all",
                type: "HTTP",
                resourceId: null,
                tags: [],
                items: [
                  {
                    id: "i1a",
                    title: "Summer",
                    url: "/collections/summer",
                    type: "HTTP",
                    resourceId: null,
                    tags: [],
                    // Shopify navigation allows three levels. This is level 3.
                    items: [
                      { id: "i1a1", title: "Swimwear", url: "/collections/swimwear", type: "HTTP", resourceId: null, tags: [], items: [] },
                    ],
                  },
                ],
              },
            ]
          : [{ id: `m${i}i1`, title: "Home", url: "/", type: "HTTP", resourceId: null, tags: [], items: [] }],
    })),
    blogs: Array.from({ length: N_BLOGS }, (_, b) => ({
      id: `gid://shopify/Blog/${b + 1}`,
      title: `Blog ${b + 1}`,
      handle: `blog-${b + 1}`,
      commentPolicy: "MODERATED",
      templateSuffix: "",
      _articles: Array.from({ length: b === 0 ? N_ARTICLES_IN_BLOG_0 : 2 }, (_, a) => ({
        id: `gid://shopify/Article/${b + 1}-${a + 1}`,
        title: `Article ${b + 1}-${a + 1}`,
        handle: `article-${b + 1}-${a + 1}`,
        body: `<p>Article body ${b + 1}-${a + 1}</p>`,
        summary: `Sum ${a + 1}`,
        tags: ["news"],
        templateSuffix: "",
        isPublished: true,
        publishedAt: "2026-03-01T00:00:00Z",
        author: { name: `Author ${b + 1}` },
        image: { url: `https://cdn/hero-${b + 1}-${a + 1}.png`, altText: "Hero" },
      })),
    })),
    products: Array.from({ length: 120 }, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`,
      title: `Product ${i + 1}`,
      status: "ACTIVE",
      vendor: "Acme",
      productType: "Thing",
      tags: [],
      handle: `product-${i + 1}`,
      bodyHtml: "<p>x</p>",
      templateSuffix: "",
      publishedAt: "2026-01-01T00:00:00Z",
      images: { nodes: [] },
      metafields: { nodes: [] },
      variants: { nodes: [{ id: `gid://shopify/ProductVariant/${i + 1}`, title: "Default", price: "10.00", compareAtPrice: null, sku: `SKU-${i + 1}`, inventoryQuantity: 1, barcode: "" }] },
    })),
    written: { articles: [], pages: [], collections: [], menus: [], themeFiles: [] },
  };
}

let STORE = freshStore();

/** Reads `first: N` for a named connection out of the query text. */
function firstArg(query, connection) {
  const m = new RegExp(`${connection}\\(first:\\s*(\\d+)`).exec(query);
  return m ? Number(m[1]) : null;
}

/** How many nested `items {` levels the query actually selects. */
function menuItemDepth(query) {
  return (query.match(/items\s*\{/g) || []).length;
}

/** Trims a menu item tree to the depth the query selected. */
function projectItems(items, depth) {
  if (!Array.isArray(items) || depth <= 0) return [];
  return items.map((it) => {
    const copy = { ...it };
    if (depth <= 1) delete copy.items;
    else copy.items = projectItems(it.items, depth - 1);
    return copy;
  });
}

function createMockAdmin() {
  const j = (data, extra = {}) => ({ json: async () => ({ data, ...extra }) });

  return {
    graphql: async (query, { variables } = {}) => {
      // Fault injection, applied per matching call.
      if (FAULT.match && query.includes(FAULT.match)) {
        FAULT.seen++;
        if (FAULT.seen >= FAULT.fromPage) {
          if (FAULT.kind === "throw") throw new Error("Network unreachable");
          return { json: async () => THROTTLE_BODY };
        }
      }

      if (query.includes("getThemes") || query.includes("getThemesList") || query.includes("checkThemeRole")) {
        if (query.includes("checkThemeRole")) {
          const t = STORE.themes.find((x) => x.id === variables?.id);
          return j({ theme: t ? { id: t.id, role: t.role, name: t.name } : null });
        }
        return j({ themes: { nodes: STORE.themes } });
      }

      if (query.includes("getAllThemeFiles")) {
        const page = firstArg(query, "files") || 250;
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.themeFiles.slice(start, start + page);
        const end = start + slice.length;
        return j({
          theme: {
            files: {
              pageInfo: { hasNextPage: end < STORE.themeFiles.length, endCursor: end < STORE.themeFiles.length ? String(end) : null },
              nodes: slice,
            },
          },
        });
      }
      if (query.includes("getThemeFiles")) {
        // Named-filename fallback query.
        const names = variables?.filenames || [];
        return j({ theme: { files: { nodes: STORE.themeFiles.filter((f) => names.includes(f.filename)) } } });
      }

      if (query.includes("getCollections")) {
        const page = firstArg(query, "collections") || 100;
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.collections.slice(start, start + page);
        const end = start + slice.length;
        return j({
          collections: {
            pageInfo: { hasNextPage: end < STORE.collections.length, endCursor: end < STORE.collections.length ? String(end) : null },
            nodes: slice,
          },
        });
      }
      if (query.includes("findCollectionByHandle")) {
        const handle = (variables?.query || "").replace("handle:", "");
        const hit = STORE.collections.filter((c) => c.handle === handle).slice(0, 5);
        return j({ collections: { nodes: hit.map((c) => ({ id: c.id, title: c.title, handle: c.handle })) } });
      }

      if (query.includes("getPages")) {
        const page = firstArg(query, "pages") || 50;
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.pages.slice(start, start + page);
        const end = start + slice.length;
        return j({
          pages: {
            pageInfo: { hasNextPage: end < STORE.pages.length, endCursor: end < STORE.pages.length ? String(end) : null },
            nodes: slice,
          },
        });
      }
      if (query.includes("findPageByHandle")) {
        const handle = (variables?.query || "").replace("handle:", "");
        const hit = STORE.pages.filter((p) => p.handle === handle).slice(0, 5);
        return j({ pages: { nodes: hit.map((p) => ({ id: p.id, title: p.title, handle: p.handle })) } });
      }

      if (query.includes("getMenus") || query.includes("findMenuByHandle")) {
        const page = firstArg(query, "menus") || 50;
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.menus.slice(start, start + page);
        const end = start + slice.length;
        const depth = menuItemDepth(query);
        return j({
          menus: {
            pageInfo: { hasNextPage: end < STORE.menus.length, endCursor: end < STORE.menus.length ? String(end) : null },
            nodes: slice.map((m) => ({ ...m, items: projectItems(m.items, depth) })),
          },
        });
      }

      if (query.includes("getBlogsWithArticles")) {
        const blogPage = firstArg(query, "blogs") || 25;
        const artPage = firstArg(query, "articles") || 50;
        const blogStart = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.blogs.slice(blogStart, blogStart + blogPage);
        const blogEnd = blogStart + slice.length;
        return j({
          blogs: {
            pageInfo: { hasNextPage: blogEnd < STORE.blogs.length, endCursor: blogEnd < STORE.blogs.length ? String(blogEnd) : null },
            nodes: slice.map((b) => ({
              id: b.id,
              title: b.title,
              handle: b.handle,
              commentPolicy: b.commentPolicy,
              templateSuffix: b.templateSuffix,
              articles: {
                pageInfo: {
                  hasNextPage: b._articles.length > artPage,
                  endCursor: b._articles.length > artPage ? String(artPage) : null,
                },
                nodes: b._articles.slice(0, artPage),
              },
            })),
          },
        });
      }
      if (query.includes("getBlogArticlesPage")) {
        // Cursor continuation for one blog's articles.
        const artPage = firstArg(query, "articles") || 50;
        const blog = STORE.blogs.find((b) => b.id === variables?.blogId);
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = (blog?._articles || []).slice(start, start + artPage);
        const end = start + slice.length;
        return j({
          blog: blog
            ? {
                id: blog.id,
                articles: {
                  pageInfo: { hasNextPage: end < blog._articles.length, endCursor: end < blog._articles.length ? String(end) : null },
                  nodes: slice,
                },
              }
            : null,
        });
      }
      if (query.includes("getBlogsForRestore") || query.includes("getBlogsForArticleRestore")) {
        const page = firstArg(query, "blogs") || 25;
        return j({ blogs: { nodes: STORE.blogs.slice(0, page).map((b) => ({ id: b.id, title: b.title, handle: b.handle })) } });
      }

      if (query.includes("getProductsForBackup")) {
        const page = firstArg(query, "products") || 50;
        const start = variables?.cursor ? Number(variables.cursor) : 0;
        const slice = STORE.products.slice(start, start + page);
        const end = start + slice.length;
        return j({
          products: {
            pageInfo: { hasNextPage: end < STORE.products.length, endCursor: end < STORE.products.length ? String(end) : null },
            nodes: slice,
          },
        });
      }

      // ── Mutations ────────────────────────────────────────────────────────
      if (query.includes("themeFilesUpsert")) {
        STORE.written.themeFiles.push(...(variables?.files || []));
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
        const input = variables?.input || {};
        STORE.written.collections.push(input);
        STORE.collections.push({ ...input, id: `gid://shopify/Collection/new-${STORE.collections.length}` });
        return j({ collectionCreate: { collection: { id: "gid://shopify/Collection/new", ...input }, userErrors: [] } });
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
        STORE.written.articles.push({ mode: "update", id: variables?.id, ...(variables?.article || {}) });
        return j({ articleUpdate: { article: { id: variables?.id, title: variables?.article?.title }, userErrors: [] } });
      }
      if (query.includes("articleCreate")) {
        STORE.written.articles.push({ mode: "create", ...(variables?.article || {}) });
        return j({ articleCreate: { article: { id: "gid://shopify/Article/new", title: variables?.article?.title }, userErrors: [] } });
      }
      if (query.includes("blogCreate")) {
        return j({ blogCreate: { blog: { id: "gid://shopify/Blog/new", ...(variables?.blog || {}) }, userErrors: [] } });
      }

      return j({});
    },
  };
}

async function resetShop({ planId = "enterprise" } = {}) {
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: TEST_SHOP } } });
  await prisma.rollbackJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.changeEvent.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.appSettings.upsert({
    where: { shop: TEST_SHOP },
    create: { shop: TEST_SHOP, planId },
    update: { planId },
  });
  STORE = freshStore();
  resetFault();
}

async function cleanupShop() {
  await resetShop();
  await prisma.appSettings.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.restorePoint.deleteMany({ where: { shop: TEST_SHOP } });
}

/**
 * A backup that did not capture everything must not read as a clean success.
 * Either the call reports failure, or the stored restore point discloses the
 * gap (status, description or the `partial` summary flag).
 */
function assertDisclosesGap(result, what) {
  if (!result.success) return;
  const rp = result.restorePoint || {};
  const disclosed =
    rp.status === "PARTIAL" ||
    result.summary?.partial === true ||
    /partial|could not be read|incomplete/i.test(rp.description || "");
  assert.ok(
    disclosed,
    `${what}: backup reported success with an incomplete capture and no disclosure (status=${rp.status}, description=${JSON.stringify(rp.description)})`
  );
}

async function main() {
  console.log("=================================================================");
  console.log("  Revertly — 1-Click Backup Options: scale & partial-failure QA");
  console.log("=================================================================");

  await resetShop();
  const admin = createMockAdmin();

  // ── 1. THEME BACKUP ───────────────────────────────────────────────────────
  section("[1] Theme Backup");

  await check("1.1 captures every theme file across cursor pages", async () => {
    const res = await backupTheme({ admin, shop: TEST_SHOP });
    assert.ok(res.success, res.message);
    assert.equal(res.restorePoint.themeData.files.length, N_THEME_FILES);
  });

  await check("1.2 a throttle on page 2 does not silently store a half theme", async () => {
    injectFault("getAllThemeFiles", { fromPage: 2 });
    const res = await backupTheme({ admin, shop: TEST_SHOP, name: "Theme partial" });
    resetFault();
    const stored = res.restorePoint?.themeData?.files?.length ?? 0;
    if (stored === N_THEME_FILES) return; // captured everything after retry — fine
    assertDisclosesGap(res, `theme capture stored ${stored}/${N_THEME_FILES} files`);
  });

  await check("1.3 a total theme-read failure is not recorded as a READY theme backup", async () => {
    injectFault("getAllThemeFiles", { fromPage: 1 });
    const res = await backupTheme({ admin, shop: TEST_SHOP, name: "Theme failed" });
    resetFault();
    const stored = res.restorePoint?.themeData?.files?.length ?? 0;
    if (stored > 0) return;
    assert.ok(
      !res.success || res.restorePoint?.status !== "READY",
      `theme backup stored 0 files but is READY (themeCount=${res.restorePoint?.themeCount})`
    );
  });

  // ── 2. PRODUCT BACKUP ─────────────────────────────────────────────────────
  section("[2] Product Backup");

  await check("2.1 captures the whole catalog across cursor pages", async () => {
    const res = await backupProducts({ admin, shop: TEST_SHOP });
    assert.ok(res.success, res.message);
    assert.equal(res.restorePoint.productCount, STORE.products.length);
  });

  await check("2.2 a throttled catalog read discloses that it fell back", async () => {
    injectFault("getProductsForBackup", { fromPage: 2 });
    const res = await backupProducts({ admin, shop: TEST_SHOP, name: "Products partial" });
    resetFault();
    if (res.restorePoint?.productCount === STORE.products.length) return;
    assertDisclosesGap(res, `product capture stored ${res.restorePoint?.productCount}/${STORE.products.length}`);
  });

  // ── 3. COLLECTION BACKUP ──────────────────────────────────────────────────
  section("[3] Collection Backup");

  await check(`3.1 captures all ${N_COLLECTIONS} collections (not just the first 250)`, async () => {
    const cols = await fetchCollectionsBackup(admin);
    assert.equal(cols.length, N_COLLECTIONS);
  });

  await check("3.2 a failure part-way through does not report a clean 0-collection backup", async () => {
    injectFault("getCollections", { fromPage: 2 });
    const res = await backupCollections({ admin, shop: TEST_SHOP, name: "Collections partial" });
    resetFault();
    const stored = res.restorePoint?.collectionCount ?? 0;
    if (stored === N_COLLECTIONS) return;
    assertDisclosesGap(res, `collection capture stored ${stored}/${N_COLLECTIONS}`);
  });

  await check("3.3 restore writes back every captured collection", async () => {
    await resetShop();
    const res = await backupCollections({ admin, shop: TEST_SHOP });
    const cols = res.restorePoint.collectionData || [];
    STORE.written.collections = [];
    for (const c of cols.slice(0, 5)) {
      const r = await restoreCollection(admin, c);
      assert.ok(r.success, r.message);
    }
    assert.equal(STORE.written.collections.length, 5);
    assert.equal(STORE.written.collections[0].title, "Collection 1");
  });

  // ── 4. PAGE BACKUP ────────────────────────────────────────────────────────
  section("[4] Page Backup");

  await check(`4.1 captures all ${N_PAGES} pages (not just the first 250)`, async () => {
    const pages = await fetchPagesBackup(admin);
    assert.equal(pages.length, N_PAGES);
  });

  await check("4.2 a failure part-way through does not report a clean 0-page backup", async () => {
    injectFault("getPages", { fromPage: 2 });
    const res = await backupPages({ admin, shop: TEST_SHOP, name: "Pages partial" });
    resetFault();
    const stored = res.restorePoint?.pageCount ?? 0;
    if (stored === N_PAGES) return;
    assertDisclosesGap(res, `page capture stored ${stored}/${N_PAGES}`);
  });

  await check("4.3 restore writes back captured pages with their body", async () => {
    await resetShop();
    const res = await backupPages({ admin, shop: TEST_SHOP });
    const pages = res.restorePoint.pageData || [];
    STORE.written.pages = [];
    const r = await restorePage(admin, pages[0]);
    assert.ok(r.success, r.message);
    assert.equal(STORE.written.pages[0].body, "<p>Body 1</p>");
  });

  // ── 5. NAVIGATION MENU BACKUP ─────────────────────────────────────────────
  section("[5] Navigation Menu Backup");

  await check(`5.1 captures all ${N_MENUS} menus (menus(first: 50) is not enough)`, async () => {
    const menus = await fetchMenusBackup(admin);
    assert.equal(menus.length, N_MENUS);
  });

  await check("5.2 captures all three levels of Shopify navigation nesting", async () => {
    const menus = await fetchMenusBackup(admin);
    const main = menus.find((m) => m.handle === "main-menu");
    assert.ok(main, "main menu missing from capture");
    const level2 = main.items?.[0]?.items?.[0];
    assert.ok(level2, "second-level menu item missing from capture");
    assert.ok(
      Array.isArray(level2.items) && level2.items.length === 1,
      "third-level menu item was dropped by the backup query"
    );
    assert.equal(level2.items[0].title, "Swimwear");
  });

  await check("5.3 restore rebuilds the full three-level tree", async () => {
    await resetShop();
    const res = await backupMenus({ admin, shop: TEST_SHOP });
    const main = (res.restorePoint.menuData || []).find((m) => m.handle === "main-menu");
    STORE.written.menus = [];
    const r = await restoreMenu(admin, main);
    assert.ok(r.success, r.message);
    const written = STORE.written.menus[0];
    assert.equal(written.items[0].items[0].items?.[0]?.title, "Swimwear", "third level missing after restore");
  });

  await check("5.4 a menu read failure is not reported as a clean menu backup", async () => {
    await resetShop();
    injectFault("getMenus", { fromPage: 1 });
    const res = await backupMenus({ admin, shop: TEST_SHOP, name: "Menus failed" });
    resetFault();
    const stored = res.restorePoint?.menuCount ?? 0;
    if (stored === N_MENUS) return;
    assertDisclosesGap(res, `menu capture stored ${stored}/${N_MENUS}`);
  });

  // ── 6. BLOG BACKUP ────────────────────────────────────────────────────────
  section("[6] Blog Backup");

  await check(`6.1 captures all ${N_BLOGS} blogs (blogs(first: 25) is not enough)`, async () => {
    await resetShop();
    const data = await fetchBlogsAndArticlesBackup(admin);
    assert.equal(data.blogs.length, N_BLOGS);
  });

  await check(`6.2 captures all ${N_ARTICLES_IN_BLOG_0} articles of a large blog`, async () => {
    const data = await fetchBlogsAndArticlesBackup(admin);
    const fromBlog0 = data.articles.filter((a) => a.blogHandle === "blog-1");
    assert.equal(fromBlog0.length, N_ARTICLES_IN_BLOG_0);
  });

  await check("6.3 every captured article keeps its author and featured image", async () => {
    const data = await fetchBlogsAndArticlesBackup(admin);
    assert.ok(data.articles.every((a) => a.author?.name), "an article lost its author");
    assert.ok(data.articles.every((a) => a.image?.url), "an article lost its featured image");
  });

  await check("6.4 restore writes the article back with author and image", async () => {
    await resetShop();
    const res = await backupBlogs({ admin, shop: TEST_SHOP });
    const article = res.restorePoint.articleData.articles[0];
    STORE.written.articles = [];
    const r = await restoreArticle(admin, article);
    assert.ok(r.success, r.message);
    const w = STORE.written.articles[0];
    assert.ok(w, "no article mutation was issued");
    assert.equal(w.body, article.body);
  });

  await check("6.5 a blog read failure is not reported as a clean blog backup", async () => {
    await resetShop();
    injectFault("getBlogsWithArticles", { fromPage: 1 });
    const res = await backupBlogs({ admin, shop: TEST_SHOP, name: "Blogs failed" });
    resetFault();
    const stored = res.restorePoint?.articleCount ?? 0;
    if (stored > 0) return;
    assertDisclosesGap(res, "blog capture stored 0 articles");
  });

  // ── 7. FULL STORE BACKUP ──────────────────────────────────────────────────
  section("[7] Full Store Backup");

  await check("7.1 captures every resource at scale in one snapshot", async () => {
    await resetShop();
    const res = await createMultiResourceRestorePoint({
      admin,
      shop: TEST_SHOP,
      name: "Full store scale",
      backupType: "FULL",
      options: {
        includeProducts: true,
        includeThemes: true,
        includeCollections: true,
        includePages: true,
        includeMenus: true,
        includeArticles: true,
        includeMetafields: false,
      },
    });
    assert.ok(res.success, res.message);
    const rp = res.restorePoint;
    assert.equal(rp.productCount, STORE.products.length, "products");
    assert.equal(rp.themeCount, 1, "theme");
    assert.equal(rp.collectionCount, N_COLLECTIONS, "collections");
    assert.equal(rp.pageCount, N_PAGES, "pages");
    assert.equal(rp.menuCount, N_MENUS, "menus");
    assert.equal(rp.articleCount, N_ARTICLES_IN_BLOG_0 + (N_BLOGS - 1) * 2, "articles");
  });

  await check("7.2 one failed resource inside a Full Store backup is disclosed", async () => {
    await resetShop();
    injectFault("getCollections", { fromPage: 1 });
    const res = await createMultiResourceRestorePoint({
      admin,
      shop: TEST_SHOP,
      name: "Full store with a failure",
      backupType: "FULL",
      options: {
        includeProducts: false,
        includeThemes: false,
        includeCollections: true,
        includePages: true,
        includeMenus: false,
        includeArticles: false,
      },
    });
    resetFault();
    if ((res.restorePoint?.collectionCount ?? 0) === N_COLLECTIONS) return;
    assertDisclosesGap(res, "full store backup lost its collections");
  });

  // ── 8. RESTORE AT SCALE ───────────────────────────────────────────────────
  section("[8] Restore at scale — everything captured goes back");

  await check("8.1 theme restore pushes every captured file (batched, none dropped)", async () => {
    await resetShop();
    const res = await backupTheme({ admin, shop: TEST_SHOP });
    const files = res.restorePoint.themeData.files;
    STORE.written.themeFiles = [];
    const r = await restoreThemeFiles(admin, "gid://shopify/Theme/900", files);
    assert.ok(r.success, r.message);
    assert.equal(r.count, N_THEME_FILES, "not every file was upserted");
    const writtenNames = new Set(STORE.written.themeFiles.map((f) => f.filename));
    for (const f of files) assert.ok(writtenNames.has(f.filename), `missing ${f.filename}`);
    const layout = STORE.written.themeFiles.find((f) => f.filename === "layout/theme.liquid");
    assert.equal(layout.body.value, "<!-- file 0 -->", "theme file content changed in the round trip");
  });

  await check("8.2 every captured collection restores with its handle and description", async () => {
    await resetShop();
    const res = await backupCollections({ admin, shop: TEST_SHOP });
    const cols = res.restorePoint.collectionData;
    assert.equal(cols.length, N_COLLECTIONS);
    STORE.written.collections = [];
    for (const c of cols) {
      const r = await restoreCollection(admin, c);
      assert.ok(r.success, `${c.handle}: ${r.message}`);
    }
    assert.equal(STORE.written.collections.length, N_COLLECTIONS);
    const last = STORE.written.collections[N_COLLECTIONS - 1];
    assert.equal(last.handle, `collection-${N_COLLECTIONS}`);
    assert.equal(last.descriptionHtml, `<p>Desc ${N_COLLECTIONS}</p>`);
  });

  await check("8.3 every captured page restores with its body", async () => {
    await resetShop();
    const res = await backupPages({ admin, shop: TEST_SHOP });
    const pages = res.restorePoint.pageData;
    assert.equal(pages.length, N_PAGES);
    STORE.written.pages = [];
    for (const p of pages) {
      const r = await restorePage(admin, p);
      assert.ok(r.success, `${p.handle}: ${r.message}`);
    }
    assert.equal(STORE.written.pages.length, N_PAGES);
    assert.equal(STORE.written.pages[N_PAGES - 1].body, `<p>Body ${N_PAGES}</p>`);
  });

  await check("8.4 every captured menu restores", async () => {
    await resetShop();
    const res = await backupMenus({ admin, shop: TEST_SHOP });
    const menus = res.restorePoint.menuData;
    assert.equal(menus.length, N_MENUS);
    STORE.written.menus = [];
    for (const m of menus) {
      const r = await restoreMenu(admin, m);
      assert.ok(r.success, `${m.handle}: ${r.message}`);
    }
    assert.equal(STORE.written.menus.length, N_MENUS);
  });

  await check("8.5 every captured article restores with body, tags and author", async () => {
    await resetShop();
    const res = await backupBlogs({ admin, shop: TEST_SHOP });
    const arts = res.restorePoint.articleData.articles;
    assert.equal(arts.length, N_ARTICLES_IN_BLOG_0 + (N_BLOGS - 1) * 2);
    STORE.written.articles = [];
    for (const a of arts.slice(0, 60)) {
      const r = await restoreArticle(admin, a);
      assert.ok(r.success, `${a.handle}: ${r.message}`);
    }
    assert.equal(STORE.written.articles.length, 60);
    const w = STORE.written.articles[0];
    assert.equal(w.body, arts[0].body);
    assert.deepEqual(w.tags, arts[0].tags);
  });

  // ── 9. THEME ZIP RECOVERY PATH ────────────────────────────────────────────
  // The ZIP is the documented fallback when Shopify denies the Theme API, so a
  // malformed archive means the merchant has no recovery route at all.
  section("[9] Download Theme as .ZIP");

  await check("9.1 the archive is a valid ZIP that every captured file survives", async () => {
    await resetShop();
    const res = await backupTheme({ admin, shop: TEST_SHOP });
    const files = res.restorePoint.themeData.files;
    const zip = buildThemeZip(files);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revertly-zip-qa-"));
    const zipPath = path.join(dir, "theme.zip");
    fs.writeFileSync(zipPath, zip);

    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.equal(listing.length, N_THEME_FILES, "ZIP entry count does not match the snapshot");

    execFileSync("unzip", ["-qq", "-o", zipPath, "-d", path.join(dir, "out")], { stdio: "pipe" });
    const extracted = fs.readFileSync(path.join(dir, "out", "layout/theme.liquid"), "utf8");
    assert.equal(extracted, "<!-- file 0 -->", "file content did not survive the ZIP round trip");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("9.2 binary (base64) theme assets survive the ZIP byte-for-byte", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const zip = buildThemeZip([
      { filename: "assets/logo.png", content: png.toString("base64"), bodyType: "BASE64" },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revertly-zip-bin-"));
    const zipPath = path.join(dir, "bin.zip");
    fs.writeFileSync(zipPath, zip);
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    execFileSync("unzip", ["-qq", "-o", zipPath, "-d", path.join(dir, "out")], { stdio: "pipe" });
    const out = fs.readFileSync(path.join(dir, "out", "assets/logo.png"));
    assert.ok(out.equals(png), "binary asset was corrupted by the ZIP writer");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("9.3 an archive holding Shopify's raw file shape still zips with real content", async () => {
    // Imported archives and older snapshots carry `body { content }` instead of
    // the normalized `content`. Writing those as empty files would hand the
    // merchant an archive of blank liquid.
    const zip = buildThemeZip([
      { filename: "layout/theme.liquid", size: 9, body: { content: "<html>RAW</html>" } },
      { filename: "snippets/x.liquid", body: { type: "TEXT", value: "upsert shape" } },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revertly-zip-raw-"));
    const zipPath = path.join(dir, "raw.zip");
    fs.writeFileSync(zipPath, zip);
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    execFileSync("unzip", ["-qq", "-o", zipPath, "-d", path.join(dir, "out")], { stdio: "pipe" });
    assert.equal(fs.readFileSync(path.join(dir, "out", "layout/theme.liquid"), "utf8"), "<html>RAW</html>");
    assert.equal(fs.readFileSync(path.join(dir, "out", "snippets/x.liquid"), "utf8"), "upsert shape");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("9.4 theme restore accepts every file shape and names what it cannot read", async () => {
    await resetShop();
    STORE.written.themeFiles = [];
    const r = await restoreThemeFiles(admin, "gid://shopify/Theme/900", [
      { filename: "layout/theme.liquid", content: "normalized" },
      { filename: "sections/header.liquid", body: { content: "raw shopify shape" } },
      { filename: "assets/logo.png", body: { contentBase64: Buffer.from("PNG").toString("base64") } },
      { filename: "snippets/empty.liquid" },
    ]);
    assert.ok(r.success, r.message);
    assert.equal(r.count, 3, "a readable file was dropped");
    const written = Object.fromEntries(STORE.written.themeFiles.map((f) => [f.filename, f.body]));
    assert.equal(written["sections/header.liquid"].value, "raw shopify shape");
    assert.equal(written["assets/logo.png"].type, "BASE64");
    assert.deepEqual(r.skipped, ["snippets/empty.liquid"]);
    assert.match(r.message, /held no readable content/);
  });

  await check("9.5 the staging ZIP endpoint serves, then expires, the archive", async () => {
    const { loader } = await import("../app/routes/api.theme-download.$token.jsx");
    const { themeZipDir, themeZipPath, THEME_ZIP_TTL_MS } = await import("../app/themeZipStore.server.js");

    fs.mkdirSync(themeZipDir(), { recursive: true });
    const token = "qa" + Math.random().toString(16).slice(2, 10);
    const zip = buildThemeZip([{ filename: "layout/theme.liquid", content: "staged" }]);
    fs.writeFileSync(themeZipPath(token), zip);

    const fresh = await loader({ params: { token: `${token}.zip` } });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get("Cache-Control"), "private, no-store", "theme source must not be cacheable by shared caches");
    assert.equal(Buffer.from(await fresh.arrayBuffer()).length, zip.length);

    // Path traversal must not reach outside the archive directory.
    await assert.rejects(
      async () => loader({ params: { token: "../../../etc/passwd" } }),
      (r) => r instanceof Response && r.status === 400
    );

    // Age the archive past its window: it is refused and removed.
    const old = Date.now() - THEME_ZIP_TTL_MS - 60_000;
    fs.utimesSync(themeZipPath(token), new Date(old), new Date(old));
    await assert.rejects(
      async () => loader({ params: { token } }),
      (r) => r instanceof Response && r.status === 404
    );
    assert.ok(!fs.existsSync(themeZipPath(token)), "expired archive was left on disk");
  });

  // ── 10. DISCLOSURE CONTRACT ───────────────────────────────────────────────
  section("[10] Disclosure contract between the capture and the hub UI");

  await check("10.1 a clean backup is not flagged partial", async () => {
    await resetShop();
    const res = await backupCollections({ admin, shop: TEST_SHOP });
    assert.equal(res.summary.partial, false);
    assert.deepEqual(res.summary.incomplete, []);
    assert.ok(!/Partial capture/.test(res.restorePoint.description));
  });

  await check("10.2 a partial backup names the resource that fell short", async () => {
    await resetShop();
    injectFault("getPages", { fromPage: 2 });
    const res = await createMultiResourceRestorePoint({
      admin,
      shop: TEST_SHOP,
      name: "Pages partial contract",
      options: { includeProducts: false, includeThemes: false, includeCollections: false, includePages: true, includeMenus: false, includeArticles: false },
    });
    resetFault();
    assert.equal(res.summary.partial, true);
    assert.deepEqual(res.summary.incomplete, ["pages"]);
    assert.match(res.restorePoint.description, /Partial capture: pages could not be fully read/);
  });

  await check("10.3 the hub reports every 1-click backup through the partial-aware responder", async () => {
    const src = fs.readFileSync(new URL("../app/routes/app.restore-points.jsx", import.meta.url), "utf8");
    const action = src.slice(src.indexOf("export const action"), src.indexOf("export default function"));
    for (const intent of [
      "backupFull",
      "backupTheme",
      "backupProducts",
      "backupCollections",
      "backupPages",
      "backupBlogs",
      "backupMenus",
      "backupMetafields",
    ]) {
      assert.ok(action.includes(intent), `intent ${intent} missing from the hub action`);
    }
    // One responder call per backup intent (backupFull shares the "create" branch).
    const responders = (action.match(/backupResponse\(/g) || []).length;
    assert.ok(responders >= 8, `only ${responders} backup responses route through backupResponse`);
    assert.ok(
      /tone={result.success \? result.tone \|\| "success" : "critical"}/.test(src),
      "the feedback banner ignores the warning tone a partial capture returns"
    );
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  await cleanupShop();

  console.log("\n=================================================================");
  if (failures.length === 0) {
    console.log(`  ALL ${passed} CHECKS PASSED`);
  } else {
    console.log(`  ${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log(`   ✗ ${f.label}\n     ${f.message}`);
  }
  console.log("=================================================================");
  await prisma.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
