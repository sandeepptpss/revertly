import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import {
  generateProductsCsv,
  generateCollectionsCsv,
  generatePagesAndMenusCsv,
  generateBlogsAndArticlesCsv,
  fetchThemeBackup,
  fetchCollectionsBackup,
  fetchPagesBackup,
  fetchMenusBackup,
  fetchBlogsAndArticlesBackup,
  fetchLiveProductsBackup,
} from "../backup.server.js";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const perm = await checkPermission(shop, session, PERMISSIONS.VIEW);
  if (!perm.allowed || perm.actor?.suspended) {
    throw new Response("Forbidden: Insufficient permissions to export store data", { status: 403 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "full_json";
  const rpIdParam = url.searchParams.get("rpId");

  const cleanShop = shop.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date().toISOString().split("T")[0];

  // Resolve target restore point if requested
  let targetRp = null;
  if (rpIdParam) {
    const parsedId = parseInt(rpIdParam, 10);
    if (isNaN(parsedId)) {
      throw new Response("Invalid Restore Point ID", { status: 400 });
    }
    targetRp = await prisma.restorePoint.findFirst({
      where: { id: parsedId, shop },
    });
    if (!targetRp) {
      throw new Response(`Restore Point #${parsedId} not found for this store.`, { status: 404 });
    }
  }

  await logAudit(shop, perm.actor, "DATA_EXPORTED", {
    resourceType: "Export",
    details: { type, rpId: targetRp ? targetRp.id : "live" },
    request,
  });

  const isSnapshot = Boolean(targetRp);
  const filePrefix = isSnapshot ? `rp${targetRp.id}` : "live";

  // Helper for consistent headers
  const makeResponse = (content, contentType, filename) => {
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  };

  // ── 1. Products CSV Export ────────────────────────────────────────────────
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
    return makeResponse(csvContent, "text/csv; charset=utf-8", filename);
  }

  // ── 2. Products JSON Export ───────────────────────────────────────────────
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
    return makeResponse(JSON.stringify(payload, null, 2), "application/json; charset=utf-8", filename);
  }

  // ── 3. Themes JSON Export ─────────────────────────────────────────────────
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
    return makeResponse(JSON.stringify(payload, null, 2), "application/json; charset=utf-8", filename);
  }

  // ── 4. Collections CSV Export ────────────────────────────────────────────
  if (type === "collections_csv") {
    let collections = [];
    if (isSnapshot) {
      collections = Array.isArray(targetRp.collectionData) ? targetRp.collectionData : [];
    } else {
      collections = await fetchCollectionsBackup(admin);
    }

    const csvContent = generateCollectionsCsv(collections);
    const filename = `revertly-collections-${cleanShop}-${filePrefix}-${dateStr}.csv`;
    return makeResponse(csvContent, "text/csv; charset=utf-8", filename);
  }

  // ── 5. Collections JSON Export ────────────────────────────────────────────
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
    return makeResponse(JSON.stringify(payload, null, 2), "application/json; charset=utf-8", filename);
  }

  // ── 6. Pages & Navigation Menus CSV Export ───────────────────────────────
  if (type === "pages_csv" || type === "menus_csv") {
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

    const csvContent = generatePagesAndMenusCsv(pages, menus);
    const filename = `revertly-pages-menus-${cleanShop}-${filePrefix}-${dateStr}.csv`;
    return makeResponse(csvContent, "text/csv; charset=utf-8", filename);
  }

  // ── 7. Pages JSON Export ──────────────────────────────────────────────────
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
    return makeResponse(JSON.stringify(payload, null, 2), "application/json; charset=utf-8", filename);
  }

  // ── 8. Blogs & Articles CSV Export ───────────────────────────────────────
  if (type === "blogs_csv" || type === "articles_csv") {
    let blogData = null;
    if (isSnapshot) {
      blogData = targetRp.articleData || null;
    } else {
      blogData = await fetchBlogsAndArticlesBackup(admin);
    }

    const blogs = blogData?.blogs || [];
    const articles = blogData?.articles || [];
    const csvContent = generateBlogsAndArticlesCsv(blogs, articles);
    const filename = `revertly-blogs-articles-${cleanShop}-${filePrefix}-${dateStr}.csv`;
    return makeResponse(csvContent, "text/csv; charset=utf-8", filename);
  }

  // ── 9. Blogs JSON Export ──────────────────────────────────────────────────
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
    return makeResponse(JSON.stringify(payload, null, 2), "application/json; charset=utf-8", filename);
  }

  // ── 7. Full Store Backup JSON Export (Default) ────────────────────────────
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
    return makeResponse(JSON.stringify(exportPayload, null, 2), "application/json; charset=utf-8", filename);
  }

  // Export LIVE store assets
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
  return makeResponse(JSON.stringify(livePayload, null, 2), "application/json; charset=utf-8", filename);
};
