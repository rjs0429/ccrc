// Shows the broker's push notifications. A tap focuses the open app and sends it to the session, or opens it there.
// Every push shows a notification: Safari may cancel the subscription of a web app whose pushes show nothing, and a
// badge alone does not count as showing something. A push that carries a number puts it on the app icon. Once its
// notification shows, and not before (Chrome leaves out of getNotifications() one shown meanwhile), the notifications
// that no longer count by the sessions the push carries are closed.
//
// It also keeps the app (the page and its files under /assets/), so the app opens while the broker cannot be reached and
// shows the conversations the phone kept. The page comes from the network whenever it answers in time and is not an
// error; /api/ is never touched.

const SHELL = "ccrc-shell-v1";
const PAGE_WAIT_MS = 3500;
// The asset files kept when the page last changed; the next change lets go of those the new page does not name.
const OLDER = "/__ccrc-older-assets";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(keepPage().catch(() => {}));
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys().catch(() => [])) if (name.startsWith("ccrc-") && name !== SHELL) await caches.delete(name).catch(() => {});
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    const net = fetch(req).then((res) => [res, res.ok && !res.redirected && isPage(res) ? res.clone() : undefined]);
    event.waitUntil(net.then(([, copy]) => copy && keepPage(copy)).catch(() => {}));
    event.respondWith(page(net.then(([res]) => res)));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(asset(event));
  }
});

const isPage = (res) => (res.headers.get("content-type") || "").startsWith("text/html");

// The network's page when it comes in time and is not an error, else the page kept, else whatever the network gives.
async function page(net) {
  const late = new Promise((resolve) => setTimeout(resolve, PAGE_WAIT_MS));
  const first = await Promise.race([net.catch(() => undefined), late]);
  if (first && first.ok) return first;
  const kept = await caches.open(SHELL).then((c) => c.match("/"), () => undefined);
  return kept || first || net;
}

// Files under /assets/ carry their content's hash in their names, so a kept one never goes stale. Without a cache to
// keep them in, they come from the network as they would without this worker.
async function asset(event) {
  const cache = await caches.open(SHELL).catch(() => undefined);
  const kept = await cache?.match(event.request, { ignoreVary: true }).catch(() => undefined);
  if (kept) return kept;
  const res = await fetch(event.request);
  if (res.ok && cache) event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
  return res;
}

async function keepPage(res) {
  const cache = await caches.open(SHELL);
  const fresh = res || (await fetch("/", { cache: "no-cache" }));
  if (!fresh.ok || fresh.redirected || !isPage(fresh)) return;
  const html = await fresh.clone().text();
  const old = await cache.match("/");
  const changed = !old || (await old.text()) !== html;
  await cache.put("/", fresh);
  const named = new Set([...html.matchAll(/["'](\/assets\/[^"'?#]+)["']/g)].map((m) => m[1]));
  if (changed) {
    const older = new Set(await cache.match(OLDER).then((r) => (r ? r.json() : []), () => []));
    const held = (await cache.keys()).map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/assets/"));
    for (const p of held) if (older.has(p) && !named.has(p)) await cache.delete(p);
    await cache.put(OLDER, new Response(JSON.stringify(held.filter((p) => named.has(p) || !older.has(p)))));
  }
  for (const p of named) {
    if (await cache.match(p)) continue;
    const r = await fetch(p);
    if (r.ok) await cache.put(p, r);
  }
}

// data.at: when the broker made it, on its clock; data.shown: when it showed, on the phone's, as iOS does not close a
// notification shown moments ago.
self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {}
  const text = (v) => (typeof v === "string" ? v : "");
  const tag = text(msg.tag);
  const at = msg.data && typeof msg.data.at === "number" ? { at: msg.data.at } : {};
  const options = {
    body: text(msg.body),
    data: { url: text(msg.data && msg.data.url) || "/", ...at, shown: Date.now() },
    icon: "/icon-192.png",
    ...(tag ? { tag, renotify: true } : {}),
  };
  const n = typeof msg.badge === "number" && msg.badge >= 0 ? Math.floor(msg.badge) : undefined;
  const shown = self.registration.showNotification(text(msg.title) || "ccrc", options);
  event.waitUntil(Promise.all([shown.then(() => tidy({ tag, data: options.data }, attention(msg.attention))), n === undefined ? undefined : setBadge(n)]));
});

// A session's notification, tagged `<session>:<kind>`, counts while the broker counts the session for its kind: a notice
// of what went on in it while it is unread, a request while one waits. Any one goes once a newer one of its tag shows.
// The same rule as settled() in broker/src/push/attention.ts, which the phone app uses.
const NOTICES = ["end", "claude", "file"];
const REQUESTS = ["permission", "question", "plan", "dialog", "elicitation"];
const madeAt = (n) => (n.data && typeof n.data.at === "number" ? n.data.at : 0);

function settled(n, list, state) {
  if (n.tag && list.some((m) => m.tag === n.tag && madeAt(m) > madeAt(n))) return true;
  if (!state || madeAt(n) >= state.at) return false;
  const i = n.tag.indexOf(":");
  if (i < 1) return false;
  const session = n.tag.slice(0, i);
  const kind = n.tag.slice(i + 1);
  if (NOTICES.includes(kind)) return !state.unseen.includes(session);
  if (REQUESTS.includes(kind)) return !state.waiting.includes(session);
  return false;
}

function attention(v) {
  const ids = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");
  return v && typeof v.at === "number" && ids(v.unseen) && ids(v.waiting) ? v : undefined;
}

// Never rejects: a push event that fails may count as one that showed nothing, which can cost the subscription.
async function tidy(shown, state) {
  try {
    const list = await self.registration.getNotifications();
    for (const n of list) if (settled(n, [...list, shown], state)) n.close();
  } catch {}
}

// Where the Badging API is missing or refuses, the notification still shows.
async function setBadge(n) {
  try {
    await (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge());
  } catch {}
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : `${self.location.origin}/`;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(tapped(url));
      await open.focus().catch(() => {});
      open.postMessage({ t: "navigate", url });
    })(),
  );
});

// An app opened from a notification is told so in its address, as an open app is by the navigate message.
function tapped(url) {
  const u = new URL(url);
  u.searchParams.set("tap", "1");
  return u.href;
}
