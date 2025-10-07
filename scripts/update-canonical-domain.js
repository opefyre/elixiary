#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const SITEMAP_PATH = path.join(DIST_DIR, 'sitemap.xml');
const ROBOTS_PATH = path.join(DIST_DIR, 'robots.txt');
const CANONICAL_ORIGIN = 'https://www.elixiary.com';

async function updateSitemap() {
  const original = await fs.readFile(SITEMAP_PATH, 'utf8');
  const updated = original.replace(/(<loc>https:\/\/)(?:www\.)?elixiary\.com/gi, `$1www.elixiary.com`);
  if (updated !== original) {
    await fs.writeFile(SITEMAP_PATH, updated);
  }
}

async function updateRobots() {
  const original = await fs.readFile(ROBOTS_PATH, 'utf8');
  const updated = original.replace(/Sitemap:\s+https:\/\/(?:www\.)?elixiary\.com\/sitemap\.xml/gi, `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
  if (updated !== original) {
    await fs.writeFile(ROBOTS_PATH, updated);
  }
}

(async () => {
  try {
    await Promise.all([updateSitemap(), updateRobots()]);
    console.log('Canonical domain updated in sitemap.xml and robots.txt');
  } catch (error) {
    console.error('Failed to update canonical domain metadata');
    console.error(error);
    process.exitCode = 1;
  }
})();
