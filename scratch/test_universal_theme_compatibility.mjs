/**
 * Revertly Universal Theme Compatibility Test Suite
 *
 * Verifies compatibility across:
 * 1. Online Store 2.0 (Dawn, Sense, Craft) with JSON templates
 * 2. Shopify Horizon (Theme blocks in blocks/*.liquid, section groups, metaobject templates)
 * 3. Vintage Themes (templates/*.liquid, legacy layout)
 * 4. Cursor Pagination (Large theme with >300 files without data drop)
 * 5. Batching & Chunking (Restoring >100 files in batches <=35 files, below Shopify's 50-file limit)
 * 6. Base64 & Binary Assets (SVG icons, web fonts)
 * 7. Draft Staging Sandbox & 20-theme Quota Guidance
 * 8. Comprehensive Fallback Query Resiliency
 */

import assert from "assert";
import {
  fetchThemeBackup,
  restoreThemeFiles,
  restoreThemeFilesWithSafety,
  createDraftStagingTheme,
  computeDiffLines,
} from "../app/backup.server.js";

const TEST_SHOP = "theme-compat-test.myshopify.com";

// ── Mock Themes ──
const MOCK_OS20_THEME = {
  id: "gid://shopify/Theme/2001",
  name: "Dawn (OS 2.0)",
  role: "MAIN",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
};

const MOCK_HORIZON_THEME = {
  id: "gid://shopify/Theme/2002",
  name: "Horizon Core (Modern Blocks)",
  role: "UNPUBLISHED",
  createdAt: "2025-06-01T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
};

const MOCK_VINTAGE_THEME = {
  id: "gid://shopify/Theme/2003",
  name: "Debut (Vintage Liquid)",
  role: "UNPUBLISHED",
  createdAt: "2020-05-01T00:00:00Z",
  updatedAt: "2021-01-01T00:00:00Z",
};

let testsPassed = 0;
let totalTests = 0;

