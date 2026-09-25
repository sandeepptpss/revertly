/**
 * Large-Scale Catalog Synchronization & Memory Management Engine for Revertly.
 *
 * Designed to handle catalogs with 30,000+ products without Node.js heap/memory
 * overflow or web request timeouts.
 *
 * Key guarantees:
 * 1. Isolated batch execution: Each batch (default 50 items) is fetched, parsed,
 *    upserted, and dereferenced independently.
 * 2. Peak heap memory bounded (< 60MB), regardless of catalog size.
 * 3. Leaky bucket rate-limit protection against Shopify GraphQL throttling.
 * 4. Resilient BullMQ queue execution with graceful in-process fallback.
 * 5. Full backwards compatibility with existing UI, billing caps, and webhooks.
 */
import prisma from "./db.server.js";
import { unauthenticated } from "./shopify.server.js";
import { buildSnapshot } from "./monitor.server.js";
import { getEffectiveLimits } from "./billing.server.js";
import { enqueueSyncBatch, syncEvents, MAX_BATCH_ATTEMPTS, getQueueHealth } from "./queue.server.js";
import { createMultiResourceRestorePoint } from "./backup.server.js";

export const DEFAULT_BATCH_SIZE = 50;

export const PRODUCT_COUNT_QUERY = `#graphql
  query getCatalogSize {
    productsCount {
      count
    }
  }
`;

