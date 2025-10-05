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
        await env.MIXOLOGY.put(key, String(count + 1), { expirationTtl: windowSec + 5 });
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
        const data = await handleList(qp, env);
        return json(data, 200, {
          ...cors,
          'ETag': data.etag,
          'Cache-Control': 'public, max-age=60',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      if (path.startsWith('/v1/post/')) {
        const slug = decodeURIComponent(path.slice('/v1/post/'.length));
        const data = await handlePost(slug, env);
        const status = data.ok ? 200 : (data.code || 404);
        return json(data, status, {
          ...cors,
          'Cache-Control': 'public, max-age=60',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      if (path === '/v1/debug') {
        const idx = await getIndex(env);
        return json({ ok: true, total: idx.rows.length, sample: idx.rows.slice(0, 3) }, 200, {
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

  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const name = r[map['name']];
    const slug = slugify(name || '');
    if (!slug) continue;

    const img = driveImageLinks(r[map['image_url']]);
    rows.push({
      _row: i + 1,
      slug,
      name: String(name || ''),
      date: toDateISO(r[map['date']]),
      category: String((r[map['category']] || '')),
      difficulty: String((r[map['difficulty']] || '')),
      prep_time: String((r[map['preptime']] || r[map['prep_time']] || '')),
      tags: splitCSV(r[map['tags']]),
      mood_labels: splitCSV(r[map['moodlabels']] || r[map['mood_labels']]),
      image_url: img.src,
      image_thumb: img.thumb
    });
  }

  rows.sort((a, b) => {
    const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCmp !== 0) return dateCmp;
    return a.slug.localeCompare(b.slug);
  });

  const etag = await hashHex(API_VERSION + ':' + rows.length + ':' + rows.slice(0, 50).map(x => x.slug).join(','));
  return { rows, etag, _headerMap: map };
}

async function getIndex(env, opts = {}) {
  const ttl = Number(env.CACHE_TTL_SECONDS || 300);
  const forceRebuild = opts.forceRebuild === true;

  if (!forceRebuild) {
    const cached = await env.MIXOLOGY.get('idx_v1', { type: 'json' });
    if (cached && cached.rows && cached.etag && cached._headerMap) return cached;
  }

  const built = await buildIndexFromSheet(env);
  await env.MIXOLOGY.put('idx_v1', JSON.stringify(built), { expirationTtl: ttl });
  return built;
}

async function fetchRowFull(env, rowNumber, headerMap = null) {
  const range = `${env.SHEET_NAME}!A${rowNumber}:L${rowNumber}`;
  const data = await fetchSheetValues(env, range);
  const values = data.values || [];
  if (!values.length) return null;

  let map = headerMap;
  if (!map || !Object.keys(map).length) {
    const idx = await getIndex(env);
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

function filterIndex(rows, qRaw, tag, cat, mood) {
  let out = rows;
  if (qRaw) {
    const q = qRaw.toLowerCase();
    out = out.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (p.mood_labels || []).some(m => m.toLowerCase().includes(q))
    );
  }
  if (tag)  out = out.filter(p => (p.tags || []).map(t => t.toLowerCase()).includes(tag.toLowerCase()));
  if (cat)  out = out.filter(p => String(p.category || '').toLowerCase() === cat.toLowerCase());
  if (mood) out = out.filter(p => (p.mood_labels || []).map(m => m.toLowerCase()).includes(mood.toLowerCase()));
  return out;
}

async function handleList(qp, env) {
  const pageDefault = Number(env.PAGE_DEFAULT || 12);
  const pageMax = Number(env.PAGE_MAX || 48);
  const page = clamp(qp.page || 1, 1, 100000);
  const size = clamp(qp.page_size || pageDefault, 1, pageMax);
  const q    = (qp.q || '').trim();
  const tag  = (qp.tag || '').trim();
  const cat  = (qp.category || '').trim();
  const mood = (qp.mood || '').trim();
  const ifE  = (qp.if_etag || '').trim();

  const idx = await getIndex(env);

  // cache hint: allow reuse of first page if unchanged and no filters
  if (ifE && ifE === idx.etag && page === 1 && !q && !tag && !cat && !mood) {
    return { ok: true, etag: idx.etag, not_modified: true, total: idx.rows.length, page: 1, page_size: size };
  }

  const filtered = filterIndex(idx.rows, q, tag, cat, mood);
  const total = filtered.length;
  const start = (page - 1) * size;
  const end   = Math.min(start + size, total);
  const slice = (start < total) ? filtered.slice(start, end) : [];

  return {
    ok: true,
    etag: idx.etag,
    total, page, page_size: size,
    has_more: end < total,
    posts: slice
  };
}

async function handlePost(slug, env) {
  let idx = await getIndex(env);
  if (!idx._headerMap || !Object.keys(idx._headerMap).length) {
    idx = await getIndex(env, { forceRebuild: true });
  }

  const rec = idx.rows.find(p => p.slug.toLowerCase() === String(slug || '').toLowerCase());
  if (!rec) return { ok: false, code: 404, error: 'not_found' };

  let headerMap = idx._headerMap;
  if (!headerMap || !Object.keys(headerMap).length) {
    const head = await fetchSheetValues(env, `${env.SHEET_NAME}!A1:L1`);
    const header = (head.values && head.values[0]) || [];
    headerMap = Object.fromEntries(header.map((h, i) => [canon(h), i]));
  }

  const post = await fetchRowFull(env, rec._row, headerMap);
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
