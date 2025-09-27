Elixiary – Architecture, Codebase, and Operations

This document explains Elixiary end-to-end: system design, repos, deployments, DNS, security, and how everything connects. A developer can onboard and operate the app without reading the code first.

1) System Overview

Goal: A fast static website listing cocktail recipes with detail pages. Content lives in Google Sheets. A Cloudflare Worker exposes a tiny read-only API cached in KV. The site is static and hosted on Firebase Hosting behind custom domains. Deployments run from GitHub.

High-level flow:

Browser → https://elixiary.com
 (Firebase Hosting serves files from dist/)

Front-end calls API → https://api.elixiary.com
 (Cloudflare Worker)

Worker reads Google Sheets (Google Sheets REST API), builds an index, caches in KV, returns JSON

Analytics: Google Analytics 4 (manual SPA page_view), Search Console & Bing verified

CI/CD: GitHub to Firebase (site) and to Cloudflare (API). PRs create preview deployments

2) Repositories and Layout
A) Front-end repo (this repo): opefyre/elixiary

Purpose: Static site + Firebase Hosting config + CI/CD workflows created by Firebase integration.

Structure:

/dist
  index.html
  contact.html
  privacy.html
  terms.html
  manifest.json
  robots.txt
  sitemap.xml
  icons, favicons, og images, etc.

firebase.json
.firebaserc
.github/workflows/   (added by Firebase GitHub integration)


Key files:

firebase.json: headers (cache + security). HTML no-cache; assets immutable 1 year.

.firebaserc: default project alias “elixiary”.

