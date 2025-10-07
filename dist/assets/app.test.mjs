import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function createStorageStub() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

test('FilterManager.createChipGroup drops placeholder category labels', async () => {
  const scriptSource = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  const catContainer = {
    innerHTML: '',
    setAttribute() {},
    querySelector() { return null; },
    appendChild() {},
    removeChild() {},
    classList: { add() {}, remove() {}, toggle() {} }
  };

  const documentStub = {
    querySelector(selector) {
      if (selector === '#cat') return catContainer;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return {
        setAttribute() {},
        removeAttribute() {},
        appendChild() {},
        remove() {},
        innerHTML: '',
        content: { firstElementChild: null },
        classList: { add() {}, remove() {}, toggle() {} }
      };
    },
    documentElement: {
      setAttribute() {},
      removeAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} }
    },
    body: {
      setAttribute() {},
      appendChild() {},
      removeChild() {},
      classList: { add() {}, remove() {}, toggle() {} }
    },
    head: {
      appendChild() {},
      removeChild() {}
    }
  };

  const locationStub = {
    origin: 'https://example.com',
    pathname: '/',
    href: 'https://example.com/',
    search: '',
    hash: '',
    replace() {},
    assign() {}
  };

  const navigatorStub = {
    onLine: true,
    userAgent: 'node',
    platform: 'node'
  };

  const storage = createStorageStub();
  const sessionStorage = createStorageStub();

  class CustomEvt {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  class NoopObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  class NoopImage {
    constructor() {
      this.decoding = 'async';
    }
    set src(_) {
      if (typeof this.onload === 'function') this.onload();
    }
    addEventListener() {}
    removeEventListener() {}
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance: { now: () => Date.now() },
    history: { pushState() {}, replaceState() {}, state: null }
  };

  const windowStub = {
    document: documentStub,
    navigator: navigatorStub,
    location: locationStub,
    localStorage: storage,
    sessionStorage,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    innerWidth: 1280,
    innerHeight: 720,
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    CustomEvent: CustomEvt,
    IntersectionObserver: NoopObserver,
    MutationObserver: NoopObserver,
    ResizeObserver: NoopObserver,
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    Image: NoopImage,
    navigator: navigatorStub
  };

  windowStub.window = windowStub;

  Object.assign(sandbox, {
    window: windowStub,
    document: documentStub,
    navigator: navigatorStub,
    location: locationStub,
    localStorage: storage,
    sessionStorage,
    CustomEvent: CustomEvt,
    fetch: windowStub.fetch,
    Image: NoopImage,
    IntersectionObserver: NoopObserver,
    MutationObserver: NoopObserver,
    ResizeObserver: NoopObserver,
    matchMedia: windowStub.matchMedia
  });

  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);

  const { FilterManager, AppState } = sandbox.window.ElixiaryApp;
  AppState.filter.category = null;

  FilterManager.createChipGroup(['Classics', 'unknown_other', 'Tiki'], 'category', '#cat');

  const html = catContainer.innerHTML;
  assert.ok(html.includes('Classics'));
  assert.ok(html.includes('Tiki'));
  assert.ok(!html.includes('Unknown Other'));
  assert.ok(!html.includes('unknown_other'));
});
