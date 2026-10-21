import { Router } from "express";
import { createMarketData, ProviderError } from "../engine/angelMarketData.js";
import { SYMBOL_RE } from "../config/env.js";

/** Live last-traded prices (INR) for the Recent Signals cards. The server calls Angel One; the page reads them here. */

const TTL_MS = 3000;
const MAX_SYMBOLS = 50;

type PriceMap = Record<string, number>;
type Extras = ReturnType<ReturnType<typeof createMarketData>["quoteExtras"]>;
const STALE_MAX_MS = 60_000;   // an older price is never served as if it were live: the page shows "unavailable" instead of yesterday's price
const cache = new Map<string, { at: number; data: PriceMap; q: Extras }>();

const router = Router();

router.get("/prices", async (req, res) => {
  const wanted = [...new Set(String(req.query.symbols ?? "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => SYMBOL_RE.test(s)))].slice(0, MAX_SYMBOLS);
  if (wanted.length === 0) {
    res.status(400).json({ error: { code: "invalid_query", message: "Pass ?symbols=RELIANCE,TCS" } });
    return;
  }
  const key = wanted.join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.json({ data: hit.data, q: hit.q, meta: { sourceExchange: "angelone", timestamp: hit.at } });
    return;
  }
  try {
        const md = createMarketData();
    const data = await md.lastPrices(wanted);
    const q = md.quoteExtras(wanted);
    if (Object.keys(data).length === 0) throw new Error("no prices returned");
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 100) cache.clear();
    res.json({ data, meta: { sourceExchange: "angelone", timestamp: Date.now() } });
  } catch (err) {
    console.error("prices error:", err);
    if (hit) {
      res.json({ data: hit.data, meta: { sourceExchange: "angelone", timestamp: hit.at, stale: true } });
      return;
    }
    const pe = err instanceof ProviderError ? err : null;
    res.status(502).json({ error: { code: pe ? pe.category.toLowerCase() : "upstream_error", message: pe ? pe.message : "Price provider unavailable", providerCode: pe?.code } });
  }
});

export default router;
