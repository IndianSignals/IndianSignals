import { Router } from "express";
import { addSub, endpointHash, hasSub, isPushEndpoint, latestFor, notifyOne, pushReady, removeSub, vapidPublicKey } from "../engine/webpush.js";

const router = Router();
const lastTest = new Map<string, number>();

router.get("/push/key", (_req, res) => {
  if (!pushReady()) { res.status(503).json({ error: "push not ready" }); return; }
  res.json({ key: vapidPublicKey() });
});

router.post("/push/subscribe", async (req, res) => {
  const endpoint: unknown = req.body?.endpoint;
  if (!isPushEndpoint(endpoint)) { res.status(400).json({ error: "bad endpoint" }); return; }
  res.json({ ok: await addSub(endpoint) });
});

router.post("/push/unsubscribe", async (req, res) => {
  const endpoint: unknown = req.body?.endpoint;
  if (!isPushEndpoint(endpoint)) { res.status(400).json({ error: "bad endpoint" }); return; }
  await removeSub(endpoint);
  res.json({ ok: true });
});

router.post("/push/test", async (req, res) => {
  const endpoint: unknown = req.body?.endpoint;
  if (!isPushEndpoint(endpoint) || !(await hasSub(endpoint))) { res.status(400).json({ error: "subscribe first" }); return; }
  const now = Date.now();
  if (now - (lastTest.get(endpoint) ?? 0) < 15_000) { res.status(429).json({ error: "wait a few seconds" }); return; }
  lastTest.set(endpoint, now);
  if (lastTest.size > 1000) lastTest.clear();
  await notifyOne(endpoint, "🔔 Test alert", "IndianSignals alerts are working. You will get beep + vibration on new signals.");
  res.json({ ok: true });
});

// Called by the service worker after a push (no payload): which alerts has this device not shown yet?
router.get("/push/latest", (req, res) => {
  const since = Number(req.query.since) || 0;
  const device = String(req.query.e ?? "");
  res.setHeader("Cache-Control", "no-store");
  res.json({ items: latestFor(since, device) });
});

export { endpointHash };
export default router;