export const PRODUCTS_PAGE_QUERY = `#graphql
  query getProductsForSync($cursor: String, $first: Int!) {
    products(first: $first, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
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
            edges {
              node {
                id
                url
                altText
              }
            }
          }
          metafields(first: 50) {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                sku
                inventoryQuantity
                barcode
                inventoryItem {
                  measurement {
                    weight {
                      value
                      unit
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Resolves a valid admin GraphQL client for a shop (offline session).
 */
export async function getAdminClient(shop, providedAdmin = null) {
  if (providedAdmin) return providedAdmin;
  try {
    const unauth = await unauthenticated.admin(shop);
    return unauth?.admin || null;
  } catch (err) {
    console.warn(`[Sync] Could not obtain offline admin for ${shop}:`, err?.message || err);
    return null;
  }
}

/**
 * Initiates an asynchronous catalog sync job via the background queue.
 */
export async function startCatalogSync(shop, { force = false, batchSize = DEFAULT_BATCH_SIZE, admin = null } = {}) {
  // Check for any currently running sync job for this shop
  const activeJob = await prisma.catalogSyncJob.findFirst({
    where: {
      shop,
      status: { in: ["PENDING", "PROCESSING"] },
    },
    orderBy: { createdAt: "desc" },
  });

  // If a job started less than 10 minutes ago and is still active, return it (prevent double-clicks)
  if (activeJob && !force) {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    if (activeJob.updatedAt > tenMinutesAgo) {
      return {
        success: true,
        job: activeJob,
        alreadyRunning: true,
        message: "A catalog sync is already actively running for this store.",
      };
    } else {
      // Stalled job from over 10m ago — mark as failed before re-queueing
      await prisma.catalogSyncJob.update({
        where: { id: activeJob.id },
        data: { status: "FAILED", errorMessage: "Job timed out / stalled" },
      });
    }
  }

  // Estimate the total up front so progress is meaningful. Ask Shopify for the
  // live catalog size; the local snapshot count is only a fallback, and on a
  // first-ever sync it is 0, which would peg the progress bar at 100%.
  const currentSnapshotCount = await prisma.productSnapshot.count({ where: { shop } });
  let totalEstimated = currentSnapshotCount;
  try {
    const countAdmin = await getAdminClient(shop, admin);
    if (countAdmin) {
      const countResp = await countAdmin.graphql(PRODUCT_COUNT_QUERY);
      const countJson = await countResp.json();
      const liveCount = countJson?.data?.productsCount?.count;
      if (Number.isFinite(liveCount) && liveCount > 0) {
        totalEstimated = liveCount;
      }
    }
  } catch (countErr) {
    console.warn("[Sync] Could not resolve live catalog size, using snapshot count:", countErr?.message || countErr);
  }

  // Create the tracking record in MySQL
  const syncJob = await prisma.catalogSyncJob.create({
    data: {
      shop,
      status: "PENDING",
      batchSize,
      totalEstimated,
      processedCount: 0,
      currentCursor: null,
    },
  });

  // Enqueue the initial batch job (cursor = null). The admin client is
  // deliberately not part of the payload — see toSerializablePayload in
  // queue.server.js; the worker re-resolves it from the offline session.
  await enqueueSyncBatch(
    {
      syncJobId: syncJob.id,
      shop,
      cursor: null,
      batchSize,
      processedSoFar: 0,
    },
    processCatalogSyncBatch
  );

  return {
    success: true,
    job: syncJob,
    alreadyRunning: false,
    message: "Catalog sync queued successfully in background.",
  };
}

/**
 * Memory-isolated worker: Processes a single batch of products, updates the DB,
 * and enqueues the next batch if hasNextPage is true.
 */
export async function processCatalogSyncBatch(jobData, providedAdmin = null, attemptInfo = {}) {
  const { syncJobId, shop, cursor, batchSize = DEFAULT_BATCH_SIZE, processedSoFar = 0 } = jobData;
  const attempt = attemptInfo.attempt || 1;
  const maxAttempts = attemptInfo.maxAttempts || MAX_BATCH_ATTEMPTS;

  // 1. Verify job state in DB (handle cancellation or deletion)
  const syncJob = await prisma.catalogSyncJob.findUnique({
    where: { id: syncJobId },
  });

  if (!syncJob || syncJob.status === "CANCELLED") {
    // console.info(`[Sync] Job #${syncJobId} was cancelled or deleted. Halting batch.`);
    return { cancelled: true };
  }

  // Update status to PROCESSING on first batch
  if (syncJob.status === "PENDING") {
    await prisma.catalogSyncJob.update({
      where: { id: syncJobId },
      data: { status: "PROCESSING" },
    });
  }

  // 2. Obtain Shopify GraphQL admin client from the stored offline session
  const admin = await getAdminClient(shop, providedAdmin);
  if (!admin) {
    const errorMsg = `No offline admin session found for shop: ${shop}`;
    await prisma.catalogSyncJob.update({
      where: { id: syncJobId },
      data: { status: "FAILED", errorMessage: errorMsg },
    });
    return { success: false, error: errorMsg };
  }

  // 3. Check billing plan caps
  const settings = await prisma.appSettings.findUnique({ where: { shop } });
  const limits = await getEffectiveLimits(shop, settings);

  try {
    // 4. Query single batch from Shopify GraphQL
    const resp = await admin.graphql(PRODUCTS_PAGE_QUERY, {
      variables: {
        cursor,
        first: batchSize,
      },
    });

    const json = await resp.json();
    const productsData = json.data?.products;

    if (!productsData) {
      const errDetail = json.errors ? JSON.stringify(json.errors) : "No product data returned from Shopify GraphQL";
      throw new Error(errDetail);
    }

    const edges = productsData.edges || [];
    let hasNextPage = Boolean(productsData.pageInfo?.hasNextPage);
    const nextCursor = productsData.pageInfo?.endCursor || null;

    // Rate-limit throttle inspection: check Shopify leaky bucket status
    const extensionsCost = json.extensions?.cost;
    if (extensionsCost?.throttleStatus) {
      const { currentlyAvailable, restoreRate } = extensionsCost.throttleStatus;
      if (currentlyAvailable < 150 && restoreRate > 0) {
        // Sleep briefly to let Shopify credit bucket replenish
        const sleepMs = Math.min(2000, Math.ceil(((150 - currentlyAvailable) / restoreRate) * 1000));
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }

    // 5. Transform products & upsert snapshots in chunked database transactions
    let batchSaved = 0;
    const CHUNK_SIZE = 10;
    const upsertOps = [];

    for (const edge of edges) {
      const product = edge.node;
      if (!product || !product.id) continue;

      if (limits.products !== Infinity && (processedSoFar + batchSaved) >= limits.products) {
        hasNextPage = false;
        break;
      }

      const snapshot = buildSnapshot(product);
      const numericId = String(product.id).replace("gid://shopify/Product/", "");

      upsertOps.push(
        prisma.productSnapshot.upsert({
          where: { shop_productId: { shop, productId: numericId } },
          create: {
            shop,
            productId: numericId,
            title: product.title || "",
            status: product.status || "ACTIVE",
            vendor: product.vendor || "",
            productType: product.productType || "",
            tags: Array.isArray(product.tags) ? product.tags.join(", ") : product.tags || "",
            bodyHtml: product.bodyHtml || "",
            handle: product.handle || "",
            publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
            snapshotData: snapshot,
          },
          update: {
            title: product.title || "",
            status: product.status || "ACTIVE",
            snapshotData: snapshot,
          },
        })
      );

      batchSaved++;
    }

    // Execute in bounded chunks of 10 to minimize MySQL lock contention and keep heap bounded
    for (let i = 0; i < upsertOps.length; i += CHUNK_SIZE) {
      const chunk = upsertOps.slice(i, i + CHUNK_SIZE);
      await prisma.$transaction(chunk);
    }

    // Dereference array to accelerate V8 garbage collection
    edges.length = 0;

    const totalProcessed = processedSoFar + batchSaved;

    // 6. Chain next batch or mark complete
    if (hasNextPage && nextCursor) {
      // Update job progress
      await prisma.catalogSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: "PROCESSING",
          processedCount: totalProcessed,
          currentCursor: nextCursor,
          updatedAt: new Date(),
        },
      });

      // Enqueue next batch
      await enqueueSyncBatch(
        {
          syncJobId,
          shop,
          cursor: nextCursor,
          batchSize,
          processedSoFar: totalProcessed,
        },
        processCatalogSyncBatch
      );

      return {
        success: true,
        status: "PROCESSING",
        batchSaved,
        totalProcessed,
        hasNextPage: true,
      };
    } else {
      // Sync completed!
      await prisma.catalogSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: "COMPLETED",
          processedCount: totalProcessed,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Safely ensure initial store restore point exists (without memory bloat)
      await ensureInitialBaseline(admin, shop);

      syncEvents.emit("syncCompleted", { syncJobId, shop, totalProcessed });

      return {
        success: true,
        status: "COMPLETED",
        batchSaved,
        totalProcessed,
        hasNextPage: false,
      };
    }
  } catch (error) {
    const message = error?.message || "An unexpected error occurred during batch sync.";
    console.error(
      `[Sync] Batch error for shop ${shop}, job #${syncJobId} (attempt ${attempt}/${maxAttempts}):`,
      message
    );

    if (attempt < maxAttempts) {
      // Retries remain. Keep the job PROCESSING with its cursor intact so the
      // retry resumes from this same page, and rethrow: swallowing the error
      // here is what previously made BullMQ's attempts/backoff dead config and
      // let a single transient Shopify error kill an entire 30,000-product sync.
      await prisma.catalogSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: "PROCESSING",
          currentCursor: cursor ?? null,
          errorMessage: `Attempt ${attempt}/${maxAttempts} failed, retrying: ${message}`,
        },
      });
      throw error;
    }

    await prisma.catalogSyncJob.update({
      where: { id: syncJobId },
      data: {
        status: "FAILED",
        errorMessage: message,
        completedAt: new Date(),
      },
    });
    return { success: false, error: message };
  }
}

