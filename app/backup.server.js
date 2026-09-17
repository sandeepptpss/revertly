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
export async function fetchThemeBackup(admin, targetThemeId = null) {
  try {
    const themeRes = await admin.graphql(
      `#graphql
      query getThemes {
        themes(first: 25) {
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

    let mainTheme = null;
    if (targetThemeId) {
      mainTheme = themes.find((t) => t.id === targetThemeId || t.id.endsWith(`/${targetThemeId}`) || t.id === `gid://shopify/Theme/${targetThemeId}`);
    }
    if (!mainTheme) {
      mainTheme = themes.find((t) => t.role === "MAIN") || themes[0];
    }

    if (!mainTheme) {
      return { themes: [], activeTheme: null, files: [] };
    }

    // Attempt to read comprehensive theme files (all templates, liquid files, config)
    let files = [];
    try {
      let filesRes = await admin.graphql(
        `#graphql
        query getAllThemeFiles($themeId: ID!) {
          theme(id: $themeId) {
            files(first: 250) {
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
      let filesJson = await filesRes.json();
      let rawFiles = filesJson.data?.theme?.files?.nodes || [];

      if (rawFiles.length === 0) {
        filesRes = await admin.graphql(
          `#graphql
          query getThemeFiles($themeId: ID!) {
            theme(id: $themeId) {
              files(first: 100, filenames: [
                "config/settings_data.json",
                "layout/theme.liquid",
                "templates/index.json",
                "templates/product.json",
                "templates/collection.json",
                "templates/cart.json",
                "templates/page.json",
                "templates/blog.json",
                "templates/article.json",
                "templates/404.json",
                "sections/header.liquid",
                "sections/footer.liquid",
                "sections/main-product.liquid"
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
        filesJson = await filesRes.json();
        rawFiles = filesJson.data?.theme?.files?.nodes || [];
      }

      files = rawFiles.map((f) => ({
        filename: f.filename,
        size: f.size || (f.body?.content ? f.body.content.length : 0),
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
 * Calculates store storage telemetry across all restore points, vault orders, and archives
 */
export async function calculateStoreStorageUsage(shop) {
  try {
    const [rps, ordersCount, customersCount] = await Promise.all([
      prisma.restorePoint.findMany({
        where: { shop },
        select: {
          id: true,
          productCount: true,
          themeCount: true,
          snapshotData: true,
          themeData: true,
          collectionData: true,
          pageData: true,
          articleData: true,
          menuData: true,
          orderData: true,
          customerData: true,
        },
      }),
      prisma.orderArchive.count({ where: { shop } }),
      prisma.customerArchive.count({ where: { shop } }),
    ]);

    // Count every payload column, not just a subset, or the reported figure
    // understates real usage for full-store backups.
    const PAYLOAD_FIELDS = [
      "snapshotData",
      "themeData",
      "collectionData",
      "pageData",
      "articleData",
      "menuData",
      "orderData",
      "customerData",
    ];

    let estimatedBytes = 0;
    for (const rp of rps) {
      for (const field of PAYLOAD_FIELDS) {
        if (rp[field]) estimatedBytes += JSON.stringify(rp[field]).length;
      }
    }

    // Add estimated 2KB per vaulted order and 1KB per customer
    estimatedBytes += ordersCount * 2048;
    estimatedBytes += customersCount * 1024;

    const mb = estimatedBytes / (1024 * 1024);
    const formattedSize = mb >= 1024
      ? `${(mb / 1024).toFixed(2)} GB`
      : `${Math.max(0.1, mb).toFixed(2)} MB`;

    return {
      totalBytes: estimatedBytes,
      formattedSize,
      totalRestorePoints: rps.length,
      totalVaultRecords: ordersCount + customersCount,
      isUnlimited: true,
      storageTier: "Unlimited File Storage (Enterprise Encrypted)",
    };
  } catch (err) {
    return {
      totalBytes: 0,
      formattedSize: "0.0 MB",
      totalRestorePoints: 0,
      totalVaultRecords: 0,
      isUnlimited: true,
      storageTier: "Unlimited File Storage",
    };
  }
}

/**
 * Enforces backup retention policy based on plan limits.
 * Prunes RestorePoints and ChangeEvents older than the plan's retention window.
 * Enterprise = 365 days, Business = 180 days, Growth = 90 days, etc.
 */
export async function enforceBackupRetentionPolicy(shop) {
  const { getEffectiveLimits } = await import("./billing.server.js");
  // Entitlement, not the stored plan: a promotional Growth seat must get the
  // 90-day window it is promised, or this would prune its history at 7 days.
  const limits = await getEffectiveLimits(shop);
  const retentionDays = limits.retentionDays || 7;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Prune expired restore points (keep at least the latest 2 regardless)
  const expiredRps = await prisma.restorePoint.findMany({
    where: {
      shop,
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const totalRps = await prisma.restorePoint.count({ where: { shop } });
  const safeToDeleteCount = Math.max(0, totalRps - 2);
  const rpIdsToDelete = expiredRps.slice(0, safeToDeleteCount).map((rp) => rp.id);

  let deletedRps = 0;
  if (rpIdsToDelete.length > 0) {
    // Delete related rollback results and jobs first
    await prisma.rollbackResult.deleteMany({
      where: { rollbackJob: { restorePointId: { in: rpIdsToDelete } } },
    });
    await prisma.rollbackJob.deleteMany({
      where: { restorePointId: { in: rpIdsToDelete } },
    });
    const del = await prisma.restorePoint.deleteMany({
      where: { id: { in: rpIdsToDelete } },
    });
    deletedRps = del.count;
  }

  // Prune expired change events
  const delEvents = await prisma.changeEvent.deleteMany({
    where: { shop, changedAt: { lt: cutoff } },
  });

  return {
    retentionDays,
    cutoffDate: cutoff.toISOString(),
    deletedRestorePoints: deletedRps,
    deletedChangeEvents: delEvents.count,
  };
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
// 1B. LIVE PRODUCTS BACKUP & CATALOG SYNC
// ============================================================================

/**
 * Fetches live products, variants, pricing, inventory, and metafields directly from Shopify Admin.
 * If shop is provided, updates productSnapshot baseline table automatically.
 */
export async function fetchLiveProductsBackup(admin, shop = null) {
  try {
    const allProducts = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const query = `#graphql
        query getProductsForBackup($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              status
              vendor
              productType
              tags
              handle
              bodyHtml
              templateSuffix
              publishedAt
              images(first: 20) {
                nodes {
                  id
                  url
                  altText
                }
              }
              metafields(first: 50) {
                nodes { id namespace key value type }
              }
              variants(first: 100) {
                nodes {
                  id title price compareAtPrice sku inventoryQuantity barcode
                }
              }
            }
          }
        }`;

      const resp = await admin.graphql(query, { variables: { cursor } });
      const json = await resp.json();
      const productsData = json.data?.products;
      if (!productsData) break;

      const items = productsData.nodes || [];
      for (const p of items) {
        const numericId = String(p.id).replace("gid://shopify/Product/", "");
        const rawVariants = p.variants?.nodes || [];
        const rawMetafields = p.metafields?.nodes || [];
        const rawImages = (p.images?.nodes || []).map((img) => ({
          id: img.id,
          url: img.url,
          altText: img.altText || "",
        }));
        const snap = {
          id: p.id,
          title: p.title,
          status: p.status,
          vendor: p.vendor,
          productType: p.productType,
          tags: p.tags,
          handle: p.handle,
          bodyHtml: p.bodyHtml,
          templateSuffix: p.templateSuffix || "",
          images: rawImages,
          variants: rawVariants,
          metafields: rawMetafields,
        };

        if (shop) {
          try {
            await prisma.productSnapshot.upsert({
              where: { shop_productId: { shop, productId: numericId } },
              create: {
                shop,
                productId: numericId,
                title: p.title || "",
                status: p.status || "ACTIVE",
                vendor: p.vendor || "",
                productType: p.productType || "",
                tags: Array.isArray(p.tags) ? p.tags.join(", ") : p.tags || "",
                handle: p.handle || "",
                snapshotData: snap,
              },
              update: {
                title: p.title || "",
                status: p.status || "ACTIVE",
                snapshotData: snap,
              },
            });
          } catch (e) {
            // ignore individual upsert errors
          }
        }

        allProducts.push({
          productId: numericId,
          title: p.title,
          snapshotData: snap,
        });
      }

      hasNextPage = productsData.pageInfo?.hasNextPage || false;
      cursor = productsData.pageInfo?.endCursor || null;
      if (allProducts.length >= 250) break;
    }

    return allProducts;
  } catch (err) {
    console.warn("fetchLiveProductsBackup error:", err?.message || err);
    return [];
  }
}

// ============================================================================
// 2. COLLECTIONS BACKUP & RESTORE
// ============================================================================

/**
 * Fetches collections (smart & custom) along with ruleSet conditions
 */
export async function fetchCollectionsBackup(admin) {
  try {
    const allCollections = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage && allCollections.length < 250) {
      const res = await admin.graphql(
        `#graphql
        query getCollections($cursor: String) {
          collections(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              handle
              descriptionHtml
              templateSuffix
              image {
                id
                url
                altText
              }
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
        }`,
        { variables: { cursor } }
      );
      const json = await res.json();
      const nodes = json.data?.collections?.nodes || [];
      allCollections.push(...nodes);

      hasNextPage = Boolean(json.data?.collections?.pageInfo?.hasNextPage);
      cursor = json.data?.collections?.pageInfo?.endCursor || null;
      if (!cursor) break;
    }

    return allCollections;
  } catch (err) {
    console.error("fetchCollectionsBackup error:", err?.message || err);
    return [];
  }
}

/**
 * Restores or recreates a collection from snapshot (tries update first if ID exists, then matches by handle, then recreates)
 */
export async function restoreCollection(admin, col) {
  if (!col || !col.title) {
    return { success: false, message: "Invalid collection data." };
  }

  try {
    const input = {
      title: col.title,
      handle: col.handle,
      descriptionHtml: col.descriptionHtml || "",
      sortOrder: col.sortOrder || "BEST_SELLING",
      ...(col.templateSuffix !== undefined ? { templateSuffix: col.templateSuffix || "" } : {}),
    };

    if (col.image?.url) {
      input.image = {
        src: col.image.url,
        altText: col.image.altText || "",
      };
    }

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

    // 1. Try updating collection in-place if ID exists
    if (col.id) {
      try {
        const updateRes = await admin.graphql(
          `#graphql
          mutation collectionUpdate($input: CollectionInput!) {
            collectionUpdate(input: $input) {
              collection {
                id
                title
                handle
                descriptionHtml
                image { url altText }
              }
              userErrors {
                field
                message
              }
            }
          }`,
          { variables: { input: { id: col.id, ...input } } }
        );
        const updateJson = await updateRes.json();
        const updateErrors = updateJson.data?.collectionUpdate?.userErrors || [];
        if (updateErrors.length === 0 && updateJson.data?.collectionUpdate?.collection?.id) {
          return { success: true, mode: "updated", collection: updateJson.data.collectionUpdate.collection };
        }
      } catch (updateErr) {
        // Fallback to match by handle or recreate
      }
    }

    // 2. If update by ID was not possible, look for existing collection with same handle
    if (col.handle) {
      try {
        const searchRes = await admin.graphql(
          `#graphql
          query findCollectionByHandle($query: String!) {
            collections(first: 5, query: $query) {
              nodes {
                id
                title
                handle
              }
            }
          }`,
          { variables: { query: `handle:${col.handle}` } }
        );
        const searchJson = await searchRes.json();
        const liveCol = searchJson.data?.collections?.nodes?.find(
          (n) => n.handle === col.handle
        );

        if (liveCol?.id) {
          const updateRes = await admin.graphql(
            `#graphql
            mutation collectionUpdateByHandle($input: CollectionInput!) {
              collectionUpdate(input: $input) {
                collection {
                  id
                  title
                  handle
                  descriptionHtml
                  image { url altText }
                }
                userErrors {
                  field
                  message
                }
              }
            }`,
            { variables: { input: { id: liveCol.id, ...input } } }
          );
          const updateJson = await updateRes.json();
          const updateErrors = updateJson.data?.collectionUpdate?.userErrors || [];
          if (updateErrors.length === 0 && updateJson.data?.collectionUpdate?.collection?.id) {
            return {
              success: true,
              mode: "updated_by_handle",
              collection: updateJson.data.collectionUpdate.collection,
            };
          }
        }
      } catch (handleErr) {
        console.warn("findCollectionByHandle warning:", handleErr?.message || handleErr);
      }
    }

    // 3. Recreate collection if update not possible or deleted
    const res = await admin.graphql(
      `#graphql
      mutation collectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection {
            id
            title
            handle
            descriptionHtml
            image { url altText }
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
    return { success: true, mode: "created", collection: json.data?.collectionCreate?.collection };
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
    let allPages = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage && allPages.length < 250) {
      const res = await admin.graphql(
        `#graphql
        query getPages($cursor: String) {
          pages(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              handle
              body
              bodySummary
              templateSuffix
              isPublished
            }
          }
        }`,
        { variables: { cursor } }
      );
      const json = await res.json();
      const nodes = json.data?.pages?.nodes || [];
      allPages.push(...nodes);

      hasNextPage = Boolean(json.data?.pages?.pageInfo?.hasNextPage);
      cursor = json.data?.pages?.pageInfo?.endCursor || null;
      if (!cursor) break;
    }

    return allPages;
  } catch (err) {
    console.warn("fetchPagesBackup warning (check scopes):", err?.message || err);
    return [];
  }
}

/**
 * Restores/recreates a deleted or modified content page (tries update first if ID exists, then matches by handle, then recreates)
 */
export async function restorePage(admin, p) {
  if (!p || !p.title) {
    return { success: false, message: "Invalid page data." };
  }

  try {
    const pageInput = {
      title: p.title,
      handle: p.handle,
      body: p.body ?? p.bodyHtml ?? "",
      isPublished: p.isPublished ?? true,
      ...(p.templateSuffix !== undefined ? { templateSuffix: p.templateSuffix || "" } : {}),
    };

    // 1. Try updating page in-place if ID exists
    if (p.id) {
      try {
        const updateRes = await admin.graphql(
          `#graphql
          mutation pageUpdate($id: ID!, $page: PageUpdateInput!) {
            pageUpdate(id: $id, page: $page) {
              page {
                id
                title
                handle
                body
              }
              userErrors {
                field
                message
              }
            }
          }`,
          { variables: { id: p.id, page: pageInput } }
        );
        const updateJson = await updateRes.json();
        const updateErrors = updateJson.data?.pageUpdate?.userErrors || [];
        if (updateErrors.length === 0 && updateJson.data?.pageUpdate?.page?.id) {
          return { success: true, mode: "updated", page: updateJson.data.pageUpdate.page };
        }
      } catch (updateErr) {
        // Fallback to match by handle or recreate
      }
    }

    // 2. If update by ID was not possible, look for existing page with same handle to update
    if (p.handle) {
      try {
        const searchRes = await admin.graphql(
          `#graphql
          query findPageByHandle($query: String!) {
            pages(first: 5, query: $query) {
              nodes {
                id
                title
                handle
              }
            }
          }`,
          { variables: { query: `handle:${p.handle}` } }
        );
        const searchJson = await searchRes.json();
        const livePage = searchJson.data?.pages?.nodes?.find(
          (n) => n.handle === p.handle
        );

        if (livePage?.id) {
          const updateRes = await admin.graphql(
            `#graphql
            mutation pageUpdateByHandle($id: ID!, $page: PageUpdateInput!) {
              pageUpdate(id: $id, page: $page) {
                page {
                  id
                  title
                  handle
                  body
                }
                userErrors {
                  field
                  message
                }
              }
            }`,
            { variables: { id: livePage.id, page: pageInput } }
          );
          const updateJson = await updateRes.json();
          const updateErrors = updateJson.data?.pageUpdateByHandle?.userErrors || updateJson.data?.pageUpdate?.userErrors || [];
          if (updateErrors.length === 0 && (updateJson.data?.pageUpdateByHandle?.page?.id || updateJson.data?.pageUpdate?.page?.id)) {
            return {
              success: true,
              mode: "updated_by_handle",
              page: updateJson.data?.pageUpdateByHandle?.page || updateJson.data?.pageUpdate?.page,
            };
          }
        }
      } catch (handleSearchErr) {
        console.warn("findPageByHandle warning:", handleSearchErr?.message || handleSearchErr);
      }
    }

    // 3. Recreate page if page does not exist yet
    const res = await admin.graphql(
      `#graphql
      mutation pageCreate($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page {
            id
            title
            handle
            body
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          page: pageInput,
        },
      }
    );
    const json = await res.json();
    const userErrors = json.data?.pageCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return { success: false, message: userErrors.map((e) => e.message).join(", ") };
    }
    return { success: true, mode: "created", page: json.data?.pageCreate?.page };
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

/**
 * Restores or creates a navigation menu (Header, Footer, etc.)
 */
export async function restoreMenu(admin, menu) {
  try {
    if (!menu || !menu.title) {
      return { success: false, message: "Invalid menu payload." };
    }

    const formatItems = (items) => {
      if (!Array.isArray(items)) return [];
      return items.map((item) => {
        const entry = {
          title: item.title,
          type: item.type || "HTTP",
          url: item.url || "#",
        };
        if (Array.isArray(item.items) && item.items.length > 0) {
          entry.items = formatItems(item.items);
        }
        return entry;
      });
    };

    const formattedItems = formatItems(menu.items);

    // 1. If menu.id is present, try updating the existing menu
    if (menu.id) {
      try {
        const updateRes = await admin.graphql(
          `#graphql
          mutation menuUpdate($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
            menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
              menu {
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
              id: menu.id,
              title: menu.title,
              handle: menu.handle,
              items: formattedItems,
            },
          }
        );
        const updateJson = await updateRes.json();
        const errors = updateJson.data?.menuUpdate?.userErrors || [];
        if (errors.length === 0 && updateJson.data?.menuUpdate?.menu?.id) {
          return { success: true, mode: "updated", menu: updateJson.data.menuUpdate.menu };
        }
      } catch (e) {
        // Fall back to handle matching or create
      }
    }

    // 2. Try finding live menu by handle
    if (menu.handle) {
      try {
        const menusRes = await admin.graphql(
          `#graphql
          query findMenuByHandle {
            menus(first: 25) {
              nodes {
                id
                title
                handle
              }
            }
          }`
        );
        const menusJson = await menusRes.json();
        const liveMenu = menusJson.data?.menus?.nodes?.find((m) => m.handle === menu.handle);

        if (liveMenu?.id) {
          const updateRes = await admin.graphql(
            `#graphql
            mutation menuUpdateByHandle($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
              menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
                menu {
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
                id: liveMenu.id,
                title: menu.title,
                handle: menu.handle,
                items: formattedItems,
              },
            }
          );
          const updateJson = await updateRes.json();
          const errors = updateJson.data?.menuUpdate?.userErrors || [];
          if (errors.length === 0 && updateJson.data?.menuUpdate?.menu?.id) {
            return { success: true, mode: "updated", menu: updateJson.data.menuUpdate.menu };
          }
        }
      } catch (findErr) {
        // Continue to create
      }
    }

    // 3. Create menu if update not possible
    try {
      const createRes = await admin.graphql(
        `#graphql
        mutation menuCreate($title: String!, $handle: String, $items: [MenuItemCreateInput!]!) {
          menuCreate(title: $title, handle: $handle, items: $items) {
            menu {
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
            title: menu.title,
            handle: menu.handle,
            items: formattedItems,
          },
        }
      );
      const createJson = await createRes.json();
      const errors = createJson.data?.menuCreate?.userErrors || [];
      if (errors.length === 0 && createJson.data?.menuCreate?.menu?.id) {
        return { success: true, mode: "created", menu: createJson.data.menuCreate.menu };
      }
      return { success: false, message: errors.map((e) => e.message).join(", ") || "Failed to create menu." };
    } catch (createErr) {
      return { success: false, message: createErr?.message || "Failed to restore menu." };
    }
  } catch (err) {
    console.warn("restoreMenu warning:", err?.message || err);
    return { success: false, message: err?.message || "Menu restoration failed." };
  }
}

// ============================================================================
// 5. BLOGS & ARTICLES BACKUP & RESTORE (SEO Content Shield)
// ============================================================================

/**
 * Fetches all blogs and published/draft articles with bodyHtml, tags, author, and handles
 */
export async function fetchBlogsAndArticlesBackup(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query getBlogsWithArticles {
        blogs(first: 25) {
          nodes {
            id
            title
            handle
            commentPolicy
            templateSuffix
            articles(first: 50) {
              nodes {
                id
                title
                handle
                body: bodyHtml
                summary: summaryHtml
                tags
                templateSuffix
                isPublished
                publishedAt
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    const blogs = json.data?.blogs?.nodes || [];

    const flattenedArticles = [];
    for (const blog of blogs) {
      const articles = blog.articles?.nodes || [];
      for (const art of articles) {
        flattenedArticles.push({
          ...art,
          blogId: blog.id,
          blogTitle: blog.title,
          blogHandle: blog.handle,
        });
      }
    }

    return {
      blogs: blogs.map((b) => ({
        id: b.id,
        title: b.title,
        handle: b.handle,
        commentPolicy: b.commentPolicy,
        templateSuffix: b.templateSuffix || "",
        articleCount: b.articles?.nodes?.length || 0,
      })),
      articles: flattenedArticles,
    };
  } catch (err) {
    console.warn("fetchBlogsAndArticlesBackup warning (check scopes):", err?.message || err);
    return { blogs: [], articles: [] };
  }
}

/**
 * Restores or recreates a blog article. If the article still exists, updates it;
 * if deleted, recreates it within its blog.
 */
export async function restoreArticle(admin, article) {
  if (!article || !article.title) {
    return { success: false, message: "Invalid article data." };
  }

  try {
    // 1. If article has an ID, try updating it in case it still exists
    if (article.id) {
      try {
        const upRes = await admin.graphql(
          `#graphql
          mutation articleUpdate($id: ID!, $article: ArticleUpdateInput!) {
            articleUpdate(id: $id, article: $article) {
              article { id title handle }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: article.id,
              article: {
                title: article.title,
                bodyHtml: article.body || article.bodyHtml || "",
                summaryHtml: article.summary || article.summaryHtml || "",
                handle: article.handle || undefined,
                templateSuffix: article.templateSuffix !== undefined ? (article.templateSuffix || "") : undefined,
                isPublished: article.isPublished ?? true,
                tags: Array.isArray(article.tags) ? article.tags : article.tags ? [article.tags] : [],
              },
            },
          }
        );
        const upJson = await upRes.json();
        if (upJson.data?.articleUpdate?.article?.id) {
          return {
            success: true,
            mode: "updated",
            article: upJson.data.articleUpdate.article,
            message: `Article "${article.title}" successfully restored to live store.`,
          };
        }
      } catch (upErr) {
        // Fallback to recreation if article was deleted
      }
    }

    // 2. If update didn't match, verify blog exists or find target blog
    let targetBlogId = article.blogId;
    if (!targetBlogId) {
      try {
        const bRes = await admin.graphql(
          `#graphql
          query getBlogsForArticleRestore {
            blogs(first: 25) {
              nodes { id title handle }
            }
          }`
        );
        const bJson = await bRes.json();
        const liveBlogs = bJson.data?.blogs?.nodes || [];
        const matched = liveBlogs.find(
          (b) =>
            (article.blogHandle && b.handle === article.blogHandle) ||
            (article.blogTitle && b.title?.toLowerCase() === article.blogTitle?.toLowerCase())
        );
        if (matched) {
          targetBlogId = matched.id;
        } else if (liveBlogs.length > 0) {
          targetBlogId = liveBlogs[0].id;
        }
      } catch (e) {
        console.warn("Could not find blogs for article restoration:", e?.message);
      }
    }

    if (!targetBlogId) {
      return { success: false, message: "No target blog found to recreate this article in." };
    }

    const createRes = await admin.graphql(
      `#graphql
      mutation articleCreate($article: ArticleCreateInput!) {
        articleCreate(article: $article) {
          article { id title handle }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          article: {
            blogId: targetBlogId,
            title: article.title,
            bodyHtml: article.body || article.bodyHtml || "",
            summaryHtml: article.summary || article.summaryHtml || "",
            handle: article.handle || undefined,
            templateSuffix: article.templateSuffix || undefined,
            isPublished: article.isPublished ?? true,
            tags: Array.isArray(article.tags) ? article.tags : article.tags ? [article.tags] : [],
          },
        },
      }
    );
    const createJson = await createRes.json();
    const userErrors = createJson.data?.articleCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return { success: false, message: userErrors.map((e) => e.message).join(", ") };
    }

    return {
      success: true,
      mode: "created",
      article: createJson.data?.articleCreate?.article,
      message: `Article "${article.title}" successfully recreated in store.`,
    };
  } catch (err) {
    console.error("restoreArticle error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to restore article." };
  }
}

// ============================================================================
// 6. PRODUCT METAFIELDS BACKUP & RESTORE
// ============================================================================

/**
 * Restores or updates product metafields via Shopify metafieldsSet mutation
 */
export async function restoreProductMetafields(admin, productId, metafields) {
  if (!metafields || metafields.length === 0) {
    return { success: true, count: 0 };
  }

  const numericId = String(productId).replace("gid://shopify/Product/", "");
  const ownerId = `gid://shopify/Product/${numericId}`;

  const metafieldInputs = metafields
    .filter((m) => m.namespace && m.key && m.value !== undefined && m.value !== null)
    .map((m) => ({
      ownerId,
      namespace: m.namespace,
      key: m.key,
      value: String(m.value),
      type: m.type || "single_line_text_field",
    }));

  if (metafieldInputs.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    const res = await admin.graphql(
      `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { metafields: metafieldInputs } }
    );

    const json = await res.json();
    const userErrors = json.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      return {
        success: false,
        message: userErrors.map((e) => `${e.field}: ${e.message}`).join(", "),
      };
    }

    const updated = json.data?.metafieldsSet?.metafields || [];
    return { success: true, count: updated.length };
  } catch (err) {
    console.error("restoreProductMetafields error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to restore metafields." };
  }
}

// ============================================================================
// 7. UNIFIED MULTI-RESOURCE RESTORE POINT CREATION
// ============================================================================

/**
 * Orchestrates a complete store backup snapshot (Products, Themes, Collections, Pages, Menus, Articles)
 * without blocking or breaking existing product flows.
 */
export async function createMultiResourceRestorePoint({
  admin,
  shop,
  name,
  description = "",
  backupType: explicitBackupType = null,
  themeId = null,
  options = {
    includeProducts: true,
    includeThemes: true,
    includeCollections: true,
    includePages: true,
    includeMenus: true,
    includeArticles: true,
  },
}) {
  const safeName =
    (name && String(name).trim()) ||
    `Manual Snapshot - ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  // Determine primary backup type
  let backupType = explicitBackupType || "FULL";
  if (!explicitBackupType) {
    if (options.includeThemes && !options.includeProducts && !options.includeCollections && !options.includePages && !options.includeArticles) {
      backupType = "THEMES";
    } else if (options.includeProducts && !options.includeThemes && !options.includeCollections && !options.includePages && !options.includeArticles) {
      backupType = "PRODUCTS";
    } else if (options.includeCollections && !options.includeProducts && !options.includeThemes && !options.includePages && !options.includeArticles) {
      backupType = "COLLECTIONS";
    } else if (options.includePages && !options.includeProducts && !options.includeThemes && !options.includeCollections && !options.includeArticles) {
      backupType = "PAGES";
    } else if (options.includeArticles && !options.includeProducts && !options.includeThemes && !options.includeCollections && !options.includePages) {
      backupType = "BLOGS";
    }
  }

  // 1. Create the pending restore point
  const rp = await prisma.restorePoint.create({
    data: {
      shop,
      name: safeName,
      description,
      status: "CREATING",
      backupType,
    },
  });

  try {
    // 2. Concurrently fetch all requested resources using Promise.allSettled
    const tasks = [];

    // Task 0: Products (from local snapshot baseline or fetch live from Shopify if empty)
    if (options.includeProducts !== false) {
      tasks.push(
        (async () => {
          let prods = await prisma.productSnapshot.findMany({
            where: { shop },
            select: { productId: true, snapshotData: true, title: true },
          });
          if (prods.length === 0 && admin) {
            prods = await fetchLiveProductsBackup(admin, shop);
          }
          return prods;
        })()
      );
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 1: Theme & Assets
    if (options.includeThemes !== false) {
      tasks.push(fetchThemeBackup(admin, themeId));
    } else {
      tasks.push(Promise.resolve(null));
    }

    // Task 2: Collections
    if (options.includeCollections !== false) {
      tasks.push(fetchCollectionsBackup(admin));
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 3: Pages
    if (options.includePages !== false) {
      tasks.push(fetchPagesBackup(admin));
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 4: Navigation Menus
    if (options.includeMenus !== false) {
      tasks.push(fetchMenusBackup(admin));
    } else {
      tasks.push(Promise.resolve([]));
    }

    // Task 5: Blogs & Articles
    if (options.includeArticles !== false) {
      tasks.push(fetchBlogsAndArticlesBackup(admin));
    } else {
      tasks.push(Promise.resolve({ blogs: [], articles: [] }));
    }

    const [prodRes, themeRes, colRes, pageRes, menuRes, articleRes] = await Promise.allSettled(tasks);

    const products = prodRes.status === "fulfilled" ? prodRes.value : [];
    const themeData = themeRes.status === "fulfilled" ? themeRes.value : null;
    const collections = colRes.status === "fulfilled" ? colRes.value : [];
    const pages = pageRes.status === "fulfilled" ? pageRes.value : [];
    const menus = menuRes.status === "fulfilled" ? menuRes.value : [];
    const articleData = articleRes.status === "fulfilled" ? articleRes.value : { blogs: [], articles: [] };

    const themeCount = themeData?.activeTheme ? 1 : 0;
    const collectionCount = Array.isArray(collections) ? collections.length : 0;
    const pageCount = Array.isArray(pages) ? pages.length : 0;
    const menuCount = Array.isArray(menus) ? menus.length : 0;
    const articleCount = Array.isArray(articleData?.articles) ? articleData.articles.length : 0;

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
        articleCount,
        snapshotData: products,
        themeData: themeData || undefined,
        collectionData: collections.length > 0 ? collections : undefined,
        pageData: pages.length > 0 ? pages : undefined,
        menuData: menus.length > 0 ? menus : undefined,
        articleData: articleCount > 0 || (articleData.blogs && articleData.blogs.length > 0) ? articleData : undefined,
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
        articles: articleCount,
        backupType,
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

/**
 * Dedicated 1-Click Full Theme Backup (Active theme or specific theme by ID)
 */
export async function backupTheme({ admin, shop, themeId = null, name = null, description = "" }) {
  const defaultName = `Theme Backup - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return createMultiResourceRestorePoint({
    admin,
    shop,
    name: name || defaultName,
    description: description || "Dedicated snapshot of theme templates, config, layouts, and liquid files.",
    backupType: "THEMES",
    themeId,
    options: {
      includeProducts: false,
      includeThemes: true,
      includeCollections: false,
      includePages: false,
      includeMenus: false,
      includeArticles: false,
    },
  });
}

/**
 * Dedicated 1-Click Product Catalog Backup
 */
export async function backupProducts({ admin, shop, name = null, description = "" }) {
  const defaultName = `Product Catalog Backup - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return createMultiResourceRestorePoint({
    admin,
    shop,
    name: name || defaultName,
    description: description || "Dedicated snapshot of all store products, variants, pricing, and metafields.",
    backupType: "PRODUCTS",
    options: {
      includeProducts: true,
      includeThemes: false,
      includeCollections: false,
      includePages: false,
      includeMenus: false,
      includeArticles: false,
    },
  });
}

/**
 * Dedicated 1-Click Collection Backup (Smart Rules & Custom Lists)
 */
export async function backupCollections({ admin, shop, name = null, description = "" }) {
  const defaultName = `Collections Backup - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return createMultiResourceRestorePoint({
    admin,
    shop,
    name: name || defaultName,
    description: description || "Dedicated snapshot of automated collection ruleSets and custom product collections.",
    backupType: "COLLECTIONS",
    options: {
      includeProducts: false,
      includeThemes: false,
      includeCollections: true,
      includePages: false,
      includeMenus: false,
      includeArticles: false,
    },
  });
}

/**
 * Dedicated 1-Click Page & Menu Backup
 */
export async function backupPages({ admin, shop, name = null, description = "" }) {
  const defaultName = `Pages & Menus Backup - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return createMultiResourceRestorePoint({
    admin,
    shop,
    name: name || defaultName,
    description: description || "Dedicated snapshot of store pages, landing policies, and navigation menus.",
    backupType: "PAGES",
    options: {
      includeProducts: false,
      includeThemes: false,
      includeCollections: false,
      includePages: true,
      includeMenus: true,
      includeArticles: false,
    },
  });
}

/**
 * Dedicated 1-Click Blog & Article Backup
 */
export async function backupBlogs({ admin, shop, name = null, description = "" }) {
  const defaultName = `Blogs & Articles Backup - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return createMultiResourceRestorePoint({
    admin,
    shop,
    name: name || defaultName,
    description: description || "Dedicated snapshot of all blog posts, authors, tags, and articles.",
    backupType: "BLOGS",
    options: {
      includeProducts: false,
      includeThemes: false,
      includeCollections: false,
      includePages: false,
      includeMenus: false,
      includeArticles: true,
    },
  });
}

// ============================================================================
// 8. ORDERS & CUSTOMERS DATA VAULT (Dispute Defense & Tax Audit Archive)
// ============================================================================

/**
 * Synchronizes orders from Shopify Admin GraphQL into the encrypted OrderArchive vault
 */
export async function syncOrdersVault(admin, shop, { maxOrders = 100 } = {}) {
  try {
    let cursor = null;
    let savedCount = 0;
    let hasNextPage = true;

    while (hasNextPage && savedCount < maxOrders) {
      const fetchCount = Math.min(50, maxOrders - savedCount);
      const res = await admin.graphql(
        `#graphql
        query getOrdersVault($first: Int!, $cursor: String) {
          orders(first: $first, after: $cursor, sortKey: CREATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              name
              createdAt
              processedAt
              financialStatus
              fulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                id
                displayName
                email
                phone
              }
              shippingAddress {
                name
                address1
                city
                province
                country
                zip
              }
              lineItems(first: 30) {
                nodes {
                  id
                  title
                  quantity
                  sku
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  variant {
                    id
                    title
                    sku
                  }
                }
              }
            }
          }
        }`,
        { variables: { first: fetchCount, cursor } }
      );

      const json = await res.json();
      const orderNodes = json.data?.orders?.nodes || [];
      if (orderNodes.length === 0) break;

      for (const ord of orderNodes) {
        const orderId = String(ord.id).replace("gid://shopify/Order/", "");
        const customerName = ord.customer?.displayName || ord.shippingAddress?.name || "Guest";
        const customerEmail = ord.customer?.email || null;
        const totalPrice = ord.totalPriceSet?.shopMoney?.amount || "0.00";
        const currency = ord.totalPriceSet?.shopMoney?.currencyCode || "USD";
        const processedAt = ord.processedAt ? new Date(ord.processedAt) : ord.createdAt ? new Date(ord.createdAt) : new Date();

        await prisma.orderArchive.upsert({
          where: { shop_orderId: { shop, orderId } },
          create: {
            shop,
            orderId,
            orderNumber: ord.name || `#${orderId}`,
            customerEmail,
            customerName,
            totalPrice,
            currency,
            financialStatus: ord.financialStatus,
            fulfillmentStatus: ord.fulfillmentStatus,
            processedAt,
            orderData: ord,
          },
          update: {
            customerEmail,
            customerName,
            totalPrice,
            financialStatus: ord.financialStatus,
            fulfillmentStatus: ord.fulfillmentStatus,
            orderData: ord,
          },
        });
        savedCount++;
      }

      hasNextPage = json.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = json.data?.orders?.pageInfo?.endCursor || null;
    }

    return { success: true, count: savedCount };
  } catch (err) {
    console.error("syncOrdersVault error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to sync orders." };
  }
}

/**
 * Synchronizes customer profiles from Shopify Admin GraphQL into CustomerArchive
 */
export async function syncCustomersVault(admin, shop, { maxCustomers = 100 } = {}) {
  try {
    let cursor = null;
    let savedCount = 0;
    let hasNextPage = true;

    while (hasNextPage && savedCount < maxCustomers) {
      const fetchCount = Math.min(50, maxCustomers - savedCount);
      const res = await admin.graphql(
        `#graphql
        query getCustomersVault($first: Int!, $cursor: String) {
          customers(first: $first, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              displayName
              firstName
              lastName
              email
              phone
              numberOfOrders
              amountSpent {
                amount
                currencyCode
              }
              tags
              defaultAddress {
                address1
                city
                province
                country
                zip
              }
            }
          }
        }`,
        { variables: { first: fetchCount, cursor } }
      );

      const json = await res.json();
      const custNodes = json.data?.customers?.nodes || [];
      if (custNodes.length === 0) break;

      for (const cust of custNodes) {
        const customerId = String(cust.id).replace("gid://shopify/Customer/", "");
        const ordersCount = cust.numberOfOrders ? parseInt(cust.numberOfOrders) : 0;
        const totalSpent = cust.amountSpent?.amount || "0.00";

        await prisma.customerArchive.upsert({
          where: { shop_customerId: { shop, customerId } },
          create: {
            shop,
            customerId,
            email: cust.email || null,
            firstName: cust.firstName || "",
            lastName: cust.lastName || "",
            phone: cust.phone || null,
            ordersCount,
            totalSpent,
            customerData: cust,
          },
          update: {
            email: cust.email || null,
            firstName: cust.firstName || "",
            lastName: cust.lastName || "",
            phone: cust.phone || null,
            ordersCount,
            totalSpent,
            customerData: cust,
          },
        });
        savedCount++;
      }

      hasNextPage = json.data?.customers?.pageInfo?.hasNextPage || false;
      cursor = json.data?.customers?.pageInfo?.endCursor || null;
    }

    return { success: true, count: savedCount };
  } catch (err) {
    console.error("syncCustomersVault error:", err?.message || err);
    return { success: false, message: err?.message || "Failed to sync customers." };
  }
}

/**
 * Converts order archives into a clean, accountant-ready CSV string with Excel UTF-8 BOM
 */
export function generateOrdersCsv(orders = []) {
  const headers = [
    "Order Number",
    "Processed At",
    "Customer Name",
    "Customer Email",
    "Financial Status",
    "Fulfillment Status",
    "Total Price",
    "Currency",
    "Line Items Count",
    "Shipping City",
    "Shipping Country",
  ];

  const rows = orders.map((o) => {
    const raw = o.orderData || {};
    const itemsCount = raw.lineItems?.nodes?.length || 0;
    const city = raw.shippingAddress?.city || "";
    const country = raw.shippingAddress?.country || "";

    return [
      o.orderNumber,
      o.processedAt ? new Date(o.processedAt).toISOString() : "",
      o.customerName || "",
      o.customerEmail || "",
      o.financialStatus || "",
      o.fulfillmentStatus || "",
      o.totalPrice,
      o.currency,
      itemsCount,
      city,
      country,
    ].map((val) => `"${String(val).replace(/"/g, '""')}"`);
  });

  return (
    "\uFEFF" +
    [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\r\n")
  );
}

/**
 * Generates a clean, compliant CSV of products for merchant exports & spreadsheet viewing
 */
export function generateProductsCsv(products = []) {
  const headers = [
    "Product ID",
    "Title",
    "Handle",
    "Status",
    "Vendor",
    "Product Type",
    "Tags",
    "Variants Count",
    "Price Min",
    "Price Max",
    "Updated At",
  ];

  const rows = products.map((p) => {
    const raw = p.snapshotData || p;
    const variants = raw.variants || [];
    const prices = variants.map((v) => parseFloat(v.price) || 0);
    const minPrice = prices.length > 0 ? Math.min(...prices).toFixed(2) : "0.00";
    const maxPrice = prices.length > 0 ? Math.max(...prices).toFixed(2) : "0.00";

    return [
      p.productId || raw.id || "",
      raw.title || p.title || "",
      raw.handle || "",
      raw.status || "ACTIVE",
      raw.vendor || "",
      raw.productType || "",
      Array.isArray(raw.tags) ? raw.tags.join(", ") : raw.tags || "",
      variants.length,
      minPrice,
      maxPrice,
      raw.updatedAt || "",
    ].map((val) => `"${String(val).replace(/"/g, '""')}"`);
  });

  return (
    "\uFEFF" +
    [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\r\n")
  );
}

/**
 * Imports and validates an external Revertly backup archive (.json).
 * Supports saving directly as an offline restore point or triggering live restoration.
 */
export async function importBackupPayload({ admin, shop, payload, mode = "SAVE_AS_RESTORE_POINT" }) {
  try {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!data || typeof data !== "object") {
      return { success: false, message: "Invalid backup file: Not a valid JSON document." };
    }

    // Extract assets from either standard disaster recovery format or raw datasets
    const storeAssets = data.storeAssets || {};
    const products = Array.isArray(storeAssets.products)
      ? storeAssets.products
      : Array.isArray(data.products)
      ? data.products
      : Array.isArray(data)
      ? data
      : [];

    const theme = storeAssets.theme || data.theme || null;
    const collections = Array.isArray(storeAssets.collections)
      ? storeAssets.collections
      : Array.isArray(data.collections)
      ? data.collections
      : [];

    const pages = Array.isArray(storeAssets.pages)
      ? storeAssets.pages
      : Array.isArray(data.pages)
      ? data.pages
      : [];

    const menus = Array.isArray(storeAssets.menus)
      ? storeAssets.menus
      : Array.isArray(data.menus)
      ? data.menus
      : [];

    const blogsAndArticles =
      storeAssets.blogsAndArticles ||
      data.blogsAndArticles || {
        blogs: Array.isArray(data.blogs) ? data.blogs : [],
        articles: Array.isArray(data.articles) ? data.articles : [],
      };

    const productCount = products.length;
    const themeCount = theme?.activeTheme || (theme?.files && theme.files.length > 0) ? 1 : 0;
    const collectionCount = collections.length;
    const pageCount = pages.length;
    const menuCount = menus.length;
    const articleCount = Array.isArray(blogsAndArticles.articles) ? blogsAndArticles.articles.length : 0;

    const totalItems = productCount + themeCount + collectionCount + pageCount + menuCount + articleCount;
    if (totalItems === 0) {
      return {
        success: false,
        message: "No recognizable store assets (Products, Themes, Collections, Pages, Menus, Articles) found in this backup file.",
      };
    }

    let backupType = data.backupType || "FULL";
    if (themeCount > 0 && productCount === 0 && collectionCount === 0 && pageCount === 0 && menuCount === 0 && articleCount === 0) {
      backupType = "THEMES";
    } else if (productCount > 0 && themeCount === 0 && collectionCount === 0 && pageCount === 0 && menuCount === 0 && articleCount === 0) {
      backupType = "PRODUCTS";
    } else if (collectionCount > 0 && productCount === 0 && themeCount === 0 && pageCount === 0 && menuCount === 0 && articleCount === 0) {
      backupType = "COLLECTIONS";
    } else if ((pageCount > 0 || menuCount > 0) && productCount === 0 && themeCount === 0 && collectionCount === 0 && articleCount === 0) {
      backupType = "PAGES";
    } else if (articleCount > 0 && productCount === 0 && themeCount === 0 && collectionCount === 0 && pageCount === 0 && menuCount === 0) {
      backupType = "BLOGS";
    }

    const archiveName = data.name
      ? `[Imported] ${data.name}`
      : `Imported Backup - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    const archiveDescription = data.description
      ? `(Imported Archive) ${data.description}`
      : `Imported from external backup file. Original date: ${data.createdAt || data.exportedAt || "Unknown"}. Source shop: ${data.shop || "External"}.`;

    // 1. Create the restore point record in DB
    const restorePoint = await prisma.restorePoint.create({
      data: {
        shop,
        name: archiveName.slice(0, 500),
        description: archiveDescription.slice(0, 2000),
        status: "READY",
        backupType,
        productCount,
        themeCount,
        collectionCount,
        pageCount,
        menuCount,
        articleCount,
        snapshotData: products.length > 0 ? products : undefined,
        themeData: theme || undefined,
        collectionData: collections.length > 0 ? collections : undefined,
        pageData: pages.length > 0 ? pages : undefined,
        menuData: menus.length > 0 ? menus : undefined,
        articleData: articleCount > 0 || (blogsAndArticles.blogs && blogsAndArticles.blogs.length > 0) ? blogsAndArticles : undefined,
      },
    });

    const summary = {
      restorePointId: restorePoint.id,
      products: productCount,
      themes: themeCount,
      collections: collectionCount,
      pages: pageCount,
      menus: menuCount,
      articles: articleCount,
      backupType,
      restoredLive: false,
    };

    // 2. If mode is RESTORE_NOW, execute live restore of the items
    if (mode === "RESTORE_NOW") {
      let liveCollections = 0;
      let livePages = 0;
      let liveMenus = 0;
      let liveArticles = 0;
      let liveTheme = false;

      // Restore collections
      for (const col of collections) {
        const res = await restoreCollection(admin, col);
        if (res.success) liveCollections++;
      }

      // Restore pages
      for (const page of pages) {
        const res = await restorePage(admin, page);
        if (res.success) livePages++;
      }

      // Restore navigation menus
      for (const menu of menus) {
        const res = await restoreMenu(admin, menu);
        if (res.success) liveMenus++;
      }

      // Restore articles
      for (const art of blogsAndArticles.articles || []) {
        const res = await restoreArticle(admin, art);
        if (res.success) liveArticles++;
      }

      // Restore theme staging if theme files present
      if (theme && Array.isArray(theme.files) && theme.files.length > 0) {
        const res = await restoreThemeFilesWithSafety({
          admin,
          shop,
          themeId: theme.activeTheme?.id,
          files: theme.files,
          createStaging: true,
        });
        if (res.success) liveTheme = true;
      }

      // Sync imported products to baseline
      let liveProducts = 0;
      for (const p of products) {
        const pId = p.productId || p.id;
        const snap = p.snapshotData || p;
        if (pId) {
          const numericId = String(pId).replace("gid://shopify/Product/", "");
          try {
            await prisma.productSnapshot.upsert({
              where: { shop_productId: { shop, productId: numericId } },
              create: {
                shop,
                productId: numericId,
                title: snap.title || p.title || "",
                status: snap.status || "ACTIVE",
                vendor: snap.vendor || "",
                productType: snap.productType || "",
                tags: Array.isArray(snap.tags) ? snap.tags.join(", ") : snap.tags || "",
                bodyHtml: snap.bodyHtml || snap.body || "",
                handle: snap.handle || "",
                snapshotData: snap,
              },
              update: {
                title: snap.title || p.title || "",
                status: snap.status || "ACTIVE",
                vendor: snap.vendor || "",
                productType: snap.productType || "",
                tags: Array.isArray(snap.tags) ? snap.tags.join(", ") : snap.tags || "",
                bodyHtml: snap.bodyHtml || snap.body || "",
                handle: snap.handle || "",
                snapshotData: snap,
              },
            });
            liveProducts++;
          } catch (snapErr) {
            // non-fatal per-product
          }
        }
      }

      summary.restoredLive = true;
      summary.liveResults = {
        products: liveProducts,
        collections: liveCollections,
        pages: livePages,
        menus: liveMenus,
        articles: liveArticles,
        themeStagingCreated: liveTheme,
      };

      const resultParts = [];
      if (liveProducts > 0) resultParts.push(`${liveProducts} products baseline synced`);
      if (liveCollections > 0) resultParts.push(`${liveCollections} collections restored`);
      if (livePages > 0) resultParts.push(`${livePages} pages restored`);
      if (liveMenus > 0) resultParts.push(`${liveMenus} menus restored`);
      if (liveArticles > 0) resultParts.push(`${liveArticles} articles restored`);
      if (liveTheme) resultParts.push("theme staging created");

      return {
        success: true,
        restorePoint,
        summary,
        message: `Backup archive imported and live restore applied: ${resultParts.join(", ") || "No changes"}.`,
      };
    }

    return {
      success: true,
      restorePoint,
      summary,
      message: `Backup archive imported successfully as Restore Point #${restorePoint.id} (${productCount} products, ${collectionCount} collections, ${pageCount} pages, ${menuCount} menus, ${articleCount} articles).`,
    };
  } catch (err) {
    console.error("importBackupPayload error:", err?.message || err);
    return {
      success: false,
      message: `Failed to import backup archive: ${err?.message || "Invalid archive structure."}`,
    };
  }
}

// Re-export CSV portability utilities for server-side consumers
export {
  generateCollectionsCsv,
  parseCollectionsCsv,
  generatePagesAndMenusCsv,
  parsePagesAndMenusCsv,
  generateBlogsAndArticlesCsv,
  parseBlogsAndArticlesCsv,
  parseProductsCsv,
  detectAndParseCsvArchive,
} from "./utils/csv-portability.js";

