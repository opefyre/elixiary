export const LIST_MEMORY_CACHE_MAX_ENTRIES = 256;

export function getListCacheTtlSeconds(env) {
  const raw = Number(env.LIST_CACHE_TTL_SECONDS || 90);
  if (!Number.isFinite(raw)) return 90;
  return Math.max(60, Math.min(120, raw));
}

export function normalizeListQueryParams(q, tag, cat, mood) {
  const norm = (val) => String(val || '').trim().toLowerCase();
  return {
    q: norm(q).replace(/\s+/g, ' '),
    tag: norm(tag),
    category: norm(cat),
    mood: norm(mood)
  };
}

export function buildListCacheKey(etag, params) {
  const { q, tag, category, mood, page, size } = params;
  const payload = JSON.stringify([q, tag, category, mood, page, size]);
  return `list_v1:${etag}:${payload}`;
}

export function createListCache({ maxEntries = LIST_MEMORY_CACHE_MAX_ENTRIES } = {}) {
  const listMemoryCache = new Map();
  let listMemoryCacheEtag = null;
  let listMemoryCacheLastFiltersCleared = true;

  function pruneExpiredListMemoryCache(ttlMs, now = Date.now()) {
    if (!(ttlMs > 0)) return;
    for (const [key, entry] of listMemoryCache) {
      if ((now - entry.insertedAt) > ttlMs) {
        listMemoryCache.delete(key);
        continue;
      }
      break;
    }
  }

  function evictListMemoryCacheToCapacity() {
    if (!(maxEntries > 0)) {
      listMemoryCache.clear();
      return;
    }
    while (listMemoryCache.size >= maxEntries) {
      const oldest = listMemoryCache.keys().next();
      if (oldest.done) break;
      listMemoryCache.delete(oldest.value);
    }
  }

  function syncIndexState(etag, filtersCleared) {
    if (etag !== listMemoryCacheEtag) {
      listMemoryCache.clear();
      listMemoryCacheEtag = etag;
      listMemoryCacheLastFiltersCleared = filtersCleared;
      return;
    }

    if (filtersCleared && !listMemoryCacheLastFiltersCleared) {
      listMemoryCache.clear();
    }
    listMemoryCacheLastFiltersCleared = filtersCleared;
  }

  function getEntry(key, ttlMs, now = Date.now()) {
    const entry = listMemoryCache.get(key);
    if (!entry) return null;
    if (ttlMs > 0 && (now - entry.insertedAt) > ttlMs) {
      listMemoryCache.delete(key);
      return null;
    }
    return entry.value;
  }

  function setEntry(key, value, ttlMs, now = Date.now()) {
    if (!(ttlMs > 0) || !(maxEntries > 0)) return;
    pruneExpiredListMemoryCache(ttlMs, now);
    if (listMemoryCache.has(key)) {
      listMemoryCache.delete(key);
    }
    evictListMemoryCacheToCapacity();
    listMemoryCache.set(key, { value, insertedAt: now });
  }

  return {
    getTtlSeconds: (env) => getListCacheTtlSeconds(env),
    syncIndexState,
    get: getEntry,
    set: setEntry
  };
}
