/**
 * API Route: Cloud Sync operations (upload, list, import)
 * Handles POST actions for cloud backup management.
 */
import { syncRestorePointToCloud, listCloudBackups, importBackupFromCloud } from "../cloudSync.server.js";
import { authenticate } from "../shopify.server.js";
import { checkPermission, PERMISSIONS } from "../team.server.js";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  // These are the same operations the restore-point page gates on
  // BACKUP_CREATE. Without the check this route is an unguarded way to push a
  // backup offsite, or pull an arbitrary cloud file in as a restore point.
  const perm = await checkPermission(shop, session, PERMISSIONS.BACKUP_CREATE);
  if (!perm.allowed) {
    return Response.json({ success: false, error: perm.message }, { status: 403 });
  }

  try {
    if (intent === "sync") {
      const restorePointId = parseInt(formData.get("restorePointId"), 10);
      if (!restorePointId) {
        return Response.json({ success: false, error: "Missing restorePointId" }, { status: 400 });
      }
      const result = await syncRestorePointToCloud(shop, restorePointId);
      return Response.json(result);
    }

    if (intent === "list") {
      const result = await listCloudBackups(shop);
      return Response.json(result);
    }

    if (intent === "import") {
      const fileId = formData.get("fileId");
      if (!fileId) {
        return Response.json({ success: false, error: "Missing fileId" }, { status: 400 });
      }
      const result = await importBackupFromCloud(shop, fileId);
      return Response.json(result);
    }

    return Response.json({ success: false, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (error) {
    console.error("[Cloud Sync API] Error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};
