// Mixology API – Cloudflare Worker (Sheets API + KV cache + OAuth + CORS + simple rate limit)
// Routes:
//   GET  /v1/list?page=&page_size=&q=&category=&difficulty=&tag=&mood=
//   GET  /v1/post/<slug>
//   GET  /v1/debug
//   HEAD /v1/* (lightweight OK with cache headers)
//
// Required bindings (Worker -> Settings -> Variables / KV):
//   KV:    MIXOLOGY
//   VARS:  SHEET_ID, SHEET_NAME
//          (either) GOOGLE_SA_JSON  ← recommended (full Service Account JSON; Sheet shared with its client_email as Viewer)
//          (or)     GOOGLE_API_KEY  ← fallback (requires public sheet)
//   VARS (optional): ALLOWED_ORIGINS (csv, supports wildcards like https://*.web.app)
//                    CACHE_TTL_SECONDS (default 300)
//                    PAGE_DEFAULT (default 12), PAGE_MAX (default 48)
//                    RL_LIMIT (default 60), RL_WINDOW_SEC (default 60)

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '');
      const method = request.method || 'GET';

      // --- CORS preflight ---
      if (method === 'OPTIONS') {
        const h = new Headers(cors);
        const reqHeaders = request.headers.get('Access-Control-Request-Headers');
        if (reqHeaders) h.set('Access-Control-Allow-Headers', reqHeaders);
        h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        h.set('Access-Control-Max-Age', '86400');
        return new Response(null, { status: 204, headers: h });
      }

      // --- Block non-GET/HEAD to API endpoints ---
      if (path.startsWith('/v1/') && !['GET', 'HEAD'].includes(method)) {
        return json({ ok: false, error: 'method_not_allowed' }, 405, {
          ...cors,
          'Allow': 'GET, HEAD, OPTIONS',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      // --- Lightweight per-IP rate limit on /v1/* (free-tier friendly) ---
      // Uses an in-memory bucket cache for quick checks with KV as an
      // eventually consistent safety net across isolates.
      if (path.startsWith('/v1/')) {
        const limit = Number(env.RL_LIMIT || 60);          // requests
        const windowSec = Math.max(1, Number(env.RL_WINDOW_SEC || 60)); // per N seconds
        const ip = clientIp(request) || 'unknown';
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

        // KV writes act as a cross-isolate safety net; the in-memory counter is
        // eventually consistent and prioritizes fewer writes per bucket window.
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
      }

      // --- HEAD shortcut (cheap success + cache hints) ---
      if (method === 'HEAD' && path.startsWith('/v1/')) {
        return new Response(null, {
          status: 200,
          headers: { ...cors, 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' }
        });
      }

      // --- Routes ---
      if (path === '/v1/list') {
        const qp = objFromSearch(url.searchParams);
        const data = await handleList(qp, env, ctx);
        return json(data, 200, {
          ...cors,
          'ETag': data.etag,
          'Cache-Control': 'public, max-age=60',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      if (path.startsWith('/v1/post/')) {
        const slug = decodeURIComponent(path.slice('/v1/post/'.length));
        const data = await handlePost(slug, env, ctx);
        const status = data.ok ? 200 : (data.code || 404);
        return json(data, status, {
          ...cors,
          'Cache-Control': 'public, max-age=60',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      if (path === '/v1/debug') {
        const idx = await getIndex(env, ctx);
        return json({ ok: true, total: idx.rows.length, sample: idx.rows.slice(0, 3).map(serializeRow) }, 200, {
          ...cors,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      return new Response('Not found', { status: 404, headers: cors });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500, { ...cors, 'X-Content-Type-Options': 'nosniff' });
    }
  }
};

/* ---------- CONFIG + UTIL ---------- */

const API_VERSION = 'v1';

const listMemoryCache = new Map();
const LIST_MEMORY_CACHE_MAX_ENTRIES = 256;
let listMemoryCacheEtag = null;
let listMemoryCacheLastFiltersCleared = true;

// Module-scoped rate limit cache keyed by `ip:bucket`
const rateLimitMemory = new Map();
const RATE_LIMIT_SYNC_STEP = 5;
const RATE_LIMIT_MEMORY_PRUNE_STEP = 20;
const RATE_LIMIT_MEMORY_PRUNE_THRESHOLD = 256;
const RATE_LIMIT_MEMORY_PRUNE_MAX_BATCHES = 5;
const RATE_LIMIT_MEMORY_PRUNE_MIN_INTERVAL = 5000;
let rateLimitMemorySweepIterator = null;
let rateLimitMemoryPruneScheduled = false;
let rateLimitMemoryWasAboveThreshold = false;
let rateLimitMemoryLastPruneAt = 0;

function getListCacheTtlSeconds(env) {
  const raw = Number(env.LIST_CACHE_TTL_SECONDS || 90);
  if (!Number.isFinite(raw)) return 90;
  return Math.max(60, Math.min(120, raw));
}

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

function evictListMemoryCacheToCapacity(maxEntries) {
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

function getListMemoryCacheEntry(key, ttlMs, now = Date.now()) {
  const entry = listMemoryCache.get(key);
  if (!entry) return null;
  if (ttlMs > 0 && (now - entry.insertedAt) > ttlMs) {
    listMemoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setListMemoryCacheEntry(key, value, ttlMs, maxEntries = LIST_MEMORY_CACHE_MAX_ENTRIES, now = Date.now()) {
  if (!(ttlMs > 0) || !(maxEntries > 0)) return;
  pruneExpiredListMemoryCache(ttlMs, now);
  if (listMemoryCache.has(key)) {
    listMemoryCache.delete(key);
  }
  evictListMemoryCacheToCapacity(maxEntries);
  listMemoryCache.set(key, { value, insertedAt: now });
}

// CORS with wildcard support (e.g. https://*.web.app)
function corsHeaders(env, origin) {
  const expose = 'ETag, Cache-Control, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset';
  const headers = { 'Vary': 'Origin', 'Access-Control-Expose-Headers': expose };

  if (!origin) return headers;

  const defaults = [
    'https://elixiary.com',
    'https://www.elixiary.com',
    'https://elixiary.web.app',
    'https://elixiary--*.web.app'
  ];

  const raw = (env.ALLOWED_ORIGINS || '').trim();
  const patterns = [
    ...defaults,
    ...(raw ? raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : [])
  ];

  if (patterns.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  let ok = false;
  try {
    const o = new URL(origin);
    const host = o.host;
    const proto = o.protocol;

    for (const p of patterns) {
      if (!p) continue;
      const isWildcard = p.includes('*.');
      if (isWildcard) {
        // pattern like https://*.web.app
        const m = p.match(/^(https?:\/\/)\*\.(.+)$/i);
        if (!m) continue;
        const pProto = m[1];
        const suffix = m[2];
        if (proto === pProto && (host === suffix || host.endsWith('.' + suffix))) { ok = true; break; }
      } else {
        if (origin === p) { ok = true; break; }
      }
    }
  } catch (_) {}

  if (ok) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
      || request.headers.get('True-Client-IP')
      || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
      || '';
}

function objFromSearch(sp) { const o = {}; for (const [k, v] of sp) o[k] = v; return o; }
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}
function scheduleBackground(ctx, promise, label) {
  const prefix = `[Mixology] ${label}`;
  const handleError = (err) => {
    console.error(`${prefix} failed`, err);
  };
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise.catch(handleError));
  } else {
    promise.catch(handleError);
  }
}

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

    processed++;
    const key = next.value;
    const entry = rateLimitMemory.get(key);
    if (!entry) continue;
    if (entry.expiresAt <= now) {
      rateLimitMemory.delete(key);
      pruned++;
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
        batches++;
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
function canon(s) { return String(s || '').replace(/\uFEFF/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function splitCSV(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
function driveImageLinks(url) {
  const u = String(url || '').trim(); if (!u) return { src:'', thumb:'' };
  const m = u.match(/\/file\/d\/([^/]+)/) || u.match(/[?&]id=([^&]+)/);
  if (!m || !m[1]) return { src:u, thumb:u };
  const id = m[1];
  return {
    src:   'https://drive.google.com/uc?export=view&id=' + id,
    thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1200'
  };
}
function toDateISO(v) {
  try {
    if (Object.prototype.toString.call(v) === '[object Date]') return !isNaN(v) ? v.toISOString().slice(0, 10) : '';
    if (typeof v === 'number') { const ms = Math.round((v - 25569) * 864e5); return new Date(ms).toISOString().slice(0, 10); }
    const d = new Date(String(v)); return isNaN(d) ? String(v || '') : d.toISOString().slice(0, 10);
  } catch { return String(v || ''); }
}
const textEncoder = new TextEncoder();

async function hashHexFromBytes(bytes) {
  const out = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(out)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashHex(s) {
  return hashHexFromBytes(textEncoder.encode(s));
}

/* ---------- SHEETS FETCH + KV CACHE ---------- */

async function fetchSheetValues(env, rangeA1) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/`;
  const url  = `${base}${encodeURIComponent(rangeA1)}`;

  // Prefer service-account OAuth if GOOGLE_SA_JSON is present
  if (env.GOOGLE_SA_JSON) {
    const token = await getGoogleAccessToken(env);
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      cf: { cacheEverything: false }
    });
    if (!r.ok) throw new Error(`Sheets API ${r.status}`);
    return r.json();
  }

  // Fallback: API key (requires the sheet to be public)
  const r = await fetch(url + `?key=${env.GOOGLE_API_KEY}`, { cf: { cacheEverything: false } });
  if (!r.ok) throw new Error(`Sheets API ${r.status}`);
  return r.json();
}

async function buildIndexFromSheet(env) {
  const range = `${env.SHEET_NAME}!A1:L`;
  const data = await fetchSheetValues(env, range);
  const values = data.values || [];
  if (!values.length) return { rows: [], etag: await hashHex(API_VERSION + ':empty'), _headerMap: {} };

  const header = values[0];
  const map = Object.fromEntries(header.map((h, i) => [canon(h), i]));
  const rows = [];
  const categoryIndex = Object.create(null);
  const tagIndex = Object.create(null);
  const moodIndex = Object.create(null);
  const tokenIndex = Object.create(null);
  const slugIndexRefs = Object.create(null);

  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const cell = (key) => {
      const idx = map[key];
      return (typeof idx === 'number') ? r[idx] : undefined;
    };

    const name = cell('name');
    const slug = slugify(name || '');
    if (!slug) continue;

    const img = driveImageLinks(cell('imageurl') || cell('image_url'));
    const category = String((cell('category') || ''));
    const tags = splitCSV(cell('tags'));
    const moods = splitCSV(cell('moodlabels') || cell('mood_labels'));
    const prepTime = String((cell('preptime') || cell('prep_time') || ''));
    const difficulty = String((cell('difficulty') || ''));
    const date = toDateISO(cell('date'));

    let ingredients = [];
    try {
      const rawIngredients = cell('ingredientsjson') || cell('ingredients_json');
      ingredients = rawIngredients ? JSON.parse(rawIngredients) : [];
      if (!Array.isArray(ingredients)) ingredients = [];
    } catch { ingredients = []; }

    const instructions = String(cell('instructions') || '');
    const glass = String(cell('glass') || '');
    const garnish = String(cell('garnish') || '');

    const row = {
      _row: i + 1,
      slug,
      name: String(name || ''),
      date,
      category,
      difficulty,
      prep_time: prepTime,
      tags,
      mood_labels: moods,
      image_url: img.src,
      image_thumb: img.thumb,
      _name_lc: String(name || '').toLowerCase(),
      _tags_lc: tags.map(t => String(t || '').toLowerCase()),
      _moods_lc: moods.map(m => String(m || '').toLowerCase()),
      _category_lc: category.toLowerCase(),
      _details: {
        slug,
        name: String(name || ''),
        ingredients,
        mood_labels: moods,
        tags,
        category,
        instructions,
        glass,
        garnish,
        prep_time: prepTime,
        difficulty,
        image_url: img.src,
        image_thumb: img.thumb,
        date
      }
    };

    rows.push(row);

    const slugLc = row.slug.toLowerCase();
    if (!(slugLc in slugIndexRefs)) {
      slugIndexRefs[slugLc] = row;
    }

    if (row._category_lc) {
      if (!categoryIndex[row._category_lc]) categoryIndex[row._category_lc] = [];
      categoryIndex[row._category_lc].push(row);
    }

    for (const t of row._tags_lc) {
      if (!tagIndex[t]) tagIndex[t] = [];
      tagIndex[t].push(row);
    }

    for (const m of row._moods_lc) {
      if (!moodIndex[m]) moodIndex[m] = [];
      moodIndex[m].push(row);
    }

    const tokens = new Set();
    addTokens(tokens, row._name_lc);
    for (const tag of row._tags_lc) addTokens(tokens, tag);
    for (const mood of row._moods_lc) addTokens(tokens, mood);
    for (const token of tokens) {
      if (!tokenIndex[token]) tokenIndex[token] = [];
      tokenIndex[token].push(row);
    }
  }

  rows.sort((a, b) => {
    const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCmp !== 0) return dateCmp;
    return a.slug.localeCompare(b.slug);
  });

  const rowToIndex = new Map();
  rows.forEach((row, idx) => rowToIndex.set(row, idx));

  const normalizeIndex = (map) => {
    const out = Object.create(null);
    for (const [key, list] of Object.entries(map)) {
      if (!key) continue;
      const idxSet = new Set();
      for (const row of list) {
        const pos = rowToIndex.get(row);
        if (typeof pos === 'number') idxSet.add(pos);
      }
      if (idxSet.size) {
        out[key] = Array.from(idxSet).sort((a, b) => a - b);
      }
    }
    return out;
  };

  const categoryIndexOut = normalizeIndex(categoryIndex);
  const tagIndexOut = normalizeIndex(tagIndex);
  const moodIndexOut = normalizeIndex(moodIndex);
  const tokenIndexOut = normalizeIndex(tokenIndex);
  const { prefixIndex: tokenPrefixIndexOut, ngramIndex: tokenNgramIndexOut } = buildTokenAuxiliaryIndexes(tokenIndexOut);
  const slugIndexOut = Object.create(null);
  for (const [slugLc, row] of Object.entries(slugIndexRefs)) {
    const pos = rowToIndex.get(row);
    if (typeof pos === 'number') {
      slugIndexOut[slugLc] = pos;
    }
  }

  const etag = await computeIndexEtag(rows);
  return { rows, etag, _headerMap: map, _categoryIndex: categoryIndexOut, _tagIndex: tagIndexOut, _moodIndex: moodIndexOut, _tokenIndex: tokenIndexOut, _tokenPrefixIndex: tokenPrefixIndexOut, _tokenNgramIndex: tokenNgramIndexOut, _slugIndex: slugIndexOut };
}

async function computeIndexEtag(rows) {
  const prefix = `${API_VERSION}:${rows.length}:`;
  const parts = [];
  parts.push(textEncoder.encode(prefix));
  for (const row of rows) {
    const snapshot = {
      slug: row.slug,
      date: row.date,
      category: row.category,
      difficulty: row.difficulty,
      prep_time: row.prep_time,
      tags: row.tags,
      mood_labels: row.mood_labels,
      image_url: row.image_url,
      image_thumb: row.image_thumb
    };
    // Feed the digest incrementally with a canonical JSON snapshot of user-visible fields.
    const encoded = textEncoder.encode(JSON.stringify(snapshot) + '\n');
    parts.push(encoded);
  }

  let totalLength = 0;
  for (const part of parts) totalLength += part.length;
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  return hashHexFromBytes(combined);
}

let memoryIndex = null;
let memoryIndexExpiry = 0;
let memoryIndexPromise = null;

async function getIndex(env, ctx, opts = {}) {
  const ttlRaw = Number(env.CACHE_TTL_SECONDS || 300);
  const ttl = Number.isFinite(ttlRaw) ? ttlRaw : 300;
  const kvTtl = Math.max(0, ttl);
  const ttlMs = kvTtl * 1000;
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
      const write = env.MIXOLOGY.put('idx_v1', JSON.stringify(built), { expirationTtl: kvTtl });
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

async function fetchRowFull(env, rowNumber, headerMap = null, ctx = null) {
  const range = `${env.SHEET_NAME}!A${rowNumber}:L${rowNumber}`;
  const data = await fetchSheetValues(env, range);
  const values = data.values || [];
  if (!values.length) return null;

  let map = headerMap;
  if (!map || !Object.keys(map).length) {
    const idx = await getIndex(env, ctx);
    map = idx._headerMap;
    if (!map || !Object.keys(map).length) {
      const head = await fetchSheetValues(env, `${env.SHEET_NAME}!A1:L1`);
      const header = (head.values && head.values[0]) || [];
      map = Object.fromEntries(header.map((h, i) => [canon(h), i]));
    }
  }

  const r = values[0];
  const name = r[map['name']];
  const slug = slugify(name || '');
  if (!slug) return null;

  let ingredients = [];
  try {
    const raw = r[map['ingredientsjson']] || r[map['ingredients_json']];
    ingredients = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ingredients)) ingredients = [];
  } catch { ingredients = []; }

  const img = driveImageLinks(r[map['imageurl']] || r[map['image_url']]);

  return {
    slug,
    name: String(name || ''),
    ingredients,
    mood_labels: splitCSV(r[map['moodlabels']] || r[map['mood_labels']]),
    tags: splitCSV(r[map['tags']]),
    category: String(r[map['category']] || ''),
    instructions: String(r[map['instructions']] || ''),
    glass: String(r[map['glass']] || ''),
    garnish: String(r[map['garnish']] || ''),
    prep_time: String(r[map['preptime']] || r[map['prep_time']] || ''),
    difficulty: String(r[map['difficulty']] || ''),
    image_url: img.src,
    image_thumb: img.thumb,
    date: toDateISO(r[map['date']])
  };
}

/* ---------- HANDLERS ---------- */

function clamp(n, lo, hi) { n = Number(n); if (isNaN(n)) n = lo; return Math.max(lo, Math.min(hi, Math.floor(n))); }

function ensureLowercaseFields(row) {
  if (!('_name_lc' in row)) {
    row._name_lc = String(row.name || '').toLowerCase();
  }
  if (!Array.isArray(row._tags_lc)) {
    row._tags_lc = Array.isArray(row.tags) ? row.tags.map(t => String(t || '').toLowerCase()) : [];
  }
  if (!Array.isArray(row._moods_lc)) {
    row._moods_lc = Array.isArray(row.mood_labels) ? row.mood_labels.map(m => String(m || '').toLowerCase()) : [];
  }
  if (!('_category_lc' in row)) {
    row._category_lc = String(row.category || '').toLowerCase();
  }
  return row;
}

function addTokens(set, value) {
  const str = String(value || '').toLowerCase();
  if (!str) return;
  const matches = str.match(/[a-z0-9]+/g);
  if (!matches) return;
  for (const token of matches) {
    if (token) set.add(token);
  }
}

function buildTokenAuxiliaryIndexes(tokenIndex) {
  const prefixBuckets = new Map();
  const ngramBuckets = new Map();

  if (!tokenIndex || typeof tokenIndex !== 'object') {
    return { prefixIndex: Object.create(null), ngramIndex: Object.create(null) };
  }

  const addToBucket = (bucket, key, values) => {
    if (!key || !Array.isArray(values) || !values.length) return;
    let set = bucket.get(key);
    if (!set) {
      set = new Set();
      bucket.set(key, set);
    }
    for (const val of values) {
      if (Number.isInteger(val)) {
        set.add(val);
      }
    }
  };

  for (const [rawToken, indexList] of Object.entries(tokenIndex)) {
    if (!Array.isArray(indexList) || !indexList.length) continue;
    const token = String(rawToken || '').toLowerCase();
    if (!token) continue;
    const len = token.length;
    if (!len) continue;

    if (len === 1) {
      addToBucket(prefixBuckets, token, indexList);
    } else {
      addToBucket(prefixBuckets, token.slice(0, 2), indexList);
      if (len >= 3) addToBucket(prefixBuckets, token.slice(0, 3), indexList);
    }

    const maxNgram = Math.min(3, len);
    const minNgram = 1;
    const seenNgrams = new Set();
    for (let size = maxNgram; size >= minNgram; size--) {
      for (let i = 0; i <= len - size; i++) {
        const key = token.slice(i, i + size);
        if (!key) continue;
        const dedupKey = `${size}:${key}`;
        if (seenNgrams.has(dedupKey)) continue;
        seenNgrams.add(dedupKey);
        addToBucket(ngramBuckets, key, indexList);
      }
    }
  }

  const convertBuckets = (bucket) => {
    const out = Object.create(null);
    for (const [key, set] of bucket.entries()) {
      if (!key || !set.size) continue;
      out[key] = Array.from(set).sort((a, b) => a - b);
    }
    return out;
  };

  return {
    prefixIndex: convertBuckets(prefixBuckets),
    ngramIndex: convertBuckets(ngramBuckets)
  };
}

function validateSortedIndexMap(map) {
  if (!map || typeof map !== 'object') return false;
  for (const value of Object.values(map)) {
    if (!Array.isArray(value)) return false;
    let prev = -Infinity;
    for (const entry of value) {
      if (!Number.isInteger(entry)) return false;
      if (entry < prev) return false;
      prev = entry;
    }
  }
  return true;
}

function ensureTokenAuxIndexes(idx) {
  if (!idx || typeof idx !== 'object' || !idx._tokenIndex || typeof idx._tokenIndex !== 'object') {
    return false;
  }

  let prefixValid = validateSortedIndexMap(idx._tokenPrefixIndex);
  let ngramValid = validateSortedIndexMap(idx._tokenNgramIndex);

  if (prefixValid && ngramValid) {
    return true;
  }

  const built = buildTokenAuxiliaryIndexes(idx._tokenIndex);
  if (!prefixValid) {
    idx._tokenPrefixIndex = built.prefixIndex;
    prefixValid = validateSortedIndexMap(idx._tokenPrefixIndex);
  }
  if (!ngramValid) {
    idx._tokenNgramIndex = built.ngramIndex;
    ngramValid = validateSortedIndexMap(idx._tokenNgramIndex);
  }

  return prefixValid && ngramValid;
}

function hasPrecomputedMaps(idx) {
  if (!idx || typeof idx !== 'object') return false;
  const baseMaps = ['_categoryIndex', '_tagIndex', '_moodIndex', '_tokenIndex'];
  for (const key of baseMaps) {
    if (!idx[key] || typeof idx[key] !== 'object') return false;
    if (!validateSortedIndexMap(idx[key])) return false;
  }

  if (!ensureTokenAuxIndexes(idx)) return false;

  if (!idx._slugIndex || typeof idx._slugIndex !== 'object') return false;
  for (const value of Object.values(idx._slugIndex)) {
    if (!Number.isInteger(value)) return false;
  }
  return true;
}

function serializeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '_row' || !key.startsWith('_')) {
      out[key] = value;
    }
  }
  return out;
}

function tokenizeQuery(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  if (!q) return [];
  const parts = q.match(/[a-z0-9]+/g);
  return parts ? parts.filter(Boolean) : [];
}

function lookupTokenMatches(idx, token) {
  const normalized = String(token || '').toLowerCase();
  if (!normalized || !idx || typeof idx._tokenIndex !== 'object') return [];

  const direct = idx._tokenIndex[normalized];
  if (Array.isArray(direct) && direct.length) {
    return direct;
  }

  if (!ensureTokenAuxIndexes(idx)) return [];

  const groups = [];
  const prefixIndex = idx._tokenPrefixIndex || {};
  const ngramIndex = idx._tokenNgramIndex || {};

  if (normalized.length === 1) {
    const singlePrefix = prefixIndex[normalized];
    if (Array.isArray(singlePrefix) && singlePrefix.length) {
      groups.push(singlePrefix);
    }
  } else {
    const prefix2 = normalized.slice(0, 2);
    const arr2 = prefixIndex[prefix2];
    if (Array.isArray(arr2) && arr2.length) {
      groups.push(arr2);
    }
    if (normalized.length >= 3) {
      const prefix3 = normalized.slice(0, 3);
      const arr3 = prefixIndex[prefix3];
      if (Array.isArray(arr3) && arr3.length) {
        groups.push(arr3);
      }
    }
  }

  const maxLen = Math.min(3, normalized.length);
  const minLen = normalized.length === 1 ? 1 : Math.min(2, normalized.length);
  const ngramKeys = new Set();
  for (let size = maxLen; size >= minLen; size--) {
    for (let i = 0; i <= normalized.length - size; i++) {
      const key = normalized.slice(i, i + size);
      if (key) ngramKeys.add(key);
    }
  }

  for (const key of ngramKeys) {
    const arr = ngramIndex[key];
    if (Array.isArray(arr) && arr.length) {
      groups.push(arr);
    }
  }

  if (!groups.length) {
    return [];
  }

  groups.sort((a, b) => a.length - b.length);
  let current = groups[0];

  for (let i = 1; i < groups.length && current.length; i++) {
    current = intersectSortedArrays(current, groups[i]);
  }

  return current;
}

function intersectSortedArrays(a, b) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const av = a[i];
    const bv = b[j];
    if (av === bv) {
      result.push(av);
      i += 1;
      j += 1;
    } else if (av < bv) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return result;
}

function filterIndex(idx, qRaw, tag, cat, mood) {
  const rows = (idx && Array.isArray(idx.rows)) ? idx.rows : [];
  const hasMaps = hasPrecomputedMaps(idx);

  if (!hasMaps) {
    const matches = [];
    const q = String(qRaw || '').toLowerCase();
    const tagLc = String(tag || '').toLowerCase();
    const catLc = String(cat || '').toLowerCase();
    const moodLc = String(mood || '').toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      const row = ensureLowercaseFields(rows[i]);
      if (q) {
        const inName = row._name_lc.includes(q);
        const inTags = row._tags_lc.some(t => t.includes(q));
        const inMoods = row._moods_lc.some(mo => mo.includes(q));
        if (!inName && !inTags && !inMoods) continue;
      }
      if (tagLc && !row._tags_lc.includes(tagLc)) continue;
      if (catLc && row._category_lc !== catLc) continue;
      if (moodLc && !row._moods_lc.includes(moodLc)) continue;
      matches.push(i);
    }
    return matches;
  }

  const groups = [];
  const lc = (s) => String(s || '').toLowerCase();

  if (cat) {
    const arr = idx._categoryIndex[lc(cat)] || [];
    if (!arr.length) return [];
    groups.push(arr);
  }

  if (tag) {
    const arr = idx._tagIndex[lc(tag)] || [];
    if (!arr.length) return [];
    groups.push(arr);
  }

  if (mood) {
    const arr = idx._moodIndex[lc(mood)] || [];
    if (!arr.length) return [];
    groups.push(arr);
  }

  const tokens = tokenizeQuery(qRaw);
  for (const token of tokens) {
    const arr = lookupTokenMatches(idx, token);
    if (!arr.length) return [];
    groups.push(arr);
  }

  if (!groups.length) {
    return rows.map((_, i) => i);
  }

  groups.sort((a, b) => a.length - b.length);
  let current = groups[0];

  for (let i = 1; i < groups.length; i++) {
    current = intersectSortedArrays(current, groups[i]);
    if (!current.length) {
      return [];
    }
  }

  return current;
}

function normalizeListQueryParams(q, tag, cat, mood) {
  const norm = (val) => String(val || '').trim().toLowerCase();
  const normalized = {
    q: norm(q).replace(/\s+/g, ' '),
    tag: norm(tag),
    category: norm(cat),
    mood: norm(mood)
  };
  return normalized;
}

function buildListCacheKey(etag, params) {
  const { q, tag, category, mood, page, size } = params;
  const payload = JSON.stringify([q, tag, category, mood, page, size]);
  return `list_v1:${etag}:${payload}`;
}

async function handleList(qp, env, ctx) {
  const pageDefault = Number(env.PAGE_DEFAULT || 12);
  const pageMax = Number(env.PAGE_MAX || 48);
  const page = clamp(qp.page || 1, 1, 100000);
  const size = clamp(qp.page_size || pageDefault, 1, pageMax);
  const q    = (qp.q || '').trim();
  const tag  = (qp.tag || '').trim();
  const cat  = (qp.category || '').trim();
  const mood = (qp.mood || '').trim();
  const ifE  = (qp.if_etag || '').trim();

  const idx = await getIndex(env, ctx);

  const listCacheTtlSeconds = getListCacheTtlSeconds(env);
  const listCacheTtlMs = listCacheTtlSeconds * 1000;

  const normalized = normalizeListQueryParams(q, tag, cat, mood);
  const filtersCleared = !normalized.q && !normalized.tag && !normalized.category && !normalized.mood;

  if (idx.etag !== listMemoryCacheEtag) {
    listMemoryCache.clear();
    listMemoryCacheEtag = idx.etag;
    listMemoryCacheLastFiltersCleared = filtersCleared;
  } else if (filtersCleared && !listMemoryCacheLastFiltersCleared) {
    listMemoryCache.clear();
    listMemoryCacheLastFiltersCleared = true;
  } else {
    listMemoryCacheLastFiltersCleared = filtersCleared;
  }

  const cacheParams = { ...normalized, page, size };
  const cacheKey = buildListCacheKey(idx.etag, cacheParams);

  const serveCached = (payload) => {
    if (!payload) return null;
    if (page === 1 && filtersCleared && ifE && ifE === idx.etag) {
      return { ok: true, etag: idx.etag, not_modified: true, total: payload.total, page: 1, page_size: size };
    }
    return payload;
  };

  const memoryCached = getListMemoryCacheEntry(cacheKey, listCacheTtlMs);
  if (memoryCached) {
    const cachedResponse = serveCached(memoryCached);
    if (cachedResponse) return cachedResponse;
  }

  if (ifE && ifE === idx.etag && page === 1 && filtersCleared) {
    return { ok: true, etag: idx.etag, not_modified: true, total: idx.rows.length, page: 1, page_size: size };
  }

  const kvCached = await env.MIXOLOGY.get(cacheKey, { type: 'json' });
  if (kvCached && kvCached.etag === idx.etag) {
    setListMemoryCacheEntry(cacheKey, kvCached, listCacheTtlMs);
    const cachedResponse = serveCached(kvCached);
    if (cachedResponse) return cachedResponse;
  }

  const filteredIndexes = filterIndex(idx, q, tag, cat, mood);
  const total = filteredIndexes.length;
  const start = (page - 1) * size;
  const end   = Math.min(start + size, total);
  const sliceIndexes = (start < total) ? filteredIndexes.slice(start, end) : [];
  const posts = sliceIndexes.map(i => serializeRow(idx.rows[i]));

  const categories = [];
  const seenCategories = new Set();
  for (const idxVal of filteredIndexes) {
    const row = idx.rows[idxVal];
    const categoryValue = row && row.category;
    if (categoryValue && !seenCategories.has(categoryValue)) {
      seenCategories.add(categoryValue);
      categories.push(categoryValue);
    }
  }

  const result = {
    ok: true,
    etag: idx.etag,
    total, page, page_size: size,
    has_more: end < total,
    posts,
    categories
  };

  setListMemoryCacheEntry(cacheKey, result, listCacheTtlMs);

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

  const post = await fetchRowFull(env, rec._row, headerMap, ctx);
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

/* ---------- GOOGLE SA OAUTH (JWT) ---------- */

async function getGoogleAccessToken(env) {
  // Try KV (cached token)
  const cached = await env.MIXOLOGY.get('google_oauth_token', { type: 'json' });
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.access_token && cached.exp && cached.exp - 60 > now) {
    return cached.access_token;
  }

  const { client_email, private_key } = JSON.parse(env.GOOGLE_SA_JSON || '{}');
  if (!client_email || !private_key) throw new Error('Missing GOOGLE_SA_JSON (client_email/private_key)');

  const iat = now;
  const exp = iat + 3600; // 1h
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const aud = 'https://oauth2.googleapis.com/token';

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: client_email, scope, aud, iat, exp };

  const jwt = await signJwtRS256(header, payload, private_key);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`oauth2 token ${resp.status}`);
  const data = await resp.json(); // { access_token, expires_in, token_type }

  await env.MIXOLOGY.put('google_oauth_token', JSON.stringify({
    access_token: data.access_token,
    exp: now + Math.max(0, Math.min(3600, (data.expires_in || 3600)))
  }), { expirationTtl: 3500 });

  return data.access_token;
}

async function signJwtRS256(header, payload, pemPrivateKey) {
  const enc = new TextEncoder();
  const input = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;

  const key = await importPkcs8PrivateKey(pemPrivateKey);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    enc.encode(input)
  );
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8PrivateKey(pem) {
  // pem: -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
                 .replace(/-----END PRIVATE KEY-----/g, '')
                 .replace(/\s+/g, '');
  const bin = b64ToArrayBuffer(b64);
  return crypto.subtle.importKey(
    'pkcs8',
    bin,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function b64urlFromString(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64ToArrayBuffer(b64) {
  const binStr = atob(b64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes.buffer;
}