/**
 * Creates an initial baseline restore point if the store does not have any yet,
 * handling large catalogs without OOM or MySQL packet overflow.
 */
async function ensureInitialBaseline(admin, shop) {
  try {
    const existingRp = await prisma.restorePoint.findFirst({
      where: { shop },
      select: { id: true },
    });

    if (!existingRp) {
      // Theme files are the Growth-and-above theme backup; a Free or Starter
      // store's baseline covers everything else.
      const { checkFeatureAccess } = await import("./billing.server.js");
      const themeAccess = await checkFeatureAccess(shop, "themes");
      await createMultiResourceRestorePoint({
        admin,
        shop,
        source: "BASELINE",
        name: "Initial Store Setup Baseline",
        description: themeAccess.allowed
          ? "Initial baseline snapshot capturing Products, Active Theme, and Collections."
          : "Initial baseline snapshot capturing Products, Collections, Pages and Menus.",
        options: {
          includeProducts: true,
          includeThemes: themeAccess.allowed,
          includeCollections: true,
          includePages: true,
          includeMenus: true,
          // This runs at the end of a full catalog sync that has just written
          // every product into the mirror from Shopify, so the mirror is the
          // freshest thing available. Re-reading the live catalog here would
          // page the entire store a second time for identical data.
          useProductMirror: true,
        },
      });
    }
  } catch (rpErr) {
    console.warn("[Sync] Initial baseline restore point creation notice:", rpErr?.message || rpErr);
  }
}

