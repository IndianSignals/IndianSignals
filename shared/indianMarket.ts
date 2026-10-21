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

/** MCX commodity futures scanned here (Angel exchange "MCX"). Trading Mon-Fri 09:00-23:30 IST. */
export const MCX_SYMBOLS: ReadonlySet<string> = new Set(["CRUDEOIL", "NATURALGAS"]);
export const isMcxSymbol = (s: string): boolean => MCX_SYMBOLS.has(String(s).toUpperCase());
export function isMcxOpen(now: number = Date.now(), env: Env = {}): boolean {
  if (!isTradingDay(now, env)) return false;
  const { minutes } = istParts(now);
  return minutes >= 9 * 60 && minutes < 23 * 60 + 30;
}
/** Is the market of THIS symbol open right now (NSE/BSE cash and indices vs MCX)? */
export const isSymbolOpen = (symbol: string, now: number = Date.now(), env: Env = {}): boolean =>
  isMcxSymbol(symbol) ? isMcxOpen(now, env) : isMarketOpen(now, env);

export const formatINR = (n: number): string => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
export const roundToTick = (price: number, tick = 0.05): number => Math.round(Math.round(price / tick) * tick * 100) / 100;

/** Benchmark index for the trend filter (the old BTC role). Stocks trade only with its trend. */
export const BENCHMARK_SYMBOL = "NIFTY";

/** INDEX_FILTER = strict | true | soft | false. The old name BTC_FILTER is still read as a fallback. */
export const indexFilterMode = (env: Env = {}): string => (env.INDEX_FILTER ?? env.BTC_FILTER ?? "strict").toLowerCase();

/**
 * Milliseconds of NSE trading time between two instants. Lets "is the last candle stale?" ignore nights,
 * weekends and holidays (Monday 09:20 sees Friday's last candle, which is fresh in trading time).
 * Gaps longer than 14 days return the raw difference.
 */
export function tradingMsBetween(from: number, to: number, env: Env = {}): number {
  if (!(to > from)) return 0;
  if (to - from > 14 * 86_400_000) return to - from;
  const DAY = 86_400_000;
  const dayStart = (ms: number): number => Math.floor((ms + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS;
  let total = 0;
  for (let d = dayStart(from); d < to; d += DAY) {
    if (!isTradingDay(d + 3_600_000, env)) continue;
    const open = d + MARKET_OPEN_MIN * 60_000, close = d + MARKET_CLOSE_MIN * 60_000;
    total += Math.max(0, Math.min(to, close) - Math.max(from, open));
  }
  return total;
}
