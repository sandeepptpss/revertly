import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import {
  generateProductsCsv,
  fetchThemeBackup,
  fetchCollectionsBackup,
  fetchPagesBackup,
  fetchMenusBackup,
  fetchBlogsAndArticlesBackup,
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

  await logAudit(shop, perm.actor, "DATA_EXPORTED", {
    resourceType: "Export",
    details: { type, rpId: rpIdParam || "live" },
    request,
  });

  // ── 1. Products CSV Export ────────────────────────────────────────────────
  if (type === "products_csv") {
    let products = [];
    if (rpIdParam) {
      const rp = await prisma.restorePoint.findFirst({
        where: { id: parseInt(rpIdParam, 10), shop },
      });
      if (rp && Array.isArray(rp.snapshotData)) products = rp.snapshotData;
    }
    if (products.length === 0) {
      products = await prisma.productSnapshot.findMany({
        where: { shop, isDeleted: false },
        orderBy: { updatedAt: "desc" },
      });
    }

    const csvContent = generateProductsCsv(products);
    return new Response(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-products-${cleanShop}-${dateStr}.csv"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // ── 2. Products JSON Export ───────────────────────────────────────────────
  if (type === "products_json") {
    let products = [];
    if (rpIdParam) {
      const rp = await prisma.restorePoint.findFirst({
        where: { id: parseInt(rpIdParam, 10), shop },
      });
      if (rp && Array.isArray(rp.snapshotData)) products = rp.snapshotData;
    }
    if (products.length === 0) {
      products = await prisma.productSnapshot.findMany({
        where: { shop, isDeleted: false },
        orderBy: { updatedAt: "desc" },
      });
    }

    const payload = {
      _schema: "revertly-products-v1",
      shop,
      exportedAt: new Date().toISOString(),
      count: products.length,
      products,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-products-${cleanShop}-${dateStr}.json"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // ── 3. Themes JSON Export ─────────────────────────────────────────────────
  if (type === "themes_json") {
    let themeData = null;
    if (rpIdParam) {
      const rp = await prisma.restorePoint.findFirst({
        where: { id: parseInt(rpIdParam, 10), shop },
      });
      if (rp && rp.themeData) themeData = rp.themeData;
    }
    if (!themeData) {
      themeData = await fetchThemeBackup(admin);
    }

    const payload = {
      _schema: "revertly-themes-v1",
      shop,
      exportedAt: new Date().toISOString(),
      theme: themeData,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-theme-${cleanShop}-${dateStr}.json"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // ── 4. Collections JSON Export ────────────────────────────────────────────
  if (type === "collections_json") {
    let collections = [];
    if (rpIdParam) {
      const rp = await prisma.restorePoint.findFirst({
        where: { id: parseInt(rpIdParam, 10), shop },
      });
      if (rp && Array.isArray(rp.collectionData)) collections = rp.collectionData;
    }
    if (collections.length === 0) {
      collections = await fetchCollectionsBackup(admin);
    }

    const payload = {
      _schema: "revertly-collections-v1",
      shop,
      exportedAt: new Date().toISOString(),
      count: collections.length,
      collections,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-collections-${cleanShop}-${dateStr}.json"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // ── 5. Pages JSON Export ──────────────────────────────────────────────────
  if (type === "pages_json") {
    let pages = [];
    let menus = [];
    if (rpIdParam) {
      const rp = await prisma.restorePoint.findFirst({
        where: { id: parseInt(rpIdParam, 10), shop },
      });
      if (rp && Array.isArray(rp.pageData)) pages = rp.pageData;
      if (rp && Array.isArray(rp.menuData)) menus = rp.menuData;
    }
    if (pages.length === 0) {
      const [p, m] = await Promise.all([fetchPagesBackup(admin), fetchMenusBackup(admin)]);
      pages = p;
      menus = m;
    }

    const payload = {
      _schema: "revertly-pages-v1",
      shop,
      exportedAt: new Date().toISOString(),
      pageCount: pages.length,
      menuCount: menus.length,
      pages,
      menus,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-pages-${cleanShop}-${dateStr}.json"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // ── 6. Blogs JSON Export ──────────────────────────────────────────────────
  if (type === "blogs_json") {
    let blogData = null;
    if (rpIdParam) {
      const rp = await prisma.restorePoint.findFirst({
        where: { id: parseInt(rpIdParam, 10), shop },
      });
      if (rp && rp.articleData) blogData = rp.articleData;
    }
    if (!blogData) {
      blogData = await fetchBlogsAndArticlesBackup(admin);
    }

    const payload = {
      _schema: "revertly-blogs-v1",
      shop,
      exportedAt: new Date().toISOString(),
      blogs: blogData?.blogs || [],
      articles: blogData?.articles || [],
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-blogs-${cleanShop}-${dateStr}.json"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // ── 7. Full Store Backup JSON Export ──────────────────────────────────────
  let latestRp = null;
  if (rpIdParam) {
    latestRp = await prisma.restorePoint.findFirst({
      where: { id: parseInt(rpIdParam, 10), shop },
    });
  }
  if (!latestRp) {
    latestRp = await prisma.restorePoint.findFirst({
      where: { shop, status: "READY" },
      orderBy: { createdAt: "desc" },
    });
  }

  if (latestRp) {
    const exportPayload = {
      _schema: "revertly-disaster-recovery-v1",
      app: "Revertly Store Protection & Backups",
      shop,
      restorePointId: latestRp.id,
      name: latestRp.name,
      description: latestRp.description || "",
      status: latestRp.status,
      backupType: latestRp.backupType,
      createdAt: latestRp.createdAt,
      exportedAt: new Date().toISOString(),
      summary: {
        productsCount: latestRp.productCount,
        themeCount: latestRp.themeCount,
        collectionCount: latestRp.collectionCount,
        pageCount: latestRp.pageCount,
        menuCount: latestRp.menuCount,
        articleCount: latestRp.articleCount || 0,
      },
      storeAssets: {
        products: latestRp.snapshotData || [],
        theme: latestRp.themeData || null,
        collections: latestRp.collectionData || [],
        pages: latestRp.pageData || [],
        menus: latestRp.menuData || [],
        blogsAndArticles: latestRp.articleData || null,
      },
    };

    return new Response(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="revertly-backup-${cleanShop}-rp${latestRp.id}-${dateStr}.json"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  // If no restore points exist yet, fetch live assets
  const [products, theme, collections, pages, menus, blogData] = await Promise.all([
    prisma.productSnapshot.findMany({ where: { shop, isDeleted: false } }),
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

  return new Response(JSON.stringify(livePayload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="revertly-live-backup-${cleanShop}-${dateStr}.json"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};
