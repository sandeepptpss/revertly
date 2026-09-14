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
            articles(first: 50) {
              nodes {
                id
                title
                handle
                body: bodyHtml
                summary: summaryHtml
                tags
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
          query getFirstBlog {
            blogs(first: 5) {
              nodes { id title handle }
            }
          }`
        );
        const bJson = await bRes.json();
        const firstBlog = bJson.data?.blogs?.nodes?.[0];
        if (firstBlog) targetBlogId = firstBlog.id;
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
  options = {
    includeProducts: true,
    includeThemes: true,
    includeCollections: true,
    includePages: true,
    includeMenus: true,
    includeArticles: true,
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
    if (options.includeProducts !== false) {
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
    if (options.includeThemes !== false) {
      tasks.push(fetchThemeBackup(admin));
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
