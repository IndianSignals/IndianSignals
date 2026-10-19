type Env = Record<string, string | undefined>;

/** NSE cash-market calendar helpers. All times are IST (UTC+5:30, no DST). */
export const IST_OFFSET_MS = 5.5 * 3_600_000;
export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;

export function istParts(ms: number): { dow: number; minutes: number; ymd: string } {
  const d = new Date(ms + IST_OFFSET_MS);
  return { dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), ymd: d.toISOString().slice(0, 10) };
}

/** Holidays come from NSE_HOLIDAYS="2026-10-20,2026-11-10" (yyyy-mm-dd). Fill it from NSE's official list. */
export function parseHolidays(env: Env = {}): Set<string> {
  return new Set((env.NSE_HOLIDAYS ?? "").split(",").map((s: string) => s.trim()).filter((s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)));
}

export function isTradingDay(ms: number, env: Env = {}): boolean {
  const { dow, ymd } = istParts(ms);
  return dow !== 0 && dow !== 6 && !parseHolidays(env).has(ymd);
}

export function isMarketOpen(now: number = Date.now(), env: Env = {}): boolean {
  if (!isTradingDay(now, env)) return false;
  const { minutes } = istParts(now);
  return minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN;
}

export const formatINR = (n: number): string => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
export const roundToTick = (price: number, tick = 0.05): number => Math.round(Math.round(price / tick) * tick * 100) / 100;
