import type { Candle, Timeframe } from "../../shared/market.js";
import { calcIndicators } from "../../shared/indicators.js";
import { CONFIRMATION_TF } from "./marketData.js";
import type { MarketData } from "./marketData.js";
import { createMarketData } from "./angelMarketData.js";

/**
 * Backtest - part 1 of 3: historical data + time-alignment helpers.
 *
 *   part 1  backtestData.ts    (this file) Angel One history, candle windows, NIFTY trend series
 *   part 2  backtest.ts        simulation core (walk candles, build signals, simulate trades)
 *   part 3  backtestReport.ts  statistics + text report, plus the /engine/backtest route
 *
 * Nothing here talks to the database or changes live behaviour.
 */

export const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000,
};

/** Candles the live scanner hands to the strategy (candleLimit in server/index.ts). */
export const WINDOW = 500;
/** Extra candles before the first test bar so SMA200 / ADX / ATR are warm. */
export const WARMUP = 500;
/** Hard cap per series so a typo in ?days= cannot hammer Angel One. */
export const MAX_HISTORY_BARS = 6000;

/** NSE candles per trading day (09:15-15:30). 4H is two bars: 09:15-13:15 and 13:15-15:30. */
const SESSION_BARS: Record<Timeframe, number> = { "1m": 375, "5m": 75, "15m": 25, "30m": 13, "1H": 7, "4H": 2, "1D": 1 };

export type Bias = 1 | -1 | 0;

export interface SymbolHistory {
  symbol: string;
  timeframe: Timeframe;
  confTimeframe: Timeframe | null;
  primary: Candle[];
  confirmation: Candle[] | null;
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function validCandle(c: Candle): boolean {
  return (
    isNum(c.timestamp) && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close) &&
    c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
    c.high >= c.low && c.high >= c.open && c.high >= c.close && c.low <= c.open && c.low <= c.close
  );
}

/** Closed, valid candles from the market-data source (Angel One pages the date windows itself). */
export async function fetchHistory(
  symbol: string, tf: Timeframe, bars: number, now: number, market: MarketData = createMarketData(),
): Promise<Candle[]> {
  const want = Math.min(Math.max(Math.trunc(bars), 1), MAX_HISTORY_BARS);
  const rows = await market.getCandles(symbol, tf, want, now);
  return rows.filter((c) => validCandle(c) && c.timestamp + TF_MS[tf] <= now).slice(-want);
}

/**
 * Primary candles (test bars + warm-up) and the confirmation-timeframe candles that cover the
 * same span. Errors are thrown on purpose: silently dropping the confirmation series would make
 * the backtest score differently from the live scanner.
 */
export async function loadSymbolHistory(
  symbol: string, tf: Timeframe, testBars: number, now: number,
  market: MarketData = createMarketData(),
): Promise<SymbolHistory> {
  const primary = await fetchHistory(symbol, tf, testBars + WARMUP, now, market);
  const confTf = CONFIRMATION_TF[tf];
  let confirmation: Candle[] | null = null;
  if (confTf) {
    const confBars = Math.ceil((primary.length * TF_MS[tf]) / TF_MS[confTf]) + WINDOW + 5;
    confirmation = await fetchHistory(symbol, confTf, confBars, now, market);
  }
  return { symbol, timeframe: tf, confTimeframe: confTf, primary, confirmation };
}

/** Number of test bars for a "last N days" request. */
export const barsForDays = (days: number, tf: Timeframe): number =>
  Math.max(1, Math.min(MAX_HISTORY_BARS - WARMUP, Math.ceil((days * 86_400_000) / TF_MS[tf])));

/** Index of the last candle fully closed at time `t` (timestamp + tfMs <= t), or -1. Candles ascending. */
export function lastClosedIndex(candles: Candle[], tfMs: number, t: number): number {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = candles[mid];
    if (!c) break;
    if (c.timestamp + tfMs <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** The last `size` candles up to and including index `i` - exactly what the live scanner sees. */
export const windowAt = (candles: Candle[], i: number, size: number = WINDOW): Candle[] =>
  candles.slice(Math.max(0, i + 1 - size), i + 1);

/** Confirmation-timeframe window that was already closed at decision time `t`, or null. */
export function confirmationWindow(conf: Candle[] | null, confMs: number, t: number, size: number = WINDOW): Candle[] | null {
  if (!conf) return null;
  const j = lastClosedIndex(conf, confMs, t);
  return j < 0 ? null : conf.slice(Math.max(0, j + 1 - size), j + 1);
}

/** One-trading-day change in percent at candle `i`, derived from candles (the live scanner uses the exchange ticker). */
export function change24hPct(candles: Candle[], i: number, tf: Timeframe): number | null {
  const bars = SESSION_BARS[tf];
  const now = candles[i], then = candles[i - bars];
  if (!now || !then || then.close <= 0) return null;
  return ((now.close - then.close) / then.close) * 100;
}

/** Trend bias used by the index filter: 1 up, -1 down, 0 unclear. Same rule as benchmarkBias() in scanner.ts. */
export function trendBias(candles: Candle[]): Bias {
  const ind = calcIndicators(candles);
  const k = candles[candles.length - 1];
  if (!ind || !k) return 0;
  if (ind.ema20 > ind.ema50 && k.close > ind.ema50) return 1;
  if (ind.ema20 < ind.ema50 && k.close < ind.ema50) return -1;
  return 0;
}

/** Bias after every candle, so the simulator can look it up instead of recomputing indicators per symbol per step. */
export function biasSeries(candles: Candle[]): Bias[] {
  return candles.map((_, i) => (i < 60 ? 0 : trendBias(windowAt(candles, i))));
}

/** Benchmark (NIFTY) bias that was known at time `t` (uses only candles already closed then). */
export function biasAt(series: Bias[], candles: Candle[], tfMs: number, t: number): Bias {
  const i = lastClosedIndex(candles, tfMs, t);
  return i < 0 ? 0 : (series[i] ?? 0);
}
