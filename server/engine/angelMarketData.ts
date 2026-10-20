import { createHmac } from "node:crypto";
import type { Candle, Timeframe } from "../../shared/market.js";
import { isMarketOpen as sharedIsMarketOpen, istParts as sharedIstParts } from "../../shared/indianMarket.js";
import type { DerivativesInput } from "../../shared/scoring.js";
import type { MarketData, MarketSnapshot, OrderBookSnapshot, Ticker24h } from "./marketData.js";

/**
 * Angel One SmartAPI market data (NSE).
 * Env: ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD (login PIN), ANGEL_TOTP_SECRET (base32 secret from the TOTP QR).
 * Optional: ANGEL_TOKENS="RELIANCE:2885,TCS:11536" skips the big instrument-master download.
 * NSE_HOLIDAYS="2026-10-20,2026-11-10" (yyyy-mm-dd) so the scanner can skip holidays.
 */

const HOST = "https://apiconnect.angelbroking.com";
const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
const IST_MS = 5.5 * 3_600_000;

const INTERVAL: Record<Exclude<Timeframe, "4H">, string> = {
  "1m": "ONE_MINUTE", "5m": "FIVE_MINUTE", "15m": "FIFTEEN_MINUTE", "30m": "THIRTY_MINUTE", "1H": "ONE_HOUR", "1D": "ONE_DAY",
};
const BAR_MS: Record<Timeframe, number> = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1H": 36e5, "4H": 144e5, "1D": 864e5 };
/** Candles per NSE trading day (09:15-15:30 = 375 min). */
const BARS_PER_DAY: Record<Timeframe, number> = { "1m": 375, "5m": 75, "15m": 25, "30m": 13, "1H": 7, "4H": 2, "1D": 1 };
/** Max calendar days Angel returns per getCandleData call. */
const MAX_DAYS: Record<string, number> = {
  ONE_MINUTE: 30, FIVE_MINUTE: 100, FIFTEEN_MINUTE: 200, THIRTY_MINUTE: 200, ONE_HOUR: 400, ONE_DAY: 2000,
};

// Indices have fixed tokens. Stocks are looked up from ANGEL_TOKENS or the instrument master.
const FIXED: Record<string, { exch: string; token: string }> = {
  NIFTY: { exch: "NSE", token: "99926000" },
  BANKNIFTY: { exch: "NSE", token: "99926009" },
  FINNIFTY: { exch: "NSE", token: "99926037" },
  MIDCPNIFTY: { exch: "NSE", token: "99926074" },
};

const toNum = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error("Non-numeric value in Angel One response");
  return n;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type ProviderCategory = "AUTH_FAILED" | "SESSION" | "RATE_LIMITED" | "NO_DATA" | "UPSTREAM";
export class ProviderError extends Error {
  constructor(public readonly category: ProviderCategory, public readonly code: string, message: string) { super(message); }
}
const categoryOf = (code: string, msg: string): ProviderCategory => {
  const m = msg.toLowerCase();
  if (code === "AG8004" || m.includes("invalid api key")) return "AUTH_FAILED";
  if (["AG8001", "AG8002", "AG8003"].includes(code) || m.includes("invalid token")) return "SESSION";
  if (m.includes("rate")) return "RATE_LIMITED";
  return "UPSTREAM";
};

