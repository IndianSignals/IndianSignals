import type { Candle, Timeframe } from "../../shared/market.js";
import { IST_OFFSET_MS, MARKET_CLOSE_MIN, MARKET_OPEN_MIN, isMarketOpen, tradingMsBetween } from "../../shared/indianMarket.js";

const DAY_MS = 86_400_000;

/**
 * Length of one bar in NSE trading minutes. Bars start at 09:15 IST. The 4H grid is 09:15-13:15 and
 * 13:15-15:30 (the second bar is short); a 1D bar is the whole 375-minute session.
 */
export const BAR_MIN: Record<Timeframe, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1H": 60, "4H": 240, "1D": MARKET_CLOSE_MIN - MARKET_OPEN_MIN,
};
export const BAR_MS: Record<Timeframe, number> = {
  "1m": BAR_MIN["1m"] * 60_000, "5m": BAR_MIN["5m"] * 60_000, "15m": BAR_MIN["15m"] * 60_000, "30m": BAR_MIN["30m"] * 60_000,
  "1H": BAR_MIN["1H"] * 60_000, "4H": BAR_MIN["4H"] * 60_000, "1D": BAR_MIN["1D"] * 60_000,
};

/** Milliseconds until the current NSE bar closes, or null while the market is closed. */
export function candleLeftMs(now: number, tf: Timeframe): number | null {
  if (!isMarketOpen(now)) return null;
  const nowMin = ((now + IST_OFFSET_MS) % DAY_MS) / 60_000;
  const len = BAR_MIN[tf];
  const idx = Math.floor((nowMin - MARKET_OPEN_MIN) / len);
  const end = Math.min(MARKET_OPEN_MIN + (idx + 1) * len, MARKET_CLOSE_MIN);
  return Math.max(0, (end - nowMin) * 60_000);
}

/**
 * Pure merge: replace the forming bar, or append a newer one. Older ticks are ignored.
 * `gap` means bars were missed: it is measured in NSE trading time, so the night, the weekend
 * or a holiday between two sessions is not a gap.
 */
export function mergeLive(base: readonly Candle[], tick: Candle, periodMs: number, max = 1000): { candles: readonly Candle[]; gap: boolean } {
  const last = base[base.length - 1];
  if (!last || tick.timestamp < last.timestamp) return { candles: base, gap: false };
  if (tick.timestamp === last.timestamp) return { candles: [...base.slice(0, -1), tick], gap: false };
  const gap = tradingMsBetween(last.timestamp, tick.timestamp) > periodMs * 1.5;
  const next = [...base, tick];
  return { candles: next.length > max ? next.slice(-max) : next, gap };
}
