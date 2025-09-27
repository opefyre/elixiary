// sw.js — kill-switch: wipe caches, unregister, and stop intercepting anything
const CACHE_NAME   = 'mixology-v1.1.2';
const STATIC_CACHE = 'mixology-static-v1.1.2';
const API_CACHE    = 'mixology-api-v1.1.2';

self.addEventListener('install', (event) => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1) delete ALL caches
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));

    // 2) take control
    await self.clients.claim();

    // 3) unregister this SW
    try { await self.registration.unregister(); } catch (_) {}

    // 4) force every open tab to reload from the network
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.navigate(c.url);
  })());
});

// No fetch handler — let the browser handle everything
