/**
 * QA: Import & Export Hub — full end-to-end round-trip verification.
 *
 * Exercises every export format the Import & Export Hub offers, feeds each
 * exported artifact back through the import pipeline, and asserts that the
 * asset counts survive the trip. Also covers invalid-file handling.
 *
 * Run with Node 22:  ~/.nvm/versions/node/v22.23.2/bin/node scratch/test_import_export_qa_cycle.mjs
 */
import prisma from "../app/db.server.js";
import {
  generateProductsCsv,
  generateCollectionsCsv,
  generatePagesAndMenusCsv,
  generateMenusCsv,
  generateMetafieldsCsv,
  generateBlogsAndArticlesCsv,
  fetchThemeBackup,
  fetchCollectionsBackup,
  fetchPagesBackup,
  fetchMenusBackup,
  fetchBlogsAndArticlesBackup,
  fetchLiveProductsBackup,
  importBackupPayload,
  normalizeMetafieldDocument,
} from "../app/backup.server.js";
import { detectAndParseCsvArchive } from "../app/utils/csv-portability.js";

const SHOP = "qa-impexp-cycle.myshopify.com";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Mock Shopify admin with a realistic multi-asset store
// ───────────────────────────────────────────────────────────────────────────────
const LIVE = {
  themes: [{ id: "gid://shopify/Theme/900", name: "Dawn", role: "MAIN", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" }],
  themeFiles: [
    { filename: "layout/theme.liquid", size: 40, body: { content: "<html>\n{{ content_for_layout }}\n</html>" } },
    { filename: "config/settings_data.json", size: 30, body: { content: '{"current":"Default, with a comma"}' } },
    { filename: "sections/header.liquid", size: 20, body: { content: 'He said "hi"\r\nand left' } },
  ],
  collections: [
    {
      id: "gid://shopify/Collection/1", title: "Summer, Sale", handle: "summer-sale",
      descriptionHtml: "<p>Line one\nLine two, with \"quotes\"</p>", templateSuffix: "",
      image: { id: "gid://shopify/Image/1", url: "https://cdn/img1.png", altText: "Alt, text" },
      sortOrder: "BEST_SELLING",
      ruleSet: { appliedDisjunctively: true, rules: [{ column: "TAG", relation: "EQUALS", condition: "summer" }] },
    },
    {
      id: "gid://shopify/Collection/2", title: "Manual Picks", handle: "manual-picks",
      descriptionHtml: "", templateSuffix: "custom", image: null,
      sortOrder: "MANUAL", ruleSet: null,
    },
  ],
  pages: [
    { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us", body: "<p>Hello,\nworld</p>", bodySummary: "Hello", templateSuffix: "", isPublished: true },
    { id: "gid://shopify/Page/2", title: "Draft Terms", handle: "terms", body: "<p>Terms</p>", bodySummary: "Terms", templateSuffix: "legal", isPublished: false },
  ],
  menus: [
    { id: "gid://shopify/Menu/1", title: "Main menu", handle: "main-menu", items: [{ id: "i1", title: "Home", url: "/", type: "FRONTPAGE", items: [{ id: "i1a", title: "Nested", url: "/n", type: "HTTP" }] }] },
    { id: "gid://shopify/Menu/2", title: "Footer menu", handle: "footer", items: [] },
  ],
  blogs: [
    {
      id: "gid://shopify/Blog/1", title: "News", handle: "news", commentPolicy: "MODERATED", templateSuffix: "",
      articles: {
        nodes: [
          { id: "gid://shopify/Article/1", title: "Hello World", handle: "hello-world", body: "<p>Body, with comma</p>", summary: "<p>Sum</p>", tags: ["a", "b"], templateSuffix: "", isPublished: true, publishedAt: "2026-03-01T00:00:00Z", image: { url: "https://cdn/a.png", altText: "A" } },
          { id: "gid://shopify/Article/2", title: "Second Post", handle: "second", body: "<p>Two</p>", summary: "", tags: [], templateSuffix: "", isPublished: false, publishedAt: "", image: null },
        ],
      },
    },
  ],
  products: [
    {
      id: "gid://shopify/Product/1", title: "Tee, Basic", status: "ACTIVE", vendor: "Acme", productType: "Shirt",
      tags: ["cotton", "summer"], handle: "tee-basic", bodyHtml: "<p>Nice tee</p>", templateSuffix: "", publishedAt: "2026-01-01T00:00:00Z",
      images: { nodes: [{ id: "gid://shopify/Image/9", url: "https://cdn/p.png", altText: "P" }] },
      metafields: { nodes: [{ id: "gid://shopify/Metafield/5", namespace: "custom", key: "care", value: "cold wash", type: "single_line_text_field" }] },
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "S", price: "19.99", compareAtPrice: "24.99", sku: "TEE-S", inventoryQuantity: 4, barcode: "" }, { id: "gid://shopify/ProductVariant/12", title: "L", price: "29.99", compareAtPrice: null, sku: "TEE-L", inventoryQuantity: 2, barcode: "" }] },
    },
    {
      id: "gid://shopify/Product/2", title: "Mug", status: "DRAFT", vendor: "Acme", productType: "Drinkware",
      tags: [], handle: "mug", bodyHtml: "", templateSuffix: "", publishedAt: null,
      images: { nodes: [] }, metafields: { nodes: [] },
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/21", title: "Default Title", price: "9.50", compareAtPrice: null, sku: "MUG", inventoryQuantity: 10, barcode: "" }] },
    },
  ],
};

