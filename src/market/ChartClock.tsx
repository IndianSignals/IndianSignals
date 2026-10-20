import { useEffect, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type { Timeframe } from "../../shared/market.js";
import { tokens } from "../../shared/designTokens.js";
import { candleLeftMs } from "./nseTime.js";

const pad = (n: number): string => String(n).padStart(2, "0");

const IST_CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** NSE wall clock (IST), e.g. 09:41:07 - the same on every device, whatever its time zone. */
export const fmtClock = (ms: number): string => IST_CLOCK.format(new Date(ms));
export const fmtLeft = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};

const box: CSSProperties = { display: "inline-flex", gap: 10, alignItems: "center", fontSize: 12, fontVariantNumeric: "tabular-nums", color: tokens.color.text.muted, whiteSpace: "nowrap" };

/** Live clock + countdown to the current candle's close. Ticks once per second. */
export function ChartClock({ timeframe }: { timeframe: Timeframe }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={box} role="timer" aria-label="Current time and time left in this candle">
      <span title="Indian Standard Time (NSE)">🕒 {fmtClock(now)} IST</span>
      {(() => {
        const left = candleLeftMs(now, timeframe);
        return left === null
          ? <span title="NSE cash market: Mon-Fri 09:15-15:30 IST">🔒 Market closed</span>
          : <span title={`Time left until this ${timeframe} candle closes`}>⏳ {fmtLeft(left)}</span>;
      })()}
    </span>
  );
}
