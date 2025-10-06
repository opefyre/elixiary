import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeListQueryParams, buildListCacheKey, createListCache } from './cache.js';

test('normalizeListQueryParams trims and lowercases values', () => {
  const normalized = normalizeListQueryParams('  Foo BAR  ', ' Citrus ', ' Fresh ', ' HAPPY ');
  assert.deepEqual(normalized, {
    q: 'foo bar',
    tag: 'citrus',
    category: 'fresh',
    mood: 'happy'
  });
});

test('buildListCacheKey includes all parameters', () => {
  const key = buildListCacheKey('etag123', { q: 'a', tag: 'b', category: 'c', mood: 'd', page: 2, size: 10 });
  assert.equal(key, 'list_v1:etag123:["a","b","c","d",2,10]');
});

test('list cache invalidates when etag changes', () => {
  const cache = createListCache();
  const now = Date.now();
  cache.syncIndexState('etag1', false);
  cache.set('key', { value: 1 }, 1000, now);
  assert.ok(cache.get('key', 1000, now));
  cache.syncIndexState('etag2', false);
  assert.equal(cache.get('key', 1000, now), null);
});

test('list cache clears when filters reset', () => {
  const cache = createListCache();
  const now = Date.now();
  cache.syncIndexState('etag', false);
  cache.set('key', { value: 2 }, 1000, now);
  assert.ok(cache.get('key', 1000, now));
  cache.syncIndexState('etag', true);
  assert.equal(cache.get('key', 1000, now), null);
});