dist/*: all site files Firebase serves.

B) API repo (Cloudflare Worker)

Purpose: Serverless API in Cloudflare Workers to read Google Sheet, build an index, cache to KV, and respond with JSON.

Typical files (for reference if/when you mirror to GitHub):

worker.js              (the Worker code)
wrangler.toml          (bindings, vars, routes – optional if you use CF UI)
.github/workflows/     (if you wire CI from GitHub)


Wrangler reference (values are configured in CF dashboard today):

name = "mixology-api"
main = "worker.js"
compatibility_date = "2024-09-01"

kv_namespaces = [
  { binding = "MIXOLOGY", id = "<kv-id>" }
]

[vars]
SHEET_ID = "<sheet id>"
SHEET_NAME = "Recipes"
GOOGLE_API_KEY = "<restricted api key>"
ALLOWED_ORIGINS = "https://elixiary.com,https://www.elixiary.com,https://elixiary.web.app"
PAGE_DEFAULT = "12"
PAGE_MAX = "48"
CACHE_TTL_SECONDS = "300"
RL_LIMIT = "60"
RL_WINDOW_SEC = "60"

3) Front-end (Firebase Hosting)

Domains:

elixiary.com and www.elixiary.com
 both point to Firebase Hosting

DNS hosted on Cloudflare (DNS-only for these records)

DNS:

A elixiary.com → 199.36.158.100 (DNS only)

CNAME www → elixiary.web.app (DNS only)

TXT elixiary.com → hosting-site=elixiary

TLS:

Firebase issues SSL certs for apex and www automatically.

Caching and headers (from firebase.json):

HTML: no-cache

Assets (js, css, images, fonts): public, max-age=31536000, immutable

Security headers:

Referrer-Policy: strict-origin-when-cross-origin

X-Content-Type-Options: nosniff

X-Frame-Options: DENY

Permissions-Policy: geolocation=(), microphone=(), camera=()

Content Security Policy (in index.html <head>):

Allows only what we need (site, fonts, GA, API).

Blocks random third-party scripts by default.

Google Analytics 4 (G-PJ2GP3Q1K1):

Loaded via gtag.

send_page_view disabled; we send page_view manually on SPA navigations.

Example:

<script async src="https://www.googletagmanager.com/gtag/js?id=G-PJ2GP3Q1K1"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }

  // Consent defaults (privacy-friendly); add a real consent UI later
  gtag('consent', 'default', {
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    ad_storage: 'denied',
    analytics_storage: 'denied'
  });

  gtag('js', new Date());
  gtag('config', 'G-PJ2GP3Q1K1', { send_page_view: false });
</script>


SPA route change tracking:

gtag('event', 'page_view', {
  page_location: location.href,
  page_path: location.pathname + location.search,
  page_title: document.title
});


SEO:

Search Console and Bing verified via HTML files in dist/

robots.txt includes “Sitemap: https://elixiary.com/sitemap.xml”

sitemap.xml lists homepage, static pages, and curated recipe URLs

JSON-LD: WebSite with SearchAction, and Organization (name/url/logo/sameAs)

Service Worker:

We removed the old SW (kill-switch). Site uses normal HTTP caching. Only add a SW later if you explicitly want PWA/offline.

4) Backend API (Cloudflare Worker at https://api.elixiary.com
)

Endpoints:

GET /v1/list
Query params:

page (default PAGE_DEFAULT)

page_size (max PAGE_MAX)

q (search in name, tags, moods)

category, tag, mood (filters)

if_etag (optimization to reuse cached page 1 when filters are empty)

Response sample:

{
  "ok": true,
  "etag": "sha1...",
  "total": 1234,
  "page": 1,
  "page_size": 12,
  "has_more": true,
  "posts": [
    {
      "_row": 2,
      "slug": "aperol-spritz",
      "name": "Aperol Spritz",
      "date": "2024-09-08",
      "category": "Aperitif",
      "difficulty": "Easy",
      "prep_time": "5m",
      "tags": ["bubbly","summer"],
      "mood_labels": ["light","citrusy"],
      "image_url": "...",
      "image_thumb": "..."
    }
  ]
}


GET /v1/post/{slug}
Response sample:

{
  "ok": true,
  "post": {
    "slug": "aperol-spritz",
    "name": "Aperol Spritz",
    "ingredients": [{ "name": "Aperol", "amount": "3 oz" }, ...],
    "mood_labels": ["light","citrusy"],
    "tags": ["bubbly","summer"],
    "category": "Aperitif",
    "instructions": "...",
    "glass": "...",
    "garnish": "...",
    "prep_time": "5m",
    "difficulty": "Easy",
    "image_url": "...",
    "image_thumb": "...",
    "date": "2024-09-08"
  }
}


Data source (Google Sheets):

Sheet columns are normalized by the Worker: Name, Date, Category, Difficulty, PrepTime/Prep_Time, Tags, MoodLabels/Mood_Labels, Image_URL

Detail-only columns: IngredientsJSON/Ingredients_JSON (stringified array), Instructions, Glass, Garnish

Drive images are converted to direct view/thumbnail links.

Caching:

Worker builds index and stores to KV (key: idx_v1). TTL controlled by CACHE_TTL_SECONDS (default 300 s).

ETag returned by /v1/list to help clients reuse results.

Responses include Cache-Control: public, max-age=60.

CORS:

ALLOWED_ORIGINS env var defines allowed origins (comma-separated) or “*”.

Preflight supports GET/HEAD/OPTIONS, echoes requested headers.

Preview channels can be whitelisted (e.g., https://pr-123--elixiary.web.app
).

Safety:

Read-only: only GET/HEAD supported on /v1/*.

KV-based rate limit: RL_LIMIT per RL_WINDOW_SEC per IP (default 60 in 60s). Exceed → 429 with Retry-After.

Error format:

{ "ok": false, "error": "not_found" }
{ "ok": false, "error": "rate_limited" }
{ "ok": false, "error": "Sheets API 403" }


Examples:

curl "https://api.elixiary.com/v1/list?page=1&page_size=12"
curl "https://api.elixiary.com/v1/list?q=spritz"
curl "https://api.elixiary.com/v1/post/aperol-spritz"

5) DNS and Certificates

Cloudflare DNS (Zone elixiary.com):

A elixiary.com → 199.36.158.100 (DNS only)

CNAME www → elixiary.web.app (DNS only)

TXT elixiary.com → hosting-site=elixiary

api.elixiary.com bound to the Worker via Cloudflare “Custom Domains” (CF manages its TLS cert)

Certificates:

Firebase auto-issues for apex and www
.

Cloudflare auto-issues for api.elixiary.com.

6) CI/CD

Firebase Hosting (site):

Connected to GitHub via Firebase Console → Hosting → Connect to GitHub

Workflows created in .github/workflows/

PRs → Preview channels at pr-###--elixiary.web.app

Push to main → deploys to production (custom domains + elixiary.web.app)

Cloudflare Worker (API):

Connected via Cloudflare dashboard → Workers → Deployments (Git integration)

Variables and KV bindings configured under the Worker → Settings → Variables/Bindings

Every push to main deploys a new Worker version

Rollback from Workers → Deployments

7) Observability and Health

Google Analytics 4:

Manual page_view events on SPA navigations

Optional custom events (search, filter, recipe_view) can be added later

Healthcheck workflow (example) in this repo:

.github/workflows/healthcheck.yml (if you added it)

Runs every 10 minutes and pings API and robots.txt

Failures surface in GitHub Actions and notifications

Cloudflare logs:

Workers → mixology-api → Logs / tail for real-time logs

8) Security Posture

Front-end:

HTML no-cache, assets immutable

CSP locked down to site, fonts, GA, API

Referrer-Policy strict-origin-when-cross-origin

X-Content-Type-Options nosniff

X-Frame-Options DENY

Permissions-Policy denies geolocation, microphone, camera by default

GA Consent Mode defaults denied (privacy-first)

API:

GET-only endpoints with allow-listed CORS origins

KV rate limit

Server-side Google API key restricted to Sheets API only (in GCP)

Secrets:

Kept in Cloudflare Variables (Worker settings), not in Git

9) Operations (Runbooks)

Deploy / rollback (site):

Push to main → deploys automatically

To rollback: Firebase Console → Hosting → Versions → Rollback

Deploy / rollback (API):

Push to main in Worker repo → deploys

To rollback: Cloudflare Workers → Deployments → choose previous → Rollback

To change rate limits or CORS: update Variables in Worker settings and redeploy

Force cache rebuild:

KV entry idx_v1 TTL is short; update sheet or purge the key to force rebuild.

Common issues:

CORS blocked → ensure exact origin (scheme + host) in ALLOWED_ORIGINS

GA blocked by CSP → connect-src/script-src must include GA hosts

DNS/SSL mismatch → ensure Firebase verification and wait for cert issuance

10) Local Development

Prereqs:

Node 18+ (you have Node 22)

Git, optional Firebase CLI, optional Wrangler if running Worker locally

Run site locally:

Serve dist/ with any static server (e.g., VS Code Live Server). The site is already built.

Test API locally (optional):

With Wrangler CLI and a local wrangler.toml and env vars; or call production API while developing.

11) Data Model (Sheet)

List/index fields:

Name (required) → slugified

Date (ISO)

Category, Difficulty, PrepTime

Tags (CSV → array), MoodLabels (CSV → array)

Image_URL (Drive or web)

Detail-only:

IngredientsJSON (stringified array)

Instructions, Glass, Garnish

12) API Contract (Quick Reference)

GET /v1/list
Inputs: page, page_size, q, category, tag, mood, if_etag
Sort: newest first by ISO date
Returns: { ok, etag, total, page, page_size, has_more, posts[] }

GET /v1/post/{slug}
Returns: { ok, post } or { ok:false, error:'not_found' }

Errors: JSON with { ok:false, error:'...' }

13) Roadmap (Optional)

Durable Object token bucket for stronger rate limiting

Structured logging and external log sink

Sentry on the front-end

i18n

Move from Google Sheets to a database when scale requires

PWA with versioned assets if offline support becomes a requirement
EOF

Create docs/ops.md (ops handbook)
cat > docs/ops.md <<'EOF'

Elixiary Ops Handbook

This document is for day-to-day operations, incidents, changes, and checklists.

1) Contacts and Scope

Product: Elixiary

Front-end: Firebase Hosting (dist/)

API: Cloudflare Worker mixology-api with KV cache

Data: Google Sheets (Recipes tab)

DNS: Cloudflare (zone elixiary.com)

Analytics: GA4

2) Health Checks

Manual quick check:

API: curl -fsS "https://api.elixiary.com/v1/list?page=1&page_size=1
"

Site: curl -fsS "https://elixiary.com/robots.txt
"

Automated (GitHub Actions):

.github/workflows/healthcheck.yml runs every 10 minutes

Failing checks show in GitHub Actions

3) Deployments

Site:

Push to main in opefyre/elixiary → auto deploy to Firebase

Rollback: Firebase Console → Hosting → Versions → Rollback to a previous version

API:

Push to main in the Worker repo (or trigger via CF Deployments) → auto deploy

Rollback: Cloudflare Workers → Deployments → select previous → Rollback

4) Configuration Changes

CORS allow-list (Worker):

Cloudflare Dashboard → Workers → mixology-api → Settings → Variables

Update ALLOWED_ORIGINS to include exact origins (e.g., https://elixiary.com
, https://www.elixiary.com
, preview URLs)

Redeploy if needed

Rate limits (Worker):

RL_LIMIT and RL_WINDOW_SEC in Variables

Example: 60 requests per 60 seconds per IP

Google API key restrictions:

In GCP Console, restrict key usage to “Google Sheets API” only

The key is server-side in Worker Variables; never ship to client

5) Data Updates (Google Sheets)

Index fields required at minimum:

Name (required), Date, Category, Difficulty, PrepTime

Tags (CSV), MoodLabels (CSV), Image_URL

Detail fields:

IngredientsJSON (JSON array as a string)

Instructions, Glass, Garnish

Image URLs:

If using Google Drive links like /file/d/<id> or ?id=<id>, Worker converts to display/thumbnail links automatically.

Cache refresh:

KV index (idx_v1) TTL is short (default 300s). Small changes appear in a few minutes.

To force: delete key in KV or adjust TTL.

6) Incident Response

A) API 5xx or slow:

Tail Worker logs: Cloudflare → Workers → mixology-api → Logs

Check GCP API quotas for Sheets

If sheet structure changed, verify headers/columns are still present

B) CORS errors in browser:

Check the browser console error

Ensure origin is in ALLOWED_ORIGINS exactly (scheme + host)

For PR previews, add specific https://pr-###--elixiary.web.app
 if needed

C) SSL/Domain errors:

Apex and www: ensure Firebase domain verification and cert issuance

API: Cloudflare custom domain bound to Worker issues its own cert

D) GA not receiving data:

Check CSP connect-src and script-src for GA/Analytics/DoubleClick/GTM hosts

Confirm send_page_view is triggered on route changes

7) Security Controls

Front-end:

CSP blocks third-party scripts except GA

Security headers: Referrer-Policy, X-Content-Type-Options, X-Frame-Options, Permissions-Policy

HTML no-cache, assets immutable for cache-busting by filename

API:

GET/HEAD only

KV rate limit

CORS allow-list (no wildcards in production unless intended)

No user data stored in the API

8) Playbooks

Add a new static page:

Add HTML file to dist/

Ensure sitemap.xml references it if appropriate

Push to main → auto deploy

Add curated recipe to sitemap:

Edit dist/sitemap.xml and add a <url> entry

Push to main

Change rate limits:

Update RL_LIMIT or RL_WINDOW_SEC in Worker Variables

Save and redeploy

Allow a PR preview origin:

Add https://pr-
<number>--elixiary.web.app to ALLOWED_ORIGINS temporarily

Remove when PR is merged/closed

Tighten CSP:

Update the meta CSP in index.html

Test GA and API calls still succeed

9) Future Improvements

Durable Objects token bucket

External log sink or analytics on API

Sentry for front-end errors

Automated sitemap generation from the sheet

PWA (only with careful versioning and SW strategy)
