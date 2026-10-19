import type { Candle, Timeframe } from "../../shared/market.js";
import type { DerivativesInput } from "../../shared/scoring.js";

/** What the scanner needs from a market-data source. Swap this for another exchange or a mock. */
export interface Ticker24h { change24hPct: number; volume24h: number }
export interface OrderBookSnapshot {
  bidVolume: number | null;
  askVolume: number | null;
  imbalance: number | null;
  spread: number | null;
  midpoint: number | null;
}

export interface MarketSnapshot {
  ticker: Ticker24h;
  derivatives: DerivativesInput;
  orderBook: OrderBookSnapshot;
  timestamp: number;
}

/** Execution-quality hard filters. OFF unless HARD_FILTERS=true. Live scanner only (not replayed in the backtest). */
export interface HardFilterConfig {
  enabled: boolean;
  /** Block when (ask - bid) / mid exceeds this percent. */
  maxSpreadPct: number;
  /** Block when today's traded value (INR) is below this. 0 = check off. The field and MIN_VOLUME_24H_USD keep their old names. */
  minVolume24hUsd: number;
  /** Block when the market snapshot is older than this. */
  maxDataAgeMs: number;
}

export function loadHardFilterConfig(env: NodeJS.ProcessEnv = process.env): HardFilterConfig {
  const n = (raw: string | undefined, d: number): number => {
    const v = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    enabled: ["1", "true", "yes"].includes((env.HARD_FILTERS ?? "").toLowerCase()),
    maxSpreadPct: n(env.MAX_SPREAD_PCT, 0.1),
    minVolume24hUsd: n(env.MIN_VOLUME_24H_USD, 0),
    maxDataAgeMs: n(env.MAX_DATA_AGE_MS, 15_000),
  };
}

/** Returns a block reason, or null when the trade may go ahead. Missing data blocks (fail closed) when enabled. */
export function checkHardFilters(snap: MarketSnapshot | null, now: number, cfg: HardFilterConfig): string | null {
  if (!cfg.enabled) return null;
  if (!snap) return "Hard filter: market snapshot unavailable";
  const age = now - snap.timestamp;
  if (!(age <= cfg.maxDataAgeMs)) return `Hard filter: market data is ${Math.round(age / 1000)}s old (max ${cfg.maxDataAgeMs / 1000}s)`;
  const { spread, midpoint } = snap.orderBook;
  if (spread === null || midpoint === null || !(midpoint > 0) || !(spread >= 0)) return "Hard filter: order-book spread unavailable";
  const pct = (spread / midpoint) * 100;
  if (pct > cfg.maxSpreadPct) return `Hard filter: spread ${pct.toFixed(3)}% is above ${cfg.maxSpreadPct}%`;
  if (cfg.minVolume24hUsd > 0) {
    const v = snap.ticker.volume24h;
    if (!(v > 0)) return "Hard filter: 24h volume unavailable"; // the snapshot reports 0 when the ticker call failed
    if (v < cfg.minVolume24hUsd) return `Hard filter: 24h volume ${Math.round(v)} is below ${cfg.minVolume24hUsd}`;
  }
  return null;
}

export interface MarketData {
  /** CLOSED candles only, oldest first. `now` decides which candle is still forming. */
  getCandles(symbol: string, tf: Timeframe, limit: number, now: number, includeForming?: boolean): Promise<Candle[]>;
  getTicker24h(symbol: string): Promise<Ticker24h>;
  /** Each field is null when its endpoint failed or is unavailable. */
  getDerivatives(symbol: string, tf: Timeframe): Promise<DerivativesInput>;
  /** Combined real-time market-analysis snapshot. */
    getMarketSnapshot(symbol: string, tf: Timeframe): Promise<MarketSnapshot>;
  /** NSE data is always the cash segment. */
  marketTypeOf?(symbol: string): "cash";
}

/** Higher timeframe used for confirmation. 1D has none, so it scores 0 and is listed as unavailable. */
export const CONFIRMATION_TF: Record<Timeframe, Timeframe | null> = {
  "1m": "5m", "5m": "15m", "15m": "1H", "30m": "4H", "1H": "4H", "4H": "1D", "1D": null,
};
export const EXECUTION_TF: Record<Timeframe, Timeframe> = {
  "1m": "1m", "5m": "1m", "15m": "1m", "30m": "1m", "1H": "5m", "4H": "15m", "1D": "1H",
};
