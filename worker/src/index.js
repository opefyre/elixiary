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
      if (path.startsWith('/v1/')) {
        const limit = Number(env.RL_LIMIT || 60);          // requests
        const windowSec = Number(env.RL_WINDOW_SEC || 60); // per N seconds
        const ip = clientIp(request) || 'unknown';
        const now = Date.now();
        const bucket = Math.floor(now / 1000 / windowSec);
        const key = `rl:${ip}:${bucket}`;

        let count = 0;
        const current = await env.MIXOLOGY.get(key);
        if (current) count = parseInt(current, 10) || 0;

        if (count >= limit) {
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

        // Increment best-effort and set TTL slightly beyond window
        const incr = env.MIXOLOGY.put(key, String(count + 1), { expirationTtl: windowSec + 5 });
        scheduleBackground(ctx, incr, 'rate_limit_increment');
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
let listMemoryCacheEtag = null;
let listMemoryCacheLastFiltersCleared = true;

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
async function hashHex(s) {
  const buf = new TextEncoder().encode(s);
  const out = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(out)].map(b => b.toString(16).padStart(2, '0')).join('');
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
  const slugIndexOut = Object.create(null);
  for (const [slugLc, row] of Object.entries(slugIndexRefs)) {
    const pos = rowToIndex.get(row);
    if (typeof pos === 'number') {
      slugIndexOut[slugLc] = pos;
    }
  }

  const etag = await hashHex(API_VERSION + ':' + rows.length + ':' + rows.slice(0, 50).map(x => x.slug).join(','));
  return { rows, etag, _headerMap: map, _categoryIndex: categoryIndexOut, _tagIndex: tagIndexOut, _moodIndex: moodIndexOut, _tokenIndex: tokenIndexOut, _slugIndex: slugIndexOut };
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

function hasPrecomputedMaps(idx) {
  if (!idx || typeof idx !== 'object') return false;
  const maps = ['_categoryIndex', '_tagIndex', '_moodIndex', '_tokenIndex', '_slugIndex'];
  for (const key of maps) {
    if (!idx[key] || typeof idx[key] !== 'object') return false;
  }
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
  if (!token || !idx || typeof idx._tokenIndex !== 'object') return [];
  const direct = idx._tokenIndex[token];
  if (Array.isArray(direct) && direct.length) {
    return direct;
  }
  const fallback = new Set();
  for (const [existing, arr] of Object.entries(idx._tokenIndex || {})) {
    if (existing.includes(token)) {
      for (const val of arr) fallback.add(val);
    }
  }
  return fallback.size ? Array.from(fallback).sort((a, b) => a - b) : [];
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

  const memoryCached = listMemoryCache.get(cacheKey);
  if (memoryCached) {
    const cachedResponse = serveCached(memoryCached);
    if (cachedResponse) return cachedResponse;
  }

  if (ifE && ifE === idx.etag && page === 1 && filtersCleared) {
    return { ok: true, etag: idx.etag, not_modified: true, total: idx.rows.length, page: 1, page_size: size };
  }

  const kvCached = await env.MIXOLOGY.get(cacheKey, { type: 'json' });
  if (kvCached && kvCached.etag === idx.etag) {
    listMemoryCache.set(cacheKey, kvCached);
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

  listMemoryCache.set(cacheKey, result);

  const expirationTtl = Math.max(60, Math.min(120, Number(env.LIST_CACHE_TTL_SECONDS || 90)));
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
