// ===== CONFIGURATION =====
  const CONFIG = {
    API_BASE: 'https://api.elixiary.com/v1',
    PAGE_SIZE: 12,
    CACHE_TTL_MS: 10 * 60 * 1000, // 10 minutes
    FETCH_TIMEOUT_MS: 12000, // 12 seconds
    DEBOUNCE_MS: 180,
    SCROLL_MARGIN: '400px', // Reduced from 600px
    IMAGE_TIMEOUT_MS: 2500,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 1000
  };

  // ===== STATE MANAGEMENT =====
  const AppState = {
    filter: { category: null, mood: null, q: '' },
    etag: null,
    page: 1,
    hasMore: true,
    gridEl: null,
    chipsBuilt: false,
    loadingMore: false,
    observer: null,
    retryCount: 0,
    requestId: 0,
    isOnline: navigator.onLine,
    theme: 'light',
    themePreference: 'auto',
    filterSets: {
      category: new Set(),
      mood: new Set()
    },
    filterSignatures: {
      category: '',
      mood: ''
    },
    searchHandlersBound: false,
    globalHandlersBound: false,
    schema: {
      homeScript: null,
      homeMarkup: '',
      recipeScript: null
    },
    filtersExpanded: true
  };

  // ===== UTILITIES =====
  const DEFAULT_META_DESCRIPTION = (() => {
    const meta = document.querySelector('meta[name="description"]');
    return (meta && meta.content) || 'Discover and explore an extensive collection of cocktail recipes with detailed ingredients, instructions, and beautiful photography. Find your perfect drink.';
  })();

  const DEFAULT_SOCIAL_META = (() => {
    const getContent = (selector) => {
      const el = document.querySelector(selector);
      return (el && el.getAttribute('content')) || '';
    };

    return {
      ogTitle: getContent('meta[property="og:title"]'),
      ogDescription: getContent('meta[property="og:description"]'),
      ogImage: getContent('meta[property="og:image"]'),
      twitterTitle: getContent('meta[name="twitter:title"]'),
      twitterDescription: getContent('meta[name="twitter:description"]'),
      twitterImage: getContent('meta[name="twitter:image"]')
    };
  })();

  const DEFAULT_PAGE_URLS = (() => {
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    const ogEl = document.querySelector('meta[property="og:url"]');
    const twitterEl = document.querySelector('meta[name="twitter:url"]');

    const fallback = `${location.origin.replace(/\/$/, '')}/`;
    const canonicalHref = (canonicalEl && canonicalEl.getAttribute('href')) || fallback;

    let canonicalUrl;
    try {
      canonicalUrl = new URL(canonicalHref, location.origin);
    } catch (_) {
      canonicalUrl = new URL(fallback);
    }

    const basePath = canonicalUrl.pathname.replace(/^\/+|\/+$/g, '');

    return {
      canonical: canonicalUrl.toString(),
      og: (ogEl && ogEl.getAttribute('content')) || canonicalUrl.toString(),
      twitter: (twitterEl && twitterEl.getAttribute('content')) || canonicalUrl.toString(),
      baseUrl: canonicalUrl,
      basePath
    };
  })();

  const Utils = {
    $: sel => document.querySelector(sel),
    $$: sel => document.querySelectorAll(sel),
    
    esc: s => String(s||'').replace(/[&<>"']/g, c=>({ 
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' 
    }[c])),
    
    fmtDate: s => {
      if(!s) return '';
      const d=new Date(s);
      return isNaN(d)? s : d.toLocaleDateString(undefined,{
        year:'numeric',month:'short',day:'numeric'
      });
    },

    toIsoDuration: (value) => {
      if (typeof value !== 'string') return '';

      const trimmed = value.trim();
      if (!trimmed) return '';

      if (/^P(T|\d)/i.test(trimmed)) {
        return trimmed.replace(/^pt/, 'PT');
      }

      const cleaned = trimmed
        .replace(/[~≈]/g, ' ')
        .replace(/\band\b/gi, ' ')
        .replace(/[,/-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const matches = cleaned.matchAll(/(\d+(?:\.\d+)?)(?:\s*)(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/gi);

      let hasMatch = false;
      const totals = { H: 0, M: 0, S: 0 };

      for (const match of matches) {
        const quantity = parseFloat(match[1]);
        if (!Number.isFinite(quantity)) continue;

        const unit = match[2].toLowerCase();
        if (unit.startsWith('h')) {
          totals.H += quantity;
          hasMatch = true;
        } else if (unit.startsWith('m')) {
          totals.M += quantity;
          hasMatch = true;
        } else if (unit.startsWith('s')) {
          totals.S += quantity;
          hasMatch = true;
        }
      }

      if (!hasMatch) {
        return trimmed;
      }

      const format = (num) => {
        if (!num) return '';
        const normalized = Number.isInteger(num) ? String(num) : String(num).replace(/\.0+$/, '');
        return normalized;
      };

      let iso = 'PT';
      const hours = format(totals.H);
      const minutes = format(totals.M);
      const seconds = format(totals.S);

      if (hours) iso += `${hours}H`;
      if (minutes) iso += `${minutes}M`;
      if (seconds) iso += `${seconds}S`;

      return iso.length > 2 ? iso : trimmed;
    },

    labelize: s => String(s||'')
      .replace(/^(cat|glass|style|strength|flavor|energy|occ)_/,'')
      .replace(/_/g,' ')
      .replace(/\b\w/g,m=>m.toUpperCase()),
    
    debounce: (fn, ms = CONFIG.DEBOUNCE_MS) => {
      let t; 
      return (...a) => { 
        clearTimeout(t); 
        t = setTimeout(() => fn(...a), ms); 
      }; 
    },
    
    announce: (message) => {
      const liveRegion = Utils.$('#live-region');
      if (liveRegion) {
        liveRegion.textContent = message;
        // Clear after announcement
        setTimeout(() => {
          liveRegion.textContent = '';
        }, 1000);
      }
    },

    setTitle: (title) => {
      const fullTitle = title ? `${title} · Elixiary` : 'Elixiary - Discover Amazing Cocktail Recipes';
      document.title = fullTitle;

      let description = DEFAULT_META_DESCRIPTION;
      if (title && title !== 'Elixiary') {
        description = `Learn how to make ${title} with detailed ingredients and instructions. Discover more cocktail recipes at Elixiary.`;
      }

      const metaDesc = Utils.$('meta[name="description"]');
      if (metaDesc) {
        metaDesc.setAttribute('content', description);
      }

      return { fullTitle, description };
    },

    updateSocialMeta: ({ title, description, image } = {}) => {
      const resolvedOgTitle = (typeof title === 'string' && title.trim()) || DEFAULT_SOCIAL_META.ogTitle || document.title;
      const resolvedTwitterTitle = (typeof title === 'string' && title.trim())
        || DEFAULT_SOCIAL_META.twitterTitle
        || resolvedOgTitle;

      const resolvedDescription = (typeof description === 'string' && description.trim())
        || DEFAULT_SOCIAL_META.ogDescription
        || DEFAULT_META_DESCRIPTION;
      const resolvedTwitterDescription = (typeof description === 'string' && description.trim())
        || DEFAULT_SOCIAL_META.twitterDescription
        || resolvedDescription;

      const resolvedImage = (typeof image === 'string' && image.trim()) || DEFAULT_SOCIAL_META.ogImage;
      const resolvedTwitterImage = (typeof image === 'string' && image.trim())
        || DEFAULT_SOCIAL_META.twitterImage
        || resolvedImage;

      const setContent = (selector, value) => {
        const el = Utils.$(selector);
        if (el && typeof value === 'string') {
          el.setAttribute('content', value);
        }
      };

      setContent('meta[property="og:title"]', resolvedOgTitle);
      setContent('meta[name="twitter:title"]', resolvedTwitterTitle);
      setContent('meta[property="og:description"]', resolvedDescription);
      setContent('meta[name="twitter:description"]', resolvedTwitterDescription);
      setContent('meta[property="og:image"]', resolvedImage);
      setContent('meta[name="twitter:image"]', resolvedTwitterImage);
    },

    restoreSocialMeta: () => {
      Utils.updateSocialMeta();
    },

    buildRecipeSocialDescription(recipe, fallbackDescription) {
      if (!recipe) return fallbackDescription || DEFAULT_META_DESCRIPTION;

      if (typeof fallbackDescription === 'string' && fallbackDescription.trim()) {
        return fallbackDescription.trim();
      }

      const instructions = String(recipe.instructions || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (instructions) {
        return instructions.length > 200 ? `${instructions.slice(0, 197)}…` : instructions;
      }

      const details = [];
      const labelize = (value) => {
        if (typeof Utils.labelize === 'function') {
          return Utils.labelize(value);
        }
        return String(value || '');
      };

      if (recipe.category) {
        details.push(labelize(recipe.category));
      }
      if (recipe.difficulty) {
        details.push(`Difficulty: ${recipe.difficulty}`);
      }
      if (recipe.prep_time) {
        details.push(`Prep: ${recipe.prep_time}`);
      }

      const detailSuffix = details.length ? ` (${details.join(' • ')})` : '';
      const baseName = recipe.name || 'this cocktail';
      return `Learn how to make ${baseName}${detailSuffix} with Elixiary's curated cocktail recipes.`;
    },

    updateRecipeSocialMeta(recipe, { description } = {}) {
      if (!recipe) {
        Utils.restoreSocialMeta();
        return;
      }

      const recipeTitle = recipe.name ? `${recipe.name} · Elixiary` : null;
      const socialDescription = Utils.buildRecipeSocialDescription(recipe, description);
      const socialImage = (recipe.image_url || recipe.image_thumb || '').trim();

      Utils.updateSocialMeta({
        title: recipeTitle,
        description: socialDescription,
        image: socialImage
      });
    },

    updateShareUrls: (path = location.pathname) => {
      const canonicalLink = Utils.$('link[rel="canonical"]');
      const ogUrl = Utils.$('meta[property="og:url"]');
      const twitterUrl = Utils.$('meta[name="twitter:url"]');

      if (!canonicalLink && !ogUrl && !twitterUrl) return;

      let slug = Utils.normalizeSlug(path);

      if (slug && DEFAULT_PAGE_URLS.basePath) {
        if (slug === DEFAULT_PAGE_URLS.basePath) {
          slug = '';
        } else if (slug.startsWith(`${DEFAULT_PAGE_URLS.basePath}/`)) {
          slug = slug.slice(DEFAULT_PAGE_URLS.basePath.length + 1);
        }
      }

      const hasSlug = Boolean(slug);
      let resolvedUrl = DEFAULT_PAGE_URLS.canonical;

      if (hasSlug) {
        try {
          resolvedUrl = new URL(slug, DEFAULT_PAGE_URLS.baseUrl).toString();
        } catch (_) {
          resolvedUrl = `${location.origin.replace(/\/$/, '')}/${slug}`;
        }
      }

      if (canonicalLink) {
        canonicalLink.setAttribute('href', hasSlug ? resolvedUrl : DEFAULT_PAGE_URLS.canonical);
      }
      if (ogUrl) {
        ogUrl.setAttribute('content', hasSlug ? resolvedUrl : DEFAULT_PAGE_URLS.og);
      }
      if (twitterUrl) {
        twitterUrl.setAttribute('content', hasSlug ? resolvedUrl : DEFAULT_PAGE_URLS.twitter);
      }
    },

    normalizeSlug: (value = '') => {
      if (typeof value !== 'string') return '';
      const trimmed = value.trim();
      if (!trimmed) return '';

      // Remove origin if a full URL is provided
      let pathname = trimmed;
      if (/^https?:\/\//i.test(trimmed)) {
        try {
          pathname = new URL(trimmed).pathname;
        } catch (_) {
          pathname = trimmed;
        }
      }

      const stripped = pathname.replace(/^\/+|\/+$/g, '');
      if (!stripped) return '';

      // Collapse any duplicate slashes between segments
      return stripped.split('/').filter(Boolean).join('/');
    },

    normalizePath: (value = '/') => {
      const slug = Utils.normalizeSlug(value);
      return slug ? `/${slug}` : '/';
    },

    ensureSchemaCache: () => {
      const current = AppState.schema.homeScript;
      if (!current || !document.contains(current)) {
        const script = document.querySelector('script[type="application/ld+json"]:not([data-schema])');
        if (script) {
          AppState.schema.homeScript = script;
          AppState.schema.homeMarkup = script.textContent || '';
        }
      }
    },

    applyRecipeSchema: (recipe) => {
      if (!recipe) return;
      Utils.ensureSchemaCache();

      const recipeJsonLd = Utils.generateRecipeJsonLd(recipe);
      if (!recipeJsonLd) return;

      let { recipeScript, homeScript } = AppState.schema;

      if (!recipeScript || !document.contains(recipeScript)) {
        recipeScript = document.createElement('script');
        recipeScript.type = 'application/ld+json';
        recipeScript.setAttribute('data-schema', 'recipe');

        if (homeScript && homeScript.parentNode) {
          homeScript.parentNode.insertBefore(recipeScript, homeScript.nextSibling);
        } else {
          (document.head || document.body || document.documentElement).appendChild(recipeScript);
        }

        AppState.schema.recipeScript = recipeScript;
      }

      recipeScript.textContent = JSON.stringify(recipeJsonLd, null, 2);
    },

    restoreHomeSchema: () => {
      Utils.ensureSchemaCache();

      const { recipeScript, homeScript, homeMarkup } = AppState.schema;
      if (recipeScript && recipeScript.parentNode) {
        recipeScript.parentNode.removeChild(recipeScript);
      }
      AppState.schema.recipeScript = null;

      if (homeScript && typeof homeMarkup === 'string') {
        homeScript.textContent = homeMarkup;
      }
    },

    generateRecipeJsonLd: (recipe) => {
      const prepTime = Utils.toIsoDuration(recipe.prep_time);
      const cookTime = Utils.toIsoDuration(recipe.cook_time);
      const totalTime = Utils.toIsoDuration(recipe.total_time);
      const slug = Utils.normalizeSlug(recipe.slug || DEFAULT_PAGE_URLS.basePath);

      let canonicalUrl = DEFAULT_PAGE_URLS.canonical;
      if (slug) {
        try {
          canonicalUrl = new URL(slug, DEFAULT_PAGE_URLS.baseUrl).toString();
        } catch (_) {
          canonicalUrl = `${location.origin.replace(/\/$/, '')}/${slug}`;
        }
      }

      const siteOrigin = (DEFAULT_PAGE_URLS.baseUrl && DEFAULT_PAGE_URLS.baseUrl.origin) || location.origin;
      const homeUrl = `${siteOrigin.replace(/\/$/, '')}/`;

      const recipeNode = {
        "@type": "Recipe",
        "@id": canonicalUrl,
        "url": canonicalUrl,
        "name": recipe.name,
        "description": recipe.instructions || "A delicious cocktail recipe",
        "image": recipe.image_url || recipe.image_thumb,
        "author": {
          "@type": "Organization",
          "@id": `${homeUrl}#org`,
          "name": "Elixiary"
        },
        "recipeCategory": recipe.category,
        "recipeCuisine": "Cocktail",
        "recipeIngredient": (recipe.ingredients || []).map(ing =>
          `${ing.measure || ''} ${ing.name || ''}`.trim()
        ),
        "recipeInstructions": recipe.instructions,
        "nutrition": {
          "@type": "NutritionInformation",
          "alcoholContent": recipe.alcohol_content || "Varies"
        }
      };

      if (prepTime) recipeNode.prepTime = prepTime;
      if (cookTime) recipeNode.cookTime = cookTime;
      if (totalTime) recipeNode.totalTime = totalTime;

      const breadcrumbNode = {
        "@type": "BreadcrumbList",
        "@id": `${canonicalUrl}#breadcrumb`,
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Home",
            "item": homeUrl
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": recipe.name || "Recipe",
            "item": canonicalUrl
          }
        ]
      };

      return {
        "@context": "https://schema.org",
        "@graph": [recipeNode, breadcrumbNode]
      };
    }
  };

  // ===== CACHE MANAGEMENT =====
  const CacheManager = {
    keyBase: () => 'mixology:index:' + JSON.stringify({
      q: AppState.filter.q,
      category: AppState.filter.category,
      mood: AppState.filter.mood
    }),
    
    get: (key) => {
      try { 
        const s = localStorage.getItem(key); 
        if (!s) return null; 
        const v = JSON.parse(s); 
        if (v.exp && Date.now() > v.exp) { 
          localStorage.removeItem(key); 
          return null; 
        } 
        return v; 
      } catch { 
        return null; 
      }
    },
    
    put: (key, val, ttlMs = CONFIG.CACHE_TTL_MS) => {
      try { 
        localStorage.setItem(key, JSON.stringify({
          exp: Date.now() + ttlMs, 
          ...val
        })); 
      } catch(e) {
        console.warn('Cache storage failed:', e);
      }
    },
    
    clearSearch: () => {
      try {
        Object.keys(localStorage).forEach(k => { 
          if (k.startsWith('mixology:index:')) localStorage.removeItem(k); 
        });
      } catch(e) {
        console.warn('Cache clear failed:', e);
      }
    }
  };

  // ===== NETWORK LAYER =====
  const APIClient = {
    async fetchWithRetry(url, options = {}, retries = CONFIG.RETRY_ATTEMPTS) {
      for (let i = 0; i < retries; i++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => 
            controller.abort(new Error('timeout')), CONFIG.FETCH_TIMEOUT_MS
          );
          
          const response = await fetch(url, {
            ...options,
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          return response;
          
        } catch (error) {
          if (i === retries - 1) throw error;
          
          // Wait before retry
          await new Promise(resolve => 
            setTimeout(resolve, CONFIG.RETRY_DELAY_MS * (i + 1))
          );
        }
      }
    },

    async fetchList({page, ifEtag}) {
      const url = new URL(`${CONFIG.API_BASE}/list`);
      url.searchParams.set('type', 'list');  // CRITICAL: Specify list type
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(CONFIG.PAGE_SIZE));
      url.searchParams.set('view', 'full'); // CRITICAL: Include images in response
      
      if (AppState.filter.q) url.searchParams.set('q', AppState.filter.q);
      if (AppState.filter.category) url.searchParams.set('category', AppState.filter.category);
      if (AppState.filter.mood) url.searchParams.set('mood', AppState.filter.mood);

      if (ifEtag) {
        url.searchParams.set('if_etag', ifEtag);
      }

      // Remove If-None-Match header due to CORS restrictions
      try {
        const res = await this.fetchWithRetry(url.toString(), {
          credentials: 'omit'
        });

        if (res.status === 304) return { ok: true, not_modified: true };

        const data = await res.json().catch(() => ({ok: false}));
        if (data && data.ok) {
          const newTag = res.headers.get('ETag') || data.etag || null;
          return { ...data, etag: newTag };
        }
        return { ok: false, error: data?.error || 'Failed to load recipes.' };
        
      } catch(e) {
        console.error('API Error:', e);
        if (e.name === 'AbortError' || e.message === 'timeout') {
          return { ok: false, error: 'Request timed out. Please check your connection.' };
        }
        return { ok: false, error: 'Network error. Please check your connection.' };
      }
    },

    async fetchPost(slug) {
      try {
        const res = await this.fetchWithRetry(
          `${CONFIG.API_BASE}/post/${encodeURIComponent(slug)}`,
          { credentials: 'omit' }
        );
      return await res.json();
      } catch(e) {
        console.error('API Error:', e);
        return { ok: false, error: 'Failed to load recipe.' };
      }
    }
  };

  // ===== THEME MANAGEMENT =====
  const ThemeManager = {
    STORAGE_KEY: 'elixiary:theme-preference',
    control: null,
    intervalId: null,
    mode: 'auto',
    mql: null,
    osListener: null,

    init() {
      this.mql = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

      this.bindThemeControls();

      const { theme, mode } = this.detectTheme();
      this.applyTheme(theme, mode);
      this.setupOsPreferenceListener();
    },

    getStoredPreference() {
      try {
        return localStorage.getItem(this.STORAGE_KEY);
      } catch (error) {
        console.warn('Unable to access stored theme preference:', error);
        return null;
      }
    },

    setStoredPreference(value) {
      try {
        localStorage.setItem(this.STORAGE_KEY, value);
      } catch (error) {
        console.warn('Unable to persist theme preference:', error);
      }
    },

    bindThemeControls() {
      const select = Utils.$('#theme-select');
      if (!select) return;

      this.control = select;
      const stored = this.getStoredPreference();
      const initial = ['light', 'dark', 'auto'].includes(stored) ? stored : 'auto';

      select.value = initial;
      AppState.themePreference = initial;
      this.mode = initial;

      select.addEventListener('change', (event) => {
        const selected = event.target.value || 'auto';
        const normalized = ['light', 'dark'].includes(selected) ? selected : 'auto';

        AppState.themePreference = normalized;
        this.mode = normalized;
        this.setStoredPreference(normalized);

        if (normalized === 'auto') {
          const { theme } = this.detectTheme();
          this.applyTheme(theme, 'auto');
        } else {
          this.applyTheme(normalized, normalized);
        }
      });
    },

    detectTheme() {
      const storedPreference = this.getStoredPreference();
      const mode = ['light', 'dark', 'auto'].includes(storedPreference)
        ? storedPreference
        : (this.mode || 'auto');

      if (mode === 'light' || mode === 'dark') {
        this.mode = mode;
        return { theme: mode, mode };
      }

      let prefersDark = false;
      try {
        prefersDark = this.mql ? this.mql.matches : window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (error) {
        console.warn('Unable to check system theme preference:', error);
      }

      if (prefersDark) {
        this.mode = 'auto';
        return { theme: 'dark', mode: 'auto' };
      }

      let theme = 'light';
      try {
        const hour = new Date().getHours();
        const isDarkTime = hour >= 18 || hour < 6;
        theme = isDarkTime ? 'dark' : 'light';
      } catch (error) {
        console.warn('Failed to detect theme based on time, defaulting to light theme:', error);
      }

      this.mode = 'auto';
      return { theme, mode: 'auto' };
    },

    applyTheme(theme, mode = 'auto') {
      document.body.setAttribute('data-theme', theme);
      AppState.theme = theme;
      AppState.themePreference = mode;
      this.mode = mode;

      if (this.control && this.control.value !== mode) {
        this.control.value = mode;
      }

      if (mode === 'auto') {
        this.setupTimeBasedTheme();
        this.runOsConsistencyCheck();
      } else {
        this.teardownTimeBasedTheme();
      }

      console.log(`Applied ${theme} theme (${mode} mode)`);
    },

    setupOsPreferenceListener() {
      if (!this.mql) return;

      const listener = () => {
        if (this.mode === 'auto') {
          const { theme } = this.detectTheme();
          if (theme !== AppState.theme) {
            this.applyTheme(theme, 'auto');
          } else {
            this.runOsConsistencyCheck();
          }
        }
      };

      if (typeof this.mql.addEventListener === 'function') {
        this.mql.addEventListener('change', listener);
      } else if (typeof this.mql.addListener === 'function') {
        this.mql.addListener(listener);
      }

      this.osListener = listener;
    },

    runOsConsistencyCheck() {
      if (this.mode === 'auto' && this.mql && this.mql.matches) {
        console.assert(
          AppState.theme === 'dark',
          'OS-level dark mode should remain active throughout the day when using auto theme.'
        );
      }
    },

    setupTimeBasedTheme() {
      if (this.intervalId || this.mode !== 'auto') {
        this.runOsConsistencyCheck();
        return;
      }

      this.intervalId = setInterval(() => {
        if (this.mode !== 'auto') {
          this.teardownTimeBasedTheme();
          return;
        }

        const { theme } = this.detectTheme();
        if (theme !== AppState.theme) {
          this.applyTheme(theme, 'auto');
        } else {
          this.runOsConsistencyCheck();
        }
      }, 60000);
    },

    teardownTimeBasedTheme() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    }
  };

  // ===== ERROR HANDLING =====
  const ErrorHandler = {
    showError(message, canRetry = false) {
      const view = Utils.$('#view');
      const retryButton = canRetry ? `
        <button class="retry-btn" type="button" data-action="retry">
          <span aria-hidden="true">🔄</span> Try Again
        </button>
      ` : '';
      
      view.innerHTML = `
        <div class="error-state">
          <div class="error-icon" aria-hidden="true">⚠️</div>
          <h2>Oops! Something went wrong</h2>
          <p>${Utils.esc(message)}</p>
          ${retryButton}
        </div>
      `;
      
      Utils.announce(`Error: ${message}`);
    },

    showEmpty(message = "No recipes found matching your search.") {
      const view = Utils.$('#view');
      view.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">🍸</div>
          <h2>No recipes found</h2>
          <p>${Utils.esc(message)}</p>
          <p>Try adjusting your search or filters.</p>
        </div>
      `;
      
      Utils.announce(message);
    },

    retry() {
      if (AppState.retryCount < CONFIG.RETRY_ATTEMPTS) {
        AppState.retryCount++;
        Router.render();
      } else {
        this.showError('Unable to connect. Please check your internet connection.', false);
      }
    }
  };

  // ===== NETWORK STATUS =====
  const NetworkManager = {
    init() {
      window.addEventListener('online', this.handleOnline.bind(this));
      window.addEventListener('offline', this.handleOffline.bind(this));
      this.updateStatus();
    },

    handleOnline() {
      AppState.isOnline = true;
      this.updateStatus();
      Utils.announce('Connection restored');
      // Retry failed requests
      Router.render();
    },

    handleOffline() {
      AppState.isOnline = false;
      this.updateStatus();
      Utils.announce('You are now offline');
    },

    updateStatus() {
      const indicator = Utils.$('#offline-indicator');
      if (indicator) {
        indicator.classList.toggle('show', !AppState.isOnline);
      }
    }
  };

  // ===== IMAGE MANAGEMENT =====
  const ImageManager = {
    imageCache: new Map(), // Cache for loaded images
    urlCache: new Map(), // Cache for converted URLs
    persistentCache: null, // Persistent localStorage cache
    sizes: {
      thumb: 'w400-h400',
      detail: 'w1200-h1200'
    },
    
    // Initialize persistent image cache
    initPersistentCache() {
      if (!this.persistentCache) {
        const cached = CacheManager.get('mixology:images');
        this.persistentCache = cached ? new Map(Object.entries(cached.data || {})) : new Map();
      }

      if (!this.persistenceEventsBound && typeof window !== 'undefined') {
        this.persistenceEventsBound = true;
        const flush = () => this.flushPersistentCache();
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
            flush();
          }
        });
      }
    },

    // Save image cache to localStorage
    savePersistentCache() {
      try {
        const cacheData = Object.fromEntries(this.persistentCache);
        CacheManager.put('mixology:images', { data: cacheData }, 24 * 60 * 60 * 1000); // 24 hours
        this.persistentCacheDirty = false;
      } catch (error) {
        console.warn('Failed to save image cache:', error);
      }
    },

    schedulePersistentSave() {
      if (this.persistentSaveHandle !== null) {
        return;
      }

      const runSave = () => {
        this.persistentSaveHandle = null;
        this.persistentSaveType = null;
        if (this.persistentCacheDirty) {
          this.savePersistentCache();
        }
      };

      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        this.persistentSaveType = 'idle';
        this.persistentSaveHandle = window.requestIdleCallback(runSave);
      } else {
        this.persistentSaveType = 'timeout';
        this.persistentSaveHandle = setTimeout(runSave, 0);
      }
    },

    flushPersistentCache() {
      if (this.persistentSaveHandle !== null) {
        if (this.persistentSaveType === 'idle' && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(this.persistentSaveHandle);
        }
        if (this.persistentSaveType === 'timeout') {
          clearTimeout(this.persistentSaveHandle);
        }
        this.persistentSaveHandle = null;
        this.persistentSaveType = null;
      }

      if (this.persistentCacheDirty) {
        this.savePersistentCache();
      }
    },

    // Get cached image URL
    getCachedImageUrl(slug) {
      this.initPersistentCache();
      return this.persistentCache.get(slug);
    },

    // Cache image URL
    cacheImageUrl(slug, imageUrl) {
      this.initPersistentCache();
      if (this.persistentCache.get(slug) === imageUrl) {
        return;
      }
      this.persistentCache.set(slug, imageUrl);
      this.persistentCacheDirty = true;
      this.schedulePersistentSave();
    },

    convertToDirectImageUrl(url, size) {
      if (!url) return url;

      const targetSize = size || this.sizes?.detail || 'w1200-h1200';
      const normalizedSize = targetSize.includes('-c') ? targetSize : `${targetSize}-c`;
      const cacheKey = `${url}|${normalizedSize}`;

      if (this.urlCache.has(cacheKey)) {
        return this.urlCache.get(cacheKey);
      }
      
      let fileId = null;
      
      if (url.includes('drive.google.com/uc')) {
        const match = url.match(/id=([a-zA-Z0-9_-]+)/);
        fileId = match ? match[1] : null;
      }
      
      if (url.includes('drive.google.com/thumbnail')) {
        const match = url.match(/id=([a-zA-Z0-9_-]+)/);
        fileId = match ? match[1] : null;
      }
      
      if (url.includes('drive.google.com/file/d/')) {
        const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        fileId = match ? match[1] : null;
      }
      
      let convertedUrl = url;
      if (fileId) {
        // Try the most reliable format for embedding
        convertedUrl = `https://lh3.googleusercontent.com/d/${fileId}=${normalizedSize}`;
      } else if (url.includes('lh3.googleusercontent.com')) {
        const [base, query] = url.split('?');
        let rebuiltBase = base;
        if (base.includes('=')) {
          rebuiltBase = base.replace(/=.*/, `=${normalizedSize}`);
        } else {
          rebuiltBase = `${base}=${normalizedSize}`;
        }
        convertedUrl = query ? `${rebuiltBase}?${query}` : rebuiltBase;
      }

      // Cache the converted URL
      this.urlCache.set(cacheKey, convertedUrl);
      return convertedUrl;
    },
    
    getAlternativeImageUrl(url) {
      if (!url) return url;
      
      let fileId = null;
      const idMatch = url.match(/id=([a-zA-Z0-9_-]+)/);
      if (idMatch) {
        fileId = idMatch[1];
      } else {
        const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        fileId = fileMatch ? fileMatch[1] : null;
      }
      
      if (fileId) {
        // Alternative formats that sometimes work better
        if (url.includes('googleusercontent.com')) {
          return `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;
        } else {
          return `https://drive.google.com/uc?export=view&id=${fileId}`;
        }
      }
      
      return url;
    },
    
    loadImageWithBlurEffect(img, imageUrl, size) {
      const thumbRail = img.closest('.thumb-rail');
      if (thumbRail) {
        thumbRail.classList.add('skeleton');
      }

      img.classList.add('loading');

      const tempImg = new Image();
      const targetSize = size || this.sizes?.detail || 'w1200-h1200';
      const sizedImageUrl = this.convertToDirectImageUrl(imageUrl, targetSize);

      tempImg.onload = () => {
        img.src = sizedImageUrl;
        img.classList.remove('loading');
        img.classList.add('loaded');

        if (thumbRail) {
          thumbRail.classList.remove('skeleton');
        }

        if (img.recipeData) {
          this.cacheImageUrl(img.recipeData.slug, sizedImageUrl);
        }
      };

      tempImg.onerror = () => {
        img.classList.remove('loading');
        if (thumbRail) {
          thumbRail.classList.remove('skeleton');
        }
        this.handleImageError(img);
      };

      tempImg.src = sizedImageUrl;

      return sizedImageUrl;
    },
    
    async loadRealImage(img, recipe) {

      const thumbSize = this.sizes?.thumb || 'w400-h400';
      const persistentImageUrl = this.getCachedImageUrl(recipe.slug);
      if (persistentImageUrl) {
        const thumbRail = img.closest('.thumb-rail');
        if (thumbRail) {
          thumbRail.classList.add('skeleton');
        }
        
        const sizedPersistentUrl = this.convertToDirectImageUrl(persistentImageUrl, thumbSize);
        if (sizedPersistentUrl !== persistentImageUrl) {
          this.cacheImageUrl(recipe.slug, sizedPersistentUrl);
        }

        img.src = sizedPersistentUrl;
        img.classList.add('loaded');
        img.dataset.realImage = 'loaded';
        
        setTimeout(() => {
          if (thumbRail) {
            thumbRail.classList.remove('skeleton');
          }
        }, 100);
        
        return;
      }
      
      const cacheKey = recipe.slug;
      if (this.imageCache.has(cacheKey)) {
        const cachedData = this.imageCache.get(cacheKey);
        console.log(`📦 Found memory cached data for ${recipe.name}:`, cachedData);
        if (cachedData.image_url || cachedData.image_thumb) {
          const sizedUrl = this.loadImageWithBlurEffect(img, cachedData.image_url || cachedData.image_thumb, thumbSize);
          img.dataset.realImage = 'loaded';

          console.log(`✅ Applied memory cached image for ${recipe.name}: ${sizedUrl}`);
        }
        return;
      }
      
      const listImageUrl = recipe.image_url || recipe.image_thumb;
      if (listImageUrl) {
        console.log(`🖼️ Using list image for ${recipe.name}: ${listImageUrl}`);

        this.imageCache.set(cacheKey, {
          image_url: recipe.image_url || null,
          image_thumb: recipe.image_thumb || null
        });

        const sizedUrl = this.loadImageWithBlurEffect(img, listImageUrl, thumbSize);
        console.log(`🔄 Converted list URL for ${recipe.name}: ${sizedUrl}`);

        img.dataset.realImage = 'loaded';
        return;
      }

      try {
        console.log(`🌐 Fetching detail data for: ${recipe.slug}`);
        const response = await APIClient.fetchPost(recipe.slug);
        console.log(`📡 API response for ${recipe.name}:`, response);

        if (response.ok && response.post) {
          const realImageUrl = response.post.image_url || response.post.image_thumb;
          console.log(`🔗 Found image URL for ${recipe.name}:`, realImageUrl);

          this.imageCache.set(cacheKey, {
            image_url: response.post.image_url,
            image_thumb: response.post.image_thumb
          });

          if (realImageUrl) {
            console.log(`🖼️ Testing image load for ${recipe.name}: ${realImageUrl}`);

            const sizedUrl = this.loadImageWithBlurEffect(img, realImageUrl, thumbSize);
            console.log(`🔄 Converted URL: ${sizedUrl}`);

            img.dataset.realImage = 'loaded';
            console.log(`✅ Successfully loaded image for ${recipe.name}`);
          } else {
            console.warn(`⚠️ No image URL found for ${recipe.name}`);
          }
        } else {
          console.warn(`❌ API call failed for ${recipe.name}:`, response);
        }
      } catch (error) {
        console.error(`💥 Error fetching image for ${recipe.name}:`, error);
      }
    },

    getPlaceholderImage(recipe) {
      const category = recipe?.category || 'cocktail';
      const name = recipe?.name || 'Recipe';
      const color = this.getCategoryColor(category);
      
      const truncatedName = name.substring(0, 20);
      const displayName = `${truncatedName}${name.length > 20 ? '...' : ''}`;
      const escapedName = Utils.esc(displayName);

      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 260" style="background:${color}">
          <g transform="translate(100,130)">
            <path d="M-30,-20 L30,-20 L0,40 Z" fill="white" fill-opacity="0.8"/>
            <rect x="-2" y="40" width="4" height="30" fill="white" fill-opacity="0.8"/>
            <rect x="-20" y="70" width="40" height="6" fill="white" fill-opacity="0.8"/>
            <circle cx="10" cy="-5" r="3" fill="#10B981" fill-opacity="0.9"/>
          </g>
          <text x="100" y="200" text-anchor="middle" fill="white" font-size="12" font-family="system-ui">
            ${escapedName}
          </text>
        </svg>
      `.trim();
      
      const encodedSvg = btoa(unescape(encodeURIComponent(svg)));
      return `data:image/svg+xml;base64,${encodedSvg}`;
    },

    getCategoryColor(category) {
      const colors = {
        'cat_shot_shooter': '#DC2626',
        'cat_beer_cocktail': '#D97706', 
        'cat_ordinary_drink': '#059669',
        'cat_cocktail': '#7C3AED',
        'default': '#6B7280'
      };
      return colors[category] || colors.default;
    },

    cleanup() {
      if (this.imageObserver) {
        this.imageObserver.disconnect();
        this.imageObserver = null;
        console.log('🧹 Cleaned up image observer');
      }
    },

    wireImages(root) {
    const imgs = (root || document).querySelectorAll('img.thumb:not([data-wired])');
      console.log(`🔌 Wiring ${imgs.length} images`);
      
      imgs.forEach(img => {
      img.dataset.wired = '1';

        const card = img.closest('.card');
        const recipeData = card ? this.extractRecipeData(card) : null;
        console.log(`🔍 Image found, recipe data:`, recipeData);

        const removeSkeleton = () => {
          const rail = img.closest('.thumb-rail');
          if (rail) rail.classList.remove('skeleton');
        };

        const handleLoad = () => {
          removeSkeleton();
          this.validateImage(img);
        };

        if (img.complete) {
          handleLoad();
        } else {
          img.addEventListener('load', handleLoad, { passive: true });
        }

        img.addEventListener('error', () => {
          this.handleImageError(img);
        });

        if (recipeData && !img.dataset.realImage) {
          const cachedUrl = this.getCachedImageUrl(recipeData.slug);
          if (cachedUrl) {
            img.src = cachedUrl;
            img.dataset.realImage = 'loaded';
          } else {
            this.observeImageForLazyLoad(img, recipeData);
          }
        }

        setTimeout(() => {
          if (!img.complete || img.naturalWidth === 0) {
            this.handleImageError(img);
          }
        }, CONFIG.IMAGE_TIMEOUT_MS);
      });
    },

    extractRecipeData(card) {
      const titleEl = card.querySelector('.title');
      const href = card.getAttribute('href');

      if (!titleEl || !href) return null;

      const slug = Utils.normalizeSlug(href);
      const name = titleEl.textContent.trim();
      const imageUrl = card.dataset.imageUrl || null;
      const imageThumb = card.dataset.imageThumb || null;

      return {
        slug,
        name,
        image_url: imageUrl || null,
        image_thumb: imageThumb || null
      };
    },

    observeImageForLazyLoad(img, recipe) {
      console.log(`👀 Setting up lazy load observer for: ${recipe.name}`);
      
      if (!this.imageObserver) {
        console.log('🔭 Creating new IntersectionObserver for images');
        this.imageObserver = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            console.log(`👁️ Image intersection changed for: ${entry.target.alt}, intersecting: ${entry.isIntersecting}`);
            if (entry.isIntersecting && !entry.target.dataset.realImage) {
              const recipeData = entry.target.recipeData;
              console.log(`🎯 Image came into view, recipe data:`, recipeData);
              if (recipeData) {
                this.loadRealImage(entry.target, recipeData);
                this.imageObserver.unobserve(entry.target);
              } else {
                console.warn('⚠️ No recipe data found on image element');
              }
            }
          });
        }, {
          rootMargin: '50px' // Start loading when 50px away from viewport
        });
      }

      img.recipeData = recipe;
      this.imageObserver.observe(img);
      console.log(`✅ Started observing image for: ${recipe.name}`);
    },

    validateImage(img) {
      if (!img.naturalWidth || !img.naturalHeight) {
        this.handleImageError(img);
      }
    },

    handleImageError(img) {
      const alt = img.dataset.alt || img.dataset.full || '';
      if (!img.dataset.fallbackAttempted && alt) {
        img.dataset.fallbackAttempted = '1';
        img.src = alt;
      } else {
        img.style.opacity = '0';
        const rail = img.closest('.thumb-rail, .detail-rail');
        if (rail) rail.classList.add('skeleton');
      }
    }
  };

  ImageManager.persistentCacheDirty = false;
  ImageManager.persistentSaveHandle = null;
  ImageManager.persistentSaveType = null;
  ImageManager.persistenceEventsBound = false;

  // ===== UI COMPONENTS =====
  const UIComponents = {
    skeletonCards(n = 8) {
      const card = `
        <div class="card skeleton-card" role="article" aria-label="Loading recipe">
          <div class="card-body">
            <div class="skeleton" style="height:18px; width:65%; border-radius:8px; margin-bottom:12px" aria-hidden="true"></div>
            <div class="skeleton" style="height:14px; width:45%; border-radius:6px; margin-bottom:8px" aria-hidden="true"></div>
            <div class="skeleton" style="height:12px; width:70%; border-radius:6px; margin-bottom:10px" aria-hidden="true"></div>
            <div class="skeleton" style="height:10px; width:35%; border-radius:4px" aria-hidden="true"></div>
          </div>
          <div class="thumb-rail">
            <div class="skeleton skeleton-thumb" aria-hidden="true"></div>
          </div>
        </div>`;
      return `<section class="grid" role="feed" aria-label="Recipe list">${Array.from({length:n}).map((_, i) => {
        const delay = i * 0.1;
        return card.replace('skeleton-card', `skeleton-card" style="animation-delay: ${delay}s`);
      }).join('')}</section>`;
    },

    createCard(recipe) {
      return `
        <a class="card fade-in"
           href="/${encodeURIComponent(recipe.slug)}"
           data-image-url="${Utils.esc(recipe.image_url || '')}"
           data-image-thumb="${Utils.esc(recipe.image_thumb || '')}"
           data-router-link
           role="article"
           aria-label="Recipe: ${Utils.esc(recipe.name || 'Untitled')}">
          <div class="card-body">
            <h3 class="title">${Utils.esc(recipe.name || 'Untitled')}</h3>
            <div class="facts">
              ${recipe.date ? `<div class="fact">
                <span class="label">Date</span>
                <span>${Utils.esc(Utils.fmtDate(recipe.date))}</span>
              </div>`:''}
              ${recipe.difficulty ? `<div class="fact">
                <span class="label">Difficulty</span>
                <span>${Utils.esc(recipe.difficulty)}</span>
              </div>`:''}
              ${recipe.prep_time ? `<div class="fact">
                <span class="label">Prep</span>
                <span>${Utils.esc(recipe.prep_time)}</span>
              </div>`:''}
            </div>
            ${recipe.tags?.length ? `<div class="pills">
              ${recipe.tags.slice(0,3).map(t=>
                `<span class="pill">${Utils.esc(Utils.labelize(t))}</span>`
              ).join('')}
            </div>` : ''}
          </div>
          <div class="thumb-rail skeleton">
            <img class="thumb" 
                 loading="lazy" 
                 decoding="async"
                 src="${Utils.esc(recipe.image_url || recipe.image_thumb || ImageManager.getPlaceholderImage(recipe))}"
                 data-alt="${Utils.esc(recipe.image_thumb || ImageManager.getPlaceholderImage(recipe))}"
                 alt="${Utils.esc(recipe.name || '')}">
          </div>
        </a>`;
    }
  };

  // ===== FILTER MANAGEMENT =====
  const FILTER_GROUP_DEFS = {
    category: {
      selector: '#cat',
      normalize: (value) => String(value || '').trim().toLowerCase()
        .replace(/^(cat|glass|style|strength|flavor|energy|occ)_/, '')
        .replace(/[\s/-]+/g, '_')
        .replace(/[^a-z0-9_]/g, ''),
      placeholders: {
        unknown_other: { drop: true, label: 'Other' },
        unknownother: { drop: true, label: 'Other' }
      },
      extractFromPost: (post) => {
        if (post && post.category) return [post.category];
        return [];
      },
      ariaLabel: (label) => `Filter by category: ${label}`,
      announceLabel: 'Category'
    },
    mood: {
      selector: '#mood',
      normalize: (value) => String(value || '').trim().toLowerCase()
        .replace(/[\s/-]+/g, '_')
        .replace(/[^a-z0-9_]/g, ''),
      extractFromPost: (post) => {
        if (post && Array.isArray(post.mood_labels)) {
          return post.mood_labels.filter(Boolean);
        }
        return [];
      },
      ariaLabel: (label) => `Filter by mood: ${label}`,
      announceLabel: 'Mood'
    }
  };

  function extractFilterPayload(payload) {
    const clone = (arr) => Array.isArray(arr) ? arr.slice() : [];
    if (!payload || typeof payload !== 'object') {
      return { category: [], mood: [] };
    }
    if (payload.filters && typeof payload.filters === 'object') {
      return {
        category: clone(payload.filters.category),
        mood: clone(payload.filters.mood)
      };
    }
    return {
      category: clone(payload.categories),
      mood: clone(payload.moods)
    };
  }

  const FilterPanel = {
    init() {
      this.section = Utils.$('#filters');
      this.body = Utils.$('#filters-body');
      this.toggleBtn = Utils.$('#filters-toggle');

      if (!this.section || !this.body || !this.toggleBtn) {
        return;
      }

      this.toggleLabel = this.toggleBtn.querySelector('.filters-toggle__label');
      this.countBadge = Utils.$('#filters-active-count');
      this.countBadgeSr = Utils.$('#filters-active-count-sr');
      this.userPreference = null;

      this.toggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this.setExpanded(!this.isExpanded());
      });

      this.mediaQuery = window.matchMedia('(min-width: 1024px)');

      const applyBreakpoint = (mq) => {
        if (mq.matches) {
          this.setExpanded(true, { silent: true, bypassPreference: true });
        } else {
          const targetState = this.userPreference !== null ? this.userPreference : false;
          this.setExpanded(targetState, { silent: true, bypassPreference: true });
        }
      };

      applyBreakpoint(this.mediaQuery);

      const listener = (event) => applyBreakpoint(event);
      if (typeof this.mediaQuery.addEventListener === 'function') {
        this.mediaQuery.addEventListener('change', listener);
      } else if (typeof this.mediaQuery.addListener === 'function') {
        this.mediaQuery.addListener(listener);
      }

      this.toggleBtn.setAttribute('aria-controls', 'filters-body');

      this.updateActiveCount();

      const slug = Utils.normalizeSlug(location.pathname);
      if (!slug) {
        this.onListView();
      } else {
        this.onDetailView();
      }
    },

    isExpanded() {
      if (!this.section) return false;
      return this.section.getAttribute('data-expanded') !== 'false';
    },

    setExpanded(expanded, options = {}) {
      if (!this.section || !this.toggleBtn) return;

      const { silent = false, bypassPreference = false } = options;
      const normalized = !!expanded;

      if (!bypassPreference) {
        this.userPreference = normalized;
      } else if (this.userPreference === null) {
        this.userPreference = normalized;
      }

      AppState.filtersExpanded = normalized;

      this.section.setAttribute('data-expanded', normalized ? 'true' : 'false');
      this.toggleBtn.setAttribute('aria-expanded', normalized ? 'true' : 'false');

      if (this.toggleLabel) {
        const collapsed = this.toggleLabel.dataset.labelCollapsed || 'Show filters';
        const expandedLabel = this.toggleLabel.dataset.labelExpanded || 'Hide filters';
        this.toggleLabel.textContent = normalized ? expandedLabel : collapsed;
      }

      if (!silent) {
        Utils.announce(normalized ? 'Filters expanded' : 'Filters collapsed');
      }
    },

    updateActiveCount() {
      if (!this.toggleBtn) return;

      const activeCount = Object.values(AppState.filter || {})
        .filter((value) => value !== null && value !== '').length;

      if (this.countBadge) {
        this.countBadge.textContent = activeCount > 0 ? String(activeCount) : '';
        this.countBadge.classList.toggle('is-visible', activeCount > 0);
      }

      this.toggleBtn.classList.toggle('has-active', activeCount > 0);

      if (this.countBadgeSr) {
        this.countBadgeSr.textContent = activeCount > 0
          ? `${activeCount} active filter${activeCount === 1 ? '' : 's'}`
          : 'No active filters';
      }
    },

    onListView() {
      if (!this.section) return;
      this.section.setAttribute('aria-hidden', 'false');
      if (this.mediaQuery && this.mediaQuery.matches) {
        this.setExpanded(true, { silent: true, bypassPreference: true });
      }
    },

    onDetailView() {
      if (!this.section) return;
      this.section.setAttribute('aria-hidden', 'true');
    }
  };

  const FilterManager = {
    reset() {
      AppState.filterSets = AppState.filterSets || {};
      AppState.filterSignatures = AppState.filterSignatures || {};
      for (const key of Object.keys(FILTER_GROUP_DEFS)) {
        AppState.filterSets[key] = new Set();
        AppState.filterSignatures[key] = '';
      }
      AppState.chipsBuilt = false;
    },

    ensureSet(key) {
      if (!AppState.filterSets || typeof AppState.filterSets !== 'object') {
        AppState.filterSets = {};
      }
      if (!(AppState.filterSets[key] instanceof Set)) {
        AppState.filterSets[key] = new Set();
      }
      return AppState.filterSets[key];
    },

    mergeFilters(posts, aggregates = {}) {
      for (const [key, config] of Object.entries(FILTER_GROUP_DEFS)) {
        const incoming = aggregates[key];
        if (Array.isArray(incoming)) {
          const normalizedIncoming = incoming
            .map(value => String(value ?? '').trim())
            .filter(Boolean);
          AppState.filterSets[key] = new Set(this.sortItems(normalizedIncoming));
        } else {
          this.ensureSet(key);
        }

        if (!Array.isArray(posts) || !posts.length) continue;

        const extractor = typeof config.extractFromPost === 'function'
          ? config.extractFromPost
          : null;

        if (!extractor) continue;

        const setRef = this.ensureSet(key);
        posts.forEach(post => {
          const values = extractor(post) || [];
          if (Array.isArray(values)) {
            values.forEach(value => {
              if (value !== undefined && value !== null) {
                const trimmed = String(value).trim();
                if (trimmed) {
                  setRef.add(trimmed);
                }
              }
            });
          } else if (values !== undefined && values !== null) {
            const trimmed = String(values).trim();
            if (trimmed) {
              setRef.add(trimmed);
            }
          }
        });

        AppState.filterSets[key] = new Set(this.sortItems(setRef));
      }
    },

    buildChips() {
      AppState.filterSets = AppState.filterSets || {};
      AppState.filterSignatures = AppState.filterSignatures || {};

      let chipsChanged = false;

      for (const [key, config] of Object.entries(FILTER_GROUP_DEFS)) {
        const setRef = this.ensureSet(key);
        const values = this.sortItems(setRef);
        const signature = values.join('|');

        if (AppState.chipsBuilt && AppState.filterSignatures[key] === signature) {
          this.updateChipStates(key);
          continue;
        }

        this.createChipGroup(values, key, config);
        AppState.filterSignatures[key] = signature;
        chipsChanged = true;
      }

      if (chipsChanged) {
        this.setupChipHandlers();
      } else {
        this.updateAllChipStates();
      }

      this.setupSearchHandlers();
      AppState.chipsBuilt = true;
      this.renderActiveFilters();
    },

    sortItems(items) {
      const arr = Array.from(items || []);
      return arr.sort((a, b) => {
        const labelA = Utils.labelize(a);
        const labelB = Utils.labelize(b);
        if (labelA === labelB) return 0;
        return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
      });
    },

    createChipGroup(items, key, config = {}) {
      const configObj = (config && typeof config === 'object' && !Array.isArray(config))
        ? config
        : { selector: typeof config === 'string' ? config : undefined };

      const baseConfig = FILTER_GROUP_DEFS[key] || {};
      const effectiveConfig = { ...baseConfig, ...configObj };

      const selector = effectiveConfig.selector || `#${key}`;
      const container = Utils.$(selector);
      if (!container) return;

      const placeholders = effectiveConfig.placeholders || {};
      const seen = new Set();
      const sanitizedItems = [];

      (items || []).forEach(rawValue => {
        const value = String(rawValue ?? '').trim();
        if (!value) return;

        const normalized = this.normalizeValue(value, key, effectiveConfig);
        if (!normalized || seen.has(normalized)) return;

        const rule = placeholders[normalized];
        if (rule && rule.drop) return;

        seen.add(normalized);

        const chipValue = rule && typeof rule.value === 'string' ? rule.value : value;
        const chipLabel = rule && rule.label ? rule.label : Utils.labelize(chipValue);
        sanitizedItems.push({ value: chipValue, label: chipLabel });
      });

      const isScrollable = sanitizedItems.length > (effectiveConfig.scrollThreshold ?? 8);
      if (container.dataset && typeof container.dataset === 'object') {
        container.dataset.scrollable = isScrollable ? 'true' : 'false';
      } else if (typeof container.setAttribute === 'function') {
        container.setAttribute('data-scrollable', isScrollable ? 'true' : 'false');
      }

      const ariaFn = typeof effectiveConfig.ariaLabel === 'function'
        ? effectiveConfig.ariaLabel
        : (label) => `Filter by ${key}: ${label}`;

      const chips = [
        `<button class="chip ${AppState.filter[key] === null ? 'is-active' : ''}"
                 data-k="${key}"
                 data-v=""
                 type="button"
                 role="button"
                 aria-pressed="${AppState.filter[key] === null ? 'true' : 'false'}"
                 aria-label="Show all ${(effectiveConfig.announceLabel || key)} options">
           <span>All</span>
         </button>`
      ];

      sanitizedItems.forEach(({ value, label }) => {
        const isActive = AppState.filter[key] === value;
        chips.push(`
          <button class="chip ${isActive ? 'is-active' : ''}"
                   data-k="${key}"
                   data-v="${Utils.esc(value)}"
                   type="button"
                   role="button"
                   aria-pressed="${isActive ? 'true' : 'false'}"
                    aria-label="${Utils.esc(ariaFn(label))}">
          <span>${Utils.esc(label)}</span>
        </button>
      `);
      });

      container.innerHTML = chips.join('');
    },

    normalizeValue(value, key, configOverride) {
      const config = configOverride || FILTER_GROUP_DEFS[key] || {};
      if (typeof config.normalize === 'function') {
        return config.normalize(value);
      }
      const normalized = String(value || '').trim().toLowerCase();
      if (!normalized) return '';
      return normalized
        .replace(/[\s/-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
    },

    updateChipStates(key) {
      const buttons = typeof key === 'string'
        ? Utils.$$(`.chip[data-k="${key}"]`)
        : Utils.$$('.chip[data-k]');

      buttons.forEach(btn => {
        const btnKey = btn.dataset.k;
        if (!btnKey) return;
        const btnValue = btn.dataset.v ?? '';
        const isActive = (btnValue === '' && AppState.filter[btnKey] === null)
          || (btnValue !== '' && AppState.filter[btnKey] === btnValue);
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    },

    updateAllChipStates() {
      this.updateChipStates();
    },

    setupChipHandlers() {
      Utils.$$('.chip[data-k]').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
      });

      const clickHandler = this.handleChipClick.bind(this);
      Utils.$$('.chip[data-k]').forEach(btn => {
        btn.addEventListener('click', clickHandler);
        btn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            clickHandler(e);
          }
        });
      });
    },

    handleChipClick(e) {
      e.preventDefault();
      e.stopPropagation();

      const btn = e.target.closest('.chip[data-k]');
      if (!btn) return;

      const key = btn.dataset.k;
      if (!key) return;

      const rawVal = btn.dataset.v ?? '';
      const val = rawVal === '' ? null : rawVal;

      AppState.filter[key] = val;
      CacheManager.clearSearch();

      this.updateChipStates(key);

      const config = FILTER_GROUP_DEFS[key] || {};
      const announceLabel = config.announceLabel || key;
      const spokenValue = val ? Utils.labelize(val) : 'All';
      Utils.announce(`${announceLabel} filter set to ${spokenValue}`);
      this.renderActiveFilters();

      Renderer.renderList(true);
    },

    renderActiveFilters() {
      const container = Utils.$('#active-filters');
      if (!container) {
        if (FilterPanel && typeof FilterPanel.updateActiveCount === 'function') {
          FilterPanel.updateActiveCount();
        }
        return;
      }

      const active = [];
      for (const [key, config] of Object.entries(FILTER_GROUP_DEFS)) {
        const value = AppState.filter[key];
        if (!value) continue;
        active.push({
          key,
          value,
          label: Utils.labelize(value),
          displayLabel: config.announceLabel || Utils.labelize(key)
        });
      }

      if (!active.length) {
        container.innerHTML = '';
        container.classList.remove('has-active');
        container.removeAttribute('role');
        if (FilterPanel && typeof FilterPanel.updateActiveCount === 'function') {
          FilterPanel.updateActiveCount();
        }
        return;
      }

      const chips = active.map(({ key, label, displayLabel }) => `
        <button type="button"
                class="active-filter-chip"
                data-clear="${key}"
                aria-label="Clear ${Utils.esc(displayLabel)} filter ${Utils.esc(label)}">
          <span class="active-filter-chip__text">${Utils.esc(displayLabel)}: ${Utils.esc(label)}</span>
          <span aria-hidden="true">×</span>
        </button>
      `).join('');

      container.innerHTML = `
        <div class="active-filters__header">
          <span class="active-filter-label">Active filters</span>
          <button type="button" class="active-filter-clear" data-clear="all">Clear all</button>
        </div>
        <div class="active-filter-list">${chips}</div>
      `;
      container.classList.add('has-active');
      container.setAttribute('role', 'status');

      if (FilterPanel && typeof FilterPanel.updateActiveCount === 'function') {
        FilterPanel.updateActiveCount();
      }

      this.setupActiveFilterHandlers();
    },

    setupActiveFilterHandlers() {
      const container = Utils.$('#active-filters');
      if (!container) return;

      container.querySelectorAll('button[data-clear]').forEach(btn => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          const key = event.currentTarget.dataset.clear;

          if (key === 'all') {
            let changed = false;
            for (const filterKey of Object.keys(FILTER_GROUP_DEFS)) {
              if (AppState.filter[filterKey] !== null) {
                AppState.filter[filterKey] = null;
                changed = true;
              }
            }

            if (!changed) return;

            CacheManager.clearSearch();
            this.updateAllChipStates();
            this.renderActiveFilters();
            Utils.announce('All filters cleared');
            Renderer.renderList(true);
            return;
          }

          if (!FILTER_GROUP_DEFS[key]) return;
          if (AppState.filter[key] === null) return;

          AppState.filter[key] = null;
          CacheManager.clearSearch();
          this.updateChipStates(key);
          this.renderActiveFilters();
          const announceLabel = FILTER_GROUP_DEFS[key].announceLabel || key;
          Utils.announce(`${announceLabel} filter cleared`);
          Renderer.renderList(true);
        });
      });
    },

    setupSearchHandlers() {
      if (AppState.searchHandlersBound) return;

      const searchInput = Utils.$('#q');
      const clearBtn = Utils.$('#clear');

      if (searchInput) {
        searchInput.addEventListener('input', Utils.debounce(() => {
          AppState.filter.q = searchInput.value.trim().toLowerCase();
          clearBtn?.classList.toggle('show', !!AppState.filter.q);
          CacheManager.clearSearch();
          Renderer.renderList(true);

          if (AppState.filter.q) {
            Utils.announce(`Searching for: ${AppState.filter.q}`);
          }
        }, CONFIG.DEBOUNCE_MS));
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (searchInput) searchInput.value = '';
          AppState.filter.q = '';
          clearBtn.classList.remove('show');
          CacheManager.clearSearch();
          Utils.announce('Search cleared');
          Renderer.renderList(true);
        });
      }

      AppState.searchHandlersBound = true;
    }
  };

  // ===== INFINITE SCROLL =====
  const InfiniteScroll = {
    setup() {
      if (AppState.observer) AppState.observer.disconnect();
      
      const sentinel = Utils.$('#sentinel');
      if (!sentinel) return;

      AppState.observer = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && AppState.hasMore && !AppState.loadingMore) {
            await this.loadNextPage();
          }
        }
      }, { 
        root: null, 
        rootMargin: CONFIG.SCROLL_MARGIN, 
        threshold: 0 
      });

      AppState.observer.observe(sentinel);
    },

    async loadNextPage() {
      AppState.loadingMore = true;
      const nextPage = AppState.page + 1;

      const moreBtn = Utils.$('#moreBtn');
      if (moreBtn) {
        moreBtn.disabled = true;
        moreBtn.innerHTML = `
          <div class="loading-indicator">
            <span class="spinner spinner-large" aria-hidden="true"></span>
            <span class="loading-text">Loading more recipes...</span>
          </div>
        `;
      }

      const baseKey = CacheManager.keyBase();
      const pageKey = `${baseKey}:p${nextPage}`;
      const cached = CacheManager.get(pageKey);

      if (cached) {
        const cachedFilters = extractFilterPayload(cached);
        Renderer.appendCards(cached.posts, cachedFilters);
        FilterManager.buildChips();
        AppState.page = nextPage;
        AppState.hasMore = cached.has_more;
        this.updatePager();
        AppState.loadingMore = false;
      return;
    }

      const data = await APIClient.fetchList({ page: nextPage });
      
      if (data && data.ok) {
        if (data.etag) {
          AppState.etag = data.etag;
          CacheManager.put('mixology:etag', { val: AppState.etag });
        }

        const pageFilters = extractFilterPayload(data);
        CacheManager.put(pageKey, {
          etag: AppState.etag,
          posts: data.posts,
          total: data.total,
          has_more: data.has_more,
          filters: pageFilters,
          categories: pageFilters.category,
          moods: pageFilters.mood
        });

        Renderer.appendCards(data.posts, pageFilters);
        FilterManager.buildChips();
        AppState.page = nextPage;
        AppState.hasMore = data.has_more;

        Utils.announce(`Loaded ${data.posts.length} more recipes`);
      } else {
        Utils.announce('Failed to load more recipes');
      }

      this.updatePager();
      AppState.loadingMore = false;
    },

    updatePager() {
      const pager = Utils.$('#pager');
      const moreBtn = Utils.$('#moreBtn');
      
      if (pager) pager.classList.toggle('hide', !AppState.hasMore);
      
      if (moreBtn) {
        moreBtn.disabled = false;
        moreBtn.innerHTML = 'Load more';
      }
    }
  };

  // ===== MAIN RENDERER =====
  const Renderer = {
    async renderList(reset) {
      const view = Utils.$('#view');

      const requestToken = ++AppState.requestId;

      Utils.restoreHomeSchema();

      // Ensure filters are visible on list pages
      const filtersEl = Utils.$('#filters');
      if (filtersEl) {
        filtersEl.style.display = 'block';
        filtersEl.style.visibility = 'visible';
        filtersEl.style.height = 'auto';
        filtersEl.style.overflow = 'visible';
        filtersEl.style.margin = '';
        filtersEl.style.padding = '';
      }
      
      if (reset) {
        AppState.page = 1;
        AppState.hasMore = true;
        AppState.loadingMore = false;
        view.innerHTML = UIComponents.skeletonCards();
        AppState.etag = (CacheManager.get('mixology:etag') || {}).val || null;
        FilterManager.reset();
        if (AppState.observer) {
          AppState.observer.disconnect();
          AppState.observer = null;
        }
      }

      const baseKey = CacheManager.keyBase();
      const firstKey = `${baseKey}:p1`;
      const cached = CacheManager.get(firstKey);
      const cachedFilters = extractFilterPayload(cached);
      let latestHasMore = (typeof (cached?.has_more) === 'boolean')
        ? cached.has_more
        : true;

      if (reset && cached) {
        AppState.etag = cached.etag || AppState.etag || null;
        this.paintCards(cached.posts, cached.total, cached.has_more, true, cachedFilters);
        FilterManager.buildChips();
      }

      const ifEtag = cached?.etag ?? null;
      const requestOptions = { page: 1 };
      if (ifEtag) {
        requestOptions.ifEtag = ifEtag;
      }

      let data = await APIClient.fetchList(requestOptions);

      if (requestToken !== AppState.requestId) {
        return;
      }

      if (data?.not_modified && !cached) {
        data = await APIClient.fetchList({ page: 1 });

        if (requestToken !== AppState.requestId) {
          return;
        }
      }

      if (!data.ok) {
        if (requestToken !== AppState.requestId) {
          return;
        }
        if (!cached) {
          if (!AppState.isOnline) {
            ErrorHandler.showError('You are offline. Please check your connection.', true);
          } else {
            ErrorHandler.showError(data.error || 'Failed to load recipes.', true);
          }
        }
        return;
      }

      if (!data.not_modified) {
        AppState.etag = data.etag || AppState.etag;
        CacheManager.put('mixology:etag', { val: AppState.etag });
        const dataFilters = extractFilterPayload(data);
        CacheManager.put(firstKey, {
          etag: AppState.etag,
          posts: data.posts,
          total: data.total,
          has_more: data.has_more,
          filters: dataFilters,
          categories: dataFilters.category,
          moods: dataFilters.mood
        });

        this.paintCards(data.posts, data.total, data.has_more, true, dataFilters);
        FilterManager.buildChips();
        latestHasMore = (typeof data.has_more === 'boolean') ? data.has_more : latestHasMore;
      } else if (cached && !cachedFilters.category.length) {
        const refresh = await APIClient.fetchList({ page: 1 });

        if (requestToken !== AppState.requestId) {
          return;
        }

        if (refresh && refresh.ok && !refresh.not_modified) {
          if (refresh.etag) {
            AppState.etag = refresh.etag;
            CacheManager.put('mixology:etag', { val: AppState.etag });
          }

          const refreshFilters = extractFilterPayload(refresh);
          CacheManager.put(firstKey, {
            etag: AppState.etag,
            posts: refresh.posts,
            total: refresh.total,
            has_more: refresh.has_more,
            filters: refreshFilters,
            categories: refreshFilters.category,
            moods: refreshFilters.mood
          });

          this.paintCards(refresh.posts, refresh.total, refresh.has_more, true, refreshFilters);
          FilterManager.buildChips();
          latestHasMore = (typeof refresh.has_more === 'boolean') ? refresh.has_more : latestHasMore;
        }
      }

      AppState.page = 1;
      AppState.hasMore = (typeof latestHasMore === 'boolean') ? latestHasMore : true;
      InfiniteScroll.setup();
      
      AppState.retryCount = 0;
    },

    paintCards(posts, total, hasMore, replace, filters) {
      const view = Utils.$('#view');
      const countEl = Utils.$('#count');

      if (!Array.isArray(posts)) {
        posts = [];
      }

      FilterManager.mergeFilters(posts, filters);

      if (countEl) countEl.textContent = String(total ?? posts.length);

      if (!posts.length) {
        ErrorHandler.showEmpty();
      return;
    }

      const cards = posts.map(recipe => UIComponents.createCard(recipe)).join('');

      if (replace) {
    view.innerHTML = `
          <section class="grid" id="grid" role="feed" aria-label="Recipe list">
          </section>
          <div class="center" id="pager">
            <button class="load-more" id="moreBtn" type="button" data-action="load-more">
              Load more
            </button>
            <div id="sentinel" aria-hidden="true"></div>
          </div>
        `;
        AppState.gridEl = Utils.$('#grid');
      }

      if (AppState.gridEl) {
        AppState.gridEl.innerHTML = cards;
      }

      AppState.hasMore = !!hasMore;
      const pager = Utils.$('#pager');
      if (pager) pager.classList.toggle('hide', !AppState.hasMore);

      ImageManager.wireImages(AppState.gridEl);
    },

    appendCards(newPosts, filters) {
      FilterManager.mergeFilters(newPosts, filters);

      if (!Array.isArray(newPosts) || !newPosts.length) return;

      const cards = newPosts.map(recipe => UIComponents.createCard(recipe)).join('');
      
      if (AppState.gridEl) {
        AppState.gridEl.insertAdjacentHTML('beforeend', cards);
        ImageManager.wireImages(AppState.gridEl);
      }
    },

    async renderDetail(slug) {
      const view = Utils.$('#view');

      const filtersEl = Utils.$('#filters');
      if (filtersEl) {
        filtersEl.style.display = 'none';
        filtersEl.style.visibility = 'hidden';
        filtersEl.style.height = '0';
        filtersEl.style.overflow = 'hidden';
        filtersEl.style.margin = '0';
        filtersEl.style.padding = '0';
      }

      const heroSection = Utils.$('.hero');
      if (heroSection) {
        heroSection.style.display = 'none';
        heroSection.style.visibility = 'hidden';
        heroSection.style.height = '0';
        heroSection.style.overflow = 'hidden';
        heroSection.style.margin = '0';
        heroSection.style.padding = '0';
      }
      
    view.innerHTML = `
      <div class="detail skeleton-card">
        <article>
            <div class="skeleton" style="height:32px; width:70%; border-radius:10px; margin-bottom:16px" aria-hidden="true"></div>
            <div class="skeleton" style="height:16px; width:40%; border-radius:8px; margin-bottom:20px" aria-hidden="true"></div>
            <div class="skeleton" style="height:14px; width:95%; border-radius:6px; margin-bottom:12px" aria-hidden="true"></div>
            <div class="skeleton" style="height:14px; width:85%; border-radius:6px; margin-bottom:12px" aria-hidden="true"></div>
            <div class="skeleton" style="height:14px; width:90%; border-radius:6px; margin-bottom:20px" aria-hidden="true"></div>
            <div class="skeleton" style="height:200px; width:100%; border-radius:12px" aria-hidden="true"></div>
        </article>
          <div class="detail-rail">
            <div class="skeleton skeleton-thumb" style="width:100%; height:100%" aria-hidden="true"></div>
          </div>
        </div>
      `;

      const response = await APIClient.fetchPost(slug);
      
      if (!response.ok || !response.post) {
        Utils.setTitle();
        Utils.restoreSocialMeta();
        Utils.updateShareUrls();
        ErrorHandler.showError('Recipe not found.', false);
        return null;
      }

      const recipe = response.post;
      const { description: pageDescription } = Utils.setTitle(recipe.name || 'Recipe');
      Utils.updateShareUrls(slug);

      Utils.applyRecipeSchema(recipe);
      Utils.updateRecipeSocialMeta(recipe, { description: pageDescription });

      const escHTML = s => Utils.esc(String(s||'')).replace(/\n/g,'<br>');
      const ingredientsList = (recipe.ingredients || []).map(ing => 
        `<li>${Utils.esc(ing.measure||'')} ${Utils.esc(ing.name||'')}</li>`
      ).join('');
      const tags = (recipe.tags || []).map(tag => 
        `<span class="pill">${Utils.esc(Utils.labelize(tag))}</span>`
      ).join('');
      const moods = (recipe.mood_labels || []).map(mood => 
        `<span class="pill">${Utils.esc(Utils.labelize(mood))}</span>`
      ).join('');

      const rawImageUrl = recipe.image_url || recipe.image_thumb;
      const detailImageUrl = rawImageUrl ? ImageManager.convertToDirectImageUrl(rawImageUrl, ImageManager.sizes?.detail) : null;
      const detailFallbackUrl = recipe.image_thumb ? ImageManager.convertToDirectImageUrl(recipe.image_thumb, ImageManager.sizes?.thumb) : '';

      const imageSection = rawImageUrl ? `
        <div class="detail-rail skeleton">
          <img class="detail-img"
               src="${Utils.esc(detailImageUrl || rawImageUrl)}"
               data-alt="${Utils.esc(detailFallbackUrl || '')}"
               alt="${Utils.esc(recipe.name||'')}"
               data-validate-image">
        </div>
      ` : `<div class="detail-rail skeleton" aria-hidden="true"></div>`;

      view.innerHTML = `
      <div class="detail fade-in">
        <article>
            <nav class="breadcrumbs" aria-label="Breadcrumb" style="margin-bottom:16px;">
              <ol style="list-style:none;display:flex;flex-wrap:wrap;align-items:center;padding:0;margin:0;font-size:13px;color:var(--muted);gap:8px;">
                <li style="display:flex;align-items:center;gap:8px;">
                  <a href="/" data-router-link style="color:var(--muted);text-decoration:none;font-weight:500;">Home</a>
                </li>
                <li style="display:flex;align-items:center;gap:8px;color:var(--muted);" aria-current="page">
                  <span aria-hidden="true" style="opacity:0.5;">/</span>
                  <span>${Utils.esc(recipe.name || 'Untitled')}</span>
                </li>
              </ol>
            </nav>
            <h1>${Utils.esc(recipe.name || 'Untitled')}</h1>
          <div class="info">
              ${Utils.esc(Utils.fmtDate(recipe.date) || '')}
              ${recipe.difficulty ? ` · ${Utils.esc(recipe.difficulty)}` : ''}
              ${recipe.prep_time ? ` · ${Utils.esc(recipe.prep_time)}` : ''}
          </div>

          <div class="row">
            <div class="col">
                <h3 style="margin:0 0 6px;font-size:16px">Ingredients</h3>
                <ul class="list">${ingredientsList || '<li>—</li>'}</ul>
            </div>
            <div class="col">
                <h3 style="margin:0 0 6px;font-size:16px">Details</h3>
              <div class="kvs">
                  <div class="kv"><b>Category</b> ${Utils.esc(Utils.labelize(recipe.category || '-'))}</div>
                  <div class="kv"><b>Glass</b> ${Utils.esc(Utils.labelize(recipe.glass || '-'))}</div>
                  <div class="kv"><b>Garnish</b> ${Utils.esc(Utils.labelize(recipe.garnish || '-'))}</div>
              </div>
            </div>
          </div>

            <h3 style="margin-top:16px;font-size:16px">Instructions</h3>
            <div>${escHTML(recipe.instructions || 'No instructions available.')}</div>

            ${tags ? `
              <h3 style="margin-top:16px;font-size:16px">Tags</h3>
              <div class="pills">${tags}</div>
            ` : ''}
            
            ${moods ? `
              <h3 style="margin-top:12px;font-size:16px">Mood</h3>
              <div class="pills">${moods}</div>
            ` : ''}

            <p>
              <a class="back" href="/" role="button" data-router-link>
                <span aria-hidden="true">←</span> Back to all recipes
              </a>
            </p>
        </article>
          ${imageSection}
        </div>
      `;

      const detailImg = view.querySelector('[data-validate-image]');
      if (detailImg) {
        const handleDetailLoad = () => {
          const rail = detailImg.closest('.detail-rail');
          if (rail) rail.classList.remove('skeleton');
          if (!detailImg.naturalWidth || !detailImg.naturalHeight) {
            ImageManager.handleImageError(detailImg);
          }
        };

        if (detailImg.complete) {
          handleDetailLoad();
        } else {
          detailImg.addEventListener('load', handleDetailLoad, { passive: true });
        }

        detailImg.addEventListener('error', () => {
          ImageManager.handleImageError(detailImg);
        });
      }

      Utils.announce(`Loaded recipe: ${recipe.name}`);
      return recipe;
    }
  };

  // ===== ROUTER =====
  const Router = {
    init() {
      window.addEventListener('popstate', () => {
        this.render();
        setTimeout(trackPageView, 0);
      });

      if (!this._linkHandlerBound) {
        document.addEventListener('click', (event) => {
          if (event.defaultPrevented) return;
          if (event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const anchor = event.target.closest('a[data-router-link]');
          if (!anchor) return;
          const href = anchor.getAttribute('href');
          if (!href) return;
          const url = new URL(href, location.href);
          if (url.origin !== location.origin) return;

          event.preventDefault();
          this.go(url.pathname + url.search + url.hash);
        });
        this._linkHandlerBound = true;
      }

      this.render();
      setTimeout(trackPageView, 0); // initial load
    },

    go(path) {
      const normalizedPath = Utils.normalizePath(path);
      history.pushState({}, '', normalizedPath);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      this.render();
      // Track after content/title update
      setTimeout(trackPageView, 0);
      return false;
    },

    render() {
      const year = new Date().getFullYear();
      const yearEl = Utils.$('#year');
      if (yearEl) yearEl.textContent = year;

      // Clean up image observers before rendering new content
      ImageManager.cleanup();

      const slug = Utils.normalizeSlug(location.pathname);
      const filtersEl = Utils.$('#filters');
      const searchWrap = Utils.$('.nav-controls .search-wrap');
      const heroSection = Utils.$('.hero');

      if (!slug) {
        // Home page - show filters
        if (filtersEl) {
          filtersEl.style.display = '';
          filtersEl.style.visibility = '';
          filtersEl.style.height = '';
          filtersEl.style.overflow = '';
          filtersEl.style.margin = '';
          filtersEl.style.padding = '';
        }
        if (heroSection) {
          heroSection.style.display = '';
          heroSection.style.visibility = '';
          heroSection.style.height = '';
          heroSection.style.overflow = '';
          heroSection.style.margin = '';
          heroSection.style.padding = '';
        }
        if (searchWrap) searchWrap.style.display = '';
        if (FilterPanel && typeof FilterPanel.onListView === 'function') {
          FilterPanel.onListView();
        }
        Utils.setTitle();
        Utils.updateShareUrls();
        Utils.restoreSocialMeta();
        return Renderer.renderList(true);
      } else {
        AppState.requestId = 0;
        // Detail page - completely hide filters
        if (filtersEl) {
          filtersEl.style.display = 'none';
          filtersEl.style.visibility = 'hidden';
          filtersEl.style.height = '0';
          filtersEl.style.overflow = 'hidden';
          filtersEl.style.margin = '0';
          filtersEl.style.padding = '0';
        }
        if (heroSection) {
          heroSection.style.display = 'none';
          heroSection.style.visibility = 'hidden';
          heroSection.style.height = '0';
          heroSection.style.overflow = 'hidden';
          heroSection.style.margin = '0';
          heroSection.style.padding = '0';
        }
        if (FilterPanel && typeof FilterPanel.onDetailView === 'function') {
          FilterPanel.onDetailView();
        }
        if (searchWrap) searchWrap.style.display = 'none';
        return Renderer.renderDetail(slug);
      }
    }
  };


  const GlobalInteractions = {
    init() {
      if (AppState.globalHandlersBound) return;

      document.addEventListener('click', (event) => {
        const retryBtn = event.target.closest('[data-action="retry"]');
        if (retryBtn) {
          event.preventDefault();
          ErrorHandler.retry();
          return;
        }

        const loadMoreBtn = event.target.closest('[data-action="load-more"]');
        if (loadMoreBtn) {
          event.preventDefault();
          InfiniteScroll.loadNextPage();
        }
      });

      AppState.globalHandlersBound = true;
    }
  };

  // ===== KEYBOARD SHORTCUTS =====
  const KeyboardShortcuts = {
    init() {
      document.addEventListener('keydown', this.handleKeydown.bind(this));
    },

    handleKeydown(e) {
      // Ignore if user is typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case '/':
          e.preventDefault();
          const searchInput = Utils.$('#q');
          if (searchInput) searchInput.focus();
          break;
          
        case 'Escape':
          const activeElement = document.activeElement;
          if (activeElement && activeElement.blur) activeElement.blur();
          break;
          
      }
    }
  };

  // ===== SCROLL MANAGEMENT =====
  const ScrollManager = {
    init() {
      const header = Utils.$('#hdr');
      if (!header) return;

      const onScroll = () => {
        const scrolled = window.scrollY > 20;
        header.classList.toggle('is-scrolled', scrolled);
        
        // Ensure header is always visible
        header.style.display = 'block';
        header.style.visibility = 'visible';
        header.style.opacity = '1';
        header.style.transform = 'none';
        
        // Add glass effect when scrolled
        if (scrolled) {
          const isDark = AppState.theme === 'dark';
          if (isDark) {
            header.style.background = 'rgba(17, 24, 39, 0.8)';
            header.style.backdropFilter = 'blur(20px) saturate(180%)';
            header.style.borderBottom = '1px solid rgba(255, 255, 255, 0.1)';
            header.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
          } else {
            header.style.background = 'rgba(255, 255, 255, 0.8)';
            header.style.backdropFilter = 'blur(20px) saturate(180%)';
            header.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
            header.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.1)';
          }
        } else {
          header.style.background = 'var(--bg)';
          header.style.backdropFilter = 'saturate(120%) blur(6px)';
          header.style.borderBottom = '1px solid var(--line-2)';
          header.style.boxShadow = 'none';
        }
      };

      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  };

  // ===== APP INITIALIZATION =====
  const App = {
    async init() {
      try {
        ThemeManager.init();
        NetworkManager.init();
        ScrollManager.init();
        KeyboardShortcuts.init();
        Router.init();
        GlobalInteractions.init();

        FilterManager.setupSearchHandlers();
        FilterPanel.init();

        const slug = Utils.normalizeSlug(location.pathname);
        const filtersEl = Utils.$('#filters');
        if (filtersEl) {
          filtersEl.style.display = slug ? 'none' : 'block';
        }
        
        // Service worker disabled for now to avoid stale HTML issues on static routes
        if ('serviceWorker' in navigator) {
          try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
              await registration.unregister();
            }
          } catch (_) {
            // ignore
          }
        }

        console.log('Elixiary app initialized successfully');
        
      } catch (error) {
        console.error('App initialization failed:', error);
        ErrorHandler.showError('Failed to initialize the application.', true);
      }
    }
  };

  // ===== GLOBAL ERROR HANDLER =====
  window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    Utils.announce('An error occurred. Please try refreshing the page.');
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    event.preventDefault(); // Prevent the default browser handling
  });

  // ===== BOOT =====
  document.addEventListener('DOMContentLoaded', () => {
    App.init()
      .then(() => {
        window.dispatchEvent(new CustomEvent('elixiary:app-ready', { detail: window.ElixiaryApp }));
      })
      .catch((error) => {
        window.dispatchEvent(new CustomEvent('elixiary:app-ready', { detail: window.ElixiaryApp, error }));
      });
  });

  // Export for debugging in development
  if (typeof window !== 'undefined') {
    window.ElixiaryApp = {
      AppState,
      Utils,
      CacheManager,
      APIClient,
      ThemeManager,
      ErrorHandler,
      FilterPanel,
      FilterManager,
      Renderer,
      Router
    };
  }

  // ---- Analytics helpers ----
  function trackPageView() {
    if (typeof gtag !== 'function') return;
    gtag('event', 'page_view', {
      page_title: document.title,
      page_location: location.href,
      page_path: location.pathname
    });
  }
