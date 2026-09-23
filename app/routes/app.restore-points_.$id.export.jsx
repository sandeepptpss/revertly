import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { checkPermission, logAudit, PERMISSIONS } from "../team.server.js";
import { buildThemeZip } from "../utils/theme-zip.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const perm = await checkPermission(shop, session, PERMISSIONS.VIEW);
  if (!perm.allowed || perm.actor?.suspended) {
    throw new Response("Forbidden: Insufficient permissions to export backup data", { status: 403 });
  }

  const rpId = parseInt(params.id);
  if (isNaN(rpId)) {
    throw new Response("Invalid Restore Point ID", { status: 400 });
  }

  const restorePoint = await prisma.restorePoint.findFirst({
    where: { id: rpId, shop },
  });

  if (!restorePoint) {
    throw new Response("Restore Point Not Found", { status: 404 });
  }

  await logAudit(shop, perm.actor, "BACKUP_EXPORTED", {
    resourceType: "RestorePoint",
    resourceId: rpId,
    details: { name: restorePoint.name },
    request,
  });

  const url = new URL(request.url);
  const format = url.searchParams.get("format");
  const cleanShop = shop.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date(restorePoint.createdAt).toISOString().split("T")[0];

  // Direct Shopify theme uploadable ZIP export
  if (format === "zip") {
    const themeFiles = restorePoint.themeData?.files || [];
    if (!themeFiles.length) {
      throw new Response("No theme files available in this restore point to generate ZIP", { status: 404 });
    }

    const themeName = restorePoint.themeData?.activeTheme?.name || "theme";
    const cleanThemeName = themeName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
    const zipFilename = `shopify-theme-${cleanThemeName}-rp${restorePoint.id}-${dateStr}.zip`;
    const zipBuffer = buildThemeZip(themeFiles);

    return new Response(zipBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFilename}"`,
        "Content-Length": String(zipBuffer.length),
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  const filename = `revertly-backup-${cleanShop}-rp${restorePoint.id}-${dateStr}.json`;

  const exportPayload = {
    _schema: "revertly-disaster-recovery-v1",
    app: "Revertly Store Protection & Backups",
    shop,
    restorePointId: restorePoint.id,
    name: restorePoint.name,
    description: restorePoint.description || "",
    status: restorePoint.status,
    backupType: restorePoint.backupType,
    createdAt: restorePoint.createdAt,
    exportedAt: new Date().toISOString(),
    summary: {
      productsCount: restorePoint.productCount,
      themeCount: restorePoint.themeCount,
      collectionCount: restorePoint.collectionCount,
      pageCount: restorePoint.pageCount,
      menuCount: restorePoint.menuCount,
      articleCount: restorePoint.articleCount || 0,
      metafieldCount: restorePoint.metafieldCount || 0,
    },
    storeAssets: {
      products: restorePoint.snapshotData || [],
      theme: restorePoint.themeData || null,
      collections: restorePoint.collectionData || [],
      pages: restorePoint.pageData || [],
      menus: restorePoint.menuData || [],
      blogsAndArticles: restorePoint.articleData || null,
      metafields: restorePoint.metafieldData || null,
    },
  };

  const jsonContent = JSON.stringify(exportPayload, null, 2);

  return new Response(jsonContent, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};

