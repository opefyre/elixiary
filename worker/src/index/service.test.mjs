import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexService } from './service.js';

test('getIndex persists indefinitely and omits expirationTtl when TTL <= 0', async (t) => {
  const originalFetch = global.fetch;
  const fetchCalls = [];
  const putCalls = [];

  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      json: async () => ({
        values: [
          ['Name', 'Image_URL', 'Category', 'Tags', 'Mood_Labels', 'Prep_Time', 'Difficulty', 'Date', 'Ingredients_JSON', 'Instructions', 'Glass', 'Garnish'],
          ['Test Drink', 'https://example.com/image.jpg', 'Classics', 'citrus,refreshing', 'happy', '5', 'Easy', '2024-01-01', '[]', 'Shake well', 'Coupe', 'Lime'],
        ],
      }),
    };
  };

  t.after(() => {
    global.fetch = originalFetch;
  });

  const mixologyStore = {
    get: async () => null,
    put: (...args) => {
      putCalls.push(args);
      return Promise.resolve();
    },
  };

  const env = {
    SHEET_ID: 'sheet123',
    SHEET_NAME: 'Sheet1',
    GOOGLE_API_KEY: 'apikey',
    CACHE_TTL_SECONDS: '0',
    MIXOLOGY: mixologyStore,
  };

  const scheduled = [];
  const { getIndex } = createIndexService({
    scheduleBackground: (_ctx, promise, tag) => {
      scheduled.push(tag);
      return promise;
    },
  });

  const ctx = {};

  const index = await getIndex(env, ctx);
  assert.ok(index);
  assert.equal(fetchCalls.length, 1);
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].length, 2);
  assert.equal(putCalls[0][0], 'idx_v1');
  assert.equal(typeof putCalls[0][1], 'string');

  const indexAgain = await getIndex(env, ctx);
  assert.strictEqual(indexAgain, index);
  assert.equal(fetchCalls.length, 1);
  assert.equal(putCalls.length, 1);

  assert.ok(scheduled.includes('index_cache_write'));
});

test('handleList omits placeholder categories from responses', async (t) => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  const sheetResponse = {
    values: [
      ['Name', 'Image_URL', 'Category', 'Tags', 'Mood_Labels', 'Prep_Time', 'Difficulty', 'Date', 'Ingredients_JSON', 'Instructions', 'Glass', 'Garnish'],
      ['Tiki Time', 'https://example.com/tiki.jpg', 'Tiki', 'tropical', 'happy', '5', 'Medium', '2024-01-04', '[]', 'Blend with ice', 'Tiki', 'Pineapple'],
      ['Mystery Mix', 'https://example.com/mystery.jpg', 'unknown_other', '', '', '4', 'Easy', '2024-01-03', '[]', 'Stir gently', 'Rocks', 'Orange Twist'],
      ['Classic Sour', 'https://example.com/classic.jpg', 'Classics', 'citrus', 'bright', '3', 'Easy', '2024-01-02', '[]', 'Shake well', 'Coupe', 'Lemon']
    ]
  };

  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      json: async () => sheetResponse
    };
  };

  t.after(() => {
    global.fetch = originalFetch;
  });

  const kvStore = new Map();
  const mixologyStore = {
    async get(key) {
      return kvStore.has(key) ? kvStore.get(key) : null;
    },
    async put(key, value) {
      const stored = typeof value === 'string' ? JSON.parse(value) : value;
      kvStore.set(key, stored);
      return Promise.resolve();
    }
  };

  const env = {
    SHEET_ID: 'sheet123',
    SHEET_NAME: 'Sheet1',
    GOOGLE_API_KEY: 'apikey',
    CACHE_TTL_SECONDS: 300,
    MIXOLOGY: mixologyStore
  };

  const { handleList } = createIndexService({
    scheduleBackground: (_ctx, promise) => promise
  });

  const ctx = {};
  const response = await handleList({}, env, ctx);

  assert.ok(response.ok);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(response.categories, ['Tiki', 'Classics']);
  assert.ok(!response.categories.includes('unknown_other'));
  assert.deepEqual(response.moods, ['happy', 'bright']);
});
