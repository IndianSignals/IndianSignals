import { describe, expect, it } from "vitest";
import type { Candle } from "../shared/market.js";
import { BAR_MS, candleLeftMs, mergeLive } from "../src/market/nseTime.js";

// IST = UTC+5:30. Tue 2026-10-20 (a trading day).
const ist = (h: number, m: number, s = 0, day = 20): number => Date.UTC(2026, 9, day, h, m, s) - 5.5 * 3_600_000;
const bar = (ts: number, close = 100): Candle => ({ timestamp: ts, open: close, high: close, low: close, close, volume: 1 });

describe("candleLeftMs (NSE bar grid from 09:15 IST)", () => {
  it("1H: 10:00 is 15 min before the 10:15 close", () => expect(candleLeftMs(ist(10, 0), "1H")).toBe(15 * 60_000));
  it("15m: counts to the next quarter past", () => expect(candleLeftMs(ist(9, 20, 30), "15m")).toBe(9 * 60_000 + 30_000));
  it("4H: first bar ends 13:15, second bar is cut at 15:30", () => {
    expect(candleLeftMs(ist(12, 0), "4H")).toBe(75 * 60_000);
    expect(candleLeftMs(ist(14, 0), "4H")).toBe(90 * 60_000);
  });
  it("1D: counts to 15:30", () => expect(candleLeftMs(ist(15, 0), "1D")).toBe(30 * 60_000));
  it("is null before the open, after the close and on weekends", () => {
    expect(candleLeftMs(ist(9, 14), "1H")).toBeNull();
    expect(candleLeftMs(ist(15, 30), "1H")).toBeNull();
    expect(candleLeftMs(ist(11, 0, 0, 24), "1H")).toBeNull(); // Saturday
  });
});

describe("mergeLive in trading time", () => {
  const H = BAR_MS["1H"];
  it("replaces the forming bar and appends a newer one without a gap", () => {
    const base = [bar(ist(9, 15), 1), bar(ist(10, 15), 2)];
    expect(mergeLive(base, bar(ist(10, 15), 3), H).candles.at(-1)?.close).toBe(3);
    const r = mergeLive(base, bar(ist(11, 15), 4), H);
    expect(r.candles).toHaveLength(3);
    expect(r.gap).toBe(false);
  });
  it("the night between sessions is not a gap", () => {
    const r = mergeLive([bar(ist(14, 15))], bar(ist(9, 15, 0, 21)), H); // Tue 14:15 -> Wed 09:15
    expect(r.gap).toBe(false);
  });
  it("a missed bar inside the session is a gap; older ticks are ignored", () => {
    expect(mergeLive([bar(ist(9, 15))], bar(ist(12, 15)), H).gap).toBe(true);
    const base = [bar(ist(10, 15))];
    expect(mergeLive(base, bar(ist(9, 15)), H).candles).toBe(base);
  });
});
