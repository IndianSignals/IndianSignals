import { useEffect, useMemo, useState } from "react";
import { fetchCandles, fetchMarketSnapshot, type MarketSnapshotResponse } from "./marketApi.js";
import type { CSSProperties, ReactElement } from "react";
import type { Timeframe } from "../../shared/market.js";
import { tokens } from "../../shared/designTokens.js";
import { isMarketOpen, istParts } from "../../shared/indianMarket.js";
import { MarketChart } from "../components/MarketChart/index.js";
import { DEFAULT_INDICATORS, INDICATORS, SUB_PANE_HEIGHT, buildOverlays, subPaneCount } from "../components/MarketChart/indicatorOverlays.js";
import type { IndicatorKey } from "../components/MarketChart/indicatorOverlays.js";
import { TIMEFRAMES } from "./timeframes.js";
import { displaySymbol, isIndexSymbol } from "./symbol.js";
import { useMarketCandles } from "./useMarketCandles.js";
import { useLiveCandles } from "./useLiveCandles.js";
import { ChartClock } from "./ChartClock.js";
import { validateCandles } from "./validateCandles.js";
import { ChartDrawingTools } from "../components/MarketChart/drawings/ChartDrawingTools.js";
import type { MarketChartApi } from "../components/MarketChart/index.js";

export const EMPTY_MESSAGE = "No market data available for this symbol/timeframe.";

const c = tokens.color;
const bar: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "8px 10px", minWidth: 0 };
const tfBtn = (active: boolean): CSSProperties => ({
  minHeight: 26, minWidth: 34, padding: "0 7px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 11, fontWeight: 600, lineHeight: 1,
  color: active ? c.text.inverse : c.text.primary,
  background: active ? c.accent.primary : c.bg.elevated,
  border: `1px solid ${active ? c.accent.primary : c.border.default}`,
});

