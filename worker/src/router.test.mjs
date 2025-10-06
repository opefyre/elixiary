import test from 'node:test';
import assert from 'node:assert/strict';

import { createFetchHandler } from './router.js';

function createHandler(overrides = {}) {
  return createFetchHandler({
    rateLimiter: () => null,
    handleList: () => { throw new Error('handleList should not be called'); },
    handlePost: () => ({ ok: true, etag: 'etag' }),
    getIndex: () => ({ rows: [] }),
    serializeRow: (row) => row,
    ...overrides
  });
}

test('HEAD /v1/post/<slug> reuses GET handler logic', async () => {
  let calls = 0;
  const handler = createHandler({
    handlePost: (slug) => {
      calls += 1;
      assert.equal(slug, 'hello-world');
      return { ok: true, etag: 'etag-value' };
    }
  });

  const url = 'https://example.com/v1/post/hello-world';
  const getResponse = await handler(new Request(url));
  assert.equal(getResponse.status, 200);
  await getResponse.json();
  assert.equal(calls, 1);

  const headResponse = await handler(new Request(url, { method: 'HEAD' }));
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-type'), getResponse.headers.get('content-type'));
  assert.equal(await headResponse.text(), '');
  assert.equal(calls, 2);
});

test('HEAD /v1/post/<missing> mirrors GET status codes', async () => {
  let calls = 0;
  const handler = createHandler({
    handlePost: () => {
      calls += 1;
      return { ok: false, code: 404, error: 'missing' };
    }
  });

  const url = 'https://example.com/v1/post/missing';
  const getResponse = await handler(new Request(url));
  assert.equal(getResponse.status, 404);
  const body = await getResponse.json();
  assert.equal(body.error, 'missing');
  assert.equal(calls, 1);

  const headResponse = await handler(new Request(url, { method: 'HEAD' }));
  assert.equal(headResponse.status, 404);
  assert.equal(headResponse.headers.get('cache-control'), getResponse.headers.get('cache-control'));
  assert.equal(await headResponse.text(), '');
  assert.equal(calls, 2);
});
