/**
 * Automated QA & backup-integrity diagnostics.
 *
 * Every check here reads real state and can genuinely fail. The point of this
 * feature is to catch a backup pipeline that has quietly stopped working, so a
 * suite that always passes would be worse than none at all.
 */
import prisma from "./db.server.js";
import { getEffectiveLimits } from "./billing.server.js";
import { listCloudBackups, isProviderConfigured } from "./cloudSync.server.js";

const PASS = "PASS";
const WARN = "WARN";
const FAIL = "FAIL";

// Weights reflect blast radius: a missing baseline or an unreadable backup
// means restores cannot work at all.
const WEIGHTS = {
  baseline_snapshot: 25,
  restore_point_integrity: 25,
  backup_schedule: 15,
  webhook_coverage: 10,
  detection_rules: 10,
  retention_policy: 5,
  cloud_sync: 10,
};

const result = (id, label, status, message, remediation = null) => ({
  id,
  label,
  status,
  message,
  remediation,
});

/** A monitoring baseline must exist, or nothing can be compared or restored. */
async function checkBaselineSnapshot(shop) {
  const count = await prisma.productSnapshot.count({ where: { shop, isDeleted: false } });
  if (count === 0) {
    return result(
      "baseline_snapshot",
      "Product baseline snapshot",
      FAIL,
      "No product snapshots exist for this store.",
      "Open Initialize and run 'Initialize Monitoring' to capture a baseline.",
    );
  }

  const newest = await prisma.productSnapshot.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const ageDays = newest ? (Date.now() - newest.updatedAt.getTime()) / 86_400_000 : Infinity;

  if (ageDays > 30) {
    return result(
      "baseline_snapshot",
      "Product baseline snapshot",
      WARN,
      `${count} products tracked, but the newest snapshot is ${Math.floor(ageDays)} days old.`,
      "Confirm the products/update webhook is delivering, or re-run Initialize.",
    );
  }

  return result("baseline_snapshot", "Product baseline snapshot", PASS, `${count} products tracked and current.`);
}

/**
 * The most important check: prove the latest backup is actually readable and
 * carries product data, rather than being an empty shell that looks fine.
 */
async function checkRestorePointIntegrity(shop) {
  const rp = await prisma.restorePoint.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      snapshotData: true,
    },
  });

  if (!rp) {
    return result(
      "restore_point_integrity",
      "Latest backup integrity",
      FAIL,
      "This store has no restore points.",
      "Create a restore point, or enable automated daily backups in Settings.",
    );
  }

  if (rp.status === "CREATING") {
    const stuckMin = (Date.now() - rp.createdAt.getTime()) / 60_000;
    if (stuckMin > 30) {
      return result(
        "restore_point_integrity",
        "Latest backup integrity",
        FAIL,
        `Backup "${rp.name}" has been stuck in CREATING for ${Math.floor(stuckMin)} minutes.`,
        "The backup job did not finish. Re-run it and check server logs.",
      );
    }
  }

  if (rp.status === "FAILED") {
    return result(
      "restore_point_integrity",
      "Latest backup integrity",
      FAIL,
      `The most recent backup "${rp.name}" failed.`,
      "Re-run the backup and review server logs for the cause.",
    );
  }

  const products = Array.isArray(rp.snapshotData) ? rp.snapshotData : null;
  if (!products) {
    return result(
      "restore_point_integrity",
      "Latest backup integrity",
      FAIL,
      `Backup "${rp.name}" contains no readable product payload.`,
      "Delete the corrupt restore point and take a fresh backup.",
    );
  }

  if (products.length === 0) {
    return result(
      "restore_point_integrity",
      "Latest backup integrity",
      WARN,
      `Backup "${rp.name}" holds zero products.`,
      "If this store has products, re-run Initialize before the next backup.",
    );
  }

  // A restore reads snapshotData[].snapshotData — verify that shape survived.
  const usable = products.filter((p) => p && (p.snapshotData || p.title || p.id)).length;
  if (usable === 0) {
    return result(
      "restore_point_integrity",
      "Latest backup integrity",
      FAIL,
      `Backup "${rp.name}" has ${products.length} entries but none are in a restorable shape.`,
      "Take a fresh backup; this one cannot be used to restore.",
    );
  }

  const ageH = (Date.now() - rp.createdAt.getTime()) / 3_600_000;
  if (ageH > 48) {
    return result(
      "restore_point_integrity",
      "Latest backup integrity",
      WARN,
      `Newest backup is ${Math.floor(ageH / 24)} days old (${usable} restorable products).`,
      "Enable automated daily backups so a recent restore point always exists.",
    );
  }

  return result(
    "restore_point_integrity",
    "Latest backup integrity",
    PASS,
    `"${rp.name}" is readable with ${usable} restorable products.`,
  );
}

