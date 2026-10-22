/* IndianSignals alerts: bell button -> phone notification + beep + vibration for new signals. */
(function () {
  "use strict";
  var API = "https://indiansignals0.onrender.com/api/v1";
  var KEY = "is_push_on";
  var supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  /* ---------- beep + vibrate (used when the page is open) ---------- */
  var ac = null;
  function unlock() { try { var C = window.AudioContext || window.webkitAudioContext; if (!C) return; ac = ac || new C(); if (ac.state === "suspended") ac.resume(); } catch (e) { /* ignore */ } }
  ["click", "touchstart", "keydown"].forEach(function (ev) { window.addEventListener(ev, unlock, { passive: true }); });
  function beep() {
    try {
      unlock(); if (!ac) return;
      [0, 0.28, 0.56].forEach(function (d, i) {
        var o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + d;
        o.type = "square"; o.frequency.value = i === 2 ? 1175 : 880;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.24);
      });
    } catch (e) { /* sound blocked */ }
  }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 700]); } catch (e) { /* ignore */ } }

  /* ---------- button ---------- */
  var btn, panel, msg;
  function css() {
    var s = document.createElement("style");
    s.textContent =
      "#isBell{position:fixed;right:6px;bottom:84px;opacity:.8;z-index:99998;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:#111827;color:#fff;font-size:22px;line-height:1;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer}" +
      "#isBell.on{background:#16a34a}" +
      "#isPanel{position:fixed;right:14px;bottom:140px;z-index:99998;background:#111827;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:12px;width:230px;font:14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none}" +
      "#isPanel button{display:block;width:100%;margin:6px 0 0;padding:9px;border-radius:8px;border:0;background:#2563eb;color:#fff;font-size:14px}" +
      "#isPanel button.red{background:#dc2626}#isPanel small{display:block;margin-top:8px;color:#9ca3af}";
    document.head.appendChild(s);
  }
    var hideT = null;
  function closePanel() { if (panel) panel.style.display = "none"; }
  function setMsg(t, autoClose) {
    if (msg) msg.textContent = t || "";
    clearTimeout(hideT);
    if (autoClose) hideT = setTimeout(closePanel, 2500);   // panel hides itself after the action
  }
  function render(on) {
    btn.textContent = on ? "🔔" : "🔕"; btn.className = on ? "on" : "";
    btn.title = on ? "Signal alerts ON" : "Turn on signal alerts";
    panel.innerHTML = on
      ? '<b>Signal alerts ON</b><button id="isTest">Send test alert</button><button id="isOff" class="red">Turn off</button><small id="isMsg"></small>'
      : '<b>Signal alerts OFF</b><button id="isOn">Turn on (beep + vibration)</button><small id="isMsg"></small>';
    msg = panel.querySelector("#isMsg");
    var a = panel.querySelector("#isOn"), t = panel.querySelector("#isTest"), o = panel.querySelector("#isOff");
    if (a) a.onclick = enable; if (t) t.onclick = test; if (o) o.onclick = disable;
  }

  /* ---------- push ---------- */
  function keyBytes(b64) {
    var p = "=".repeat((4 - (b64.length % 4)) % 4), s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  var sameKey = function (sub, key) {
    var k = sub.options && sub.options.applicationServerKey; if (!k) return true;
    var u = new Uint8Array(k), v = keyBytes(key); if (u.length !== v.length) return false;
    for (var i = 0; i < u.length; i++) if (u[i] !== v[i]) return false; return true;
  };
  function post(path, body) {
    return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  async function ensure() {
    var reg = await navigator.serviceWorker.register("sw.js?api=" + encodeURIComponent(API));
    await navigator.serviceWorker.ready;
    var kr = await fetch(API + "/push/key"); if (!kr.ok) throw new Error("Server is waking up, try again in 30 seconds");
    var key = (await kr.json()).key;
    var sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    var r = await post("/push/subscribe", { endpoint: sub.endpoint }); if (!r.ok) throw new Error("Server refused (HTTP " + r.status + ")");
    return sub;
  }
  async function enable() {
    unlock(); setMsg("Please wait...");
    try {
      if (!supported) throw new Error("This browser does not support alerts. On iPhone: Add to Home Screen first.");
      var p = await Notification.requestPermission();
      if (p !== "granted") throw new Error("Notifications are blocked. Allow them in browser site settings.");
      await ensure();
      try { localStorage.setItem(KEY, "1"); } catch (e) { /* ignore */ }
      render(true); setMsg("Done. Alerts are ON.", true); beep(); buzz();
    } catch (e) { setMsg(e && e.message ? e.message : "Failed"); }
  }
  async function test() {
    unlock(); setMsg("Sending...");
    try {
      var sub = await ensure(), r = await post("/push/test", { endpoint: sub.endpoint });
      setMsg(r.ok ? "Sent. Lock the phone and wait a few seconds." : r.status === 429 ? "Wait 15 seconds." : "Failed (HTTP " + r.status + ")", true);
    } catch (e) { setMsg(e && e.message ? e.message : "Failed"); }
  }
  async function disable() {
    try {
      var reg = await navigator.serviceWorker.getRegistration(), sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(function () {}); await sub.unsubscribe(); }
    } catch (e) { /* ignore */ }
        try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    render(false); closePanel();
  }

  /* ---------- start ---------- */
  function start() {
    css();
    btn = document.createElement("button"); btn.id = "isBell"; btn.type = "button";
    panel = document.createElement("div"); panel.id = "isPanel";
    document.body.appendChild(panel); document.body.appendChild(btn);
    btn.onclick = function () { unlock(); panel.style.display = panel.style.display === "block" ? "none" : "block"; };
    document.addEventListener("click", function (e) { if (panel.style.display === "block" && !panel.contains(e.target) && e.target !== btn) closePanel(); });   // tap outside = close
    var on = false; try { on = localStorage.getItem(KEY) === "1" && supported && Notification.permission === "granted"; } catch (e) { on = false; }
    render(on);
    if (on) ensure().catch(function () { /* will retry next visit */ });   // keeps the server list fresh
    if (supported) navigator.serviceWorker.addEventListener("message", function (ev) {
      if (ev.data && ev.data.type === "is-alert") { beep(); buzz(); if (window.showToast) window.showToast(ev.data.title + " " + ev.data.body); }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