// A metafield document in the shape fetchMetafieldsBackup produces.
const METAFIELD_DOC = {
  _schema: "revertly-metafields-v1",
  capturedAt: "2026-09-01T00:00:00Z",
  sourceShop: SHOP,
  definitionSchema: "rich",
  definitions: {
    PRODUCT: [{ namespace: "custom", key: "care", name: "Care", type: "single_line_text_field", description: "", validations: [], ownerType: "PRODUCT" }],
    SHOP: [],
    COLLECTION: [],
    PAGE: [],
    BLOG: [],
    ARTICLE: [],
  },
  owners: [
    { ownerType: "PRODUCT", sourceGid: "gid://shopify/Product/1", handle: "tee-basic", title: "Tee, Basic", parentHandle: null, truncated: false, metafields: [{ namespace: "custom", key: "care", type: "single_line_text_field", value: "cold wash" }] },
    { ownerType: "SHOP", sourceGid: "gid://shopify/Shop/1", handle: null, title: "QA Shop", parentHandle: null, truncated: false, metafields: [{ namespace: "custom", key: "motto", type: "single_line_text_field", value: 'We say "hi", loudly' }] },
    { ownerType: "ARTICLE", sourceGid: "gid://shopify/Article/1", handle: "hello-world", title: "Hello World", parentHandle: "news", truncated: false, metafields: [{ namespace: "custom", key: "reading_time", type: "number_integer", value: "5" }] },
  ],
  counts: {
    definitions: 1,
    definitionsByOwnerType: { PRODUCT: 1 },
    owners: 3,
    metafields: 3,
    metafieldsByOwnerType: { PRODUCT: 1, SHOP: 1, ARTICLE: 1 },
    truncatedOwners: 0,
  },
  warnings: [],
};

