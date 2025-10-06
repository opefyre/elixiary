export const API_VERSION = 'v1';

const textEncoder = new TextEncoder();

export function createIndexBuilder({ fetchSheetValues }) {
  if (typeof fetchSheetValues !== 'function') {
    throw new TypeError('fetchSheetValues must be a function');
  }

  async function buildIndexFromSheet(env) {
    const range = `${env.SHEET_NAME}!A1:L`;
    const data = await fetchSheetValues(env, range);
    const values = data.values || [];
    if (!values.length) {
      return { rows: [], etag: await hashHex(`${API_VERSION}:empty`), _headerMap: {} };
    }

    const header = values[0];
    const map = Object.fromEntries(header.map((h, i) => [canon(h), i]));
    const rows = [];
    const categoryIndex = Object.create(null);
    const tagIndex = Object.create(null);
    const moodIndex = Object.create(null);
    const tokenIndex = Object.create(null);
    const slugIndexRefs = Object.create(null);

    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      const cell = (key) => {
        const idx = map[key];
        return (typeof idx === 'number') ? r[idx] : undefined;
      };

      const name = cell('name');
      const slug = slugify(name || '');
      if (!slug) continue;

      const img = driveImageLinks(cell('imageurl') || cell('image_url'));
      const category = String((cell('category') || ''));
      const tags = splitCSV(cell('tags'));
      const moods = splitCSV(cell('moodlabels') || cell('mood_labels'));
      const prepTime = String((cell('preptime') || cell('prep_time') || ''));
      const difficulty = String((cell('difficulty') || ''));
      const date = toDateISO(cell('date'));

      let ingredients = [];
      try {
        const rawIngredients = cell('ingredientsjson') || cell('ingredients_json');
        ingredients = rawIngredients ? JSON.parse(rawIngredients) : [];
        if (!Array.isArray(ingredients)) ingredients = [];
      } catch {
        ingredients = [];
      }

      const instructions = String(cell('instructions') || '');
      const glass = String(cell('glass') || '');
      const garnish = String(cell('garnish') || '');

      const row = {
        _row: i + 1,
        slug,
        name: String(name || ''),
        date,
        category,
        difficulty,
        prep_time: prepTime,
        tags,
        mood_labels: moods,
        image_url: img.src,
        image_thumb: img.thumb,
        _name_lc: String(name || '').toLowerCase(),
        _tags_lc: tags.map(t => String(t || '').toLowerCase()),
        _moods_lc: moods.map(m => String(m || '').toLowerCase()),
        _category_lc: category.toLowerCase(),
        _details: {
          slug,
          name: String(name || ''),
          ingredients,
          mood_labels: moods,
          tags,
          category,
          instructions,
          glass,
          garnish,
          prep_time: prepTime,
          difficulty,
          image_url: img.src,
          image_thumb: img.thumb,
          date
        }
      };

      rows.push(row);

      const slugLc = row.slug.toLowerCase();
      if (!(slugLc in slugIndexRefs)) {
        slugIndexRefs[slugLc] = row;
      }

      if (row._category_lc) {
        if (!categoryIndex[row._category_lc]) categoryIndex[row._category_lc] = [];
        categoryIndex[row._category_lc].push(row);
      }

      for (const t of row._tags_lc) {
        if (!tagIndex[t]) tagIndex[t] = [];
        tagIndex[t].push(row);
      }

      for (const m of row._moods_lc) {
        if (!moodIndex[m]) moodIndex[m] = [];
        moodIndex[m].push(row);
      }

      const tokens = new Set();
      addTokens(tokens, row._name_lc);
      for (const tag of row._tags_lc) addTokens(tokens, tag);
      for (const mood of row._moods_lc) addTokens(tokens, mood);
      for (const token of tokens) {
        if (!tokenIndex[token]) tokenIndex[token] = [];
        tokenIndex[token].push(row);
      }
    }

    rows.sort((a, b) => {
      const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
      if (dateCmp !== 0) return dateCmp;
      return a.slug.localeCompare(b.slug);
    });

    const rowToIndex = new Map();
    rows.forEach((row, idx) => rowToIndex.set(row, idx));

    const normalizeIndex = (map) => {
      const out = Object.create(null);
      for (const [key, list] of Object.entries(map)) {
        if (!key) continue;
        const idxSet = new Set();
        for (const row of list) {
          const pos = rowToIndex.get(row);
          if (typeof pos === 'number') idxSet.add(pos);
        }
        if (idxSet.size) {
          out[key] = Array.from(idxSet).sort((a, b) => a - b);
        }
      }
      return out;
    };

    const categoryIndexOut = normalizeIndex(categoryIndex);
    const tagIndexOut = normalizeIndex(tagIndex);
    const moodIndexOut = normalizeIndex(moodIndex);
    const tokenIndexOut = normalizeIndex(tokenIndex);
    const { prefixIndex: tokenPrefixIndexOut, ngramIndex: tokenNgramIndexOut } = buildTokenAuxiliaryIndexes(tokenIndexOut);
    const slugIndexOut = Object.create(null);
    for (const [slugLc, row] of Object.entries(slugIndexRefs)) {
      const pos = rowToIndex.get(row);
      if (typeof pos === 'number') {
        slugIndexOut[slugLc] = pos;
      }
    }

    const etag = await computeIndexEtag(rows);
    return {
      rows,
      etag,
      _headerMap: map,
      _categoryIndex: categoryIndexOut,
      _tagIndex: tagIndexOut,
      _moodIndex: moodIndexOut,
      _tokenIndex: tokenIndexOut,
      _tokenPrefixIndex: tokenPrefixIndexOut,
      _tokenNgramIndex: tokenNgramIndexOut,
      _slugIndex: slugIndexOut
    };
  }

  async function fetchRowFull(env, rowNumber, { headerMap, ctx, getIndex }) {
    const range = `${env.SHEET_NAME}!A${rowNumber}:L${rowNumber}`;
    const data = await fetchSheetValues(env, range);
    const values = data.values || [];
    if (!values.length) return null;

    let map = headerMap;
    if (!map || !Object.keys(map).length) {
      if (typeof getIndex === 'function') {
        const idx = await getIndex(env, ctx);
        map = idx && idx._headerMap;
      }
      if (!map || !Object.keys(map).length) {
        const head = await fetchSheetValues(env, `${env.SHEET_NAME}!A1:L1`);
        const header = (head.values && head.values[0]) || [];
        map = Object.fromEntries(header.map((h, i) => [canon(h), i]));
      }
    }

    const r = values[0];
    const name = r[map['name']];
    const slug = slugify(name || '');
    if (!slug) return null;

    let ingredients = [];
    try {
      const raw = r[map['ingredientsjson']] || r[map['ingredients_json']];
      ingredients = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(ingredients)) ingredients = [];
    } catch {
      ingredients = [];
    }

    const img = driveImageLinks(r[map['imageurl']] || r[map['image_url']]);

    return {
      slug,
      name: String(name || ''),
      ingredients,
      mood_labels: splitCSV(r[map['moodlabels']] || r[map['mood_labels']]),
      tags: splitCSV(r[map['tags']]),
      category: String(r[map['category']] || ''),
      instructions: String(r[map['instructions']] || ''),
      glass: String(r[map['glass']] || ''),
      garnish: String(r[map['garnish']] || ''),
      prep_time: String(r[map['preptime']] || r[map['prep_time']] || ''),
      difficulty: String(r[map['difficulty']] || ''),
      image_url: img.src,
      image_thumb: img.thumb,
      date: toDateISO(r[map['date']])
    };
  }

  return {
    buildIndexFromSheet,
    fetchRowFull,
    ensureTokenAuxIndexes,
    hasPrecomputedMaps,
    filterIndex,
    serializeRow
  };
}

