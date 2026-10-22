import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { Timeframe } from "../../shared/market.js";
import { DEFAULT_TIMEFRAME, isTimeframe } from "./timeframes.js";
import { DEFAULT_SYMBOL, normalizeSymbol } from "./symbol.js";
import { MarketSymbolView } from "./MarketSymbolView.js";

/** URL contract (docs/routes.md: `/market/:symbol?tf=`): here `?page=market&symbol=RELIANCE&tf=1H`. */
/** Chart ka default timeframe = Settings wala (signal engine ke saath match). */
const settingsTf = (): Timeframe => {
  const w = window as unknown as { CGS?: { get(): { tf?: string } } };
  const m: Record<string, Timeframe> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" };
  return m[String(w.CGS?.get().tf ?? "").toLowerCase()] ?? DEFAULT_TIMEFRAME;
};
const readUrl = (): { raw: string | null; tf: Timeframe } => {
  const p = new URLSearchParams(window.location.search);
  const tf = p.get("tf");
  return { raw: p.get("symbol") || document.getElementById("liveSymbol")?.textContent?.trim() || DEFAULT_SYMBOL, tf: isTimeframe(tf) ? tf : DEFAULT_TIMEFRAME };
};

export function MarketSymbolApp(): ReactElement | null {
  const [url, setUrl] = useState(readUrl);

  useEffect(() => {
    const on = (): void => setUrl(readUrl());
    window.addEventListener("popstate", on);
    const live = document.getElementById("liveSymbol");
    const mo = live ? new MutationObserver(on) : null;
    if (live && mo) mo.observe(live, { childList: true, characterData: true, subtree: true });
    return () => { window.removeEventListener("popstate", on); mo?.disconnect(); };
  }, []);

  const onTimeframeChange = useCallback((tf: Timeframe) => {
    const u = new URL(window.location.href);
    u.searchParams.set("tf", tf);
    window.history.replaceState(window.history.state, "", u); // no reload, no extra history entry
    setUrl((prev) => ({ ...prev, tf }));
  }, []);

  if (!url.raw) return null; // no symbol in the URL: the existing market page is left exactly as it was
  return <MarketSymbolView symbol={normalizeSymbol(url.raw)} rawSymbol={url.raw} timeframe={url.tf} onTimeframeChange={onTimeframeChange} />;
}
