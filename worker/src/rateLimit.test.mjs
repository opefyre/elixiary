import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from './rateLimit.js';

const scheduler = (ctx, promise) => {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise.catch(() => {}));
  } else {
    promise.catch(() => {});
  }
};

test('rate limiter enforces limit per IP', async () => {
  const limiter = createRateLimiter({ scheduleBackground: scheduler });
  const store = new Map();
  const env = {
    RL_LIMIT: '2',
    RL_WINDOW_SEC: '60',
    MIXOLOGY: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        store.set(key, value);
      }
    }
  };

  const ctx = { waitUntil: (p) => p.catch(() => {}) };
  const request = new Request('https://example.com/v1/list');
  const cors = {};
  const ip = '1.1.1.1';

  const first = await limiter({ request, env, ctx, cors, ip });
  assert.equal(first, null);

  const second = await limiter({ request, env, ctx, cors, ip });
  assert.equal(second, null);

  const third = await limiter({ request, env, ctx, cors, ip });
  assert.ok(third instanceof Response);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('X-RateLimit-Limit'), '2');
  assert.equal(third.headers.get('X-RateLimit-Remaining'), '0');
});
