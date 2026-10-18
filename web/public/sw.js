// Shows the broker's push notifications. A tap focuses the open app and sends it to the session, or opens it there.
// Every push shows a notification: Safari may cancel the subscription of a web app whose pushes show nothing, and a
// badge alone does not count as showing something. A push that carries a number puts it on the app icon.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {}
  const text = (v) => (typeof v === "string" ? v : "");
  const tag = text(msg.tag);
  const options = {
    body: text(msg.body),
    data: { url: text(msg.data && msg.data.url) || "/" },
    icon: "/icon-192.png",
    ...(tag ? { tag, renotify: true } : {}),
  };
  const n = typeof msg.badge === "number" && msg.badge >= 0 ? Math.floor(msg.badge) : undefined;
  event.waitUntil(Promise.all([self.registration.showNotification(text(msg.title) || "ccrc", options), n === undefined ? undefined : setBadge(n)]));
});

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
