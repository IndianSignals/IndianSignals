import { describe, expect, it } from "vitest";
import { BENCHMARK_SYMBOL, indexFilterMode, tradingMsBetween } from "../shared/indianMarket.js";
import { fetchHistory, change24hPct } from "../server/engine/backtestData.js";
import type { MarketData } from "../server/engine/marketData.js";
import type { Candle } from "../shared/market.js";

const ist = (y: number, m: number, d: number, hh: number, mm: number): number => Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3_600_000;
const MIN = 60_000;

describe("tradingMsBetween (NSE trading time only)", () => {
  it("Friday 15:15 -> Monday 09:20 is 20 trading minutes", () => {
    expect(tradingMsBetween(ist(2026, 10, 16, 15, 15), ist(2026, 10, 19, 9, 20))).toBe(20 * MIN);
  });
  it("a holiday adds no trading time", () => {
    const env = { NSE_HOLIDAYS: "2026-10-19" };
    expect(tradingMsBetween(ist(2026, 10, 16, 15, 15), ist(2026, 10, 19, 9, 20), env)).toBe(15 * MIN);
  });
  it("inside one session it is plain elapsed time, and never negative", () => {
    expect(tradingMsBetween(ist(2026, 10, 19, 10, 0), ist(2026, 10, 19, 11, 0))).toBe(60 * MIN);
    expect(tradingMsBetween(ist(2026, 10, 19, 11, 0), ist(2026, 10, 19, 10, 0))).toBe(0);
  });
});

describe("index filter", () => {
  it("INDEX_FILTER wins, BTC_FILTER is the fallback, default is strict", () => {
    expect(indexFilterMode({ INDEX_FILTER: "Soft", BTC_FILTER: "false" })).toBe("soft");
    expect(indexFilterMode({ BTC_FILTER: "false" })).toBe("false");
    expect(indexFilterMode({})).toBe("strict");
    expect(BENCHMARK_SYMBOL).toBe("NIFTY");
  });
});

describe("backtest history from the market-data source", () => {
  const T = ist(2026, 10, 14, 9, 15);
  const c = (i: number, over: Partial<Candle> = {}): Candle => ({ timestamp: T + i * 3_600_000, open: 100, high: 101, low: 99, close: 100, volume: 10, ...over });
  const market = (rows: Candle[]): MarketData => ({
    getCandles: async () => rows,
    getTicker24h: async () => ({ change24hPct: 0, volume24h: 0 }),
    getDerivatives: async () => ({ fundingRate: null, oiChangePct: null, longShortRatio: null, bookImbalance: null }),
    getMarketSnapshot: async () => { throw new Error("unused"); },
  });
  it("drops the forming candle and invalid rows, keeps the last N", async () => {
    const rows = [c(0), c(1), c(2, { high: 90 }), c(3), c(4)];
    const now = T + 4 * 3_600_000 + 1000; // candle 4 is still forming
    const out = await fetchHistory("RELIANCE", "1H", 2, now, market(rows));
    expect(out.map((x) => x.timestamp)).toEqual([T + 1 * 3_600_000, T + 3 * 3_600_000]);
  });
  it("one-day change looks back one trading session, not 24 clock hours", () => {
    const rows = Array.from({ length: 20 }, (_, i) => c(i, { close: 100 + i }));
    expect(change24hPct(rows, 10, "1H")).toBeCloseTo(((110 - 103) / 103) * 100, 8); // 7 bars per NSE day
  });
});
