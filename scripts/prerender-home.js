#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const cheerio = require('cheerio');

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const API_URL = 'https://api.elixiary.com/v1/list';
const POST_API_URL = 'https://api.elixiary.com/v1/post';
const OUTPUT_PATH = path.join(__dirname, '..', 'dist', 'index.html');
const SITE_ORIGIN = 'https://www.elixiary.com';
const USER_AGENT = 'ElixiaryBuildBot/1.0 (+https://www.elixiary.com)';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function labelize(value) {
  return String(value ?? '')
    .replace(/^(cat|glass|style|strength|flavor|energy|occ)_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function toIsoDuration(value) {
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

  const regex = /(\d+(?:\.\d+)?)(?:\s*)(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/gi;
  const totals = { H: 0, M: 0, S: 0 };
  let hasMatch = false;

  let match;
  while ((match = regex.exec(cleaned))) {
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
    return Number.isInteger(num) ? String(num) : String(num).replace(/\.0+$/, '');
  };

  let iso = 'PT';
  const hours = format(totals.H);
  const minutes = format(totals.M);
  const seconds = format(totals.S);

  if (hours) iso += `${hours}H`;
  if (minutes) iso += `${minutes}M`;
  if (seconds) iso += `${seconds}S`;

  return iso.length > 2 ? iso : trimmed;
}

function getPlaceholderColor(category) {
  const colors = {
    cat_shot_shooter: '#DC2626',
    cat_beer_cocktail: '#D97706',
    cat_ordinary_drink: '#059669',
    cat_cocktail: '#7C3AED',
    default: '#6B7280'
  };
  return colors[category] || colors.default;
}

function getPlaceholderImage(recipe) {
  const category = recipe?.category || 'cocktail';
  const name = recipe?.name || 'Recipe';
  const color = getPlaceholderColor(category);

  const truncatedName = name.substring(0, 20);
  const displayName = `${truncatedName}${name.length > 20 ? '...' : ''}`;
  const escapedName = escapeHtml(displayName);

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

  const encodedSvg = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${encodedSvg}`;
}

function setMetaContent($, selector, value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const element = $(selector).first();
  if (!element.length) return;
  element.attr('content', trimmed);
}

function applySocialMeta($, { title, description, image } = {}) {
  if (typeof title === 'string' && title.trim()) {
    setMetaContent($, 'meta[property="og:title"]', title);
    setMetaContent($, 'meta[name="twitter:title"]', title);
  }

  if (typeof description === 'string' && description.trim()) {
    setMetaContent($, 'meta[property="og:description"]', description);
    setMetaContent($, 'meta[name="twitter:description"]', description);
  }

  if (typeof image === 'string' && image.trim()) {
    setMetaContent($, 'meta[property="og:image"]', image);
    setMetaContent($, 'meta[name="twitter:image"]', image);
  }
}

function createCard(recipe) {
  const name = recipe.name || 'Untitled';
  const slug = recipe.slug || '';
  const href = `/${encodeURIComponent(slug)}`;
  const date = formatDate(recipe.date);
  const difficulty = recipe.difficulty || '';
  const prepTime = recipe.prep_time || '';
  const tags = Array.isArray(recipe.tags) ? recipe.tags.slice(0, 3) : [];
  const rawImage = recipe.image_url || recipe.image_thumb || getPlaceholderImage(recipe);
  const thumbImage = recipe.image_thumb || rawImage;

  const facts = [];
  if (date) {
    facts.push(`
      <div class="fact">
        <span class="label">Date</span>
        <span>${escapeHtml(date)}</span>
      </div>`);
  }
  if (difficulty) {
    facts.push(`
      <div class="fact">
        <span class="label">Difficulty</span>
        <span>${escapeHtml(difficulty)}</span>
      </div>`);
  }
  if (prepTime) {
    facts.push(`
      <div class="fact">
        <span class="label">Prep</span>
        <span>${escapeHtml(prepTime)}</span>
      </div>`);
  }

  const pills = tags.length
    ? `
      <div class="pills">
        ${tags.map((tag) => `<span class="pill">${escapeHtml(labelize(tag))}</span>`).join('')}
      </div>`
    : '';

  return `
    <a class="card fade-in"
       href="${href}"
       data-image-url="${escapeHtml(recipe.image_url || '')}"
       data-image-thumb="${escapeHtml(recipe.image_thumb || '')}"
       data-router-link
       role="article"
       aria-label="Recipe: ${escapeHtml(name)}">
      <div class="card-body">
        <h3 class="title">${escapeHtml(name)}</h3>
        <div class="facts">
          ${facts.join('')}
        </div>
        ${pills}
      </div>
      <div class="thumb-rail skeleton">
        <img class="thumb"
             loading="lazy"
             decoding="async"
             src="${escapeHtml(rawImage)}"
             data-alt="${escapeHtml(thumbImage)}"
             alt="${escapeHtml(name)}">
      </div>
    </a>`;
}

function buildGrid(recipes) {
  const cards = recipes.map(createCard).join('');
  return `
    <section class="grid" role="feed" aria-label="Recipe list">
      ${cards}
    </section>
  `;
}

function buildMetaDescription(recipes) {
  if (!recipes.length) return null;
  const names = recipes.slice(0, 4).map((recipe) => recipe.name).filter(Boolean);
  if (!names.length) return null;
  if (names.length === 1) {
    return `Discover cocktails like ${names[0]} and more curated recipes at Elixiary.`;
  }
  const last = names.pop();
  return `Discover cocktails like ${names.join(', ')} and ${last} curated by Elixiary.`;
}

function buildItemList(recipes) {
  const itemListElement = recipes.map((recipe, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    url: `${SITE_ORIGIN}/${encodeURIComponent(recipe.slug || '')}`,
    name: recipe.name || 'Untitled',
    image: recipe.image_url || recipe.image_thumb,
    description: recipe.instructions ? recipe.instructions.slice(0, 200) : undefined
  })).map((entry) => {
    if (!entry.description) {
      delete entry.description;
    }
    if (!entry.image) {
      delete entry.image;
    }
    return entry;
  });

  return {
    '@type': 'ItemList',
    '@id': `${SITE_ORIGIN}/#top-recipes`,
    name: 'Top Cocktail Recipes',
    itemListOrder: 'http://schema.org/ItemListOrderAscending',
    numberOfItems: recipes.length,
    itemListElement
  };
}

async function fetchRecipes() {
  const response = await fetch(`${API_URL}?page=1`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch recipes: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.posts)) {
    throw new Error('Unexpected API response when fetching recipes.');
  }

  return payload.posts;
}

async function updateStructuredData($, recipes) {
  const script = $('script[type="application/ld+json"]').first();
  if (!script.length) return;

  let data;
  try {
    data = JSON.parse(script.html());
  } catch (error) {
    console.warn('Unable to parse existing JSON-LD; skipping structured data update.', error);
    return;
  }

  if (Array.isArray(data?.['@graph'])) {
    data['@graph'] = data['@graph'].filter((node) => node['@id'] !== `${SITE_ORIGIN}/#top-recipes`);
    data['@graph'].push(buildItemList(recipes));
  } else if (data) {
    data = {
      '@context': data['@context'] || 'https://schema.org',
      '@graph': [data, buildItemList(recipes)]
    };
  }

  script.text(JSON.stringify(data, null, 2));
}

async function fetchRecipeDetail(slug) {
  if (!slug) return null;
  const target = `${POST_API_URL}/${encodeURIComponent(slug)}`;
  const response = await fetch(target, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch recipe ${slug}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data?.ok || !data?.post) {
    throw new Error(`Unexpected API response when fetching recipe ${slug}.`);
  }

  return data.post;
}

function buildRecipeDescription(recipe) {
  if (!recipe) return '';

  const fallback = recipe.name
    ? `Learn how to make ${recipe.name} with detailed ingredients and instructions. Discover more cocktail recipes at Elixiary.`
    : 'Discover and explore amazing cocktail recipes with detailed ingredients and instructions.';

  const instructions = String(recipe.instructions || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (instructions) {
    return instructions.length > 200 ? `${instructions.slice(0, 197)}…` : instructions;
  }

  const details = [];
  if (recipe.category) {
    details.push(labelize(recipe.category));
  }
  if (recipe.difficulty) {
    details.push(`Difficulty: ${recipe.difficulty}`);
  }
  if (recipe.prep_time) {
    details.push(`Prep: ${recipe.prep_time}`);
  }

  if (details.length) {
    return `${recipe.name || 'This cocktail'} – ${details.join(' · ')}.`;
  }

  return fallback;
}

function buildRecipeDetailMarkup(recipe) {
  const infoParts = [];
  const formattedDate = formatDate(recipe.date);
  if (formattedDate) {
    infoParts.push(escapeHtml(formattedDate));
  }
  if (recipe.difficulty) {
    infoParts.push(escapeHtml(recipe.difficulty));
  }
  if (recipe.prep_time) {
    infoParts.push(escapeHtml(recipe.prep_time));
  }

  const infoLine = infoParts.length ? infoParts.join(' · ') : '';

  const ingredientsList = Array.isArray(recipe.ingredients) && recipe.ingredients.length
    ? recipe.ingredients
        .map((ingredient) => {
          const measure = String(ingredient.measure || '').trim();
          const name = String(ingredient.name || '').trim();
          const combined = [measure, name].filter(Boolean).join(' ');
          return `<li>${escapeHtml(combined)}</li>`;
        })
        .join('')
    : '<li>—</li>';

  const tags = Array.isArray(recipe.tags) && recipe.tags.length
    ? recipe.tags
        .map((tag) => `<span class="pill">${escapeHtml(labelize(tag))}</span>`)
        .join('')
    : '';

  const moods = Array.isArray(recipe.mood_labels) && recipe.mood_labels.length
    ? recipe.mood_labels
        .map((mood) => `<span class="pill">${escapeHtml(labelize(mood))}</span>`)
        .join('')
    : '';

  const instructions = String(recipe.instructions || 'No instructions available.')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => escapeHtml(line))
    .join('<br>');

  const rawImageUrl = recipe.image_url || recipe.image_thumb || '';
  const fallbackImage = recipe.image_thumb || rawImageUrl || getPlaceholderImage(recipe);
  const imageSection = rawImageUrl
    ? `
        <div class="detail-rail skeleton">
          <img class="detail-img"
               src="${escapeHtml(rawImageUrl)}"
               data-alt="${escapeHtml(fallbackImage)}"
               alt="${escapeHtml(recipe.name || '')}"
               data-validate-image>
        </div>
      `
    : `
        <div class="detail-rail skeleton" aria-hidden="true"></div>
      `;

  return `
      <div class="detail fade-in">
        <article>
          <nav class="breadcrumbs" aria-label="Breadcrumb" style="margin-bottom:16px;">
            <ol style="list-style:none;display:flex;flex-wrap:wrap;align-items:center;padding:0;margin:0;font-size:13px;color:var(--muted);gap:8px;">
              <li style="display:flex;align-items:center;gap:8px;">
                <a href="/" data-router-link style="color:var(--muted);text-decoration:none;font-weight:500;">Home</a>
              </li>
              <li style="display:flex;align-items:center;gap:8px;color:var(--muted);" aria-current="page">
                <span aria-hidden="true" style="opacity:0.5;">/</span>
                <span>${escapeHtml(recipe.name || 'Untitled')}</span>
              </li>
            </ol>
          </nav>
          <h1>${escapeHtml(recipe.name || 'Untitled')}</h1>
          <div class="info">${infoLine}</div>
          <div class="row">
            <div class="col">
              <h3 style="margin:0 0 6px;font-size:16px">Ingredients</h3>
              <ul class="list">${ingredientsList}</ul>
            </div>
            <div class="col">
              <h3 style="margin:0 0 6px;font-size:16px">Details</h3>
              <div class="kvs">
                <div class="kv"><b>Category</b> ${escapeHtml(labelize(recipe.category || '-'))}</div>
                <div class="kv"><b>Glass</b> ${escapeHtml(labelize(recipe.glass || '-'))}</div>
                <div class="kv"><b>Garnish</b> ${escapeHtml(labelize(recipe.garnish || '-'))}</div>
              </div>
            </div>
          </div>
          <h3 style="margin-top:16px;font-size:16px">Instructions</h3>
          <div>${instructions || 'No instructions available.'}</div>
          ${tags
            ? `
              <h3 style="margin-top:16px;font-size:16px">Tags</h3>
              <div class="pills">${tags}</div>
            `
            : ''}
          ${moods
            ? `
              <h3 style="margin-top:12px;font-size:16px">Mood</h3>
              <div class="pills">${moods}</div>
            `
            : ''}
          <p>
            <a class="back" href="/" role="button" data-router-link>
              <span aria-hidden="true">←</span> Back to all recipes
            </a>
          </p>
        </article>
        ${imageSection}
      </div>
  `;
}

function sanitizeRecipeNode(node) {
  const clone = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const filtered = value.filter((item) => item !== undefined && item !== null && item !== '');
      if (!filtered.length) continue;
      clone[key] = filtered;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeRecipeNode(value);
      if (Object.keys(nested).length) {
        clone[key] = nested;
      }
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

function buildRecipeStructuredData(baseData, recipe) {
  let graph = [];
  const baseGraph = Array.isArray(baseData?.['@graph']) ? baseData['@graph'] : [];
  if (baseGraph.length) {
    graph = baseGraph
      .filter((node) => {
        const type = Array.isArray(node?.['@type']) ? node['@type'][0] : node?.['@type'];
        if (!type) return true;
        const normalized = String(type).toLowerCase();
        return normalized !== 'itemlist' && normalized !== 'recipe';
      })
      .map((node) => JSON.parse(JSON.stringify(node)));
  }

  const canonicalUrl = `${SITE_ORIGIN}/${encodeURIComponent(recipe.slug || '')}`;
  const description = buildRecipeDescription(recipe);
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients
        .map((ingredient) => {
          const measure = String(ingredient.measure || '').trim();
          const name = String(ingredient.name || '').trim();
          const combined = [measure, name].filter(Boolean).join(' ');
          return combined.trim();
        })
        .filter(Boolean)
    : [];

  const keywordValues = [
    ...(Array.isArray(recipe.tags) ? recipe.tags.map((tag) => labelize(tag)).filter(Boolean) : []),
    ...(Array.isArray(recipe.mood_labels) ? recipe.mood_labels.map((mood) => labelize(mood)).filter(Boolean) : [])
  ];

  const dedupedKeywords = Array.from(new Set(keywordValues));

  const recipeNode = sanitizeRecipeNode({
    '@type': 'Recipe',
    '@id': canonicalUrl,
    url: canonicalUrl,
    name: recipe.name,
    description,
    image: recipe.image_url || recipe.image_thumb,
    datePublished: recipe.date,
    prepTime: toIsoDuration(recipe.prep_time),
    recipeCategory: recipe.category ? labelize(recipe.category) : undefined,
    recipeCuisine: 'Cocktail',
    recipeIngredient: ingredients,
    recipeInstructions: recipe.instructions || undefined,
    author: {
      '@type': 'Organization',
      '@id': `${SITE_ORIGIN}/#org`,
      name: 'Elixiary'
    },
    keywords: dedupedKeywords,
    totalTime: toIsoDuration(recipe.total_time),
    cookTime: toIsoDuration(recipe.cook_time),
    nutrition: recipe.alcohol_content
      ? {
          '@type': 'NutritionInformation',
          alcoholContent: recipe.alcohol_content
        }
      : undefined
  });

  graph.push(recipeNode);

  const breadcrumbNode = sanitizeRecipeNode({
    '@type': 'BreadcrumbList',
    '@id': `${canonicalUrl}#breadcrumb`,
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: `${SITE_ORIGIN}/`
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: recipe.name || 'Recipe',
        item: canonicalUrl
      }
    ]
  });

  graph.push(breadcrumbNode);

  return {
    '@context': baseData?.['@context'] || 'https://schema.org',
    '@graph': graph
  };
}

