import { json } from './utils.js';

export function createFetchHandler({ rateLimiter, handleList, handlePost, getIndex, serializeRow }) {
  if (typeof rateLimiter !== 'function') throw new TypeError('rateLimiter must be a function');
  if (typeof handleList !== 'function') throw new TypeError('handleList must be a function');
  if (typeof handlePost !== 'function') throw new TypeError('handlePost must be a function');
  if (typeof getIndex !== 'function') throw new TypeError('getIndex must be a function');
  if (typeof serializeRow !== 'function') throw new TypeError('serializeRow must be a function');

  return async function fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = createCorsHeaders(env, origin);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '');
      const method = request.method || 'GET';

      if (method === 'OPTIONS') {
        const h = new Headers(cors);
        const reqHeaders = request.headers.get('Access-Control-Request-Headers');
        if (reqHeaders) h.set('Access-Control-Allow-Headers', reqHeaders);
        h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        h.set('Access-Control-Max-Age', '86400');
        return new Response(null, { status: 204, headers: h });
      }

      if (path.startsWith('/v1/') && !['GET', 'HEAD'].includes(method)) {
        return json({ ok: false, error: 'method_not_allowed' }, 405, {
          ...cors,
          'Allow': 'GET, HEAD, OPTIONS',
          'X-Content-Type-Options': 'nosniff'
        });
      }

      if (path.startsWith('/v1/')) {
        const ip = clientIp(request) || 'unknown';
        const rateLimitResponse = await rateLimiter({ request, env, ctx, cors, ip });
        if (rateLimitResponse) {
          return rateLimitResponse;
        }
      }

      if (method === 'HEAD' && path.startsWith('/v1/')) {
        return new Response(null, {
          status: 200,
          headers: { ...cors, 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' }
        });
      }

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
  };
}

export function createCorsHeaders(env, origin) {
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

  const matcher = createOriginMatcher(patterns);
  if (matcher.allowAll) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  if (matcher.test(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

export function createOriginMatcher(patterns = []) {
  const compiled = [];
  let allowAll = false;

  for (const pattern of patterns) {
    const value = (pattern || '').trim();
    if (!value) continue;
    if (value === '*') {
      allowAll = true;
      continue;
    }

    const compiledPattern = compileCorsPattern(value);
    if (compiledPattern) compiled.push(compiledPattern);
  }

  return {
    allowAll,
    test(origin) {
      if (!origin) return false;
      let url;
      try {
        url = new URL(origin);
      } catch (_) {
        return false;
      }

      const proto = url.protocol.toLowerCase();
      const host = url.host.toLowerCase();

      for (const entry of compiled) {
        if (entry.protocol !== proto) continue;
        if (entry.hostRegex.test(host)) return true;
        if (entry.allowBareSuffix && host === entry.allowBareSuffix) return true;
      }
      return false;
    }
  };
}

function compileCorsPattern(pattern) {
  const match = pattern.match(/^(https?):\/\/([^/]+)$/i);
  if (!match) return null;

  const protocol = `${match[1].toLowerCase()}:`;
  const hostPattern = match[2];
  const allowBareSuffix = hostPattern.startsWith('*.')
    ? hostPattern.slice(2).toLowerCase()
    : null;

  const escaped = hostPattern
    .split('*')
    .map(escapeRegExp)
    .join('.*');

  const hostRegex = new RegExp(`^${escaped}$`, 'i');
  return { protocol, hostRegex, allowBareSuffix };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
      || request.headers.get('True-Client-IP')
      || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
      || '';
}

function objFromSearch(sp) {
  const o = {};
  for (const [k, v] of sp) o[k] = v;
  return o;
}
