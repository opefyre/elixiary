const GA_ID = 'G-PJ2GP3Q1K1';
const CONSENT_STORAGE_KEY = 'elixiary.consent.v1';

window.dataLayer = window.dataLayer || [];
window.gtag = window.gtag || function gtag(){
  window.dataLayer.push(arguments);
};

gtag('consent', 'default', {
  ad_storage: 'denied',
  analytics_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  wait_for_update: 500
});

function readStoredConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.analytics === 'boolean') {
      return parsed.analytics;
    }
  } catch (error) {
    console.warn('Failed to read consent preference', error);
  }
  return null;
}

function persistConsent(consented) {
  try {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ analytics: consented, ts: Date.now() })
    );
  } catch (error) {
    console.warn('Failed to persist consent preference', error);
  }
}

function applyConsent(consented) {
  gtag('consent', 'update', {
    analytics_storage: consented ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });
}

const storedConsent = readStoredConsent();
if (typeof storedConsent === 'boolean') {
  applyConsent(storedConsent);
}

function loadAnalyticsLibrary() {
  if (document.getElementById('ga-gtag-script')) return;
  const script = document.createElement('script');
  script.id = 'ga-gtag-script';
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  script.async = true;
  script.addEventListener('load', () => {
    gtag('js', new Date());
    gtag('config', GA_ID, {
      send_page_view: false,
      allow_ad_personalization_signals: false
      // ,debug_mode: true
    });
  });
  document.head.appendChild(script);
}

loadAnalyticsLibrary();

function showConsentBanner() {
  if (typeof storedConsent === 'boolean') {
    return;
  }

  const bar = document.createElement('div');
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-live', 'polite');
  bar.setAttribute('aria-label', 'Analytics consent request');
  Object.assign(bar.style, {
    position: 'fixed',
    inset: 'auto 12px 12px 12px',
    zIndex: '99999',
    background: '#111827',
    color: '#fff',
    padding: '12px 14px',
    borderRadius: '10px',
    font: '14px/1.4 system-ui',
    boxShadow: '0 10px 30px rgba(0,0,0,.25)',
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    flexWrap: 'wrap'
  });

  const label = document.createElement('span');
  label.textContent = 'We use anonymous analytics to improve Elixiary. OK to enable?';

  const buttonGroup = document.createElement('div');
  Object.assign(buttonGroup.style, {
    marginLeft: 'auto',
    display: 'flex',
    gap: '8px'
  });

  const allowBtn = document.createElement('button');
  allowBtn.id = 'consent-allow';
  allowBtn.type = 'button';
  allowBtn.textContent = 'Allow analytics';
  Object.assign(allowBtn.style, {
    background: '#10B981',
    color: '#fff',
    border: '0',
    borderRadius: '999px',
    padding: '8px 12px',
    cursor: 'pointer'
  });

  const denyBtn = document.createElement('button');
  denyBtn.id = 'consent-essentials';
  denyBtn.type = 'button';
  denyBtn.textContent = 'Essentials only';
  Object.assign(denyBtn.style, {
    background: '#374151',
    color: '#fff',
    border: '0',
    borderRadius: '999px',
    padding: '8px 12px',
    cursor: 'pointer'
  });

  allowBtn.addEventListener('click', () => {
    persistConsent(true);
    applyConsent(true);
    bar.remove();
  });

  denyBtn.addEventListener('click', () => {
    persistConsent(false);
    applyConsent(false);
    bar.remove();
  });

  buttonGroup.append(allowBtn, denyBtn);
  bar.append(label, buttonGroup);
  document.body.appendChild(bar);
}

function setupSearchTracking() {
  const input = document.getElementById('q');
  if (!input) return;
  let last = '';
  input.addEventListener('change', () => {
    const term = input.value.trim();
    if (term && term !== last) {
      last = term;
      gtag('event', 'search', { search_term: term });
    }
  });
}

function setupFilterTracking() {
  document.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    gtag('event', 'filter_change', {
      filter_name: chip.dataset.k || 'category',
      filter_value: chip.dataset.v || 'all'
    });
  });
}

function setupLoadMoreTracking() {
  document.addEventListener('click', (event) => {
    const btn = event.target.id === 'moreBtn' ? event.target : event.target.closest('#moreBtn');
    if (!btn) return;
    gtag('event', 'load_more', {
      next_page: (window.ElixiaryApp?.AppState?.page || 1) + 1,
      reason: 'button'
    });
  });
}

function setupOutboundTracking() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin) return;
    gtag('event', 'outbound_click', {
      link_url: url.href,
      link_text: (link.textContent || '').trim().slice(0, 80)
    });
  });
}

function setupErrorTracking() {
  window.addEventListener('error', (event) => {
    gtag('event', 'exception', {
      description: String(event.error?.message || event.message || 'Unknown error'),
      fatal: false
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    gtag('event', 'exception', {
      description: String(event.reason?.message || event.reason || 'Promise rejection'),
      fatal: false
    });
  });
}

function setupSpaHooks() {
  if (setupSpaHooks.bound) return;
  const app = window.ElixiaryApp;
  if (!app) return;

  if (app.InfiniteScroll) {
    const original = app.InfiniteScroll.loadNextPage;
    app.InfiniteScroll.loadNextPage = async function patchedLoadNextPage() {
      gtag('event', 'load_more', {
        next_page: (window.ElixiaryApp?.AppState?.page || 1) + 1,
        reason: 'infinite_scroll'
      });
      return original.apply(this, arguments);
    };
  }

  if (app.Renderer) {
    const originalRenderDetail = app.Renderer.renderDetail;
    app.Renderer.renderDetail = async function patchedRenderDetail(slug) {
      const recipe = await originalRenderDetail.call(app.Renderer, slug);
      try {
        if (recipe) {
          gtag('event', 'view_item', {
            items: [{
              item_id: String(slug),
              item_name: recipe.name || String(slug),
              item_category: recipe.category || ''
            }]
          });
        }
      } catch (error) {
        console.warn('Failed to track view_item', error);
      }
      return recipe;
    };
  }

  setupSpaHooks.bound = true;
}

setupFilterTracking();
setupLoadMoreTracking();
setupOutboundTracking();
setupErrorTracking();

window.addEventListener('elixiary:app-ready', setupSpaHooks, { once: false });
if (window.ElixiaryApp) {
  setupSpaHooks();
}

document.addEventListener('DOMContentLoaded', () => {
  setupSearchTracking();
  showConsentBanner();
});