function setCanonicalMeta($, canonicalUrl) {
  const canonical = $('link[rel="canonical"]').first();
  if (canonical.length) {
    canonical.attr('href', canonicalUrl);
  }

  const ogUrl = $('meta[property="og:url"]').first();
  if (ogUrl.length) {
    ogUrl.attr('content', canonicalUrl);
  }

  const twitterUrl = $('meta[name="twitter:url"]').first();
  if (twitterUrl.length) {
    twitterUrl.attr('content', canonicalUrl);
  }
}

async function cleanupStaleRecipePages(validSlugs) {
  const distDir = path.join(__dirname, '..', 'dist');
  let entries = [];
  try {
    entries = await fs.readdir(distDir, { withFileTypes: true });
  } catch (error) {
    console.warn('Unable to inspect dist directory for cleanup:', error.message || error);
    return;
  }

  const reservedDirs = new Set(['assets']);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (reservedDirs.has(entry.name)) continue;
    if (validSlugs.has(entry.name)) continue;

    const candidate = path.join(distDir, entry.name, 'index.html');
    try {
      await fs.access(candidate);
    } catch (_) {
      continue;
    }

    console.log(`Removing stale recipe page: ${entry.name}`);
    await fs.rm(path.join(distDir, entry.name), { recursive: true, force: true });
  }
}

