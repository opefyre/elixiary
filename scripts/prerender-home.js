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

  await fs.writeFile(OUTPUT_PATH, $.html(), 'utf8');
  console.log('Successfully updated dist/index.html with prerendered content.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
