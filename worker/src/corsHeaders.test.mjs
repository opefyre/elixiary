import test from 'node:test';
import assert from 'node:assert/strict';

import { createOriginMatcher } from './index.js';

test('direct origin matches', () => {
  const matcher = createOriginMatcher(['https://example.com']);
  assert.ok(matcher.test('https://example.com'));
  assert.ok(!matcher.test('https://example.org'));
  assert.ok(!matcher.test('http://example.com'));
});

test('prefix wildcard matches subdomains and bare domain', () => {
  const matcher = createOriginMatcher(['https://*.web.app']);
  assert.ok(matcher.test('https://foo.web.app'));
  assert.ok(matcher.test('https://web.app'));
  assert.ok(!matcher.test('https://web.app.evil.com'));
});

test('mid-host wildcard matches firebase previews', () => {
  const matcher = createOriginMatcher(['https://elixiary--*.web.app']);
  assert.ok(matcher.test('https://elixiary--preview.web.app'));
  assert.ok(matcher.test('https://elixiary--feature-x.web.app'));
  assert.ok(!matcher.test('https://elixiary.web.app'));
});