function step(id, description, condition, details = "") {
  totalTests++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ [${id}] ${description}`);
  } else {
    console.error(`  ❌ [${id}] FAILED: ${description}`);
    if (details) console.error(`     Details: ${details}`);
    process.exitCode = 1;
  }
}

async function runThemeCompatibilityTests() {
  console.log("===============================================================");
  console.log("🚀 STARTING UNIVERSAL SHOPIFY THEME COMPATIBILITY TEST SUITE");
  console.log("   (OS 2.0, Horizon, Vintage, Pagination, Batching, Base64)");
  console.log("===============================================================\n");

  // ─────────────────────────────────────────────────────────────
  // SUITE 1: ONLINE STORE 2.0 THEME CAPTURE & RESTORE (DAWN)
  // ─────────────────────────────────────────────────────────────
  console.log("▶ [SUITE 1] Online Store 2.0 Theme Architecture (Dawn / Sense)");

  const os20Files = [
    { filename: "config/settings_data.json", content: JSON.stringify({ current: { colors_accent_1: "#121212" } }) },
    { filename: "layout/theme.liquid", content: "<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>" },
    { filename: "templates/index.json", content: JSON.stringify({ sections: { image_banner: { type: "image-banner" } }, order: ["image_banner"] }) },
    { filename: "templates/product.json", content: JSON.stringify({ sections: { main: { type: "main-product" } }, order: ["main"] }) },
    { filename: "templates/collection.json", content: JSON.stringify({ sections: { main: { type: "main-collection" } }, order: ["main"] }) },
    { filename: "sections/header-group.json", content: JSON.stringify({ type: "header", name: "Header Group", sections: {} }) },
    { filename: "sections/footer-group.json", content: JSON.stringify({ type: "footer", name: "Footer Group", sections: {} }) },
    { filename: "sections/main-product.liquid", content: "<div class=\"product\">{{ product.title }}</div>" },
  ];

  const adminOs20Mock = {
    graphql: async (query, vars = {}) => {
      if (query.includes("getThemes")) {
        return {
          json: async () => ({
            data: { themes: { nodes: [MOCK_OS20_THEME, MOCK_HORIZON_THEME, MOCK_VINTAGE_THEME] } },
          }),
        };
      }
      if (query.includes("getAllThemeFiles")) {
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: os20Files.map((f) => ({
                    filename: f.filename,
                    size: f.content.length,
                    body: { content: f.content },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const os20Backup = await fetchThemeBackup(adminOs20Mock, MOCK_OS20_THEME.id);
  step("1.1", "OS 2.0 active theme identified as Dawn", os20Backup?.activeTheme?.name === "Dawn (OS 2.0)");
  step("1.2", "OS 2.0 captured all JSON templates and section groups", os20Backup?.files?.length === os20Files.length);
  const indexJsonFile = os20Backup?.files?.find((f) => f.filename === "templates/index.json");
  step("1.3", "templates/index.json parsed with valid JSON content", indexJsonFile && indexJsonFile.content.includes("image-banner"));
  const headerGroup = os20Backup?.files?.find((f) => f.filename === "sections/header-group.json");
  step("1.4", "Section groups (header-group.json) preserved intact", headerGroup && headerGroup.content.includes("Header Group"));

  // ─────────────────────────────────────────────────────────────
  // SUITE 2: SHOPIFY HORIZON THEME ARCHITECTURE (2024-2026+)
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 2] Shopify Horizon Architecture (Blocks, Metaobjects, Web Components)");

  const horizonFiles = [
    { filename: "config/settings_data.json", content: JSON.stringify({ current: { typography: "Assistant" } }) },
    { filename: "layout/theme.liquid", content: "<!doctype html><html><body>{{ content_for_layout }}</body></html>" },
    { filename: "blocks/product-title.liquid", content: "<h1 class=\"product-title\">{{ product.title }}</h1>" },
    { filename: "blocks/accordion-item.liquid", content: "<details class=\"horizon-accordion\"><summary>{{ block.settings.heading }}</summary></details>" },
    { filename: "sections/overlay-group.json", content: JSON.stringify({ type: "overlay", sections: { popup: { type: "newsletter-popup" } } }) },
    { filename: "templates/metaobject/lookbook.json", content: JSON.stringify({ sections: { main: { type: "lookbook-grid" } } }) },
    { filename: "assets/horizon-theme.css", content: ":root { --rv-brand: #008060; }" },
  ];

  const adminHorizonMock = {
    graphql: async (query) => {
      if (query.includes("getThemes")) {
        return {
          json: async () => ({
            data: { themes: { nodes: [MOCK_HORIZON_THEME] } },
          }),
        };
      }
      if (query.includes("getAllThemeFiles")) {
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: horizonFiles.map((f) => ({
                    filename: f.filename,
                    size: f.content.length,
                    body: { content: f.content },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const horizonBackup = await fetchThemeBackup(adminHorizonMock, MOCK_HORIZON_THEME.id);
  step("2.1", "Horizon theme backed up with modern block structure", horizonBackup?.activeTheme?.name.includes("Horizon"));
  const blockTitle = horizonBackup?.files?.find((f) => f.filename === "blocks/product-title.liquid");
  step("2.2", "Horizon theme blocks (blocks/*.liquid) captured successfully", Boolean(blockTitle && blockTitle.content.includes("product-title")));
  const metaobjectTpl = horizonBackup?.files?.find((f) => f.filename === "templates/metaobject/lookbook.json");
  step("2.3", "Metaobject template (templates/metaobject/*.json) captured", Boolean(metaobjectTpl && metaobjectTpl.content.includes("lookbook-grid")));

  // ─────────────────────────────────────────────────────────────
  // SUITE 3: VINTAGE LIQUID THEMES (DEBUT, BROOKLYN)
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 3] Vintage Themes (pre-OS 2.0 Liquid Templates)");

  const vintageFiles = [
    { filename: "config/settings_data.json", content: JSON.stringify({ current: {} }) },
    { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
    { filename: "templates/index.liquid", content: "{% section 'hero' %}{% section 'featured-products' %}" },
    { filename: "templates/product.liquid", content: "{% section 'product-template' %}" },
    { filename: "templates/collection.liquid", content: "{% section 'collection-template' %}" },
    { filename: "snippets/social-sharing.liquid", content: "<div class=\"social-sharing\"></div>" },
  ];

  const adminVintageMock = {
    graphql: async (query) => {
      if (query.includes("getThemes")) {
        return { json: async () => ({ data: { themes: { nodes: [MOCK_VINTAGE_THEME] } } }) };
      }
      if (query.includes("getAllThemeFiles")) {
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: vintageFiles.map((f) => ({
                    filename: f.filename,
                    size: f.content.length,
                    body: { content: f.content },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const vintageBackup = await fetchThemeBackup(adminVintageMock, MOCK_VINTAGE_THEME.id);
  step("3.1", "Vintage theme backed up with liquid templates", vintageBackup?.activeTheme?.name.includes("Debut"));
  const productLiquid = vintageBackup?.files?.find((f) => f.filename === "templates/product.liquid");
  step("3.2", "templates/product.liquid vintage template preserved", Boolean(productLiquid && productLiquid.content.includes("product-template")));

  // ─────────────────────────────────────────────────────────────
  // SUITE 4: CURSOR PAGINATION (>300 THEME FILES)
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 4] Cursor-Based Pagination for Large Commercial Themes (320 files)");

  // Generate 320 simulated theme files across 2 pages (250 on page 1, 70 on page 2)
  const all320Files = [];
  for (let i = 1; i <= 320; i++) {
    all320Files.push({
      filename: `snippets/widget-${String(i).padStart(3, "0")}.liquid`,
      size: 150,
      body: { content: `<!-- Widget #${i} -->` },
    });
  }

  let paginationCalls = 0;
  const adminPaginationMock = {
    graphql: async (query, vars = {}) => {
      if (query.includes("getThemes")) {
        return { json: async () => ({ data: { themes: { nodes: [MOCK_OS20_THEME] } } }) };
      }
      if (query.includes("getAllThemeFiles")) {
        paginationCalls++;
        const cursor = vars?.variables?.cursor || vars?.cursor;
        if (!cursor) {
          // Page 1: 0 to 250
          return {
            json: async () => ({
              data: {
                theme: {
                  files: {
                    nodes: all320Files.slice(0, 250),
                    pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
                  },
                },
              },
            }),
          };
        } else if (cursor === "cursor-page-2") {
          // Page 2: 250 to 320
          return {
            json: async () => ({
              data: {
                theme: {
                  files: {
                    nodes: all320Files.slice(250),
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          };
        }
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const paginatedBackup = await fetchThemeBackup(adminPaginationMock, MOCK_OS20_THEME.id);
  step("4.1", "Pagination loop made exactly 2 cursor queries", paginationCalls === 2);
  step("4.2", "Captured 100% of 320 theme files without dropping files 251-320", paginatedBackup?.files?.length === 320);
  const lastFile = paginatedBackup?.files?.find((f) => f.filename === "snippets/widget-320.liquid");
  step("4.3", "File #320 accurately retrieved from second page", Boolean(lastFile && lastFile.content.includes("Widget #320")));

  // ─────────────────────────────────────────────────────────────
  // SUITE 5: BATCHED RESTORATION (SHOPIFY 50-FILE LIMIT PROTECTION)
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 5] Batched Theme Restoration (Shopify <=50 mutation limit protection)");

  const filesToRestore = [];
  for (let i = 1; i <= 100; i++) {
    filesToRestore.push({
      filename: `templates/page.custom-${i}.json`,
      content: JSON.stringify({ sections: { hero: { type: "hero" } } }),
    });
  }

  const batchSizesSeen = [];
  const adminBatchRestoreMock = {
    graphql: async (query, vars = {}) => {
      if (query.includes("themeFilesUpsert")) {
        const batchFiles = vars?.variables?.files || vars?.files || [];
        batchSizesSeen.push(batchFiles.length);

        // Assert strictly that batch size NEVER exceeds Shopify's 50-file limit
        if (batchFiles.length > 50) {
          throw new Error(`Shopify API violation: Attempted to upsert ${batchFiles.length} files in a single mutation! Maximum allowed is 50.`);
        }

        return {
          json: async () => ({
            data: {
              themeFilesUpsert: {
                upsertedThemeFiles: batchFiles.map((f) => ({ filename: f.filename })),
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const restoreResult = await restoreThemeFiles(adminBatchRestoreMock, "gid://shopify/Theme/2001", filesToRestore);
  step("5.1", "100 files restored successfully", restoreResult.success && restoreResult.count === 100);
  step("5.2", "All batches stayed strictly <= 50 files", batchSizesSeen.every((sz) => sz <= 50));
  step("5.3", "Batches chunked cleanly (expected ~35 per batch): " + batchSizesSeen.join(", "), batchSizesSeen.length === 3);

  // ─────────────────────────────────────────────────────────────
  // SUITE 6: BASE64 ASSETS (SVG ICONS & WEB FONTS)
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 6] Base64 & Binary Asset Preservation (SVG Icons, Fonts)");

  const svgBase64 = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><circle r='10'/></svg>").toString("base64");
  const base64ThemeFiles = [
    {
      filename: "assets/icon-cart.svg",
      size: 120,
      body: { encodedContent: svgBase64 }, // Base64 fragment
    },
    {
      filename: "templates/index.json",
      size: 50,
      body: { content: "{}" }, // Standard text fragment
    },
  ];

  const adminBase64Mock = {
    graphql: async (query) => {
      if (query.includes("getThemes")) {
        return { json: async () => ({ data: { themes: { nodes: [MOCK_OS20_THEME] } } }) };
      }
      if (query.includes("getAllThemeFiles")) {
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: base64ThemeFiles,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const base64Backup = await fetchThemeBackup(adminBase64Mock, MOCK_OS20_THEME.id);
  const svgFile = base64Backup?.files?.find((f) => f.filename === "assets/icon-cart.svg");
  step("6.1", "Base64 SVG asset captured with bodyType: BASE64", svgFile && svgFile.bodyType === "BASE64");
  step("6.2", "Base64 content preserved exactly", svgFile && svgFile.content === svgBase64);

  // Verify that restoreThemeFiles passes type: "BASE64" for binary assets
  let restoredBodyType = null;
  const adminVerifyBase64Restore = {
    graphql: async (query, vars = {}) => {
      if (query.includes("themeFilesUpsert")) {
        const batchFiles = vars?.variables?.files || vars?.files || [];
        restoredBodyType = batchFiles[0]?.body?.type;
        return {
          json: async () => ({
            data: {
              themeFilesUpsert: {
                upsertedThemeFiles: [{ filename: "assets/icon-cart.svg" }],
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  await restoreThemeFiles(adminVerifyBase64Restore, "gid://shopify/Theme/2001", [svgFile]);
  step("6.3", "themeFilesUpsert correctly transmits body.type: BASE64", restoredBodyType === "BASE64");

  // ─────────────────────────────────────────────────────────────
  // SUITE 7: DRAFT THEME QUOTA HANDLING (20 THEMES CEILING)
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 7] Draft Staging Sandbox & 20-Theme Quota Protection");

  // 7.1 Successful draft creation
  const adminDraftSuccessMock = {
    graphql: async (query, vars = {}) => {
      if (query.includes("themeCreate")) {
        return {
          json: async () => ({
            data: {
              themeCreate: {
                theme: { id: "gid://shopify/Theme/99999", name: vars.name || "Draft Staging" },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("themeFilesUpsert")) {
        return {
          json: async () => ({
            data: { themeFilesUpsert: { upsertedThemeFiles: [{ filename: "layout/theme.liquid" }], userErrors: [] } },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const draftSuccess = await createDraftStagingTheme(adminDraftSuccessMock, TEST_SHOP, "Test Theme", [{ filename: "layout/theme.liquid", content: "{}" }]);
  step("7.1", "Draft theme staging created with preview & editor URLs", draftSuccess.success && draftSuccess.previewUrl.includes("preview_theme_id=99999"));

  // 7.2 Store has reached Shopify's 20-theme ceiling
  const adminDraftLimitMock = {
    graphql: async (query) => {
      if (query.includes("themeCreate")) {
        return {
          json: async () => ({
            data: {
              themeCreate: {
                theme: null,
                userErrors: [{ field: "base", message: "You have reached the maximum number of themes for this shop (20)." }],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const draftLimitResult = await createDraftStagingTheme(adminDraftLimitMock, TEST_SHOP, "Test Theme", [{ filename: "layout/theme.liquid", content: "{}" }]);
  step("7.2", "20-theme limit detected and returned as graceful guidance", !draftLimitResult.success && draftLimitResult.message.includes("Shopify theme library limit reached (maximum 20 themes)"));

  // ─────────────────────────────────────────────────────────────
  // SUITE 8: FALLBACK RESILIENCY WHEN WILDCARD FILES QUERY IS EMPTY
  // ─────────────────────────────────────────────────────────────
  console.log("\n▶ [SUITE 8] Fallback Query Resiliency for Restrictive API Environments");

  let fallbackFilenamesQueried = [];
  const adminFallbackMock = {
    graphql: async (query, vars = {}) => {
      if (query.includes("getThemes")) {
        return { json: async () => ({ data: { themes: { nodes: [MOCK_OS20_THEME] } } }) };
      }
      if (query.includes("getAllThemeFiles")) {
        // Return 0 files on wildcard to trigger fallback
        return { json: async () => ({ data: { theme: { files: { nodes: [] } } } }) };
      }
      if (query.includes("getThemeFiles")) {
        fallbackFilenamesQueried = vars?.variables?.filenames || vars?.filenames || [];
        return {
          json: async () => ({
            data: {
              theme: {
                files: {
                  nodes: [
                    { filename: "config/settings_data.json", size: 100, body: { content: "{}" } },
                    { filename: "sections/header-group.json", size: 200, body: { content: "{}" } },
                    { filename: "templates/product.json", size: 300, body: { content: "{}" } },
                    { filename: "templates/product.liquid", size: 400, body: { content: "{% layout %}" } },
                    { filename: "blocks/product-title.liquid", size: 150, body: { content: "<h1></h1>" } },
                  ],
                },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };

  const fallbackBackup = await fetchThemeBackup(adminFallbackMock, MOCK_OS20_THEME.id);
  step("8.1", "Fallback query triggered when wildcard returns empty", fallbackBackup?.files?.length === 5);
  step("8.2", "Fallback catalog requests Horizon section groups", fallbackFilenamesQueried.includes("sections/header-group.json"));
  step("8.3", "Fallback catalog requests Horizon blocks", fallbackFilenamesQueried.includes("blocks/product-title.liquid"));
  step("8.4", "Fallback catalog requests vintage templates", fallbackFilenamesQueried.includes("templates/product.liquid"));

  console.log("\n===============================================================");
  console.log(`🎉 UNIVERSAL THEME COMPATIBILITY SUMMARY: ${testsPassed} / ${totalTests} PASSED (100%)`);
  console.log("===============================================================");

  if (testsPassed !== totalTests) {
    process.exit(1);
  }
}

runThemeCompatibilityTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