function makeAdmin() {
  return {
    graphql: async (query, opts = {}) => {
      const j = (data) => ({ json: async () => ({ data }) });
      if (query.includes("getThemes")) return j({ themes: { nodes: LIVE.themes } });
      if (query.includes("getAllThemeFiles")) return j({ theme: { files: { nodes: LIVE.themeFiles } } });
      if (query.includes("getThemeFiles")) return j({ theme: { files: { nodes: LIVE.themeFiles } } });
      if (query.includes("getCollections")) return j({ collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LIVE.collections } });
      if (query.includes("getPages")) return j({ pages: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LIVE.pages } });
      if (query.includes("getMenus")) return j({ menus: { nodes: LIVE.menus } });
      if (query.includes("getBlogsWithArticles")) return j({ blogs: { nodes: LIVE.blogs } });
      if (query.includes("getProductsForBackup")) return j({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: LIVE.products } });
      // Live-restore mutations succeed by default
      if (query.includes("collectionCreate")) return j({ collectionCreate: { collection: { id: "gid://shopify/Collection/new" }, userErrors: [] } });
      if (query.includes("collectionUpdate")) return j({ collectionUpdate: { collection: { id: opts.variables?.input?.id }, userErrors: [] } });
      if (query.includes("pageCreate")) return j({ pageCreate: { page: { id: "gid://shopify/Page/new" }, userErrors: [] } });
      if (query.includes("pageUpdate")) return j({ pageUpdate: { page: { id: opts.variables?.id }, userErrors: [] } });
      if (query.includes("menuCreate")) return j({ menuCreate: { menu: { id: "gid://shopify/Menu/new" }, userErrors: [] } });
      if (query.includes("menuUpdate")) return j({ menuUpdate: { menu: { id: opts.variables?.id }, userErrors: [] } });
      if (query.includes("articleCreate")) return j({ articleCreate: { article: { id: "gid://shopify/Article/new" }, userErrors: [] } });
      if (query.includes("articleUpdate")) return j({ articleUpdate: { article: { id: opts.variables?.id }, userErrors: [] } });
      return j({});
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Mirror of the browser-side file inspector in app/routes/app.import-export.jsx
// (processFile) so the counters the merchant sees can be compared with what the
// server actually persists.
// ───────────────────────────────────────────────────────────────────────────────
function inspectJson(text) {
  const parsed = JSON.parse(text);
  const storeAssets = parsed.storeAssets || {};
  const prods = Array.isArray(storeAssets.products) ? storeAssets.products
    : Array.isArray(parsed.products) ? parsed.products
    : Array.isArray(parsed) ? parsed : [];
  const theme = storeAssets.theme || parsed.theme || null;
  const cols = Array.isArray(storeAssets.collections) ? storeAssets.collections
    : Array.isArray(parsed.collections) ? parsed.collections : [];
  const pgs = Array.isArray(storeAssets.pages) ? storeAssets.pages
    : Array.isArray(parsed.pages) ? parsed.pages : [];
  const menus = Array.isArray(storeAssets.menus) ? storeAssets.menus
    : Array.isArray(parsed.menus) ? parsed.menus : [];
  const arts = storeAssets.blogsAndArticles?.articles || parsed.blogsAndArticles?.articles || parsed.articles || [];
  const metafieldDoc = storeAssets.metafields || parsed.metafields || parsed.metafieldData || null;
  const metafieldCount = metafieldDoc?.counts?.metafields || 0;
  const definitionCount = metafieldDoc?.counts?.definitions || 0;
  const themeFilesCount = theme?.files?.length || (theme?.activeTheme ? 1 : 0);
  return {
    products: prods.length, themeFiles: themeFilesCount, collections: cols.length,
    pages: pgs.length, menus: menus.length, articles: arts.length,
    metafields: metafieldCount, definitions: definitionCount,
    total: prods.length + themeFilesCount + cols.length + pgs.length + menus.length + arts.length + metafieldCount + definitionCount,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Mirror of the export route (app/routes/app.export.jsx) payload builders
// ───────────────────────────────────────────────────────────────────────────────
async function buildExports(admin) {
  const [theme, collections, pages, menus, blogData] = await Promise.all([
    fetchThemeBackup(admin), fetchCollectionsBackup(admin), fetchPagesBackup(admin),
    fetchMenusBackup(admin), fetchBlogsAndArticlesBackup(admin),
  ]);
  const products = await fetchLiveProductsBackup(admin); // no shop => no DB writes
  const metafieldDoc = METAFIELD_DOC;

  return {
    live: { theme, collections, pages, menus, blogData, products, metafieldDoc },
    json: {
      full_json: {
        _schema: "revertly-disaster-recovery-v1", app: "Revertly", shop: SHOP, source: "live",
        name: "Live Store Export - 2026-09-22", description: "On-demand export of live Shopify store assets.",
        status: "READY", backupType: "FULL", exportedAt: new Date().toISOString(),
        summary: {
          productsCount: products.length, themeCount: theme ? 1 : 0, collectionCount: collections.length,
          pageCount: pages.length, menuCount: menus.length, articleCount: blogData?.articles?.length || 0,
          metafieldCount: metafieldDoc?.counts?.metafields || 0,
        },
        storeAssets: { products, theme, collections, pages, menus, blogsAndArticles: blogData, metafields: metafieldDoc },
      },
      products_json: { _schema: "revertly-products-v1", shop: SHOP, source: "live", exportedAt: "x", count: products.length, products },
      themes_json: { _schema: "revertly-themes-v1", shop: SHOP, source: "live", exportedAt: "x", theme },
      collections_json: { _schema: "revertly-collections-v1", shop: SHOP, source: "live", exportedAt: "x", count: collections.length, collections },
      pages_json: { _schema: "revertly-pages-v1", shop: SHOP, source: "live", exportedAt: "x", pageCount: pages.length, menuCount: menus.length, pages, menus },
      blogs_json: { _schema: "revertly-blogs-v1", shop: SHOP, source: "live", exportedAt: "x", blogs: blogData?.blogs || [], articles: blogData?.articles || [] },
      menus_json: { _schema: "revertly-menus-v1", shop: SHOP, source: "live", exportedAt: "x", menuCount: menus.length, menus },
      metafields_json: {
        _schema: "revertly-metafields-v1", shop: SHOP, source: "live", exportedAt: "x",
        metafieldCount: metafieldDoc.counts.metafields, definitionCount: metafieldDoc.counts.definitions,
        metafields: metafieldDoc,
      },
    },
    csv: {
      products_csv: generateProductsCsv(products),
      collections_csv: generateCollectionsCsv(collections),
      pages_csv: generatePagesAndMenusCsv(pages, menus),
      menus_csv: generateMenusCsv(menus),
      blogs_csv: generateBlogsAndArticlesCsv(blogData?.blogs || [], blogData?.articles || []),
      metafields_csv: generateMetafieldsCsv(metafieldDoc),
    },
  };
}

// Mirror of the import action's parse step in app/routes/app.import-export.jsx
function actionParse(fileContent) {
  if (!fileContent || typeof fileContent !== "string" || !fileContent.trim()) {
    return { error: "Please select or upload a valid JSON or CSV backup file." };
  }
  const trimmed = fileContent.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { parsed: JSON.parse(trimmed) };
    } catch (e) {
      return { error: `Invalid JSON file syntax: ${e.message}` };
    }
  }
  try {
    const parsedCsv = detectAndParseCsvArchive(fileContent);
    return { parsed: { name: `Imported CSV Archive (${parsedCsv.type})`, backupType: parsedCsv.type, ...parsedCsv.data } };
  } catch (e) {
    return { error: `Invalid CSV backup file: ${e.message}` };
  }
}

