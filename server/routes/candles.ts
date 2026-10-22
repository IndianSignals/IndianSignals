import { Router } from "express";
import { z } from "zod";
import type { Candle, ProviderResponse, Timeframe } from "../../shared/market.js";
import { createMarketData } from "../engine/angelMarketData.js";
import { SYMBOL_RE } from "../config/env.js";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D"] as const;

const querySchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(SYMBOL_RE),
  timeframe: z.enum(TIMEFRAMES).default("1H"),
  limit: z.coerce.number().int().min(10).max(4000).default(300),
});

const market = createMarketData();

// tiny cache so refreshes don't hammer Angel One
const cache = new Map<string, { at: number; data: Candle[] }>();
const inflight = new Map<string, Promise<Candle[]>>();   // same request already running => share it (no duplicate Angel calls)
type Snap = Awaited<ReturnType<typeof market.getMarketSnapshot>>;
const snapCache = new Map<string, { at: number; data: Snap }>();
const snapInflight = new Map<string, Promise<Snap>>();
const TTL_MS = 15000;

const router = Router();

router.get("/market/snapshot", async (req, res) => {
  const parsed = z.object({
    symbol: z.string().trim().toUpperCase().regex(SYMBOL_RE),
    timeframe: z.enum(TIMEFRAMES).default("1H"),
  }).safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_query",
        message: "Invalid symbol or timeframe",
      },
    });
    return;
  }

  const started = Date.now();

  try {
        const sKey = `${parsed.data.symbol}|${parsed.data.timeframe}`;
    const sHit = snapCache.get(sKey);
    let data: Snap;
    if (sHit && Date.now() - sHit.at < 10_000) {
      data = sHit.data;
    } else {
      let sp = snapInflight.get(sKey);
      if (!sp) {
        sp = market.getMarketSnapshot(parsed.data.symbol, parsed.data.timeframe).finally(() => { snapInflight.delete(sKey); });
        snapInflight.set(sKey, sp);
      }
      data = await sp;
      snapCache.set(sKey, { at: Date.now(), data });
      if (snapCache.size > 100) snapCache.clear();
    }

    res.json({
      data,
            meta: {
        sourceExchange: "angelone",
        symbol: parsed.data.symbol,
        timeframe: parsed.data.timeframe,
        timestamp: Date.now(),
        latencyMs: Date.now() - started,
      },
    });
  } catch (err) {
    console.error("market snapshot error:", err);

    res.status(502).json({
      error: {
        code: "upstream_error",
        message: "Market data provider unavailable",
      },
    });
  }
});

router.get("/market/depth", async (req, res) => {
  const parsed = z.object({ symbol: z.string().trim().toUpperCase().regex(SYMBOL_RE) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: { code: "invalid_query", message: "Invalid symbol" } }); return; }
  try {
    res.json({ data: await market.getDepth(parsed.data.symbol), meta: { sourceExchange: "angelone", symbol: parsed.data.symbol, timestamp: Date.now() } });
  } catch (err) {
    console.error("depth error:", err);
    res.status(502).json({ error: { code: "upstream_error", message: "Market data provider unavailable" } });
  }
});

router.get("/candles", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_query", message: "Invalid symbol, timeframe or limit" } });
    return;
  }
  const { symbol, timeframe, limit } = parsed.data;
    const fetchLimit = timeframe !== "4H" && limit <= 300 ? 300 : limit;   // small polls (limit 10) reuse the same cached 300 bars
  const key = `${symbol}|${timeframe}|${fetchLimit}`;
  const started = Date.now();

  try {
    const hit = cache.get(key);
    let data: Candle[];
    if (hit && started - hit.at < TTL_MS) {
      data = hit.data;
    } else {
      // MAX_SAFE_INTEGER => still-forming candle is INCLUDED (needed for live chart)
            let p = inflight.get(key);
      if (!p) {
        p = market.getCandles(symbol, timeframe as Timeframe, fetchLimit, Number.MAX_SAFE_INTEGER).finally(() => { inflight.delete(key); });
        inflight.set(key, p);
      }
      data = await p;
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 200) cache.clear();
    }
    data = data.slice(-limit);
    const body: ProviderResponse<Candle[]> = {
      data,
            meta: {
        sourceExchange: "angelone",
        symbol,
        timestamp: Date.now(),
        timeframe: timeframe as Timeframe,
        dataQuality: { status: "fresh", ageMs: 0 },
        latencyMs: Date.now() - started,
      },
    };
    res.json(body);
  } catch (err) {
    console.error("candles error:", err);
    const stale = cache.get(key);
        if (stale) {
      res.json({ data: stale.data.slice(-limit), meta: { sourceExchange: "angelone", symbol, timestamp: Date.now(), timeframe: timeframe as Timeframe, dataQuality: { status: "stale", ageMs: Date.now() - stale.at }, latencyMs: Date.now() - started } });
      return;
    }
    res.status(502).json({ error: { code: "upstream_error", message: "Market data provider unavailable" } });
  }
});

export default router;
