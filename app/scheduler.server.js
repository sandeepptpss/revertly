/**
 * Automated Backup Scheduler & Background Runner for Revertly
 * Handles daily, twice-daily, and weekly automated backups.
 */
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";
import { createMultiResourceRestorePoint, enforceBackupRetentionPolicy } from "./backup.server.js";
import { withJobLock } from "./cron.server.js";
import { syncRestorePointToCloud } from "./cloudSync.server.js";
import { runDueServiceChecks } from "./uptime.server.js";
import { runDueQaSuites } from "./qa.server.js";
import { checkFeatureAccess } from "./billing.server.js";

/**
 * Computes the next scheduled backup timestamp based on cadence and UTC preferred time
 */
export function computeNextAutoBackup(schedule, timeStr, fromDate = new Date()) {
  if (!schedule || schedule === "OFF") return null;
  const [hours, minutes] = (timeStr || "02:00").split(":").map((v) => parseInt(v, 10) || 0);
  const now = new Date(fromDate);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));

  if (next.getTime() <= now.getTime()) {
    if (schedule === "TWICE_DAILY") {
      next.setUTCHours(next.getUTCHours() + 12);
    } else if (schedule === "WEEKLY") {
      next.setUTCDate(next.getUTCDate() + 7);
    } else {
      // DAILY
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next;
}

/**
 * Executes a scheduled backup for a single shop
 */
export async function runScheduledBackupForShop(shop, { force = false, source = "AUTOMATED_SCHEDULE" } = {}) {
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  if (!settings) {
    return { success: false, error: `No settings found for shop: ${shop}` };
  }

  if (!force && settings.autoBackupSchedule === "OFF") {
    return { success: false, skipped: true, reason: "Auto backups disabled for shop" };
  }

  const now = new Date();
  if (!force && settings.nextAutoBackupAt && settings.nextAutoBackupAt > now) {
    return { success: false, skipped: true, reason: "Backup not yet due" };
  }

  // Obtain admin GraphQL client
  let admin = null;
  try {
    const unauth = await unauthenticated.admin(shop);
    admin = unauth?.admin;
  } catch (authErr) {
    console.warn(`[Scheduler] Could not instantiate offline admin for ${shop}: ${authErr?.message}`);
  }

  const timestampStr = now.toISOString().slice(0, 16).replace("T", " ");
  const backupName = `Automated Daily Backup - ${timestampStr} UTC`;

  const themeCheck = await checkFeatureAccess(shop, "themes");

  const backupRes = await createMultiResourceRestorePoint({
    admin,
    shop,
    name: backupName,
    description: `Automated ${settings.autoBackupSchedule.toLowerCase()} snapshot executed automatically by Revertly Guardian (${source}).`,
    options: {
      includeProducts: true,
      includeThemes: Boolean(admin && themeCheck.allowed),
      includeCollections: Boolean(admin),
      includePages: Boolean(admin),
      includeMenus: Boolean(admin),
      includeArticles: Boolean(admin),
    },
  });

  if (!backupRes.success) {
    return { success: false, error: backupRes.message || "Failed to create automated snapshot" };
  }

  const rp = backupRes.restorePoint;

  // Cloud Auto-Sync if enabled. This performs a real upload; it must never
  // stamp SYNCED without one, or merchants believe they have an offsite copy
  // that does not exist.
  // A store that drops to Free keeps its stored connection, so the entitlement
  // is re-checked on every run rather than trusted from the saved flags.
  const cloudSyncAccess = await checkFeatureAccess(shop, "cloudSync");

  let cloudSync = null;
  if (cloudSyncAccess.allowed && settings.cloudSyncConnected && settings.cloudSyncAutoUpload && rp) {
    try {
      cloudSync = await syncRestorePointToCloud(shop, rp.id);
      if (!cloudSync.success) {
        console.warn(`[Scheduler] Auto cloud-sync failed for ${shop}: ${cloudSync.error}`);
      }
    } catch (cloudErr) {
      cloudSync = { success: false, error: cloudErr?.message || String(cloudErr) };
      console.warn(`[Scheduler] Auto cloud-sync error for ${shop}:`, cloudErr?.message);
    }
  }

  // Calculate new nextAutoBackupAt and update lastAutoBackupAt
  const nextBackup = computeNextAutoBackup(settings.autoBackupSchedule, settings.autoBackupTime, now);
  await prisma.appSettings.update({
    where: { shop },
    data: {
      lastAutoBackupAt: now,
      nextAutoBackupAt: nextBackup,
    },
  });

  // Log in AuditLog
  try {
    await prisma.auditLog.create({
      data: {
        shop,
        userEmail: "system@revertly.internal",
        userName: "Revertly Automated Guardian",
        action: "AUTOMATED_BACKUP_EXECUTED",
        resourceType: "RestorePoint",
        resourceId: String(rp.id),
        details: {
          restorePointId: rp.id,
          schedule: settings.autoBackupSchedule,
          summary: backupRes.summary,
        },
      },
    });
  } catch (auditErr) {
    // Audit logging is non-blocking
  }

  return {
    success: true,
    shop,
    restorePointId: rp.id,
    lastAutoBackupAt: now,
    nextAutoBackupAt: nextBackup,
    summary: backupRes.summary,
    cloudSync,
  };
}

/**
 * Sweeps all shops and runs due automated backups
 */
export async function runDueAutomatedBackups() {
  const now = new Date();
  const dueSettings = await prisma.appSettings.findMany({
    where: {
      autoBackupSchedule: { not: "OFF" },
      OR: [
        { nextAutoBackupAt: null },
        { nextAutoBackupAt: { lte: now } },
      ],
    },
  });

  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (const s of dueSettings) {
    try {
      const res = await runScheduledBackupForShop(s.shop, { force: false });
      if (res.success) {
        successCount++;
      } else if (!res.skipped) {
        failedCount++;
      }

      results.push({ shop: s.shop, ...res });
    } catch (err) {
      failedCount++;
      results.push({ shop: s.shop, success: false, error: err?.message || String(err) });
    }
  }

  // Retention is a data-protection obligation, not a side effect of backing up:
  // a shop that has auto-backups switched OFF must still have history pruned to
  // its plan's window. So sweep every shop, not just the ones backed up above.
  const retentionResults = await enforceRetentionForAllShops();

  return {
    timestamp: now.toISOString(),
    checkedCount: dueSettings.length,
    successCount,
    failedCount,
    results,
    retention: retentionResults,
  };
}

/**
 * Applies each shop's plan retention window, independently of backup scheduling.
 */
export async function enforceRetentionForAllShops() {
  const shops = await prisma.appSettings.findMany({ select: { shop: true } });
  const summary = { sweptShops: 0, deletedRestorePoints: 0, deletedChangeEvents: 0, errors: [] };

  for (const { shop } of shops) {
    try {
      const res = await enforceBackupRetentionPolicy(shop);
      summary.sweptShops++;
      summary.deletedRestorePoints += res.deletedRestorePoints || 0;
      summary.deletedChangeEvents += res.deletedChangeEvents || 0;
    } catch (err) {
      summary.errors.push({ shop, error: err?.message || String(err) });
      console.warn(`[Scheduler] Retention enforcement warning for ${shop}:`, err?.message);
    }
  }

  return summary;
}

let schedulerTimer = null;

/**
 * Runs every due scheduled job once. Each sweep takes its own lock so that a
 * deployment running several web instances still performs each sweep once.
 * Exported so the secured cron endpoints can drive the same code path.
 */
export async function runAllDueJobs() {
  const [backups, uptime, qa] = await Promise.all([
    withJobLock("backups:sweep", 30 * 60 * 1000, () => runDueAutomatedBackups()).catch((err) => ({
      error: err?.message || String(err),
    })),
    withJobLock("uptime:sweep", 10 * 60 * 1000, () => runDueServiceChecks()).catch((err) => ({
      error: err?.message || String(err),
    })),
    withJobLock("qa:sweep", 30 * 60 * 1000, () => runDueQaSuites()).catch((err) => ({
      error: err?.message || String(err),
    })),
  ]);

  return { backups, uptime, qa };
}

/**
 * Initializes in-process background scheduler interval
 */
export function initBackgroundScheduler(intervalMinutes = 5) {
  if (schedulerTimer) return schedulerTimer;
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  schedulerTimer = setInterval(async () => {
    try {
      await runAllDueJobs();
    } catch (err) {
      console.error("[Scheduler] Interval execution error:", err);
    }
  }, intervalMs);

  if (typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref(); // Don't block Node process exit
  }
  return schedulerTimer;
}