/** NSE prices: Indian digit grouping, always 2 decimals (tick = 0.05). */
const fmtPx = (n: number): string => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Traded value in INR as lakh / crore, e.g. "₹1,245.60 Cr". */
const fmtValue = (n: number): string =>
  n >= 1e7 ? `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`
  : n >= 1e5 ? `₹${(n / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`
  : `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Previous-session close, from daily candles (refreshed every 60 s). With the live candle close it gives the
 * header's "change vs previous close". If today's daily bar exists, or the market is closed, the bar before the
 * latest one is the reference; during market hours without today's bar the latest bar is yesterday's close.
 */
function usePrevClose(symbol: string | null): number | null {
  const [prev, setPrev] = useState<number | null>(null);
  useEffect(() => {
    setPrev(null);
    if (!symbol) return;
    const ctrl = new AbortController();
    const load = (): void => {
      fetchCandles(symbol, "1D", 10, ctrl.signal)
        .then((rows) => {
          const { candles } = validateCandles(rows);
          const last = candles.at(-1);
          if (!last) return;
          const hasToday = istParts(last.timestamp).ymd === istParts(Date.now()).ymd;
          const ref = hasToday || !isMarketOpen(Date.now()) ? candles.at(-2) : last;
          if (ref && ref.close > 0) setPrev(ref.close);
        })
        .catch(() => { /* keep the last value; the header just hides the change until the next refresh */ });
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => { ctrl.abort(); window.clearInterval(id); };
  }, [symbol]);
  return prev;
}

/** Chart height follows the viewport class without hardcoding a width; the chart itself resizes to its container. */
function useChartHeight(): number {
  const query = "(max-width: 640px)";
  const [small, setSmall] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (): void => setSmall(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return small ? 300 : 440;
}

export interface MarketSymbolViewProps {
  /** Exchange symbol from normalizeSymbol(), or null when the route symbol is not a tradable pair. */
  symbol: string | null;
  rawSymbol: string;
  timeframe: Timeframe;
  onTimeframeChange(tf: Timeframe): void;
}

/**
 * The chart stays mounted across symbol/timeframe changes (one Lightweight Charts instance);
 * only its data changes. Chart height is fixed, so loading/empty/error never shift the layout.
 */
export function MarketSymbolView({ symbol, rawSymbol, timeframe, onTimeframeChange }: MarketSymbolViewProps): ReactElement {
  const { status, candles: history, error, retry } = useMarketCandles(symbol, timeframe);
  const { candles, status: liveStatus } = useLiveCandles(symbol, timeframe, history, status === "ready", retry);
  const baseHeight = useChartHeight();
  const [chartApi, setChartApi] = useState<MarketChartApi | null>(null);
  const [snapshot, setSnapshot] = useState<MarketSnapshotResponse | null>(null);
  const [snapshotStatus, setSnapshotStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [active, setActive] = useState<ReadonlySet<IndicatorKey>>(() => new Set(DEFAULT_INDICATORS));
  const overlays = useMemo(() => buildOverlays(active), [active]);
  const height = baseHeight + subPaneCount(active) * (SUB_PANE_HEIGHT + 8);
  const toggle = (k: IndicatorKey): void => setActive((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    const label = symbol ? displaySymbol(symbol) : rawSymbol;
  const open24 = usePrevClose(symbol);
  const isIndex = symbol !== null && isIndexSymbol(symbol);
  const lastPrice = candles.at(-1)?.close ?? null;
  const chgPts = lastPrice !== null && open24 !== null ? lastPrice - open24 : null;
  const chgPct = chgPts !== null && open24 !== null ? (chgPts / open24) * 100 : null;
  const up = chgPts === null || chgPts >= 0;
  const chgColor = chgPts === null ? c.text.primary : up ? c.positive.base : c.negative.base;

  useEffect(() => {
    if (!symbol) {
      setSnapshot(null);
      return;
    }

    const controller = new AbortController();
    let activeRequest = true;

    setSnapshotStatus("loading");

    fetchMarketSnapshot(symbol, timeframe, controller.signal)
      .then((data) => {
        if (!activeRequest) return;
        setSnapshot(data);
        setSnapshotStatus("ready");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || !activeRequest) return;
        console.error("market snapshot error:", err);
        setSnapshotStatus("error");
      });

    return () => {
      activeRequest = false;
      controller.abort();
    };
  }, [symbol, timeframe]);

  const formatNumber = (value: number | null, digits = 2): string =>
    value === null || !Number.isFinite(value)
      ? "Unavailable"
      : value.toLocaleString(undefined, {
          maximumFractionDigits: digits,
        });

  const formatPercent = (value: number | null): string =>
    value === null || !Number.isFinite(value)
      ? "Unavailable"
      : `${value.toFixed(2)}%`;

  return (
    <section className="chartbox" aria-label={`${label} market chart`} style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", padding: "8px 10px 2px", minWidth: 0 }}>
        <strong style={{ fontSize: 15, letterSpacing: 0.2 }}>{label}</strong>
        <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: chgColor }}>
          {lastPrice === null ? "—" : `${isIndex ? "" : "₹"}${fmtPx(lastPrice)}`}
        </span>
        {chgPts !== null && chgPct !== null && (
          <span
            title="Change vs previous close"
            style={{
              fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: chgColor,
              background: up ? c.positive.subtle : c.negative.subtle, borderRadius: 999, padding: "2px 8px",
            }}
          >
            {up ? "▲ +" : "▼ −"}{fmtPx(Math.abs(chgPts))} ({up ? "+" : "−"}{Math.abs(chgPct).toFixed(2)}%)
          </span>
        )}
        {liveStatus !== "off" && (
          <span role="status" style={{ marginLeft: "auto", fontSize: 11, color: liveStatus === "live" ? c.positive.base : c.text.muted }}>
            {liveStatus === "live" ? "● Live" : liveStatus === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        )}
        {status === "error" && (
          <button type="button" style={{ ...tfBtn(false), marginLeft: "auto" }} onClick={retry}>Retry</button>
        )}
      </div>
      <div style={{ ...bar, gap: 4, padding: "4px 10px 6px" }}>
        <div role="group" aria-label="Timeframe" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {TIMEFRAMES.map((tf) => (
            <button key={tf} type="button" aria-pressed={tf === timeframe} style={tfBtn(tf === timeframe)} onClick={() => tf !== timeframe && onTimeframeChange(tf)}>
              {tf}
            </button>
          ))}
        </div>
        <ChartClock timeframe={timeframe} />
      </div>
      
            {snapshot && snapshotStatus === "ready" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            order: 2,
            gap: 8,
            padding: "8px 10px",
          }}
          aria-label="Market analysis data"
        >
          

          <div className="data-card" style={snapshot.derivatives.fundingRate === null ? { display: "none" } : undefined}>
            <label>Funding</label>
            <strong>
              {snapshot.derivatives.fundingRate === null
                ? "Unavailable"
                : `${(snapshot.derivatives.fundingRate * 100).toFixed(4)}%`}
            </strong>
          </div>

          <div className="data-card" style={snapshot.derivatives.oiChangePct === null ? { display: "none" } : undefined}>
            <label>Open Interest</label>
            <strong>{formatPercent(snapshot.derivatives.oiChangePct)}</strong>
          </div>

          <div className="data-card" style={snapshot.derivatives.longShortRatio === null ? { display: "none" } : undefined}>
            <label>Long / Short</label>
            <strong>
              {formatNumber(snapshot.derivatives.longShortRatio, 2)}
            </strong>
          </div>

          <div className="data-card" style={snapshot.derivatives.topTraderRatio == null ? { display: "none" } : undefined}>
            <label>Top Traders L/S</label>
            <strong>{formatNumber(snapshot.derivatives.topTraderRatio ?? null, 2)}</strong>
          </div>

          <div className="data-card" style={snapshot.derivatives.takerBuySellRatio == null ? { display: "none" } : undefined}>
            <label>Taker Buy/Sell</label>
            <strong>{formatNumber(snapshot.derivatives.takerBuySellRatio ?? null, 2)}</strong>
          </div>

          <div className="data-card" style={snapshot.orderBook.imbalance === null ? { display: "none" } : undefined}>
            <label>Order Book</label>
            <strong>
              {snapshot.orderBook.imbalance === null
                ? "Unavailable"
                : `${snapshot.orderBook.imbalance >= 0 ? "Bids +" : "Asks +"}${Math.abs(snapshot.orderBook.imbalance * 100).toFixed(0)}%`}
            </strong>
          </div>

          
        </div>
      )}

      {snapshotStatus === "error" && (
        <div
          role="status"
          style={{
            padding: "8px 10px",
            fontSize: 12,
            order: 2,
            color: c.text.muted,
          }}
        >
          Market-analysis data is temporarily unavailable. The chart remains available.
        </div>
      )}

      <div style={{ order: 1, minWidth: 0 }}>
      <ChartDrawingTools
        api={chartApi}
        symbol={label}
        timeframe={timeframe}
        indicators={{
          items: INDICATORS.map((i) => ({ key: i.key, label: i.label, active: active.has(i.key) })),
          onToggle: (k) => { const hit = INDICATORS.find((i) => i.key === k); if (hit) toggle(hit.key); },
        }}
      >
        <MarketChart
          symbol={label}
          timeframe={timeframe}
          candles={candles}
          loading={status === "loading"}
          error={status === "error" ? error : null}
          height={height}
          overlays={overlays}
          onReady={setChartApi}
        />
      </ChartDrawingTools>
      </div>
    </section>
  );
}
