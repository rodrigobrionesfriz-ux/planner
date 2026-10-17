/* Service worker del Planificador.
   Al cambiar archivos de la app, sube el número de VERSION para que los teléfonos tomen la nueva versión. */
const VERSION = "v5";
const CACHE = `planificador-${VERSION}`;
const APP = [
  "./", "./index.html", "./styles.css", "./app.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png"
];
// Librerías externas con versión fija en la URL: se guardan la primera vez y no cambian.
const CDN = ["https://www.gstatic.com/firebasejs/", "https://cdn.jsdelivr.net/npm/chart.js@"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const claves = await caches.keys();
    await Promise.all(claves.filter((k) => k.startsWith("planificador-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => { if (e.data === "actualizar") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firestore y el acceso de Firebase van siempre directo a la red (Firestore ya tiene su propia caché).
  if (url.pathname.startsWith("/__/") || /googleapis\.com$|firebaseapp\.com$|google\.com$/.test(url.hostname)) return;

  // Librerías externas: primero caché.
  if (CDN.some((p) => req.url.startsWith(p))) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
      return res;
    })));
    return;
  }

  if (url.origin !== location.origin) return;

  // Página: primero red, y si no hay conexión, la copia guardada.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => {
      const copia = res.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copia));
      return res;
    }).catch(() => caches.match("./index.html")));
    return;
  }

  // Archivos de la app: responde desde caché y actualiza en segundo plano.
  e.respondWith(caches.match(req).then((guardado) => {
    const red = fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
      return res;
    }).catch(() => guardado);
    return guardado || red;
  }));
});