const created = [];
async function importFile(admin, fileContent, mode = "SAVE_AS_RESTORE_POINT") {
  const p = actionParse(fileContent);
  if (p.error) return { success: false, message: p.error };
  const res = await importBackupPayload({ admin, shop: SHOP, payload: p.parsed, mode });
  if (res.restorePoint?.id) created.push(res.restorePoint.id);
  return res;
}

async function run() {
  const admin = makeAdmin();
  // Imports now count toward the plan's restore-point allowance, and this
  // suite imports many archives in a row. Run the store on an unlimited plan
  // (a sim_ subscription, so nothing reconciles it with Shopify).
  await prisma.appSettings.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, planId: "enterprise", subscriptionId: "sim_enterprise_impexp_qa" },
    update: { planId: "enterprise", subscriptionId: "sim_enterprise_impexp_qa" },
  });
  console.log("=".repeat(78));
  console.log("  IMPORT & EXPORT HUB — END-TO-END QA CYCLE");
  console.log("=".repeat(78));

  const ex = await buildExports(admin);
  const L = ex.live;

  // ── 1. Export content sanity ────────────────────────────────────────────────
  console.log("\n[1] Exported artifacts contain the expected data");
  check("full JSON archive carries all 2 products", ex.json.full_json.storeAssets.products.length === 2);
  check("full JSON archive carries 3 theme files", ex.json.full_json.storeAssets.theme?.files?.length === 3);
  check("full JSON archive carries 2 collections", ex.json.full_json.storeAssets.collections.length === 2);
  check("full JSON archive carries 2 pages", ex.json.full_json.storeAssets.pages.length === 2);
  check("full JSON archive carries 2 menus", ex.json.full_json.storeAssets.menus.length === 2);
  check("full JSON archive carries 2 articles", ex.json.full_json.storeAssets.blogsAndArticles.articles.length === 2);
  check("full JSON archive carries 3 metafields", ex.json.full_json.storeAssets.metafields.counts.metafields === 3);
  check("products CSV has one row per product", ex.csv.products_csv.trim().split("\r\n").length === 3,
    `rows=${ex.csv.products_csv.trim().split("\r\n").length}`);
  check("pages CSV has one row per page + menu", ex.csv.pages_csv.trim().split(/\r\n(?=")/).length === 5);
  check("metafields CSV has one row per metafield", ex.csv.metafields_csv.split(/\r\n(?=")/).length === 4);

  // ── 2. Full JSON archive round trip ─────────────────────────────────────────
  console.log("\n[2] Full JSON archive: export → import round trip");
  const fullText = JSON.stringify(ex.json.full_json, null, 2);
  const insp = inspectJson(fullText);
  check("client inspector reports 2 products", insp.products === 2, `got ${insp.products}`);
  check("client inspector reports 3 theme files", insp.themeFiles === 3, `got ${insp.themeFiles}`);
  check("client inspector reports 2 collections/2 pages/2 menus/2 articles",
    insp.collections === 2 && insp.pages === 2 && insp.menus === 2 && insp.articles === 2,
    JSON.stringify(insp));
  check("client inspector reports 3 metafields + 1 definition", insp.metafields === 3 && insp.definitions === 1, JSON.stringify(insp));

  const r1 = await importFile(admin, fullText);
  check("full archive imports successfully", r1.success, r1.message);
  if (r1.success) {
    const s = r1.summary;
    check("imported products count matches export", s.products === 2, `got ${s.products}`);
    check("imported themes count matches export", s.themes === 1, `got ${s.themes}`);
    check("imported collections count matches export", s.collections === 2, `got ${s.collections}`);
    check("imported pages count matches export", s.pages === 2, `got ${s.pages}`);
    check("imported menus count matches export", s.menus === 2, `got ${s.menus}`);
    check("imported articles count matches export", s.articles === 2, `got ${s.articles}`);
    check("imported metafields count matches export", s.metafields === 3, `got ${s.metafields}`);
    check("imported metafield definitions count matches export", s.metafieldDefinitions === 1, `got ${s.metafieldDefinitions}`);
    check("backupType for a multi-asset archive is FULL", s.backupType === "FULL", `got ${s.backupType}`);

    const rp = await prisma.restorePoint.findUnique({ where: { id: r1.restorePoint.id } });
    check("persisted restore point stores theme files", (rp.themeData?.files?.length || 0) === 3, `got ${rp.themeData?.files?.length}`);
    check("persisted restore point stores page bodies verbatim",
      rp.pageData?.[0]?.body === LIVE.pages[0].body, JSON.stringify(rp.pageData?.[0]?.body));
    check("persisted restore point stores nested menu items",
      rp.menuData?.[0]?.items?.[0]?.items?.[0]?.title === "Nested");
    check("persisted restore point stores product variants",
      rp.snapshotData?.[0]?.snapshotData?.variants?.length === 2, `got ${rp.snapshotData?.[0]?.snapshotData?.variants?.length}`);
    check("persisted metafield values survive quoting",
      rp.metafieldData?.owners?.find((o) => o.ownerType === "SHOP")?.metafields?.[0]?.value === 'We say "hi", loudly');
  }

  // ── 3. Per-type JSON exports round trip ─────────────────────────────────────
  console.log("\n[3] Per-type JSON exports: export → import round trip");
  const jsonExpect = {
    products_json: { products: 2, backupType: "PRODUCTS" },
    themes_json: { themes: 1, backupType: "THEMES" },
    collections_json: { collections: 2, backupType: "COLLECTIONS" },
    pages_json: { pages: 2, menus: 2, backupType: "PAGES" },
    blogs_json: { articles: 2, backupType: "BLOGS" },
    menus_json: { menus: 2, backupType: "MENUS" },
    metafields_json: { metafields: 3, metafieldDefinitions: 1, backupType: "METAFIELDS" },
  };
  for (const [type, expect] of Object.entries(jsonExpect)) {
    const text = JSON.stringify(ex.json[type], null, 2);
    const i = inspectJson(text);
    check(`${type}: client inspector accepts file (total > 0)`, i.total > 0, JSON.stringify(i));
    const res = await importFile(admin, text);
    check(`${type}: imports successfully`, res.success, res.message);
    if (!res.success) continue;
    for (const [k, v] of Object.entries(expect)) {
      check(`${type}: summary.${k} === ${v}`, res.summary[k] === v, `got ${res.summary[k]}`);
    }
  }

  // ── 4. CSV exports round trip ───────────────────────────────────────────────
  console.log("\n[4] CSV exports: export → import round trip");
  const csvExpect = {
    products_csv: { type: "PRODUCTS", products: 2 },
    collections_csv: { type: "COLLECTIONS", collections: 2 },
    pages_csv: { type: "PAGES", pages: 2, menus: 2 },
    menus_csv: { type: "MENUS", menus: 2 },
    blogs_csv: { type: "BLOGS", articles: 2 },
    metafields_csv: { type: "METAFIELDS", metafields: 3 },
  };
  for (const [type, expect] of Object.entries(csvExpect)) {
    const text = ex.csv[type];
    let detected = null;
    try {
      detected = detectAndParseCsvArchive(text);
    } catch (e) {
      check(`${type}: CSV format detected`, false, e.message);
      continue;
    }
    check(`${type}: detected as ${expect.type}`, detected.type === expect.type, `got ${detected.type}`);
    const res = await importFile(admin, text);
    check(`${type}: imports successfully`, res.success, res.message);
    if (!res.success) continue;
    for (const [k, v] of Object.entries(expect)) {
      if (k === "type") continue;
      check(`${type}: summary.${k} === ${v}`, res.summary[k] === v, `got ${res.summary[k]}`);
    }
  }

  // ── 5. CSV fidelity spot checks ─────────────────────────────────────────────
  console.log("\n[5] CSV fidelity (no corruption of embedded commas / quotes / newlines)");
  const colsBack = detectAndParseCsvArchive(ex.csv.collections_csv).data.collections;
  check("collection title with a comma survives", colsBack[0].title === "Summer, Sale", colsBack[0].title);
  check("collection description with newline + quotes survives",
    colsBack[0].descriptionHtml === LIVE.collections[0].descriptionHtml,
    JSON.stringify(colsBack[0].descriptionHtml));
  check("smart collection rules survive", colsBack[0].ruleSet?.rules?.[0]?.condition === "summer");
  check("smart collection ANY/ALL match survives", colsBack[0].ruleSet?.appliedDisjunctively === true);
  check("manual collection stays manual (no ruleSet)", colsBack[1].ruleSet === null, JSON.stringify(colsBack[1].ruleSet));

  const pagesBack = detectAndParseCsvArchive(ex.csv.pages_csv).data;
  check("page body with newline survives CSV", pagesBack.pages.find((p) => p.title === "About Us")?.body === LIVE.pages[0].body,
    JSON.stringify(pagesBack.pages.find((p) => p.title === "About Us")?.body));
  check("unpublished page stays unpublished", pagesBack.pages.find((p) => p.title === "Draft Terms")?.isPublished === false);
  check("menu nested items survive pages CSV",
    pagesBack.menus.find((m) => m.title === "Main menu")?.items?.[0]?.items?.[0]?.title === "Nested");
  check("empty menu survives pages CSV as a menu (not a page)",
    pagesBack.menus.some((m) => m.title === "Footer menu"),
    `pages=${JSON.stringify(pagesBack.pages.map((p) => p.title))} menus=${JSON.stringify(pagesBack.menus.map((m) => m.title))}`);

  const menusBack = detectAndParseCsvArchive(ex.csv.menus_csv).data.menus;
  check("standalone menus CSV keeps both menus", menusBack.length === 2, `got ${menusBack.length}`);

  const artsBack = detectAndParseCsvArchive(ex.csv.blogs_csv).data.articles;
  check("article tags survive CSV", JSON.stringify(artsBack[0].tags) === JSON.stringify(["a", "b"]), JSON.stringify(artsBack[0].tags));
  check("unpublished article stays unpublished", artsBack.find((a) => a.title === "Second Post")?.isPublished === false);

  const mfBack = detectAndParseCsvArchive(ex.csv.metafields_csv).data.metafields;
  check("metafields CSV keeps all 3 owners", mfBack.counts.owners === 3, `got ${mfBack.counts.owners}`);
  check("metafields CSV keeps ARTICLE parent handle",
    mfBack.owners.find((o) => o.ownerType === "ARTICLE")?.parentHandle === "news");
  check("metafields CSV value with quotes+comma survives",
    mfBack.owners.find((o) => o.ownerType === "SHOP")?.metafields?.[0]?.value === 'We say "hi", loudly');

  const prodsBack = detectAndParseCsvArchive(ex.csv.products_csv).data.products;
  check("products CSV keeps variant prices", prodsBack[0].variants?.[0]?.price === "19.99", JSON.stringify(prodsBack[0].variants));
  check("products CSV keeps DRAFT status", prodsBack.find((p) => p.title === "Mug")?.status === "DRAFT");
  check("products CSV does not invent variants that never existed",
    prodsBack.find((p) => p.title === "Mug")?.variants?.length === 1,
    `Mug variants=${JSON.stringify(prodsBack.find((p) => p.title === "Mug")?.variants)}`);

  // ── 6. Invalid-file handling ────────────────────────────────────────────────
  console.log("\n[6] Invalid files produce a clear, user-friendly error");
  const bad = [
    ["empty string", ""],
    ["whitespace only", "   \n  "],
    ["truncated JSON", '{"storeAssets": {"products": [ '],
    ["JSON with no assets", '{"storeAssets":{"products":[],"collections":[]}}'],
    ["JSON null", "null"],
    ["random prose", "this is not a backup at all"],
    ["unrelated CSV", "Foo,Bar\r\n1,2"],
    ["CSV headers only", '"Collection ID","Title","Handle"\r\n'],
    ["binary-ish blob", "\u0000\u0001\u0002garbage"],
  ];
  for (const [label, content] of bad) {
    const res = await importFile(admin, content);
    const msg = res.message || "";
    check(`${label}: rejected`, res.success === false, msg);
    check(`${label}: message is non-empty and readable`,
      msg.length > 10 && !/undefined|\[object|Cannot read|TypeError/i.test(msg), msg);
  }

  // ── 7. No duplicate rows on repeat import ───────────────────────────────────
  console.log("\n[7] Repeat import does not duplicate or corrupt persisted data");
  const before = await prisma.restorePoint.count({ where: { shop: SHOP } });
  const again = await importFile(admin, JSON.stringify(ex.json.collections_json));
  const after = await prisma.restorePoint.count({ where: { shop: SHOP } });
  check("re-importing the same file adds exactly one restore point", after - before === 1, `delta=${after - before}`);
  check("re-import summary is identical to the first import", again.summary.collections === 2);

  // ── 8. Live restore mode ────────────────────────────────────────────────────
  console.log("\n[8] RESTORE_NOW mode reports accurate live results");
  const liveRes = await importFile(admin, JSON.stringify(ex.json.full_json), "RESTORE_NOW");
  check("live restore succeeds", liveRes.success, liveRes.message);
  if (liveRes.success) {
    const lr = liveRes.summary.liveResults || {};
    check("live restore reports 2 collections", lr.collections === 2, `got ${lr.collections}`);
    check("live restore reports 2 pages", lr.pages === 2, `got ${lr.pages}`);
    check("live restore reports 2 menus", lr.menus === 2, `got ${lr.menus}`);
    check("live restore reports 2 articles", lr.articles === 2, `got ${lr.articles}`);
    check("live restore message mentions what happened", /restored|synced|staging/.test(liveRes.message), liveRes.message);
  }

  // ── 9. normalizeMetafieldDocument guards ────────────────────────────────────
  console.log("\n[9] Metafield document normalisation");
  check("empty doc normalises to null", normalizeMetafieldDocument({ owners: [], definitions: {} }) === null);
  check("array input normalises to null", normalizeMetafieldDocument([]) === null);
  const normed = normalizeMetafieldDocument(METAFIELD_DOC);
  check("valid doc round trips 3 metafields", normed.counts.metafields === 3, `got ${normed?.counts?.metafields}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await prisma.rollbackResult.deleteMany({ where: { rollbackJob: { shop: SHOP } } }).catch(() => {});
  await prisma.rollbackJob.deleteMany({ where: { shop: SHOP } }).catch(() => {});
  await prisma.restorePoint.deleteMany({ where: { shop: SHOP } });
  await prisma.productSnapshot.deleteMany({ where: { shop: SHOP } }).catch(() => {});
  await prisma.appSettings.deleteMany({ where: { shop: SHOP } }).catch(() => {});

  console.log("\n" + "=".repeat(78));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\n  FAILURES:");
    failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
  }
  console.log("=".repeat(78));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error("HARNESS CRASH:", e);
  await prisma.$disconnect();
  process.exit(2);
});
