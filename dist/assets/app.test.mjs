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

const scriptSourcePromise = readFile(new URL('./app.js', import.meta.url), 'utf8');

function createContainerStub() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    style: {},
    disabled: false,
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    removeChild() {},
    replaceChild() {},
    addEventListener() {},
    removeEventListener() {},
    parentNode: {
      replaceChild() {}
    }
  };
}

async function createAppTestContext({ fetchImpl, elements = {} } = {}) {
  const scriptSource = await scriptSourcePromise;

  const storage = createStorageStub();
  const sessionStorage = createStorageStub();

  const elementMap = new Map();
  for (const [selector, element] of Object.entries(elements)) {
    elementMap.set(selector, element);
  }

  const defaultSelectors = [
    '#filters',
    '#filters-body',
    '#filters-toggle',
    '#filters-active-count',
    '#filters-active-count-sr',
    '#view',
    '#moreBtn',
    '#pager',
    '#active-filters'
  ];
  defaultSelectors.forEach((selector) => {
    if (!elementMap.has(selector)) {
      elementMap.set(selector, createContainerStub());
    }
  });

  const documentStub = {
    querySelector(selector) {
      return elementMap.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const el = createContainerStub();
      el.content = { firstElementChild: null };
      return el;
    },
    documentElement: Object.assign(createContainerStub(), {
      setAttribute() {},
      removeAttribute() {}
    }),
    body: Object.assign(createContainerStub(), {
      appendChild() {},
      removeChild() {}
    }),
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

  const AbortControllerRef = typeof AbortController === 'function'
    ? AbortController
    : class {
        constructor() {
          this.signal = {};
        }
        abort() {}
      };

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
    history: { pushState() {}, replaceState() {}, state: null },
    AbortController: AbortControllerRef
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
    AbortController: AbortControllerRef,
    Image: NoopImage,
    fetch: fetchImpl || (() => Promise.resolve({
      status: 200,
      headers: { get: () => null },
      json: async () => ({})
    }))
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
    matchMedia: windowStub.matchMedia,
    AbortController: AbortControllerRef
  });

  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);

  return {
    window: windowStub,
    document: documentStub,
    elements: elementMap
  };
}

test('FilterManager.createChipGroup drops placeholder category labels', async () => {
  const catContainer = createContainerStub();

  const { window } = await createAppTestContext({
    elements: {
      '#cat': catContainer
    }
  });

  const { FilterManager, AppState } = window.ElixiaryApp;
  AppState.filter.category = null;

  FilterManager.createChipGroup(['Classics', 'unknown_other', 'Tiki'], 'category', '#cat');

  const html = catContainer.innerHTML;
  assert.ok(html.includes('Classics'));
  assert.ok(html.includes('Tiki'));
  assert.ok(!html.includes('Unknown Other'));
  assert.ok(!html.includes('unknown_other'));
  assert.match(html, /data-v="classics"/);
  assert.match(html, /data-v="tiki"/);
});

test('APIClient.fetchList sends raw filter values while displaying labels', async () => {
  const catContainer = createContainerStub();
  const activeFiltersContainer = createContainerStub();
  const fetchCalls = [];

  const fetchStub = async (url) => {
    fetchCalls.push(url);
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        ok: true,
        posts: [{ id: 'abc', name: 'Test Cocktail' }],
        total: 1,
        has_more: false
      })
    };
  };

  const { window } = await createAppTestContext({
    fetchImpl: fetchStub,
    elements: {
      '#cat': catContainer,
      '#active-filters': activeFiltersContainer
    }
  });

  const { FilterManager, AppState, APIClient } = window.ElixiaryApp;

  FilterManager.createChipGroup(['Low ABV'], 'category', '#cat');
  assert.match(catContainer.innerHTML, /data-v="low abv"/);

  AppState.filter.category = 'low abv';
  FilterManager.renderActiveFilters();
  assert.match(activeFiltersContainer.innerHTML, /Low ABV/);

  const data = await APIClient.fetchList({ page: 1 });
  assert.equal(fetchCalls.length, 1);
  const requested = new URL(fetchCalls[0]);
  assert.equal(requested.searchParams.get('category'), 'low abv');
  assert.equal(data.ok, true);
  assert.equal(Array.isArray(data.posts) ? data.posts.length : 0, 1);
});
