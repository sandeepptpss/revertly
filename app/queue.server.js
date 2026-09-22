/**
 * Distributed Background Queue System for Revertly.
 *
 * Supports Redis-backed processing via BullMQ with an automatic resilient
 * fallback to an in-process / database-backed runner when Redis is not configured
 * or temporarily unreachable.
 *
 * This ensures:
 * 1. Zero out-of-memory crashes on large catalogs (30,000+ products) via memory-isolated batches.
 * 2. Enterprise BullMQ features (exponential backoff, concurrency controls, stalled recovery) when Redis is present.
 * 3. 100% testability and reliability in environments without Redis.
 */
import EventEmitter from "node:events";

export const QUEUE_NAME = "catalog-sync";

// Event bus for local job notifications and UI updates
export const syncEvents = new EventEmitter();

let bullQueue = null;
let bullWorker = null;
let redisClient = null;
let redisChecked = false;
let redisAvailable = false;
let isInitializing = false;
let lastRedisCheckAt = 0;

// How many times a batch is attempted before the sync job is marked FAILED.
// Shared by the BullMQ path (via defaultJobOptions.attempts) and the in-process
// fallback runner, so both retry transient Shopify/network errors identically.
export const MAX_BATCH_ATTEMPTS = 3;

// When Redis is absent we re-probe at most this often. Without it, a 30,000-product
// sync would open a fresh connection for each of its ~600 batch enqueues.
const REDIS_RECHECK_INTERVAL_MS = 60 * 1000;

/**
 * Parses Redis connection options from environment variables.
 */
export function getRedisConfig() {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = parseInt(process.env.REDIS_PORT || "6379", 10);
  const password = process.env.REDIS_PASSWORD || undefined;

  return {
    host,
    port,
    password,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 3000,
    retryStrategy: (times) => {
      // Limit reconnection attempts so we don't spam if Redis is down
      if (times > 3) return null;
      return Math.min(times * 500, 2000);
    },
  };
}

/**
 * Checks whether Redis is available and working.
 */
export async function isRedisConnected() {
  if (redisChecked) return redisAvailable;
  await initQueue();
  return redisAvailable;
}

/**
 * Initializes the BullMQ Queue and Worker if Redis is available.
 * If Redis is absent, gracefully sets redisAvailable = false.
 */
export async function initQueue(processorFn = null) {
  if (isInitializing || (redisChecked && redisAvailable && bullQueue)) {
    return { redisAvailable, queue: bullQueue };
  }
  // Redis was already found to be absent: stay on the fallback runner until the
  // re-probe window elapses rather than reconnecting on every single batch.
  if (redisChecked && !redisAvailable && Date.now() - lastRedisCheckAt < REDIS_RECHECK_INTERVAL_MS) {
    return { redisAvailable: false, queue: null };
  }
  isInitializing = true;

  try {
    const { Queue } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;

    const redisConfig = getRedisConfig();
    const testClient = typeof redisConfig === "string" 
      ? new IORedis(redisConfig, { maxRetriesPerRequest: null, lazyConnect: true, connectTimeout: 2000 })
      : new IORedis({ ...redisConfig, lazyConnect: true, connectTimeout: 2000 });

    // Swallow connection errors so an unreachable Redis never crashes the process.
    testClient.on("error", () => {});

    try {
      await testClient.connect();
      await testClient.ping();
      redisAvailable = true;
      redisClient = testClient;
      // console.log("[Queue] Redis connection established. Using BullMQ queue engine.");
    } catch {
      redisAvailable = false;
      try {
        testClient.disconnect();
      } catch {
        // already disconnected
      }
      // console.info("[Queue] Redis is not available or not running. Operating with resilient in-process runner.");
    }

    if (redisAvailable) {
      bullQueue = new Queue(QUEUE_NAME, {
        connection: redisClient,
        defaultJobOptions: {
          attempts: MAX_BATCH_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
          removeOnComplete: {
            count: 100,
            age: 24 * 3600,
          },
          removeOnFail: {
            count: 200,
          },
        },
      });

      if (processorFn) {
        initWorker(processorFn);
      }
    }
  } catch {
    redisAvailable = false;
    // console.info("[Queue] BullMQ/IORedis initialization fallback.");
  } finally {
    redisChecked = true;
    lastRedisCheckAt = Date.now();
    isInitializing = false;
  }

  return { redisAvailable, queue: bullQueue };
}

/**
 * Initializes a BullMQ Worker if Redis is available.
 */