async function generateRecipePages(recipes, baseHtml) {
  if (!Array.isArray(recipes) || !recipes.length) return;

  console.log('Generating static recipe detail pages...');

  let baseStructuredData = null;
  try {
    const $ = cheerio.load(baseHtml);
    const script = $('script[type="application/ld+json"]').first();
    if (script.length) {
      baseStructuredData = JSON.parse(script.html());
    }
  } catch (error) {
    console.warn('Unable to parse base structured data for recipe pages:', error.message || error);
  }

  const successfulSlugs = new Set();

  for (const recipe of recipes) {
    const slug = String(recipe.slug || '').trim();
    if (!slug) {
      continue;
    }

    try {
      const detail = await fetchRecipeDetail(slug);
      const canonicalUrl = `${SITE_ORIGIN}/${encodeURIComponent(slug)}`;
      const detailHtml = buildRecipePage(baseHtml, baseStructuredData, detail, canonicalUrl);

      const outputDir = path.join(__dirname, '..', 'dist', slug);
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, 'index.html'), detailHtml, 'utf8');
      console.log(`  • /${slug}`);
      successfulSlugs.add(slug);
    } catch (error) {
      console.error(`Failed to generate static page for slug "${slug}":`, error.message || error);
    }
  }

  const validSlugs = new Set(recipes.map((recipe) => String(recipe.slug || '').trim()).filter(Boolean));
  await cleanupStaleRecipePages(validSlugs);

  console.log(`Generated ${successfulSlugs.size} recipe detail pages.`);
}

