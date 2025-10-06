import { json, scheduleBackground as defaultScheduleBackground } from './utils.js';

const RATE_LIMIT_SYNC_STEP = 5;
const RATE_LIMIT_MEMORY_PRUNE_STEP = 20;
const RATE_LIMIT_MEMORY_PRUNE_THRESHOLD = 256;
const RATE_LIMIT_MEMORY_PRUNE_MAX_BATCHES = 5;
const RATE_LIMIT_MEMORY_PRUNE_MIN_INTERVAL = 5000;

export function createRateLimiter({ scheduleBackground = defaultScheduleBackground } = {}) {
  const rateLimitMemory = new Map();
  let rateLimitMemorySweepIterator = null;
  let rateLimitMemoryPruneScheduled = false;
  let rateLimitMemoryWasAboveThreshold = false;
  let rateLimitMemoryLastPruneAt = 0;

  function pruneRateLimitMemory(now, limit = RATE_LIMIT_MEMORY_PRUNE_STEP) {
    if (!rateLimitMemory.size || limit <= 0) return 0;

    if (!rateLimitMemorySweepIterator) {
      rateLimitMemorySweepIterator = rateLimitMemory.keys();
    }

    let processed = 0;
    let pruned = 0;

    while (processed < limit) {
      let next = rateLimitMemorySweepIterator.next();
      if (next.done) {
        rateLimitMemorySweepIterator = rateLimitMemory.keys();
        next = rateLimitMemorySweepIterator.next();
        if (next.done) {
          rateLimitMemorySweepIterator = null;
          break;
        }
      }

      processed += 1;
      const key = next.value;
      const entry = rateLimitMemory.get(key);
      if (!entry) continue;
      if (entry.expiresAt <= now) {
        rateLimitMemory.delete(key);
        pruned += 1;
      }
    }

    if (!rateLimitMemory.size) {
      rateLimitMemorySweepIterator = null;
    }

    return pruned;
  }

  function scheduleRateLimitPrune(now, ctx) {
    const size = rateLimitMemory.size;
    if (size <= RATE_LIMIT_MEMORY_PRUNE_THRESHOLD) {
      rateLimitMemoryWasAboveThreshold = false;
      return;
    }

    const crossedThreshold = !rateLimitMemoryWasAboveThreshold;
    rateLimitMemoryWasAboveThreshold = true;

    if (!crossedThreshold && (now - rateLimitMemoryLastPruneAt) < RATE_LIMIT_MEMORY_PRUNE_MIN_INTERVAL) {
      return;
    }

    if (rateLimitMemoryPruneScheduled) {
      return;
    }

    rateLimitMemoryPruneScheduled = true;
    rateLimitMemoryLastPruneAt = now;

    const cleanup = (async () => {
      try {
        let batches = 0;
        while (batches < RATE_LIMIT_MEMORY_PRUNE_MAX_BATCHES
          && rateLimitMemory.size > RATE_LIMIT_MEMORY_PRUNE_THRESHOLD) {
          const pruned = pruneRateLimitMemory(Date.now(), RATE_LIMIT_MEMORY_PRUNE_STEP * 4);
          batches += 1;
          if (pruned === 0) break;
        }
      } finally {
        rateLimitMemoryPruneScheduled = false;
        rateLimitMemoryWasAboveThreshold = rateLimitMemory.size > RATE_LIMIT_MEMORY_PRUNE_THRESHOLD;
        if (!rateLimitMemory.size) {
          rateLimitMemorySweepIterator = null;
        }
      }
    })();

    scheduleBackground(ctx, cleanup, 'rate_limit_prune');
  }

  return async function enforceRateLimit({ request, env, ctx, cors, ip }) {
    const limit = Number(env.RL_LIMIT || 60);
    const windowSec = Math.max(1, Number(env.RL_WINDOW_SEC || 60));
    const now = Date.now();
    const bucket = Math.floor(now / 1000 / windowSec);
    const kvKey = `rl:${ip}:${bucket}`;
    const mapKey = `${ip}:${bucket}`;
    const bucketExpiresAt = (bucket + 1) * windowSec * 1000;

    pruneRateLimitMemory(now);

    let entry = rateLimitMemory.get(mapKey);
    if (entry && entry.expiresAt <= now) {
      rateLimitMemory.delete(mapKey);
      entry = null;
    }

    if (!entry) {
      const current = await env.MIXOLOGY.get(kvKey);
      const kvCount = current ? parseInt(current, 10) || 0 : 0;
      entry = {
        count: kvCount,
        expiresAt: bucketExpiresAt,
        syncedCount: kvCount,
        hasKvValue: Boolean(current),
        syncScheduled: false,
        needsSyncAfterCurrent: false
      };
      rateLimitMemory.set(mapKey, entry);
    } else {
      entry.expiresAt = bucketExpiresAt;
    }

    const count = entry.count;

    if (count >= limit && limit > 0) {
      const resetIn = windowSec - Math.floor((now / 1000) % windowSec);
      return json({ ok: false, error: 'rate_limited' }, 429, {
        ...cors,
        'Retry-After': String(resetIn),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetIn),
        'X-Content-Type-Options': 'nosniff'
      });
    }

    entry.count = count + 1;
    rateLimitMemory.set(mapKey, entry);

    scheduleRateLimitPrune(now, ctx);

    const unsynced = entry.count - entry.syncedCount;
    const nearingLimit = limit > 0 && entry.count >= Math.max(1, limit - 1);
    const shouldSync = unsynced >= RATE_LIMIT_SYNC_STEP
      || nearingLimit
      || (!entry.hasKvValue && entry.count === 1);

    const queueKvSync = () => {
      const countToWrite = entry.count;
      entry.syncScheduled = true;
      entry.needsSyncAfterCurrent = false;
      const write = env.MIXOLOGY.put(kvKey, String(countToWrite), { expirationTtl: windowSec + 5 })
        .then(() => {
          entry.syncedCount = Math.max(entry.syncedCount, countToWrite);
          entry.hasKvValue = true;
          entry.syncScheduled = false;
          if (entry.needsSyncAfterCurrent) {
            entry.needsSyncAfterCurrent = false;
            if (entry.count - entry.syncedCount > 0) queueKvSync();
          }
        })
        .catch((err) => {
          entry.syncScheduled = false;
          throw err;
        });
      scheduleBackground(ctx, write, 'rate_limit_sync');
    };

    if (shouldSync) {
      if (entry.syncScheduled) {
        entry.needsSyncAfterCurrent = true;
      } else {
        queueKvSync();
      }
    }

    return null;
  };
}
