/* Star Swim service worker.
 *
 * Strategy — deliberately conservative for a site that shares its origin
 * with the SSB Scheduler app (app.html + app.compiled.js):
 *
 *   • Navigations (HTML pages) ......... network-first, cache fallback.
 *     Pages stay fresh; the last-seen copy serves offline.
 *   • Same-origin images ............... cache-first (they're immutable-ish).
 *   • EVERYTHING ELSE .................. untouched (straight to network).
 *     JS/CSS/API are never cached, so app.compiled.js deploys and all
 *     Supabase data are always live. This also keeps the scheduler app
 *     completely unaffected by the PWA layer.
 */
const CACHE = 'starswim-v1';
const IMG_RE = /\.(png|jpe?g|webp|svg|gif|ico)$/i;

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Supabase etc.

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/')))
    );
    return;
  }

  if (IMG_RE.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
  }
  // all other requests fall through untouched
});