export const isMarketOpen = (now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean => sharedIsMarketOpen(now, env);
const istParts = sharedIstParts;

/* ---------- TOTP (RFC 6238), no dependency ---------- */
function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
/** Accepts a raw base32 secret, or a pasted otpauth:// URL, with spaces/quotes/dashes. */
export function cleanSecret(raw: string): string {
  let s = raw.trim().replace(/^["']|["']$/g, "");
  const m = /secret=([^&\s]+)/i.exec(s);
  if (m) s = m[1]!;
  return s.replace(/[\s=-]/g, "").toUpperCase();
}
export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const code = (((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}

/* ---------- pacing: Angel allows ~3 historical calls/s and 1 quote call/s ---------- */
const nextSlot = new Map<string, number>();
async function pace(key: string, gapMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, at + gapMs);
  if (at > now) await sleep(at - now);
}

const istStamp = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 16).replace("T", " ");

export class AngelMarketData implements MarketData {
  private jwt: string | null = null;
  private loginAt = 0;
  private loginInflight: Promise<void> | null = null;
  private tokens = new Map<string, { exch: string; token: string }>();
  private masterLoaded = false;
  private quoteCache = new Map<string, { at: number; q: Record<string, unknown> }>();

  constructor(private readonly timeoutMs = 10_000, private readonly fetchFn: typeof fetch = fetch) {
    for (const pair of (process.env.ANGEL_TOKENS ?? "").split(",")) {
      const [sym, tok] = pair.split(":").map((s) => s?.trim());
      if (sym && tok) this.tokens.set(sym.toUpperCase(), { exch: "NSE", token: tok });
    }
  }

  private headers(auth: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json", Accept: "application/json",
      "X-UserType": "USER", "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": (process.env.ANGEL_API_KEY ?? "").trim(),
    };
    if (auth && this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }

    private loginBlockedUntil = 0;
  private loginLastError: ProviderError | null = null;

  private async login(): Promise<void> {
    // Cooldown: don't hammer Angel with failing logins (causes HTTP 403 / account lock).
    if (this.loginLastError && Date.now() < this.loginBlockedUntil) throw this.loginLastError;
    const { ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD, ANGEL_TOTP_SECRET } = process.env;
    if (!ANGEL_API_KEY || !ANGEL_CLIENT_CODE || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
      throw new ProviderError("AUTH_FAILED", "NO_CREDENTIALS", "Angel One credentials missing (ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD, ANGEL_TOTP_SECRET)");
    }
    const secret = cleanSecret(ANGEL_TOTP_SECRET);
    let lastMsg = "";
    let totpRejected = false;
    // Current 30s window first, then +/-1 window in case the server clock is slightly off.
    for (const drift of [0, -30_000, 30_000]) {
      const res = await this.fetchFn(`${HOST}/rest/auth/angelbroking/user/v1/loginByPassword`, {
        method: "POST", headers: this.headers(false), signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ clientcode: ANGEL_CLIENT_CODE.trim(), password: ANGEL_PASSWORD.trim(), totp: totp(secret, Date.now() + drift) }),
      });
      const body = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: { jwtToken?: string } } | null;
      if (body?.status && body.data?.jwtToken) {
        this.jwt = body.data.jwtToken;
        this.loginAt = Date.now();
        this.loginLastError = null;
        this.loginBlockedUntil = 0;
        return;
      }
      lastMsg = body?.message ?? (res.status === 403 ? "HTTP 403 (IP not whitelisted or temporarily blocked)" : `HTTP ${res.status}`);
      totpRejected = /totp/i.test(lastMsg);
      if (!totpRejected) break;
    }
    // Wrong secret/client: retry after 5 min. Other failures (403, network): 1 min.
    this.loginBlockedUntil = Date.now() + (totpRejected ? 300_000 : 60_000);
    this.loginLastError = new ProviderError("AUTH_FAILED", totpRejected ? "BAD_TOTP" : "LOGIN_FAILED", `Angel One login failed: ${lastMsg}`);
    throw this.loginLastError;
  }

  private async ensureLogin(force = false): Promise<void> {
    const stale = !this.jwt || Date.now() - this.loginAt > 6 * 3_600_000;
    if (!force && !stale) return;
    this.loginInflight ??= this.login().finally(() => { this.loginInflight = null; });
    await this.loginInflight;
  }

  private async post(path: string, payload: unknown, gapKey: string, gapMs: number): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.ensureLogin();
      await pace(gapKey, gapMs);
      const res = await this.fetchFn(`${HOST}${path}`, {
        method: "POST", headers: this.headers(true), body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      type Reply = { status?: boolean; message?: string; errorcode?: string; errorCode?: string; data?: unknown };
      let body = null as Reply | null;
      try { body = JSON.parse(text) as Reply; } catch { body = null; }
      const msg = `${body?.message ?? ""} ${text.slice(0, 120)}`.toLowerCase();
      const code = String(body?.errorcode ?? body?.errorCode ?? "");
      if (res.status === 429 || res.status === 403 || msg.includes("exceeding access rate") || msg.includes("rate")) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (code === "AG8004" || msg.includes("invalid api key")) throw new ProviderError("AUTH_FAILED", code || "AG8004", "Angel One rejected the API key (Invalid API Key)");
      if (res.status === 401 || code === "AG8001" || code === "AG8002" || code === "AG8003" || msg.includes("invalid token")) {
        await this.ensureLogin(true);
        continue;
      }
    if (!res.ok || !body?.status) throw new ProviderError(categoryOf(code, msg), code || String(res.status), `Angel One ${code || res.status}: ${body?.message ?? "request failed"}`);
      return body.data;
    }
 throw new ProviderError("UPSTREAM", "RETRIES_EXHAUSTED", "Angel One request failed after retries (rate limit or session)");
  }

  /* ---------- symbol -> token ---------- */
  private async resolve(symbol: string): Promise<{ exch: string; token: string; tsym: string }> {
    const name = symbol.toUpperCase();
    const fixed = FIXED[name] ?? this.tokens.get(name);
    if (fixed) return { ...fixed, tsym: name };
    if (!this.masterLoaded) await this.loadMaster();
    const hit = this.tokens.get(name);
    if (!hit) throw new Error(`Angel One: no NSE token for ${name} (add it to ANGEL_TOKENS)`);
    return { ...hit, tsym: name };
  }

  private async loadMaster(): Promise<void> {
    const res = await this.fetchFn(MASTER_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Instrument master HTTP ${res.status}`);
    const rows = (await res.json()) as { token?: string; symbol?: string; exch_seg?: string }[];
    for (const r of rows) {
      if (r.exch_seg === "NSE" && r.symbol?.endsWith("-EQ") && r.token) {
        const n = r.symbol.slice(0, -3).toUpperCase();
        if (!this.tokens.has(n)) this.tokens.set(n, { exch: "NSE", token: r.token });
      }
    }
    this.masterLoaded = true;
  }

  /* ---------- candles ---------- */
  private async rawCandles(symbol: string, interval: string, fromMs: number, toMs: number): Promise<Candle[]> {
    const inst = await this.resolve(symbol);
    const data = await this.post("/rest/secure/angelbroking/historical/v1/getCandleData", {
      exchange: inst.exch, symboltoken: inst.token, interval, fromdate: istStamp(fromMs), todate: istStamp(toMs),
    }, "candle", 400);
    if (!Array.isArray(data)) return [];
    const out: Candle[] = [];
    for (const row of data) {
      if (!Array.isArray(row)) continue;
      const ts = Date.parse(String(row[0]));
      if (!Number.isFinite(ts)) continue;
      out.push({ timestamp: ts, open: toNum(row[1]), high: toNum(row[2]), low: toNum(row[3]), close: toNum(row[4]), volume: toNum(row[5]) });
    }
    return out;
  }

  private async fetchBars(symbol: string, tf: Exclude<Timeframe, "4H">, want: number, now: number): Promise<Candle[]> {
    const interval = INTERVAL[tf];
    const maxDays = MAX_DAYS[interval]!;
    const end = Math.min(now, Date.now());
    let remainingDays = Math.ceil((Math.ceil(want / BARS_PER_DAY[tf]) * 7) / 5) + 4;
    let windowEnd = end;
    const byTime = new Map<number, Candle>();
    for (let i = 0; i < 12 && remainingDays > 0 && byTime.size < want; i++) {
      const span = Math.min(remainingDays, maxDays);
      const from = windowEnd - span * 864e5;
      for (const c of await this.rawCandles(symbol, interval, from, windowEnd)) byTime.set(c.timestamp, c);
      windowEnd = from - 6e4;
      remainingDays -= span;
    }
    return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Angel has no 4H bar: build it from 1H. NSE day = 09:15-13:15 and 13:15-15:30. */
  private aggregate4H(h1: Candle[], now: number, includeForming: boolean): Candle[] {
    const days = new Map<string, Candle[]>();
    for (const c of h1) {
      const k = istParts(c.timestamp).ymd;
      (days.get(k) ?? days.set(k, []).get(k)!).push(c);
    }
    const out: Candle[] = [];
    for (const list of days.values()) {
      for (let i = 0; i < list.length; i += 4) {
        const g = list.slice(i, i + 4);
        const last = g[g.length - 1]!;
        const closed = last.timestamp + BAR_MS["1H"] <= now && (g.length === 4 || istParts(last.timestamp).minutes >= 15 * 60);
        if (!closed && !includeForming) continue;
        out.push({
          timestamp: g[0]!.timestamp, open: g[0]!.open, close: last.close,
          high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
          volume: g.reduce((a, x) => a + x.volume, 0),
        });
      }
    }
    return out;
  }

  async getCandles(symbol: string, tf: Timeframe, limit: number, now: number, includeForming = false): Promise<Candle[]> {
    let rows: Candle[];
    if (tf === "4H") {
      rows = this.aggregate4H(await this.fetchBars(symbol, "1H", limit * 4 + 4, now), now, includeForming);
    } else {
      rows = (await this.fetchBars(symbol, tf, limit + 1, now)).filter((c) => includeForming || c.timestamp + BAR_MS[tf] <= now);
    }
    return rows.slice(-limit);
  }

  /* ---------- quote / depth ---------- */
  private async quote(symbol: string): Promise<Record<string, unknown>> {
    const hit = this.quoteCache.get(symbol);
    if (hit && Date.now() - hit.at < 2000) return hit.q;
    const inst = await this.resolve(symbol);
    const data = (await this.post("/rest/secure/angelbroking/market/v1/quote/", {
      mode: "FULL", exchangeTokens: { [inst.exch]: [inst.token] },
    }, "quote", 1100)) as { fetched?: Record<string, unknown>[] } | null;
    const q = data?.fetched?.[0];
    if (!q) throw new Error(`Angel One: empty quote for ${symbol}`);
    this.quoteCache.set(symbol, { at: Date.now(), q });
    return q;
  }

  async getTicker24h(symbol: string): Promise<Ticker24h> {
    const q = await this.quote(symbol);
    const ltp = toNum(q.ltp);
        // Volume is INR value traded today (shares x last price). MIN_VOLUME_24H_USD keeps its old name but means INR here.
    return { change24hPct: toNum(q.percentChange ?? 0), volume24h: toNum(q.tradeVolume ?? 0) * ltp };
  }

  private async getOrderBook(symbol: string): Promise<OrderBookSnapshot> {
    const q = await this.quote(symbol);
    const depth = (q.depth ?? {}) as { buy?: { price?: number; quantity?: number }[]; sell?: { price?: number; quantity?: number }[] };
    const buy = depth.buy ?? [], sell = depth.sell ?? [];
    const sum = (side: { quantity?: number }[]): number => side.reduce((a, l) => a + Number(l.quantity ?? 0), 0);
    const bid = Number(buy[0]?.price ?? 0), ask = Number(sell[0]?.price ?? 0);
    const bidVolume = sum(buy), askVolume = sum(sell), total = bidVolume + askVolume;
    const ok = bid > 0 && ask > 0;
    return {
      bidVolume, askVolume,
      imbalance: total > 0 ? (bidVolume - askVolume) / total : null,
      spread: ok ? ask - bid : null,
      midpoint: ok ? (ask + bid) / 2 : null,
    };
  }

  /** NSE cash has no funding / OI / long-short data: only the order-book imbalance is real. */
  async getDerivatives(symbol: string, _tf: Timeframe): Promise<DerivativesInput> {
    let bookImbalance: number | null = null;
    try { bookImbalance = (await this.getOrderBook(symbol)).imbalance; } catch { /* leave null */ }
    return { fundingRate: null, oiChangePct: null, longShortRatio: null, bookImbalance, asOf: Date.now(), source: "angelone" };
  }

    marketTypeOf(): "cash" { return "cash"; }

  async getMarketSnapshot(symbol: string, tf: Timeframe): Promise<MarketSnapshot> {
    const [ticker, derivatives, orderBook] = await Promise.allSettled([
      this.getTicker24h(symbol), this.getDerivatives(symbol, tf), this.getOrderBook(symbol),
    ]);
    return {
      ticker: ticker.status === "fulfilled" ? ticker.value : { change24hPct: 0, volume24h: 0 },
      derivatives: derivatives.status === "fulfilled" ? derivatives.value
        : { fundingRate: null, oiChangePct: null, longShortRatio: null, bookImbalance: null },
      orderBook: orderBook.status === "fulfilled" ? orderBook.value
        : { bidVolume: null, askVolume: null, imbalance: null, spread: null, midpoint: null },
      timestamp: Date.now(),
    };
  }

  /** Last traded prices for the dashboard cards (one quote call per symbol, cached 2 s). */
    async lastPrices(symbols: string[]): Promise<Record<string, number>> {
    const errors: ProviderError[] = [];
    const out = await this.lastPricesRaw(symbols, errors);
    if (Object.keys(out).length === 0 && errors[0]) throw errors[0];
    return out;
  }

  private async lastPricesRaw(symbols: string[], errors: ProviderError[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of symbols) {
      try {
        const p = Number((await this.quote(s)).ltp);
        if (Number.isFinite(p) && p > 0) out[s] = p;
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError("UPSTREAM", "ERR", err instanceof Error ? err.message : "unknown error");
        errors.push(pe);
                console.error(`lastPrices ${s}: ${pe.category} ${pe.code}: ${pe.message}`);
        if (pe.category === "AUTH_FAILED") break; // login broken: skip remaining symbols
      }
    }
    return out;
  }
}

let shared: AngelMarketData | null = null;
/** One shared instance = one login + one rate-limit gate. */
export function createMarketData(): AngelMarketData {
  return (shared ??= new AngelMarketData());
}