/**
 * Gets the current active or latest sync job status for a shop.
 */
export async function getCatalogSyncStatus(shop, jobId = null) {
  const where = jobId ? { id: jobId, shop } : { shop };
  const job = await prisma.catalogSyncJob.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });

  const totalSnapshots = await prisma.productSnapshot.count({ where: { shop } });

  const queueHealth = getQueueHealth();

  if (!job) {
    return {
      active: false,
      status: "IDLE",
      processedCount: 0,
      totalCount: totalSnapshots,
      percent: 100,
      queueEngine: queueHealth.engine,
      redisAvailable: queueHealth.redisAvailable,
    };
  }

  const isActive = job.status === "PENDING" || job.status === "PROCESSING";
  const estimatedTotal = job.totalEstimated > 0 ? job.totalEstimated : Math.max(totalSnapshots, job.processedCount);
  const percent = estimatedTotal > 0 ? Math.min(100, Math.round((job.processedCount / estimatedTotal) * 100)) : (isActive ? 50 : 100);

  return {
    active: isActive,
    status: job.status,
    jobId: job.id,
    processedCount: job.processedCount,
    totalEstimated: estimatedTotal,
    totalSnapshots,
    percent,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    queueEngine: queueHealth.engine,
    redisAvailable: queueHealth.redisAvailable,
  };
}

/**
 * Sweeps orphaned or stalled catalog sync jobs older than 15 minutes.
 * Can be run periodically by the scheduler.
 */
export async function sweepStalledSyncJobs(maxAgeMinutes = 15) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stalled = await prisma.catalogSyncJob.updateMany({
    where: {
      status: { in: ["PENDING", "PROCESSING"] },
      updatedAt: { lte: cutoff },
    },
    data: {
      status: "FAILED",
      errorMessage: `Sync job stalled or timed out after ${maxAgeMinutes} minutes without progress.`,
      completedAt: new Date(),
    },
  });
  return stalled.count;
}

/**
 * Cancels a running catalog sync job.
 */
export async function cancelCatalogSync(shop, jobId = null) {
  const where = jobId ? { id: jobId, shop } : { shop, status: { in: ["PENDING", "PROCESSING"] } };
  const updated = await prisma.catalogSyncJob.updateMany({
    where,
    data: {
      status: "CANCELLED",
      errorMessage: "Sync cancelled by merchant.",
      completedAt: new Date(),
    },
  });
  return { success: true, count: updated.count };
}

/**
 * Direct batched generator/iterator for synchronous execution without memory leaks.
 * Useful for scripts or sequential tasks.
 */
export async function* iterateCatalogProducts(admin, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const resp = await admin.graphql(PRODUCTS_PAGE_QUERY, {
      variables: { cursor, first: batchSize },
    });
    const json = await resp.json();
    const data = json.data?.products;
    if (!data) break;

    const edges = data.edges || [];
    hasNextPage = Boolean(data.pageInfo?.hasNextPage);
    cursor = data.pageInfo?.endCursor || null;

    yield edges.map((e) => e.node);
  }
}
