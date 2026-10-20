import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle, Timeframe } from "../../shared/market.js";
import { isMarketOpen } from "../../shared/indianMarket.js";
import { fetchCandles } from "./marketApi.js";
import { BAR_MS, mergeLive } from "./nseTime.js";
import { validateCandles } from "./validateCandles.js";

export type LiveStatus = "off" | "connecting" | "live" | "reconnecting" | "closed";

/** Calendar bar length per timeframe; the drawing tools use it for time snapping. (NSE trading lengths live in nseTime.ts.) */
export const PERIOD_MS: Record<Timeframe, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000,
};

/** Angel One has no key-free browser stream, so the page polls our server (it caches /candles for 15 s). */
const POLL_MS = 6_000;
const CLOSED_RECHECK_MS = 30_000;
const TAIL = 10; // newest bars per poll: the forming bar plus the one that just closed

interface Tail { key: string; candles: readonly Candle[] }

/**
 * Keeps the forming candle fresh by polling /candles while the NSE market is open, and merges it into `base`.
 *  - Outside market hours it does not call the server; it only re-checks the clock.
 *  - A failed poll backs off (6 s -> 30 s) and the status reads "reconnecting".
 *  - If bars were missed (gap, measured in trading time), `onGap` is called once so the caller can re-fetch history.
 */
export function useLiveCandles(
  symbol: string | null, timeframe: Timeframe, base: readonly Candle[], enabled: boolean, onGap: () => void,
): { candles: readonly Candle[]; status: LiveStatus } {
  const key = `${symbol ?? ""}|${timeframe}`;
  const [tail, setTail] = useState<Tail | null>(null);
  const [status, setStatus] = useState<LiveStatus>("off");
  const onGapRef = useRef(onGap);
  onGapRef.current = onGap;

  useEffect(() => {
    if (!enabled || symbol === null) { setStatus("off"); return; }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    setStatus("connecting");

    const poll = async (): Promise<void> => {
      if (ctrl.signal.aborted) return;
      let wait = POLL_MS;
      if (!isMarketOpen(Date.now())) {
        setStatus("closed");
        wait = CLOSED_RECHECK_MS;
      } else {
        try {
          const { candles } = validateCandles(await fetchCandles(symbol, timeframe, 10, ctrl.signal));
          if (ctrl.signal.aborted) return;
          if (candles.length > 0) setTail({ key, candles: candles.slice(-TAIL) });
          fails = 0;
          setStatus("live");
        } catch {
          if (ctrl.signal.aborted) return;
          fails += 1;
          setStatus("reconnecting");
          wait = Math.min(30_000, POLL_MS * 2 ** fails);
        }
      }
      timer = setTimeout(() => { void poll(); }, wait);
    };
    void poll();

    return () => {
      ctrl.abort();
      clearTimeout(timer);
      setStatus("off");
    };
  }, [symbol, timeframe, enabled, key]);

  const merged = useMemo(() => {
    if (!enabled || !tail || tail.key !== key) return { candles: base, gap: false };
    let candles = base;
    let gap = false;
    for (const c of tail.candles) {
      const r = mergeLive(candles, c, BAR_MS[timeframe]);
      candles = r.candles;
      if (r.gap) gap = true;
    }
    return { candles, gap };
  }, [base, tail, key, enabled, timeframe]);

  const gapKey = merged.gap && tail ? `${tail.key}|${tail.candles.at(-1)?.timestamp ?? 0}` : null;
  const gapDone = useRef<string | null>(null);
  useEffect(() => {
    if (gapKey !== null && gapDone.current !== gapKey) { gapDone.current = gapKey; onGapRef.current(); }
  }, [gapKey]);

  return { candles: merged.candles, status };
}
