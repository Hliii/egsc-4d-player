// EGSC 4D Player service worker: offline-first PWA.
//
// - install: pre-cache the app shell (player modules, wasm glue, css).
// - the 24.5MB scene is cached on first successful fetch (streamed, not
//   precached, so install stays fast and retryable).
// - fetch: cache-first for same-origin GETs (stale-while-revalidate for the
//   HTML shells), so after the first load everything works with zero network.

const CACHE = "egsc-4d-v23";
const SHELL = [
  "examples/egsc-demo.html",
  "src/index.js",
  "src/player.js",
  "src/renderer.js",
  "src/sort.js",
  "src/sort-worker.js",
  "src/camera.js",
  "src/model.js",
  "src/decode.js",
  "src/decode-worker.js",
  "src/worker.js",
  "src/ftgs.js",
  "src/egsc.js",
  "src/egsc-model.js",
  "src/egsc-astc.js",
  "src/egsc-loader.js",
  "src/attr-worker.js",
  "src/attr-inline.js",
  "src/model-worker.js",
  "src/tex-worker.js",
  "src/tex-inline.js",
  "src/astc-worker.js",
  "src/vendor/fzstd.js",
  "src/vendor/texture2ddecoder.js",
  "src/vendor/wasm/texture2ddecoder.js",
  "src/vendor/wasm/texture2ddecoder.wasm",
  "egsc-pwa/manifest.json",
  "egsc-pwa/icon-192.png",
  "egsc-pwa/icon-512.png",
  "egsc-pwa/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll aborts wholesale on one failure; add individually + skip-fail
      // so a missing optional file never blocks install.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const hit = await caches.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  // cache same-origin GETs that succeed (covers scene.egsc + future assets)
  if (response.ok && request.method === "GET") {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function htmlStrategy(request) {
  // stale-while-revalidate: serve cached shell instantly (works offline on
  // first reload), refresh the copy in the background when online.
  const cached = await caches.match(request, { ignoreVary: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) {
        caches.open(CACHE).then((c) => c.put(request, response.clone()).catch(() => {}));
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error("offline and not cached: " + request.url);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isHtml = request.destination === "document" || url.pathname.endsWith(".html");
  event.respondWith(
    isHtml ? htmlStrategy(request) : cacheFirst(request),
  );
});
