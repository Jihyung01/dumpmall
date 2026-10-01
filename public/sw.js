/* Only public static assets are cached. Auth, API, messages and user HTML always use the network. */
const CACHE = "dumpingmall-public-v5";
const OFFLINE = "/offline.html";
const CORE = [
  OFFLINE,
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((k) => k.startsWith("dumpingmall-public-") && k !== CACHE)
              .map((k) => caches.delete(k)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/sign-in") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/signin-") ||
    url.pathname.startsWith("/signout-") ||
    url.pathname === "/callback"
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(OFFLINE);
        // Static hosting redirects .html to a clean URL. Navigation requests
        // cannot consume a redirected cached Response; normalize its body.
        if (cached)
          return new Response(cached.body, {
            status: 200,
            headers: {
              "Content-Type": "text/html;charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        return new Response("오프라인입니다. 연결 후 다시 시도해 주세요.", {
          status: 503,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }),
    );
    return;
  }
  if (
    url.pathname.startsWith("/images/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.svg"
  )
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic")
          await cache.put(request, response.clone());
        return response;
      }),
    );
});

self.addEventListener("push", (event) => {
  let data = { title: "덤핑몰", body: "새 알림이 있습니다.", url: "/?view=trades&tab=alerts" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || data.kind || "dumpmall",
      renotify: true,
      data: { url: data.url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
self.addEventListener("pushsubscriptionchange", (event) => {
  const options = event.oldSubscription?.options;
  if (!options?.applicationServerKey) return;
  event.waitUntil(
    self.registration.pushManager.subscribe(options).then((subscription) => {
      const json = subscription.toJSON();
      return fetch("/api/market", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dumping-Client": "1" },
        body: JSON.stringify({ action: "push_subscribe", subscription: { endpoint: json.endpoint, keys: json.keys } }),
      });
    }).catch(() => {}),
  );
});
