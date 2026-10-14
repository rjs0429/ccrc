// Shows the broker's push notifications. A tap focuses the open app and sends it to the session, or opens it there.
// Every push shows a notification: Safari may cancel the subscription of a web app whose pushes show nothing.

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
  event.waitUntil(self.registration.showNotification(text(msg.title) || "ccrc", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : `${self.location.origin}/`;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      await open.focus().catch(() => {});
      open.postMessage({ t: "navigate", url });
    })(),
  );
});