function canon(s) {
  return String(s || '').replace(/\uFEFF/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function splitCSV(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function driveImageLinks(url) {
  const u = String(url || '').trim();
  if (!u) return { src: '', thumb: '' };
  const m = u.match(/\/file\/d\/([^/]+)/) || u.match(/[?&]id=([^&]+)/);
  if (!m || !m[1]) return { src: u, thumb: u };
  const id = m[1];
  return {
    src: `https://drive.google.com/uc?export=view&id=${id}`,
    thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w1200`
  };
}

function toDateISO(v) {
  try {
    if (Object.prototype.toString.call(v) === '[object Date]') return !isNaN(v) ? v.toISOString().slice(0, 10) : '';
    if (typeof v === 'number') {
      const ms = Math.round((v - 25569) * 864e5);
      return new Date(ms).toISOString().slice(0, 10);
    }
    const d = new Date(String(v));
    return isNaN(d) ? String(v || '') : d.toISOString().slice(0, 10);
  } catch {
    return String(v || '');
  }
}

async function hashHexFromBytes(bytes) {
  const out = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(out)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashHex(s) {
  return hashHexFromBytes(textEncoder.encode(s));
}

async function computeIndexEtag(rows) {
  const prefix = `${API_VERSION}:${rows.length}:`;
  const parts = [];
  parts.push(textEncoder.encode(prefix));
  for (const row of rows) {
    const snapshot = {
      slug: row.slug,
      date: row.date,
      category: row.category,
      difficulty: row.difficulty,
      prep_time: row.prep_time,
      tags: row.tags,
      mood_labels: row.mood_labels,
      image_url: row.image_url,
      image_thumb: row.image_thumb
    };
    const encoded = textEncoder.encode(JSON.stringify(snapshot) + '\n');
    parts.push(encoded);
  }

  let totalLength = 0;
  for (const part of parts) totalLength += part.length;
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  return hashHexFromBytes(combined);
}

function ensureLowercaseFields(row) {
  if (!('_name_lc' in row)) {
    row._name_lc = String(row.name || '').toLowerCase();
  }
  if (!Array.isArray(row._tags_lc)) {
    row._tags_lc = Array.isArray(row.tags) ? row.tags.map(t => String(t || '').toLowerCase()) : [];
  }
  if (!Array.isArray(row._moods_lc)) {
    row._moods_lc = Array.isArray(row.mood_labels) ? row.mood_labels.map(m => String(m || '').toLowerCase()) : [];
  }
  if (!('_category_lc' in row)) {
    row._category_lc = String(row.category || '').toLowerCase();
  }
  return row;
}

function addTokens(set, value) {
  const str = String(value || '').toLowerCase();
  if (!str) return;
  const matches = str.match(/[a-z0-9]+/g);
  if (!matches) return;
  for (const token of matches) {
    if (token) set.add(token);
  }
}

function buildTokenAuxiliaryIndexes(tokenIndex) {
  const prefixBuckets = new Map();
  const ngramBuckets = new Map();

  if (!tokenIndex || typeof tokenIndex !== 'object') {
    return { prefixIndex: Object.create(null), ngramIndex: Object.create(null) };
  }

  const addToBucket = (bucket, key, values) => {
    if (!key || !Array.isArray(values) || !values.length) return;
    let set = bucket.get(key);
    if (!set) {
      set = new Set();
      bucket.set(key, set);
    }
    for (const val of values) {
      if (Number.isInteger(val)) {
        set.add(val);
      }
    }
  };

  for (const [rawToken, indexList] of Object.entries(tokenIndex)) {
    if (!Array.isArray(indexList) || !indexList.length) continue;
    const token = String(rawToken || '').toLowerCase();
    if (!token) continue;
    const len = token.length;
    if (!len) continue;

    if (len === 1) {
      addToBucket(prefixBuckets, token, indexList);
    } else {
      addToBucket(prefixBuckets, token.slice(0, 2), indexList);
      if (len >= 3) addToBucket(prefixBuckets, token.slice(0, 3), indexList);
    }

    const maxNgram = Math.min(3, len);
    const minNgram = 1;
    const seenNgrams = new Set();
    for (let size = maxNgram; size >= minNgram; size--) {
      for (let i = 0; i <= len - size; i++) {
        const key = token.slice(i, i + size);
        if (!key) continue;
        const dedupKey = `${size}:${key}`;
        if (seenNgrams.has(dedupKey)) continue;
        seenNgrams.add(dedupKey);
        addToBucket(ngramBuckets, key, indexList);
      }
    }
  }

  const convertBuckets = (bucket) => {
    const out = Object.create(null);
    for (const [key, set] of bucket.entries()) {
      if (!key || !set.size) continue;
      out[key] = Array.from(set).sort((a, b) => a - b);
    }
    return out;
  };

  return {
    prefixIndex: convertBuckets(prefixBuckets),
    ngramIndex: convertBuckets(ngramBuckets)
  };
}

function validateSortedIndexMap(map) {
  if (!map || typeof map !== 'object') return false;
  for (const value of Object.values(map)) {
    if (!Array.isArray(value)) return false;
    let prev = -Infinity;
    for (const entry of value) {
      if (!Number.isInteger(entry)) return false;
      if (entry < prev) return false;
      prev = entry;
    }
  }
  return true;
}

function ensureTokenAuxIndexes(idx) {
  if (!idx || typeof idx !== 'object' || !idx._tokenIndex || typeof idx._tokenIndex !== 'object') {
    return false;
  }

  let prefixValid = validateSortedIndexMap(idx._tokenPrefixIndex);
  let ngramValid = validateSortedIndexMap(idx._tokenNgramIndex);

  if (prefixValid && ngramValid) {
    return true;
  }

  const built = buildTokenAuxiliaryIndexes(idx._tokenIndex);
  if (!prefixValid) {
    idx._tokenPrefixIndex = built.prefixIndex;
    prefixValid = validateSortedIndexMap(idx._tokenPrefixIndex);
  }
  if (!ngramValid) {
    idx._tokenNgramIndex = built.ngramIndex;
    ngramValid = validateSortedIndexMap(idx._tokenNgramIndex);
  }

  return prefixValid && ngramValid;
}

function hasPrecomputedMaps(idx) {
  if (!idx || typeof idx !== 'object') return false;
  const baseMaps = ['_categoryIndex', '_tagIndex', '_moodIndex', '_tokenIndex'];
  for (const key of baseMaps) {
    if (!idx[key] || typeof idx[key] !== 'object') return false;
    if (!validateSortedIndexMap(idx[key])) return false;
  }

  if (!ensureTokenAuxIndexes(idx)) return false;

  if (!idx._slugIndex || typeof idx._slugIndex !== 'object') return false;
  for (const value of Object.values(idx._slugIndex)) {
    if (!Number.isInteger(value)) return false;
  }
  return true;
}

function serializeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '_row' || !key.startsWith('_')) {
      out[key] = value;
    }
  }
  return out;
}

function tokenizeQuery(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  if (!q) return [];
  const parts = q.match(/[a-z0-9]+/g);
  return parts ? parts.filter(Boolean) : [];
}

function lookupTokenMatches(idx, token) {
  const normalized = String(token || '').toLowerCase();
  if (!normalized || !idx || typeof idx._tokenIndex !== 'object') return [];

  const direct = idx._tokenIndex[normalized];
  if (Array.isArray(direct) && direct.length) {
    return direct;
  }

  if (!ensureTokenAuxIndexes(idx)) return [];

  const groups = [];
  const prefixIndex = idx._tokenPrefixIndex || {};
  const ngramIndex = idx._tokenNgramIndex || {};

  if (normalized.length === 1) {
    const singlePrefix = prefixIndex[normalized];
    if (Array.isArray(singlePrefix) && singlePrefix.length) {
      groups.push(singlePrefix);
    }
  } else {
    const prefix2 = normalized.slice(0, 2);
    const arr2 = prefixIndex[prefix2];
    if (Array.isArray(arr2) && arr2.length) {
      groups.push(arr2);
    }
    if (normalized.length >= 3) {
      const prefix3 = normalized.slice(0, 3);
      const arr3 = prefixIndex[prefix3];
      if (Array.isArray(arr3) && arr3.length) {
        groups.push(arr3);
      }
    }
  }

  const maxLen = Math.min(3, normalized.length);
  const minLen = normalized.length === 1 ? 1 : Math.min(2, normalized.length);
  const ngramKeys = new Set();
  for (let size = maxLen; size >= minLen; size--) {
    for (let i = 0; i <= normalized.length - size; i++) {
      const key = normalized.slice(i, i + size);
      if (key) ngramKeys.add(key);
    }
  }

  for (const key of ngramKeys) {
    const arr = ngramIndex[key];
    if (Array.isArray(arr) && arr.length) {
      groups.push(arr);
    }
  }

  if (!groups.length) {
    return [];
  }

  groups.sort((a, b) => a.length - b.length);
  let current = groups[0];

  for (let i = 1; i < groups.length && current.length; i++) {
    current = intersectSortedArrays(current, groups[i]);
  }

  return current;
}

function intersectSortedArrays(a, b) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const av = a[i];
    const bv = b[j];
    if (av === bv) {
      result.push(av);
      i += 1;
      j += 1;
    } else if (av < bv) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return result;
}

function filterIndex(idx, qRaw, tag, cat, mood) {
  const rows = (idx && Array.isArray(idx.rows)) ? idx.rows : [];
  const hasMaps = hasPrecomputedMaps(idx);

  if (!hasMaps) {
    const matches = [];
    const q = String(qRaw || '').toLowerCase();
    const tagLc = String(tag || '').toLowerCase();
    const catLc = String(cat || '').toLowerCase();
    const moodLc = String(mood || '').toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      const row = ensureLowercaseFields(rows[i]);
      if (q) {
        const inName = row._name_lc.includes(q);
        const inTags = row._tags_lc.some(t => t.includes(q));
        const inMoods = row._moods_lc.some(mo => mo.includes(q));
        if (!inName && !inTags && !inMoods) continue;
      }
      if (tagLc && !row._tags_lc.includes(tagLc)) continue;
      if (catLc && row._category_lc !== catLc) continue;
      if (moodLc && !row._moods_lc.includes(moodLc)) continue;
      matches.push(i);
    }
    return matches;
  }

  const groups = [];
  const lc = (s) => String(s || '').toLowerCase();

  if (cat) {
    const arr = idx._categoryIndex[lc(cat)] || [];
    if (!arr.length) return [];
    groups.push(arr);
  }

  if (tag) {
    const arr = idx._tagIndex[lc(tag)] || [];
    if (!arr.length) return [];
    groups.push(arr);
  }

  if (mood) {
    const arr = idx._moodIndex[lc(mood)] || [];
    if (!arr.length) return [];
    groups.push(arr);
  }

  const tokens = tokenizeQuery(qRaw);
  for (const token of tokens) {
    const arr = lookupTokenMatches(idx, token);
    if (!arr.length) return [];
    groups.push(arr);
  }

  if (!groups.length) {
    return rows.map((_, i) => i);
  }

  groups.sort((a, b) => a.length - b.length);
  let current = groups[0];

  for (let i = 1; i < groups.length; i++) {
    current = intersectSortedArrays(current, groups[i]);
    if (!current.length) {
      return [];
    }
  }

  return current;
}