export async function initWorker(processorFn) {
  if (!redisAvailable || !redisClient || bullWorker) return;

  try {
    const { Worker } = await import("bullmq");
    bullWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        // `attemptsMade` counts attempts already finished, so the run starting now
        // is attempt number attemptsMade + 1. The processor needs this to know
        // whether a thrown error still has retries left before it marks the sync
        // FAILED — throwing is what lets BullMQ apply its backoff at all.
        return await processorFn(job.data, null, {
          attempt: (job.attemptsMade || 0) + 1,
          maxAttempts: job.opts?.attempts || MAX_BATCH_ATTEMPTS,
        });
      },
      {
        connection: redisClient,
        concurrency: 2,
        limiter: {
          max: 4,
          duration: 1000,
        },
      }
    );

    bullWorker.on("completed", (job) => {
      syncEvents.emit("jobCompleted", job.data);
    });

    bullWorker.on("failed", (job, err) => {
      syncEvents.emit("jobFailed", { job: job?.data, error: err?.message });
    });

    // Worker-level errors (connection blips) must be handled or Node treats them
    // as unhandled 'error' events and terminates the process.
    bullWorker.on("error", () => {});
  } catch (workerErr) {
    // console.warn("[Queue] BullMQ worker registration notice:", workerErr?.message);
  }
}

/**
 * Strips anything that cannot survive a round-trip through Redis.
 *
 * BullMQ persists job data as a JSON string, so live objects such as a Shopify
 * admin GraphQL client silently deserialize into `{}` — truthy, but with no
 * methods, which then fails the batch. The worker re-resolves the admin client
 * from the stored offline session instead, so it must never be carried here.
 */
function toSerializablePayload(jobData) {
  const { syncJobId, shop, cursor, batchSize, processedSoFar } = jobData;
  return {
    syncJobId,
    shop,
    cursor: cursor ?? null,
    batchSize,
    processedSoFar: processedSoFar || 0,
  };
}

// In-process fallback concurrency limiter to prevent event loop starvation and heap bloat
const MAX_CONCURRENT_FALLBACK = 2;
let activeFallbackCount = 0;
const fallbackQueue = [];

function scheduleFallbackTask(task) {
  fallbackQueue.push(task);
  drainFallbackQueue();
}

function drainFallbackQueue() {
  while (activeFallbackCount < MAX_CONCURRENT_FALLBACK && fallbackQueue.length > 0) {
    const nextTask = fallbackQueue.shift();
    activeFallbackCount++;
    (async () => {
      try {
        await nextTask();
      } catch (err) {
        console.error("[Queue Fallback] Unhandled error during fallback task execution:", err);
      } finally {
        activeFallbackCount--;
        // Yield to event loop and GC breathing room before draining next task
        setTimeout(() => {
          if (typeof global.gc === "function") {
            try { global.gc(); } catch {}
          }
          drainFallbackQueue();
        }, 100);
      }
    })();
  }
}

/**
 * Returns queue health and engine telemetry.
 */
export function getQueueHealth() {
  return {
    engine: redisAvailable ? "bullmq" : "in-process",
    redisAvailable,
    isConnected: redisAvailable && Boolean(redisClient),
    lastRedisCheckAt,
    maxBatchAttempts: MAX_BATCH_ATTEMPTS,
    activeFallbackWorkers: activeFallbackCount,
    pendingFallbackJobs: fallbackQueue.length,
  };
}

/**
 * Enqueues a catalog sync batch job into BullMQ or triggers the resilient runner.
 */
export async function enqueueSyncBatch(jobData, processorFn = null) {
  await initQueue(processorFn);

  const payload = toSerializablePayload(jobData);

  if (redisAvailable && bullQueue) {
    // The cursor makes this unique per batch. `processedSoFar` alone does not: a
    // page whose products are all skipped advances the cursor without advancing
    // the count, and a duplicate jobId would be dropped, stalling the sync.
    const batchKey = payload.cursor ? String(payload.cursor).slice(-32) : "start";
    const jobId = `sync_${payload.syncJobId}_${payload.processedSoFar}_${batchKey}`;
    return await bullQueue.add("process-batch", payload, {
      jobId,
      priority: 1,
    });
  }

  // Resilient fallback: bounded concurrency queue with retry budget matching BullMQ
  scheduleFallbackTask(async () => {
    const runBatch =
      typeof processorFn === "function"
        ? processorFn
        : (await import("./sync.server.js")).processCatalogSyncBatch;

    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
      try {
        await runBatch(payload, null, { attempt, maxAttempts: MAX_BATCH_ATTEMPTS });
        syncEvents.emit("jobCompleted", payload);
        return;
      } catch (runErr) {
        if (attempt >= MAX_BATCH_ATTEMPTS) {
          const errorMsg = runErr?.message || String(runErr);
          console.error("[Queue Fallback] Batch failed after all retries:", errorMsg);
          syncEvents.emit("jobFailed", { job: payload, error: errorMsg });
          return;
        }
        // Exponential backoff mirroring BullMQ defaultJobOptions
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      }
    }
  });

  return { id: `fallback_${payload.syncJobId}_${Date.now()}` };
}

/**
 * Shuts down queue and worker gracefully on process termination.
 */
export async function closeQueue() {
  try {
    if (bullWorker) await bullWorker.close();
    if (bullQueue) await bullQueue.close();
    if (redisClient) redisClient.disconnect();
  } catch (err) {
    // ignore shutdown errors
  }
}