function buildRecipePage(baseHtml, baseStructuredData, recipe, canonicalUrl) {
  const $ = cheerio.load(baseHtml);

  const pageTitle = recipe.name ? `${recipe.name} · Elixiary` : 'Elixiary';
  $('title').first().text(pageTitle);

  const description = buildRecipeDescription(recipe);
  if (description) {
    setMetaContent($, 'meta[name="description"]', description);
  }

  applySocialMeta($, {
    title: pageTitle,
    description,
    image: recipe.image_url || recipe.image_thumb || getPlaceholderImage(recipe)
  });

  const ogType = $('meta[property="og:type"]').first();
  if (ogType.length) {
    ogType.attr('content', 'article');
  }

  setCanonicalMeta($, canonicalUrl);

  const view = $('#view');
  if (!view.length) {
    throw new Error('Failed to locate #view container when building recipe page');
  }
  // Remove list-only UI elements so the recipe heading is the first H1
  $('.hero').remove();
  $('#filters').remove();

  view.attr('data-prerendered', 'true');
  view.html(buildRecipeDetailMarkup(recipe));

  const structuredData = buildRecipeStructuredData(baseStructuredData, recipe);
  const script = $('script[type="application/ld+json"]').first();
  if (script.length) {
    script.text(JSON.stringify(structuredData, null, 2));
  } else {
    $('head').append(
      `<script type="application/ld+json">${JSON.stringify(structuredData, null, 2)}</script>`
    );
  }

  return $.html();
}

