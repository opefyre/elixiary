// Mixology API – Cloudflare Worker (Sheets API + KV cache)
// Routes:
//   GET /v1/list?page=&page_size=&q=&category=&difficulty=&tag=&mood=
//   GET /v1/post/<slug>

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '');

      // CORS preflight
      if (request.method === 'OPTIONS') {
        const h = new Headers(cors);
        const reqHeaders = request.headers.get('Access-Control-Request-Headers');
        if (reqHeaders) h.set('Access-Control-Allow-Headers', reqHeaders);
        h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        h.set('Access-Control-Max-Age', '86400');
        return new Response(null, { status: 204, headers: h });
      }

      if (path === '/v1/list') {
        const qp = objFromSearch(url.searchParams);
        const data = await handleList(qp, env);
        return json(data, 200, {
          ...cors,
          'ETag': data.etag,
          'Cache-Control': 'public, max-age=60'
        });
      }

      if (path.startsWith('/v1/post/')) {
        const slug = decodeURIComponent(path.slice('/v1/post/'.length));
        const data = await handlePost(slug, env);
        const status = data.ok ? 200 : (data.code || 404);
        return json(data, status, {
          ...cors,
          'Cache-Control': 'public, max-age=60'
        });
      }

      if (path === '/v1/debug') {
        const idx = await getIndex(env);
        return json({ ok: true, total: idx.rows.length, sample: idx.rows.slice(0, 3) }, 200, cors);
      }

      return new Response('Not found', { status: 404, headers: cors });
    } catch (err) {
      // Always include CORS on errors too
      return json({ ok: false, error: String(err) }, 500, cors);
    }
  }
};

/* ---------- CONFIG + UTIL ---------- */

const API_VERSION = 'v1';

/**
 * Safer CORS:
 * - Allows exact prod origins (elixiary.com, www.elixiary.com, elixiary.web.app)
 * - Allows Firebase preview channels that end with: --elixiary.web.app
 * - Lets you extend via env:
 *     ALLOWED_ORIGINS  = comma/space separated list of exact origins or hosts
 *     ALLOWED_SUFFIXES = comma/space separated host suffixes (e.g. --elixiary.web.app)
 */
function corsHeaders(env, origin) {
  const headers = {
    'Vary': 'Origin',
    'Access-Control-Expose-Headers': 'ETag, Cache-Control'
  };
  if (!origin) return headers;

  let host = '';
  try {
    const u = new URL(origin);
    host = (u.hostname || '').toLowerCase();
  } catch {
    return headers; // invalid Origin
  }

  // Exact allow-list (prod)
  const exact = new Set([
    'elixiary.com',
    'www.elixiary.com',
    'elixiary.web.app'
  ]);

  // Extend exact list via env (accepts full origins or bare hosts)
  if (env.ALLOWED_ORIGINS) {
    String(env.ALLOWED_ORIGINS)
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(x => {
        try {
          const h = x.startsWith('http') ? new URL(x).hostname : x;
          exact.add(h.toLowerCase());
        } catch {}
      });
  }

  // Suffix allow-list for preview channels
  const defaultSuffixes = ['--elixiary.web.app'];
  const suffixes = env.ALLOWED_SUFFIXES
    ? String(env.ALLOWED_SUFFIXES).split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    : defaultSuffixes;

  const allowed =
    exact.has(host) ||
    suffixes.some(suf => host.endsWith(suf.toLowerCase()));

  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
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
  const url = `${base}${encodeURIComponent(rangeA1)}?key=${env.GOOGLE_API_KEY}`;
  const r = await fetch(url, { cf: { cacheEverything: false }});
  if (!r.ok) throw new Error(`Sheets API ${r.status}`);
  return r.json();
}

async function buildIndexFromSheet(env) {
  const range = `${env.SHEET_NAME}!A1:L`;
  const data = await fetchSheetValues(env, range);
  const values = data.values || [];
  if (!values.length) return { rows: [], etag: await hashHex(API_VERSION + ':empty') };

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

  const etag = await hashHex(API_VERSION + ':' + rows.length + ':' + rows.slice(0, 50).map(x => x.slug).join(','));
  return { rows, etag };
}

async function getIndex(env) {
  const ttl = Number(env.CACHE_TTL_SECONDS || 300);
  const cached = await env.MIXOLOGY.get('idx_v1', { type: 'json' });
  if (cached && cached.rows && cached.etag) return cached;

  const built = await buildIndexFromSheet(env);
  await env.MIXOLOGY.put('idx_v1', JSON.stringify(built), { expirationTtl: ttl });
  return built;
}

async function fetchRowFull(env, rowNumber) {
  const range = `${env.SHEET_NAME}!A${rowNumber}:L${rowNumber}`;
  const data = await fetchSheetValues(env, range);
  const values = data.values || [];
  if (!values.length) return null;

  const head = await fetchSheetValues(env, `${env.SHEET_NAME}!A1:L1`);
  const header = (head.values && head.values[0]) || [];
  const map = Object.fromEntries(header.map((h, i) => [canon(h), i]));

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
  out = out.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
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
  const idx = await getIndex(env);
  const rec = idx.rows.find(p => p.slug.toLowerCase() === String(slug || '').toLowerCase());
  if (!rec) return { ok: false, code: 404, error: 'not_found' };
  const post = await fetchRowFull(env, rec._row);
  return { ok: true, post };
}