/** The schedule must be both enabled and actually advancing. */
async function checkBackupSchedule(shop, settings) {
  if (!settings || settings.autoBackupSchedule === "OFF") {
    return result(
      "backup_schedule",
      "Automated backup schedule",
      WARN,
      "Automated backups are switched off.",
      "Enable a daily schedule in Settings so backups do not depend on manual action.",
    );
  }

  if (!settings.nextAutoBackupAt) {
    return result(
      "backup_schedule",
      "Automated backup schedule",
      FAIL,
      `Schedule is ${settings.autoBackupSchedule} but no next run is scheduled.`,
      "Re-save Settings to recompute the next backup time.",
    );
  }

  // A next-run far in the past means the runner is not executing.
  const overdueMin = (Date.now() - settings.nextAutoBackupAt.getTime()) / 60_000;
  if (overdueMin > 120) {
    return result(
      "backup_schedule",
      "Automated backup schedule",
      FAIL,
      `The next backup was due ${Math.floor(overdueMin / 60)} hours ago and has not run.`,
      "The scheduler is not running. Check the server process or the /api/cron/backups job.",
    );
  }

  return result(
    "backup_schedule",
    "Automated backup schedule",
    PASS,
    `${settings.autoBackupSchedule} at ${settings.autoBackupTime} UTC; next run ${settings.nextAutoBackupAt.toISOString()}.`,
  );
}