async function main() {
  console.log('Fetching recipes from API...');
  const recipes = await fetchRecipes();
  if (!recipes.length) {
    throw new Error('No recipes returned from API.');
  }

  console.log(`Fetched ${recipes.length} recipes.`);
  const html = await fs.readFile(OUTPUT_PATH, 'utf8');
  const $ = cheerio.load(html);

  const view = $('#view');
  if (!view.length) {
    throw new Error('Failed to locate #view container in index.html');
  }

  const gridMarkup = buildGrid(recipes);
  view.html(gridMarkup);
  view.attr('data-prerendered', 'true');

  const description = buildMetaDescription(recipes);
  if (description) {
    $('meta[name="description"]').attr('content', description);
  }

  const pageTitle = $('title').first().text().trim();

  let socialImage = '';
  const firstImage = recipes.find((recipe) => recipe.image_url || recipe.image_thumb);
  if (firstImage) {
    const imageUrl = firstImage.image_url || firstImage.image_thumb;
    if (imageUrl) {
      socialImage = imageUrl;
    }
  }

  applySocialMeta($, {
    title: pageTitle,
    description: description || undefined,
    image: socialImage || undefined
  });

  await updateStructuredData($, recipes);

  const updatedHomeHtml = $.html();
  await fs.writeFile(OUTPUT_PATH, updatedHomeHtml, 'utf8');
  console.log('Successfully updated dist/index.html with prerendered content.');

  await generateRecipePages(recipes, updatedHomeHtml);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
