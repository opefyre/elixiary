import { createListCache, normalizeListQueryParams, buildListCacheKey } from '../cache.js';
import { createIndexBuilder } from './indexBuilder.js';
import { getGoogleAccessToken } from '../google/oauth.js';
import { scheduleBackground as defaultScheduleBackground } from '../utils.js';

const CATEGORY_PLACEHOLDER_MAP = new Map([
  ['unknown_other', null],
  ['unknownother', null]
]);

export function createIndexService({ listCache = createListCache(), scheduleBackground = defaultScheduleBackground } = {}) {
  const builder = createIndexBuilder({ fetchSheetValues });
  const { buildIndexFromSheet, fetchRowFull, filterIndex, serializeRow, hasPrecomputedMaps } = builder;

  let memoryIndex = null;
  let memoryIndexExpiry = 0;
  let memoryIndexPromise = null;

  async function fetchSheetValues(env, rangeA1) {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/`;
    const url = `${base}${encodeURIComponent(rangeA1)}`;

    if (env.GOOGLE_SA_JSON) {
      const token = await getGoogleAccessToken(env);
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        cf: { cacheEverything: false }
      });
      if (!r.ok) throw new Error(`Sheets API ${r.status}`);
      return r.json();
    }

    const r = await fetch(`${url}?key=${env.GOOGLE_API_KEY}`, { cf: { cacheEverything: false } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}`);
    return r.json();
  }

  async function getIndex(env, ctx, opts = {}) {
    const ttlRaw = Number(env.CACHE_TTL_SECONDS || 300);
    const ttl = Number.isFinite(ttlRaw) ? ttlRaw : 300;
    const shouldExpire = ttl > 0;
    const kvTtl = shouldExpire ? ttl : 0;
    const ttlMs = shouldExpire ? kvTtl * 1000 : Infinity;
    const forceRebuild = opts.forceRebuild === true;
    const now = Date.now();

    if (!forceRebuild && memoryIndex && memoryIndexExpiry && now < memoryIndexExpiry && hasPrecomputedMaps(memoryIndex)) {
      return memoryIndex;
    }

    if (!forceRebuild) {
      const cached = await env.MIXOLOGY.get('idx_v1', { type: 'json' });
      if (cached && cached.rows && cached.etag && cached._headerMap && hasPrecomputedMaps(cached)) {
        memoryIndex = cached;
        memoryIndexExpiry = Date.now() + ttlMs;
        return cached;
      }
    }

    if (!memoryIndexPromise) {
      const rebuildPromise = (async () => {
        const built = await buildIndexFromSheet(env);
        memoryIndex = built;
        memoryIndexExpiry = Date.now() + ttlMs;
        const writeArgs = ['idx_v1', JSON.stringify(built)];
        if (shouldExpire) {
          writeArgs.push({ expirationTtl: kvTtl });
        }
        const write = env.MIXOLOGY.put(...writeArgs);
        scheduleBackground(ctx, write, 'index_cache_write');
        return built;
      })();

      memoryIndexPromise = rebuildPromise.then(
        (result) => {
          memoryIndexPromise = null;
          return result;
        },
        (err) => {
          memoryIndexPromise = null;
          throw err;
        }
      );
    }

    return memoryIndexPromise;
  }

  async function handleList(qp, env, ctx) {
    const pageDefault = Number(env.PAGE_DEFAULT || 12);
    const pageMax = Number(env.PAGE_MAX || 48);
    const page = clamp(qp.page || 1, 1, 100000);
    const size = clamp(qp.page_size || pageDefault, 1, pageMax);
    const q = (qp.q || '').trim();
    const tag = (qp.tag || '').trim();
    const cat = (qp.category || '').trim();
    const mood = (qp.mood || '').trim();
    const ifE = (qp.if_etag || '').trim();

    const idx = await getIndex(env, ctx);

    const listCacheTtlSeconds = listCache.getTtlSeconds(env);
    const listCacheTtlMs = listCacheTtlSeconds * 1000;

    const normalized = normalizeListQueryParams(q, tag, cat, mood);
    const filtersCleared = !normalized.q && !normalized.tag && !normalized.category && !normalized.mood;

    listCache.syncIndexState(idx.etag, filtersCleared);

    const cacheParams = { ...normalized, page, size };
    const cacheKey = buildListCacheKey(idx.etag, cacheParams);

    const serveCached = (payload) => {
      if (!payload) return null;
      if (page === 1 && filtersCleared && ifE && ifE === idx.etag) {
        return { ok: true, etag: idx.etag, not_modified: true, total: payload.total, page: 1, page_size: size };
      }
      return payload;
    };

    const memoryCached = listCache.get(cacheKey, listCacheTtlMs);
    if (memoryCached) {
      const cachedResponse = serveCached(memoryCached);
      if (cachedResponse) return cachedResponse;
    }

    if (ifE && ifE === idx.etag && page === 1 && filtersCleared) {
      return { ok: true, etag: idx.etag, not_modified: true, total: idx.rows.length, page: 1, page_size: size };
    }

    const kvCached = await env.MIXOLOGY.get(cacheKey, { type: 'json' });
    if (kvCached && kvCached.etag === idx.etag) {
      listCache.set(cacheKey, kvCached, listCacheTtlMs);
      const cachedResponse = serveCached(kvCached);
      if (cachedResponse) return cachedResponse;
    }

    const filteredIndexes = filterIndex(idx, q, tag, cat, mood);
    const total = filteredIndexes.length;
    const start = (page - 1) * size;
    const end = Math.min(start + size, total);
    const sliceIndexes = (start < total) ? filteredIndexes.slice(start, end) : [];
    const posts = sliceIndexes.map(i => serializeRow(idx.rows[i]));

    const categories = [];
    const seenCategories = new Set();
    for (const idxVal of filteredIndexes) {
      const row = idx.rows[idxVal];
      const categoryValue = row && row.category;
      if (!categoryValue) continue;

      const normalized = normalizeCategoryKey(categoryValue);
      if (!normalized) continue;

      if (CATEGORY_PLACEHOLDER_MAP.has(normalized)) {
        const replacement = CATEGORY_PLACEHOLDER_MAP.get(normalized);
        if (typeof replacement === 'string' && replacement) {
          const replacementKey = normalizeCategoryKey(replacement);
          if (replacementKey && !seenCategories.has(replacementKey)) {
            seenCategories.add(replacementKey);
            categories.push(replacement);
          }
        }
        continue;
      }

      if (seenCategories.has(normalized)) continue;
      seenCategories.add(normalized);
      categories.push(categoryValue);
    }

    const result = {
      ok: true,
      etag: idx.etag,
      total, page, page_size: size,
      has_more: end < total,
      posts,
      categories
    };

    listCache.set(cacheKey, result, listCacheTtlMs);

    const expirationTtl = listCacheTtlSeconds;
    const putList = env.MIXOLOGY.put(cacheKey, JSON.stringify(result), { expirationTtl });
    scheduleBackground(ctx, putList, 'list_cache_write');

    return result;
  }

  async function handlePost(slug, env, ctx) {
    let idx = await getIndex(env, ctx);
    const hasHeader = idx._headerMap && Object.keys(idx._headerMap).length;
    const hasSlugIndex = idx._slugIndex && typeof idx._slugIndex === 'object';
    if (!hasHeader || !hasSlugIndex) {
      idx = await getIndex(env, ctx, { forceRebuild: true });
    }

    const slugKey = String(slug || '').toLowerCase();
    const rowIndex = idx._slugIndex && typeof idx._slugIndex === 'object' ? idx._slugIndex[slugKey] : undefined;
    if (!Number.isInteger(rowIndex)) {
      return { ok: false, code: 404, error: 'not_found' };
    }

    const rec = idx.rows[rowIndex];
    if (!rec || String(rec.slug || '').toLowerCase() !== slugKey) {
      return { ok: false, code: 404, error: 'not_found' };
    }

    const cacheKey = `post_v1:${idx.etag}:${rec.slug}`;
    const cached = await env.MIXOLOGY.get(cacheKey, { type: 'json' });
    if (cached && cached.post && cached.etag === idx.etag) {
      return { ok: true, post: cached.post };
    }

    if (rec._details && typeof rec._details === 'object') {
      const post = { ...rec._details };
      const ttl = Number(env.CACHE_TTL_SECONDS || 300);
      const expirationTtl = Math.max(60, ttl + 30);
      const putPost = env.MIXOLOGY.put(cacheKey, JSON.stringify({ etag: idx.etag, post }), {
        expirationTtl
      });
      scheduleBackground(ctx, putPost, 'post_cache_write');
      return { ok: true, post };
    }

    let headerMap = idx._headerMap;
    if (!headerMap || !Object.keys(headerMap).length) {
      const head = await fetchSheetValues(env, `${env.SHEET_NAME}!A1:L1`);
      const header = (head.values && head.values[0]) || [];
      headerMap = Object.fromEntries(header.map((h, i) => [canon(h), i]));
    }

    const post = await fetchRowFull(env, rec._row, { headerMap, ctx, getIndex });
    if (!post) return { ok: false, code: 404, error: 'not_found' };

    rec._details = post;

    const ttl = Number(env.CACHE_TTL_SECONDS || 300);
    const expirationTtl = Math.max(60, ttl + 30);
    const putPost = env.MIXOLOGY.put(cacheKey, JSON.stringify({ etag: idx.etag, post }), {
      expirationTtl
    });
    scheduleBackground(ctx, putPost, 'post_cache_write');

    return { ok: true, post };
  }

  return {
    getIndex,
    handleList,
    handlePost,
    serializeRow
  };
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (isNaN(n)) n = lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function canon(s) {
  return String(s || '').replace(/\uFEFF/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeCategoryKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  return normalized
    .replace(/^(cat|glass|style|strength|flavor|energy|occ)_/, '')
    .replace(/[\s/-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}