/** Real-time protection depends on webhooks delivering. */
async function checkWebhookCoverage(shop) {
  const recent = await prisma.changeEvent.count({
    where: { shop, changedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  });
  const tracked = await prisma.productSnapshot.count({ where: { shop } });

  if (tracked === 0) {
    return result(
      "webhook_coverage",
      "Real-time change capture",
      WARN,
      "No products tracked yet, so webhook delivery cannot be confirmed.",
      "Run Initialize first.",
    );
  }

  if (recent === 0) {
    return result(
      "webhook_coverage",
      "Real-time change capture",
      WARN,
      "No product changes recorded in the last 30 days.",
      "Normal for a quiet catalog. If you have edited products recently, verify the products/update webhook.",
    );
  }

  return result("webhook_coverage", "Real-time change capture", PASS, `${recent} change events captured in the last 30 days.`);
}

/** Rules with impossible thresholds silently never fire. */
async function checkDetectionRules(shop) {
  const rules = await prisma.detectionRule.findMany({ where: { shop } });
  const active = rules.filter((r) => r.isActive);

  if (active.length === 0) {
    return result(
      "detection_rules",
      "Detection rules",
      WARN,
      "No active detection rules.",
      "Add at least one rule (e.g. price drop over 30%) so anomalies raise incidents.",
    );
  }

  const broken = active.filter(
    (r) =>
      (r.condition === "DECREASE_BY_PERCENT" || r.condition === "INCREASE_BY_PERCENT") &&
      (r.threshold == null || r.threshold <= 0 || r.threshold > 100),
  );

  if (broken.length > 0) {
    return result(
      "detection_rules",
      "Detection rules",
      FAIL,
      `${broken.length} rule(s) have an out-of-range threshold and can never trigger: ${broken.map((r) => r.name).join(", ")}.`,
      "Set each percentage threshold between 1 and 100.",
    );
  }

  return result("detection_rules", "Detection rules", PASS, `${active.length} active rule(s) configured correctly.`);
}

/** History held beyond the plan window indicates retention is not running. */
async function checkRetentionPolicy(shop, settings) {
  const limits = await getEffectiveLimits(shop, settings);
  const retentionDays = limits.retentionDays || 7;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  const stale = await prisma.restorePoint.count({ where: { shop, createdAt: { lt: cutoff } } });
  const total = await prisma.restorePoint.count({ where: { shop } });

  // The policy intentionally keeps the two newest restore points regardless.
  if (stale > 0 && total > 2) {
    return result(
      "retention_policy",
      "Retention policy",
      WARN,
      `${stale} restore point(s) are older than the ${retentionDays}-day window for your plan.`,
      "Retention runs with the scheduled sweep; confirm the scheduler is running.",
    );
  }

  return result("retention_policy", "Retention policy", PASS, `History within the ${retentionDays}-day plan window.`);
}

/** If cloud sync claims to be connected, prove the credentials still work. */
async function checkCloudSync(shop, settings) {
  if (!settings?.cloudSyncConnected) {
    return result("cloud_sync", "Offsite cloud sync", WARN, "No cloud provider connected.", "Connect Google Drive or Dropbox in Settings for offsite copies.");
  }

  if (!isProviderConfigured(settings.cloudSyncProvider)) {
    return result(
      "cloud_sync",
      "Offsite cloud sync",
      FAIL,
      `${settings.cloudSyncProvider} is marked connected but the server has no OAuth credentials for it.`,
      "Set the provider's client ID and secret in the environment, then reconnect.",
    );
  }

  try {
    const res = await listCloudBackups(shop);
    if (!res.success) {
      return result("cloud_sync", "Offsite cloud sync", FAIL, `Cloud provider rejected the request: ${res.error}`, "Reconnect the provider in Settings.");
    }
    const failedSyncs = await prisma.restorePoint.count({ where: { shop, cloudSyncStatus: "FAILED" } });
    if (failedSyncs > 0) {
      return result("cloud_sync", "Offsite cloud sync", WARN, `Reachable, but ${failedSyncs} backup(s) failed to upload.`, "Retry the sync from Restore Points.");
    }
    return result("cloud_sync", "Offsite cloud sync", PASS, `Connected; ${res.files?.length ?? 0} backup file(s) offsite.`);
  } catch (err) {
    return result("cloud_sync", "Offsite cloud sync", FAIL, `Could not reach the provider: ${err?.message}`, "Reconnect the provider in Settings.");
  }
}

/**
 * Runs the full suite and persists a QaTestRun.
 */
export async function runQaSuite(shop) {
  const settings = await prisma.appSettings.findUnique({ where: { shop } });

  const checks = await Promise.all([
    checkBaselineSnapshot(shop),
    checkRestorePointIntegrity(shop),
    checkBackupSchedule(shop, settings),
    checkWebhookCoverage(shop),
    checkDetectionRules(shop),
    checkRetentionPolicy(shop, settings),
    checkCloudSync(shop, settings),
  ]);

  // Weighted score: a WARN costs half of its check's weight, a FAIL all of it.
  let lost = 0;
  let possible = 0;
  for (const c of checks) {
    const w = WEIGHTS[c.id] ?? 10;
    possible += w;
    if (c.status === FAIL) lost += w;
    else if (c.status === WARN) lost += w / 2;
  }
  const healthScore = Math.max(0, Math.round(((possible - lost) / possible) * 100));

  const failed = checks.filter((c) => c.status === FAIL).length;
  const warned = checks.filter((c) => c.status === WARN).length;
  const status = failed > 0 ? "FAILED" : warned > 0 ? "WARNING" : "PASSED";

  const summary =
    failed > 0
      ? `${failed} check(s) failed and ${warned} raised warnings.`
      : warned > 0
        ? `All critical checks passed; ${warned} warning(s).`
        : "All checks passed.";

  const run = await prisma.qaTestRun.create({
    data: { shop, healthScore, status, summary, testResults: checks },
  });

  return { run, healthScore, status, summary, checks };
}

/** Nightly sweep: one run per shop per 24h. */
export async function runDueQaSuites() {
  const shops = await prisma.appSettings.findMany({ select: { shop: true } });
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const results = [];

  for (const { shop } of shops) {
    try {
      const recent = await prisma.qaTestRun.findFirst({
        where: { shop, testedAt: { gte: dayAgo } },
        select: { id: true },
      });
      if (recent) continue;

      const previous = await prisma.qaTestRun.findFirst({
        where: { shop },
        orderBy: { testedAt: "desc" },
      });

      const res = await runQaSuite(shop);
      results.push({ shop, healthScore: res.healthScore, status: res.status });

      // Alert only on a regression, not on a store that is steadily unhealthy.
      if (previous && previous.status !== "FAILED" && res.status === "FAILED") {
        await alertQaRegression(shop, res).catch(() => {});
      }
    } catch (err) {
      results.push({ shop, error: err?.message || String(err) });
    }
  }

  return { timestamp: new Date().toISOString(), checkedShops: shops.length, ran: results.length, results };
}

async function alertQaRegression(shop, res) {
  const { getOrCreateSettings, sendIncidentAlert } = await import("./monitor.server.js");
  const settings = await getOrCreateSettings(shop);
  const failing = res.checks.filter((c) => c.status === "FAIL").map((c) => c.label);
  await sendIncidentAlert(
    shop,
    {
      id: `qa-${res.run.id}`,
      name: `Backup health check failed: ${failing.join(", ")}`,
      severity: "HIGH",
      status: "OPEN",
      affectedCount: failing.length,
      notes: res.summary,
    },
    settings,
  );
}
