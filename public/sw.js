/* IndianSignals service worker: shows signal alerts with vibration, even when the site is closed. */
const API = new URL(self.location.href).searchParams.get("api") || "https://indiansignals0.onrender.com/api/v1";
const VIBRATE = [400, 150, 400, 150, 700];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function getSince() {
  try { const r = await (await caches.open("is-meta")).match("/since"); return r ? Number(await r.text()) || 0 : 0; } catch (_) { return 0; }
}
async function setSince(n) {
  try { await (await caches.open("is-meta")).put("/since", new Response(String(n))); } catch (_) { /* ignore */ }
}
async function deviceId() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return "";
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sub.endpoint));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch (_) { return ""; }
}

async function onPush() {
  let items = [];
  try {
    const since = await getSince(), e = await deviceId();
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(API + "/push/latest?since=" + since + "&e=" + e, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    items = ((await r.json()).items) || [];
  } catch (_) { /* server asleep or offline: show a generic alert below */ }
  if (items.length === 0) items = [{ id: 0, title: "📈 New signal", body: "Open IndianSignals to see it." }];
  let maxId = 0;
  for (const it of items) {
    maxId = Math.max(maxId, it.id || 0);
    await self.registration.showNotification(it.title, {
      body: it.body, tag: it.id ? "is-" + it.id : "is-generic", renotify: true,
      vibrate: VIBRATE, requireInteraction: true, data: { url: self.registration.scope },
    });
  }
  if (maxId) await setSince(maxId);
  // If the site is open, let the page play the beep too.
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of wins) w.postMessage({ type: "is-alert", title: items[items.length - 1].title, body: items[items.length - 1].body });
}

self.addEventListener("push", (e) => e.waitUntil(onPush()));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
