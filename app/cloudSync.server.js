/**
 * Cloud Sync Transport Layer for Revertly
 * Provides Google Drive & Dropbox integration for backup export/import.
 *
 * Architecture:
 *  - OAuth tokens are stored in AppSettings (cloudSyncAccessToken / cloudSyncRefreshToken)
 *  - On sync, restore point data is serialized to JSON and uploaded as a file
 *  - On import, the file is fetched from the cloud and deserialized
 *  - Supports both manual sync and auto-upload after backups
 */
import prisma from "./db.server.js";
import { checkFeatureAccess } from "./billing.server.js";
import { encrypt, decrypt } from "./crypto.server.js";

const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const DROPBOX_LIST_URL = "https://api.dropboxapi.com/2/files/list_folder";
const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

export const CLOUD_PROVIDERS = {
  GOOGLE_DRIVE: {
    id: "GOOGLE_DRIVE",
    label: "Google Drive",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: GOOGLE_DRIVE_TOKEN_URL,
    scope: "https://www.googleapis.com/auth/drive.file",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
  DROPBOX: {
    id: "DROPBOX",
    label: "Dropbox",
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: DROPBOX_TOKEN_URL,
    scope: "files.content.write files.content.read files.metadata.read account_info.read",
    clientIdEnv: "DROPBOX_APP_KEY",
    clientSecretEnv: "DROPBOX_APP_SECRET",
  },
};

/**
 * Offsite Cloud Storage Sync is a paid-plan entitlement (`cloudSync`).
 *
 * The gate lives here rather than in each route because upload, list and import
 * are reachable from four places — the Settings page, both restore-point views,
 * the /api/cloud-sync endpoint and the automated scheduler. Guarding the
 * transport entry points means a Free store cannot reach a provider through any
 * of them, including a hand-crafted POST to the API route.
 */
export const CLOUD_SYNC_UPGRADE_MESSAGE =
  "Offsite Cloud Storage Sync (Google Drive & Dropbox) is not included in the Free plan. Upgrade to Starter, Growth, Business, or Enterprise in Plans & Billing to keep backups in your own cloud storage.";

export async function checkCloudSyncAccess(shop) {
  return checkFeatureAccess(shop, "cloudSync");
}

/** Resolves a provider descriptor, or null for unknown/NONE. */
export function getProvider(providerId) {
  return CLOUD_PROVIDERS[String(providerId || "").toUpperCase()] || null;
}

/**
 * Whether the operator has supplied OAuth credentials for a provider.
 * The UI uses this to show an honest "needs configuration" state instead of
 * offering a Connect button that could only ever fail.
 */
export function isProviderConfigured(providerId) {
  const p = getProvider(providerId);
  if (!p) return false;
  return Boolean(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

/** Configuration status for every provider, for rendering the Settings page. */
export function getCloudProviderStatus() {
  return Object.values(CLOUD_PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    configured: isProviderConfigured(p.id),
    missingEnv: [p.clientIdEnv, p.clientSecretEnv].filter((e) => !process.env[e]),
  }));
}

/**
 * Serializes a restore point and its related data into a portable JSON blob
 */
export async function serializeRestorePoint(restorePointId) {
  const rp = await prisma.restorePoint.findUnique({
    where: { id: restorePointId },
    include: {
      rollbackJobs: { include: { results: true } },
    },
  });
  if (!rp) throw new Error(`RestorePoint ${restorePointId} not found`);

  // Gather change events up to this restore point
  const events = await prisma.changeEvent.findMany({
    where: {
      shop: rp.shop,
      changedAt: { lte: rp.createdAt },
    },
    orderBy: { changedAt: "desc" },
    take: 500,
  });

  const payload = {
    version: "1.1",
    exportedAt: new Date().toISOString(),
    app: "Revertly",
    restorePoint: {
      id: rp.id,
      shop: rp.shop,
      name: rp.name,
      description: rp.description,
      createdAt: rp.createdAt,
      backupType: rp.backupType,
      // Products live in `snapshotData`, with the product's own metafields
      // nested inside each entry there. `metafieldData` is a *different*
      // thing: the store-wide metafield backup (shop, collection, page, blog
      // and article owners plus the definitions), which has its own column.
      snapshotData: rp.snapshotData,
      themeData: rp.themeData,
      collectionData: rp.collectionData,
      pageData: rp.pageData,
      articleData: rp.articleData,
      menuData: rp.menuData,
      metafieldData: rp.metafieldData,
      orderData: rp.orderData,
      customerData: rp.customerData,
      counts: {
        products: rp.productCount,
        themes: rp.themeCount,
        collections: rp.collectionCount,
        pages: rp.pageCount,
        menus: rp.menuCount,
        articles: rp.articleCount,
        metafields: rp.metafieldCount,
        orders: rp.orderCount,
        customers: rp.customerCount,
      },
    },
    changeEventsSnapshot: events.map((e) => ({
      id: e.id,
      productId: e.productId,
      fieldName: e.fieldName,
      variantId: e.variantId,
      oldValue: e.oldValue,
      newValue: e.newValue,
      changedAt: e.changedAt,
    })),
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Gets or refreshes the OAuth access token for a provider
 */
async function getAccessToken(settings) {
  const provider = settings.cloudSyncProvider;
  const accessToken = decrypt(settings.cloudSyncAccessToken);
  const refreshToken = decrypt(settings.cloudSyncRefreshToken);
  const tokenExpiry = settings.cloudSyncTokenExpiry;

  // If token is still valid, return it
  if (accessToken && tokenExpiry && new Date(tokenExpiry) > new Date()) {
    return accessToken;
  }

  // Token expired or missing — attempt refresh
  if (!refreshToken) {
    throw new Error(`No refresh token available for ${provider}. Please reconnect.`);
  }

  let tokenUrl, body;
  if (provider === "GOOGLE_DRIVE") {
    tokenUrl = GOOGLE_DRIVE_TOKEN_URL;
    body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
  } else if (provider === "DROPBOX") {
    tokenUrl = DROPBOX_TOKEN_URL;
    body = new URLSearchParams({
      client_id: process.env.DROPBOX_APP_KEY || "",
      client_secret: process.env.DROPBOX_APP_SECRET || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
  } else {
    throw new Error(`Unknown cloud provider: ${provider}`);
  }

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token refresh failed for ${provider}: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const newAccessToken = data.access_token;
  const expiresIn = data.expires_in || 3600;

  // Persist new token
  await prisma.appSettings.update({
    where: { shop: settings.shop },
    data: {
      cloudSyncAccessToken: encrypt(newAccessToken),
      cloudSyncTokenExpiry: new Date(Date.now() + expiresIn * 1000),
    },
  });

  return newAccessToken;
}

/**
 * Uploads a restore point to Google Drive
 */
async function uploadToGoogleDrive(accessToken, folder, fileName, content) {
  // Step 1: Find or create the folder
  const folderQuery = encodeURIComponent(
    `name='${folder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchResp = await fetch(`${GOOGLE_DRIVE_FILES_URL}?q=${folderQuery}&spaces=drive`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const searchData = await searchResp.json();

  let folderId;
  if (searchData.files && searchData.files.length > 0) {
    folderId = searchData.files[0].id;
  } else {
    // Create the folder
    const createResp = await fetch(GOOGLE_DRIVE_FILES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folder,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    const createData = await createResp.json();
    folderId = createData.id;
  }

  // Step 2: Upload the file as multipart
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    mimeType: "application/json",
  });

  const boundary = "revertly_upload_boundary";
  const multipartBody = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: application/json",
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");

  const uploadResp = await fetch(`${GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    throw new Error(`Google Drive upload failed: ${uploadResp.status} ${errText}`);
  }

  const uploadResult = await uploadResp.json();
  return {
    provider: "GOOGLE_DRIVE",
    fileId: uploadResult.id,
    fileName,
    folderId,
    webViewLink: uploadResult.webViewLink || null,
  };
}

/**
 * Uploads a restore point to Dropbox
 */
async function uploadToDropbox(accessToken, folder, fileName, content) {
  const path = `/${folder}/${fileName}`;
  const resp = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "add",
        autorename: true,
        mute: false,
      }),
    },
    body: content,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Dropbox upload failed: ${resp.status} ${errText}`);
  }

  const result = await resp.json();
  return {
    provider: "DROPBOX",
    fileId: result.id,
    fileName: result.name,
    path: result.path_display,
    size: result.size,
  };
}

/**
 * Lists backup files from a cloud provider folder
 */
export async function listCloudBackups(shop) {
  const access = await checkCloudSyncAccess(shop);
  if (!access.allowed) {
    return { success: false, error: CLOUD_SYNC_UPGRADE_MESSAGE, upgradeRequired: true };
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  if (!settings?.cloudSyncConnected) {
    return { success: false, error: "Cloud sync not connected" };
  }

  const accessToken = await getAccessToken(settings);
  const folder = settings.cloudSyncFolder || "Revertly_Backups";
  const provider = settings.cloudSyncProvider;

  if (provider === "GOOGLE_DRIVE") {
    const folderQuery = encodeURIComponent(
      `name='${folder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const searchResp = await fetch(`${GOOGLE_DRIVE_FILES_URL}?q=${folderQuery}&spaces=drive`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const searchData = await searchResp.json();
    if (!searchData.files?.length) return { success: true, files: [] };

    const folderId = searchData.files[0].id;
    const filesQuery = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const filesResp = await fetch(
      `${GOOGLE_DRIVE_FILES_URL}?q=${filesQuery}&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime desc`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const filesData = await filesResp.json();
    return { success: true, provider, files: filesData.files || [] };
  }

  if (provider === "DROPBOX") {
    const resp = await fetch(DROPBOX_LIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: `/${folder}`, recursive: false }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      // If the backup folder does not exist yet in Dropbox, treat as 0 files rather than error
      if (errText.includes("path/not_found") || resp.status === 409) {
        return { success: true, provider, files: [] };
      }
      return { success: false, error: `Dropbox list failed: ${resp.status}` };
    }
    const data = await resp.json();
    const files = (data.entries || [])
      .filter((e) => e[".tag"] === "file")
      .map((e) => ({
        id: e.id,
        name: e.name,
        size: e.size,
        modifiedTime: e.server_modified,
        path: e.path_display,
      }));
    return { success: true, provider, files };
  }

  return { success: false, error: `Unknown provider: ${provider}` };
}

/**
 * Downloads a backup file from the cloud and returns parsed JSON
 */
export async function downloadCloudBackup(shop, fileId) {
  if (!fileId || typeof fileId !== "string") {
    throw new Error("Invalid file ID provided.");
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  if (!settings?.cloudSyncConnected) {
    throw new Error("Cloud sync not connected");
  }

  const accessToken = await getAccessToken(settings);
  const provider = settings.cloudSyncProvider;

  if (provider === "GOOGLE_DRIVE") {
    const encodedId = encodeURIComponent(fileId.trim());
    const resp = await fetch(`${GOOGLE_DRIVE_FILES_URL}/${encodedId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new Error(`Google Drive download failed: ${resp.status}`);
    return await resp.json();
  }

  if (provider === "DROPBOX") {
    const trimmed = fileId.trim();
    if (trimmed.includes("..")) {
      throw new Error("Invalid Dropbox file path.");
    }
    const resp = await fetch(DROPBOX_DOWNLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: trimmed }),
      },
    });
    if (!resp.ok) throw new Error(`Dropbox download failed: ${resp.status}`);
    return await resp.json();
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Syncs a specific restore point to the connected cloud provider
 */
export async function syncRestorePointToCloud(shop, restorePointId) {
  // Checked before anything is written, and deliberately *not* inside the try
  // below: a plan that does not include cloud sync is not a failed upload, so
  // the restore point must not be stamped FAILED over it.
  const access = await checkCloudSyncAccess(shop);
  if (!access.allowed) {
    return { success: false, error: CLOUD_SYNC_UPGRADE_MESSAGE, upgradeRequired: true };
  }

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  if (!settings?.cloudSyncConnected) {
    return { success: false, error: "Cloud sync is not connected. Connect a provider in Settings." };
  }

  const provider = settings.cloudSyncProvider;
  const providerMeta = getProvider(provider);
  if (!providerMeta) {
    return { success: false, error: "No cloud provider configured." };
  }

  // Ownership guard: never let one shop push another shop's restore point.
  const rp = await prisma.restorePoint.findFirst({
    where: { id: restorePointId, shop },
    select: { id: true, name: true, createdAt: true },
  });
  if (!rp) {
    return { success: false, error: "Restore point not found." };
  }

  const folder = settings.cloudSyncFolder || "Revertly_Backups";
  const safeName = (rp.name || "backup").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 80);
  const dateStr = (rp.createdAt || new Date()).toISOString().slice(0, 10);
  const fileName = `revertly_${dateStr}_${safeName}.json`;

  try {
    // Checked inside the try so a misconfigured server is recorded as a sync
    // failure on the restore point, not silently left looking un-synced.
    if (!isProviderConfigured(provider)) {
      throw new Error(
        `${providerMeta.label} is not configured on this server (missing ${providerMeta.clientIdEnv}/${providerMeta.clientSecretEnv}).`,
      );
    }

    const accessToken = await getAccessToken(settings);
    const content = await serializeRestorePoint(restorePointId);

    const uploadResult =
      provider === "GOOGLE_DRIVE"
        ? await uploadToGoogleDrive(accessToken, folder, fileName, content)
        : await uploadToDropbox(accessToken, folder, fileName, content);

    await prisma.restorePoint.update({
      where: { id: restorePointId },
      data: {
        cloudSyncedAt: new Date(),
        cloudSyncStatus: "SYNCED",
        cloudProvider: provider,
      },
    });

    return {
      success: true,
      provider,
      uploadResult,
      bytes: content.length,
      message: `Backup synced to ${providerMeta.label} as "${fileName}".`,
    };
  } catch (err) {
    // Record the failure rather than leaving a stale SYNCED/NOT_SYNCED state —
    // a merchant must be able to see that their offsite copy did not happen.
    await prisma.restorePoint
      .update({
        where: { id: restorePointId },
        data: { cloudSyncStatus: "FAILED", cloudProvider: provider },
      })
      .catch(() => {});

    console.error(`[Cloud Sync] Upload failed for ${shop} rp#${restorePointId}:`, err?.message);
    return { success: false, provider, error: err?.message || "Cloud upload failed." };
  }
}

/**
 * Imports a backup from cloud storage and creates a restore point from it
 */
export async function importBackupFromCloud(shop, fileId) {
  const access = await checkCloudSyncAccess(shop);
  if (!access.allowed) {
    throw new Error(CLOUD_SYNC_UPGRADE_MESSAGE);
  }

  const data = await downloadCloudBackup(shop, fileId);
  if (!data?.restorePoint) {
    throw new Error("Invalid backup file format — missing restorePoint");
  }

  const rpData = data.restorePoint;

  // v1.0 files were written with a `productData` key that never held anything.
  // Accept both shapes so older exports still import, preferring the real one.
  const products = rpData.snapshotData ?? rpData.productData ?? undefined;
  const countOf = (v) => (Array.isArray(v) ? v.length : 0);

  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const provider =
    settings?.cloudSyncProvider && settings.cloudSyncProvider !== "NONE"
      ? settings.cloudSyncProvider
      : null;

  // Create a new restore point from the imported data. It is immediately
  // usable, so it must land as READY — leaving it at the CREATING default
  // would make it look like a stuck backup in the UI.
  // A cloud import is the merchant's own backup: it counts toward the plan's
  // restore-point allowance and is never rotated out.
  const { reserveRestorePointSlot, restorePointLimitMessage } = await import("./backup.server.js");
  const slot = await reserveRestorePointSlot(shop, { source: "MANUAL" });
  if (!slot.allowed) throw new Error(restorePointLimitMessage(slot.limit));

  const newRp = await prisma.restorePoint.create({
    data: {
      shop,
      name: `[Cloud Import] ${rpData.name || "Imported Backup"}`,
      description: `Imported from cloud on ${new Date().toISOString()}. Original: ${rpData.name}`,
      status: "READY",
      backupType: rpData.backupType || "FULL",
      snapshotData: products,
      themeData: rpData.themeData || undefined,
      collectionData: rpData.collectionData || undefined,
      pageData: rpData.pageData || undefined,
      articleData: rpData.articleData || undefined,
      menuData: rpData.menuData || undefined,
      metafieldData: rpData.metafieldData || undefined,
      orderData: rpData.orderData || undefined,
      customerData: rpData.customerData || undefined,
      productCount: rpData.counts?.products ?? countOf(products),
      themeCount: rpData.counts?.themes ?? (rpData.themeData ? 1 : 0),
      collectionCount: rpData.counts?.collections ?? countOf(rpData.collectionData),
      pageCount: rpData.counts?.pages ?? countOf(rpData.pageData),
      menuCount: rpData.counts?.menus ?? countOf(rpData.menuData),
      articleCount: rpData.counts?.articles ?? countOf(rpData.articleData?.articles),
      metafieldCount: rpData.counts?.metafields ?? (rpData.metafieldData?.counts?.metafields || 0),
      cloudSyncedAt: new Date(),
      cloudSyncStatus: "IMPORTED",
      cloudProvider: provider,
    },
  });

  return {
    success: true,
    restorePointId: newRp.id,
    name: newRp.name,
    productCount: newRp.productCount,
    message: `Successfully imported backup as restore point #${newRp.id}`,
  };
}
