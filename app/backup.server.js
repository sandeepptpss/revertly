/**
 * Full Store Backup & Disaster Recovery Service for Revertly
 * Handles Themes, Collections, Pages, and Navigation Menus
 */
import prisma from "./db.server.js";

// ============================================================================
// 1. THEMES BACKUP & RESTORE
// ============================================================================

/**
 * Fetches all themes and backs up the active (MAIN) theme's metadata and critical files.
 */
export async function fetchThemeBackup(admin) {
  try {
    const themeRes = await admin.graphql(
      `#graphql
      query getThemes {
        themes(first: 10) {
          nodes {
            id
            name
            role
            createdAt
            updatedAt
          }
        }
      }`
    );
    const themeJson = await themeRes.json();
    const themes = themeJson.data?.themes?.nodes || [];
    const mainTheme = themes.find((t) => t.role === "MAIN") || themes[0];

    if (!mainTheme) {
      return { themes: [], activeTheme: null, files: [] };
    }

    // Attempt to read critical theme files (settings_data.json, theme.liquid, templates)
    let files = [];
    try {
      const filesRes = await admin.graphql(
        `#graphql
        query getThemeFiles($themeId: ID!) {
          theme(id: $themeId) {
            files(first: 50, filenames: [
              "config/settings_data.json",
              "layout/theme.liquid",
              "templates/index.json",
              "templates/product.json",
              "templates/collection.json",
              "templates/cart.json",
              "templates/page.json",
              "templates/404.json"
            ]) {
              nodes {
                filename
                size
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }`,
        { variables: { themeId: mainTheme.id } }
      );
      const filesJson = await filesRes.json();
      const rawFiles = filesJson.data?.theme?.files?.nodes || [];
      files = rawFiles.map((f) => ({
        filename: f.filename,
        size: f.size,
        content: f.body?.content || "",
      }));
    } catch (fileErr) {
      console.warn("Theme files fetch warning (non-fatal):", fileErr?.message || fileErr);
    }

    return {
      themes,
      activeTheme: {
        id: mainTheme.id,
        name: mainTheme.name,
        role: mainTheme.role,
        updatedAt: mainTheme.updatedAt,
      },
      files,
      backedUpAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("fetchThemeBackup error:", err?.message || err);
    return null;
  }
}

/**
 * Restores theme files and settings to the specified theme via GraphQL
 */
export async function restoreThemeFiles(admin, themeId, files) {
  if (!themeId || !files || files.length === 0) {
    return { success: false, message: "No files to restore or invalid theme ID." };
  }

  try {
    const inputFiles = files
      .filter((f) => f.content)
      .map((f) => ({
        filename: f.filename,
        body: {
          type: "TEXT",
          value: f.content,
        },
      }));

    if (inputFiles.length === 0) {
      return { success: false, message: "No text content found in theme files backup." };
    }

    const res = await admin.graphql(
      `#graphql
      mutation themeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) {
          upsertedThemeFiles {
            filename
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          themeId,
          files: inputFiles,
        },
      }
    );

    const json = await res.json();
    const userErrors = json.data?.themeFilesUpsert?.userErrors || [];
    if (userErrors.length > 0) {
      return {
        success: false,
        message: userErrors.map((e) => `${e.field}: ${e.message}`).join(", "),
      };
    }

    const upserted = json.data?.themeFilesUpsert?.upsertedThemeFiles || [];
    return {
      success: true,
      count: upserted.length,
      files: upserted.map((u) => u.filename),
      message: `Successfully restored ${upserted.length} theme files.`,
    };
  } catch (err) {
    console.error("restoreThemeFiles error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to restore theme files." };
  }
}

/**
 * Computes line-by-line diff between current live content and saved backup content
 * Returns additions, deletions, isIdentical, and formatted diff line objects
 */
export function computeDiffLines(currentContent = "", savedContent = "") {
  const currentLines = (currentContent || "").split("\n");
  const savedLines = (savedContent || "").split("\n");

  if (currentContent === savedContent) {
    return {
      isIdentical: true,
      additions: 0,
      deletions: 0,
      lines: savedLines.slice(0, 80).map((line, i) => ({
        type: "same",
        content: line,
        oldLineNum: i + 1,
        newLineNum: i + 1,
      })),
    };
  }

  const diff = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  const maxLines = 150;

  while (i < currentLines.length || j < savedLines.length) {
    if (diff.length >= maxLines) {
      diff.push({
        type: "info",
        content: `... (${Math.max(currentLines.length - i, savedLines.length - j)} more lines truncated for preview)`,
      });
      break;
    }

    const cur = currentLines[i];
    const sav = savedLines[j];

    if (cur === sav) {
      diff.push({
        type: "same",
        content: cur,
        oldLineNum: i + 1,
        newLineNum: j + 1,
      });
      i++;
      j++;
    } else {
      if (i < currentLines.length && (j >= savedLines.length || !savedLines.slice(j, j + 4).includes(cur))) {
        diff.push({
          type: "removed",
          content: cur,
          oldLineNum: i + 1,
          newLineNum: null,
        });
        deletions++;
        i++;
      } else if (j < savedLines.length) {
        diff.push({
          type: "added",
          content: sav,
          oldLineNum: null,
          newLineNum: j + 1,
        });
        additions++;
        j++;
      } else {
        break;
      }
    }
  }

  return {
    isIdentical: additions === 0 && deletions === 0,
    additions,
    deletions,
    lines: diff,
  };
}

/**
 * Creates a duplicate UNPUBLISHED draft theme for staging/preview
 */
export async function createDraftStagingTheme(admin, shop, baseName, files) {
  try {
    const timestamp = new Date().toLocaleDateString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const draftName = `${baseName || "Theme"} [Revertly Staging - ${timestamp}]`;

    // Try GraphQL themeCreate
    let createdTheme = null;
    try {
      const res = await admin.graphql(
        `#graphql
        mutation themeCreate($name: String!, $role: ThemeRole) {
          themeCreate(name: $name, role: $role) {
            theme {
              id
              name
              role
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            name: draftName,
            role: "UNPUBLISHED",
          },
        }
      );
      const json = await res.json();
      if (!json.data?.themeCreate?.userErrors?.length) {
        createdTheme = json.data?.themeCreate?.theme;
      }
    } catch (gErr) {
      console.warn("GraphQL themeCreate attempt failed, trying alternate format:", gErr?.message || gErr);
    }

    // Fallback format if needed
    if (!createdTheme) {
      const res = await admin.graphql(
        `#graphql
        mutation themeCreate($input: ThemeInput!) {
          themeCreate(input: $input) {
            theme {
              id
              name
              role
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              name: draftName,
              role: "UNPUBLISHED",
            },
          },
        }
      );
      const json = await res.json();
      createdTheme = json.data?.themeCreate?.theme;
    }

    if (!createdTheme?.id) {
      return { success: false, message: "Could not create draft staging theme in Shopify." };
    }

    // Push backup files into the draft staging theme
    const fileRes = await restoreThemeFiles(admin, createdTheme.id, files);
    const numericId = createdTheme.id.split("/").pop();
    const cleanShop = shop.replace(/^https?:\/\//, "").replace(/\/$/, "");

    return {
      success: true,
      isDraft: true,
      draftThemeId: createdTheme.id,
      draftThemeName: createdTheme.name,
      previewUrl: `https://${cleanShop}?preview_theme_id=${numericId}`,
      editorUrl: `https://${cleanShop}/admin/themes/${numericId}/editor`,
      filesRestored: fileRes.count || 0,
      message: `Draft staging theme "${createdTheme.name}" created with ${fileRes.count || 0} files.`,
    };
  } catch (err) {
    console.error("createDraftStagingTheme error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to create draft theme." };
  }
}

/**
 * Advanced Theme Rollback with Pre-Rollback Safety Snapshot & Selective Filename Filtering
 */
export async function restoreThemeFilesWithSafety({
  admin,
  shop,
  themeId,
  themeName,
  files,
  selectedFilenames = null,
  mode = "live",
}) {
  // 1. Filter files if selective list provided
  const targetFiles =
    selectedFilenames && selectedFilenames.length > 0
      ? files.filter((f) => selectedFilenames.includes(f.filename))
      : files;

  if (!targetFiles || targetFiles.length === 0) {
    return { success: false, message: "No files selected to restore." };
  }

  // 2. If DRAFT mode: create staging theme and preview link
  if (mode === "draft") {
    return await createDraftStagingTheme(admin, shop, themeName, targetFiles);
  }

  // 3. If LIVE mode: take pre-rollback safety snapshot first!
  let safetyRpId = null;
  try {
    const currentThemeData = await fetchThemeBackup(admin);
    if (currentThemeData?.activeTheme) {
      const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const safetyPoint = await prisma.restorePoint.create({
        data: {
          shop,
          name: `Pre-Rollback Safety Snapshot (${timeStr})`,
          description: `Auto-saved before restoring ${targetFiles.length} files to ${themeName || "Live Theme"}. Click Restore on this snapshot to undo if needed.`,
          status: "READY",
          backupType: "THEMES",
          themeCount: 1,
          themeData: currentThemeData,
        },
      });
      safetyRpId = safetyPoint.id;
    }
  } catch (snapErr) {
    console.warn("Pre-rollback safety snapshot warning (proceeding with restore):", snapErr?.message || snapErr);
  }

  // 4. Perform live restore
  const restoreRes = await restoreThemeFiles(admin, themeId, targetFiles);
  if (restoreRes.success) {
    restoreRes.isLive = true;
    restoreRes.safetyRpId = safetyRpId;
    restoreRes.message = safetyRpId
      ? `${restoreRes.message} (Safety snapshot #${safetyRpId} auto-created for 1-click Undo).`
      : restoreRes.message;
  }
  return restoreRes;
}

// ============================================================================
// 2. COLLECTIONS BACKUP & RESTORE
// ============================================================================

/**
 * Fetches collections (smart & custom) along with ruleSet conditions
 */
export async function fetchCollectionsBackup(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query getCollections {
        collections(first: 100) {
          nodes {
            id
            title
            handle
            descriptionHtml
            sortOrder
            ruleSet {
              appliedDisjunctively
              rules {
                column
                relation
                condition
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    return json.data?.collections?.nodes || [];
  } catch (err) {
    console.error("fetchCollectionsBackup error:", err?.message || err);
    return [];
  }
}

/**
 * Restores or recreates a collection from snapshot
 */
export async function restoreCollection(admin, col) {
  try {
    const input = {
      title: col.title,
      handle: col.handle,
      descriptionHtml: col.descriptionHtml || "",
      sortOrder: col.sortOrder || "BEST_SELLING",
    };

    if (col.ruleSet && col.ruleSet.rules?.length > 0) {
      input.ruleSet = {
        appliedDisjunctively: col.ruleSet.appliedDisjunctively || false,
        rules: col.ruleSet.rules.map((r) => ({
          column: r.column,
          relation: r.relation,
          condition: r.condition,
        })),
      };
    }

    const res = await admin.graphql(
      `#graphql
      mutation collectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { input } }
    );

    const json = await res.json();
    const userErrors = json.data?.collectionCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return { success: false, message: userErrors.map((e) => e.message).join(", ") };
    }
    return { success: true, collection: json.data?.collectionCreate?.collection };
  } catch (err) {
    console.error("restoreCollection error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to restore collection." };
  }
}

// ============================================================================
// 3. PAGES BACKUP & RESTORE
// ============================================================================

/**
 * Fetches content pages (About, Contact, Policies, Landing Pages)
 */
export async function fetchPagesBackup(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query getPages {
        pages(first: 50) {
          nodes {
            id
            title
            handle
            body
            isPublished
          }
        }
      }`
    );
    const json = await res.json();
    return json.data?.pages?.nodes || [];
  } catch (err) {
    console.warn("fetchPagesBackup warning (check scopes):", err?.message || err);
    return [];
  }
}

/**
 * Restores/recreates a deleted content page
 */
export async function restorePage(admin, p) {
  try {
    const res = await admin.graphql(
      `#graphql
      mutation pageCreate($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          page: {
            title: p.title,
            handle: p.handle,
            body: p.body || "",
            isPublished: p.isPublished ?? true,
          },
        },
      }
    );
    const json = await res.json();
    const userErrors = json.data?.pageCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return { success: false, message: userErrors.map((e) => e.message).join(", ") };
    }
    return { success: true, page: json.data?.pageCreate?.page };
  } catch (err) {
    console.error("restorePage error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to restore page." };
  }
}

// ============================================================================
// 4. NAVIGATION MENUS BACKUP & RESTORE
// ============================================================================

/**
 * Fetches navigation linklists (Header, Footer menus)
 */
export async function fetchMenusBackup(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query getMenus {
        menus(first: 25) {
          nodes {
            id
            title
            handle
            items {
              id
              title
              url
              type
              items {
                id
                title
                url
                type
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    return json.data?.menus?.nodes || [];
  } catch (err) {
    console.warn("fetchMenusBackup warning (check scopes):", err?.message || err);
    return [];
  }
}

// ============================================================================
// 5. UNIFIED MULTI-RESOURCE RESTORE POINT CREATION
// ============================================================================

/**
 * Orchestrates a complete store backup snapshot (Products, Themes, Collections, Pages, Menus)
 * without blocking or breaking existing product flows.
 */
export async function createMultiResourceRestorePoint({
  admin,
  shop,
  name,
  description = "",
  options = {
    includeProducts: true,
    includeThemes: true,
    includeCollections: true,
    includePages: true,
    includeMenus: true,
  },
}) {
  // 1. Create the pending restore point
  const rp = await prisma.restorePoint.create({
    data: {
      shop,
      name,
      description,
      status: "CREATING",
      backupType: "FULL",
    },
  });

  try {
    // 2. Concurrently fetch all requested resources using Promise.allSettled
    const tasks = [];

    // Task 0: Products (from local snapshot baseline)
    if (options.includeProducts) {
      tasks.push(
        prisma.productSnapshot.findMany({
          where: { shop },
          select: { productId: true, snapshotData: true, title: true },
        })
      );
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 1: Theme & Assets
    if (options.includeThemes) {
      tasks.push(fetchThemeBackup(admin));
    } else {
      tasks.push(Promise.resolve(null));
    }

    // Task 2: Collections
    if (options.includeCollections) {
      tasks.push(fetchCollectionsBackup(admin));
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 3: Pages
    if (options.includePages) {
      tasks.push(fetchPagesBackup(admin));
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 4: Navigation Menus
    if (options.includeMenus) {
      tasks.push(fetchMenusBackup(admin));
    } else {
      tasks.push(Promise.resolve([]));
    }

    const [prodRes, themeRes, colRes, pageRes, menuRes] = await Promise.allSettled(tasks);

    const products = prodRes.status === "fulfilled" ? prodRes.value : [];
    const themeData = themeRes.status === "fulfilled" ? themeRes.value : null;
    const collections = colRes.status === "fulfilled" ? colRes.value : [];
    const pages = pageRes.status === "fulfilled" ? pageRes.value : [];
    const menus = menuRes.status === "fulfilled" ? menuRes.value : [];

    const themeCount = themeData?.activeTheme ? 1 : 0;
    const collectionCount = Array.isArray(collections) ? collections.length : 0;
    const pageCount = Array.isArray(pages) ? pages.length : 0;
    const menuCount = Array.isArray(menus) ? menus.length : 0;

    // Determine primary backup type
    let backupType = "FULL";
    if (options.includeThemes && !options.includeProducts) backupType = "THEMES";
    else if (options.includeCollections && !options.includeProducts) backupType = "COLLECTIONS";
    else if (options.includeProducts && !options.includeThemes && !options.includeCollections) backupType = "PRODUCTS";

    // 3. Update RestorePoint to READY status
    const updated = await prisma.restorePoint.update({
      where: { id: rp.id },
      data: {
        status: "READY",
        backupType,
        productCount: products.length,
        themeCount,
        collectionCount,
        pageCount,
        menuCount,
        snapshotData: products,
        themeData: themeData || undefined,
        collectionData: collections.length > 0 ? collections : undefined,
        pageData: pages.length > 0 ? pages : undefined,
        menuData: menus.length > 0 ? menus : undefined,
      },
    });

    return {
      success: true,
      restorePoint: updated,
      summary: {
        products: products.length,
        themes: themeCount,
        collections: collectionCount,
        pages: pageCount,
        menus: menuCount,
      },
    };
  } catch (err) {
    console.error("createMultiResourceRestorePoint error:", err?.message || err);
    await prisma.restorePoint.update({
      where: { id: rp.id },
      data: { status: "FAILED" },
    });
    return { success: false, message: err?.message || "Failed to create restore point." };
  }
}
