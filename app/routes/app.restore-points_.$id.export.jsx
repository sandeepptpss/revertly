import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

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

  const cleanShop = shop.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date(restorePoint.createdAt).toISOString().split("T")[0];
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
    },
    storeAssets: {
      products: restorePoint.snapshotData || [],
      theme: restorePoint.themeData || null,
      collections: restorePoint.collectionData || [],
      pages: restorePoint.pageData || [],
      menus: restorePoint.menuData || [],
      blogsAndArticles: restorePoint.articleData || null,
    },
  };

  const jsonContent = JSON.stringify(exportPayload, null, 2);

  return new Response(jsonContent, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};
