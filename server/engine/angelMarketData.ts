import { createHmac } from "node:crypto";
import type { Candle, Timeframe } from "../../shared/market.js";
import { isMarketOpen as sharedIsMarketOpen, istParts as sharedIstParts, MCX_SYMBOLS } from "../../shared/indianMarket.js";
import type { DerivativesInput, OiBuildup } from "../../shared/scoring.js";
import type { MarketData, MarketSnapshot, OrderBookSnapshot, Ticker24h } from "./marketData.js";
import { buildFnoPlan, loadFnoConfig, parseExpiry, parseFnoRow, selectFnoContracts } from "../../shared/fno.js";
import type { FnoContract, FnoPlan, FnoSignalInput, ScripRow } from "../../shared/fno.js";

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
  SENSEX: { exch: "BSE", token: "99919000" },
};

/** MCX futures roll every month: use the nearest contract that is more than 2 days from expiry (expiry-day trading is thin). */
export function pickMcxContract<T extends { expiry: number }>(list: T[], now: number): T | null {
  const sorted = [...list].sort((a, b) => a.expiry - b.expiry);
  return sorted.find((c) => c.expiry - now > 2 * 864e5) ?? sorted.find((c) => c.expiry > now) ?? null;
}

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
    // Cooldown: don't hammer Angel with failing logins (that causes HTTP 403 blocks / account lock).
    if (this.loginLastError && Date.now() < this.loginBlockedUntil) throw this.loginLastError;
    const { ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD, ANGEL_TOTP_SECRET } = process.env;
    if (!ANGEL_API_KEY || !ANGEL_CLIENT_CODE || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
      throw new ProviderError("AUTH_FAILED", "NO_CREDENTIALS", "Angel One credentials missing (ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD, ANGEL_TOTP_SECRET)");
    }
    const secret = cleanSecret(ANGEL_TOTP_SECRET);
    let lastMsg = "";
    let totpRejected = false;
    // Try current 30 s window first, then +/-1 window in case the server clock is slightly off.
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
    // Wrong secret/client: retry only after 5 min. Other failures (403, network): 1 min.
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
    let lastWhy = "";
    for (let attempt = 0; attempt < 6; attempt++) {
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
      lastWhy = `HTTP ${res.status} ${code} ${text.slice(0, 100)}`;
      if (res.status === 429 || res.status === 403 || code === "AB1021" || msg.includes("exceeding access rate") || msg.includes("too many requests") || msg.includes("rate limit")) {
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
throw new ProviderError("UPSTREAM", "RETRIES_EXHAUSTED", `Angel One request failed after retries: ${lastWhy || "rate limit or session"}`);
  }

  /* ---------- F&O: PCR + OI build-up (Angel One derivatives market-data APIs) ---------- */
  private fnoCache: { at: number; pcr: Map<string, number>; buildup: Map<string, { kind: OiBuildup; oiChangePct: number | null }> } | null = null;
  private fnoInflight: Promise<void> | null = null;

  /** GET twin of post(): putCallRatio is a GET endpoint. Same login, pacing and retry rules. */
  private async getReq(path: string, gapKey: string, gapMs: number): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.ensureLogin();
      await pace(gapKey, gapMs);
      const res = await this.fetchFn(`${HOST}${path}`, { method: "GET", headers: this.headers(true), signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await res.text();
      let body = null as { status?: boolean; success?: boolean; message?: string; data?: unknown } | null;
      try { body = JSON.parse(text) as typeof body; } catch { body = null; }
      if (res.status === 401) { await this.ensureLogin(true); continue; }
      if (res.status === 429 || res.status === 403) { await sleep(1500 * (attempt + 1)); continue; }
      if (!res.ok || !(body?.status === true || body?.success === true)) throw new ProviderError("UPSTREAM", String(res.status), `Angel One GET ${path}: ${body?.message ?? "request failed"}`);
      return body?.data;
    }
    throw new ProviderError("UPSTREAM", "RETRIES_EXHAUSTED", "Angel One GET failed after retries (rate limit or session)");
  }

  /** "RELIANCE28OCT25FUT" -> "RELIANCE". Both F&O APIs name rows by derivative contract. */
  private static underlyingOf(tradingSymbol: unknown): string | null {
    const m = /^(.+?)\d{2}[A-Z]{3}\d{2}/.exec(String(tradingSymbol ?? "").toUpperCase());
    return m ? m[1]! : null;
  }

  /** One refresh = 1 PCR call + 4 OI build-up calls (near expiry). Cached 5 min, so a whole scan shares it. A failed call just leaves its data empty. */
  private async refreshFno(): Promise<void> {
    const pcr = new Map<string, number>();
    const buildup = new Map<string, { kind: OiBuildup; oiChangePct: number | null }>();
    try {
      const rows = await this.getReq("/rest/secure/angelbroking/marketData/v1/putCallRatio", "fno", 500);
      if (Array.isArray(rows)) for (const r of rows as Record<string, unknown>[]) {
        const u = AngelMarketData.underlyingOf(r.tradingSymbol), v = Number(r.pcr);
        if (u && Number.isFinite(v) && v > 0 && !pcr.has(u)) pcr.set(u, v);
      }
    } catch (err) { console.error(`F&O PCR: ${err instanceof Error ? err.message : "failed"}`); }
    const kinds: [string, OiBuildup][] = [
      ["Long Built Up", "long_buildup"], ["Short Built Up", "short_buildup"],
      ["Short Covering", "short_covering"], ["Long Unwinding", "long_unwinding"],
    ];
    for (const [datatype, kind] of kinds) {
      try {
        const rows = await this.post("/rest/secure/angelbroking/marketData/v1/OIBuildup", { expirytype: "NEAR", datatype }, "fno", 500);
        if (Array.isArray(rows)) for (const r of rows as Record<string, unknown>[]) {
          const u = AngelMarketData.underlyingOf(r.tradingSymbol);
          if (!u || buildup.has(u)) continue;
          const oi = Number(r.opnInterest), chg = Number(r.netChangeOpnInterest), prev = oi - chg;
          buildup.set(u, { kind, oiChangePct: Number.isFinite(oi) && Number.isFinite(chg) && prev > 0 ? (chg / prev) * 100 : null });
        }
      } catch (err) { console.error(`F&O OI build-up (${datatype}): ${err instanceof Error ? err.message : "failed"}`); }
    }
    this.fnoCache = { at: Date.now(), pcr, buildup };
  }

  private async fnoFor(symbol: string): Promise<{ pcr: number | null; buildup: { kind: OiBuildup; oiChangePct: number | null } | null }> {
    if (!this.fnoCache || Date.now() - this.fnoCache.at > 5 * 60_000) {
      this.fnoInflight ??= this.refreshFno().finally(() => { this.fnoInflight = null; });
      await this.fnoInflight;
    }
    const u = symbol.toUpperCase();
    return { pcr: this.fnoCache?.pcr.get(u) ?? null, buildup: this.fnoCache?.buildup.get(u) ?? null };
  }

  /* ---------- instrument master: ONE shared download ---------- */
  private masterInflight: Promise<void> | null = null;
  private masterFailAt = 0;
  private masterWhy = "";
  private lastWhy = "";
  /** Every stock needs the big instrument master (~40 MB). Before: each symbol started its own download, 4 at once, and they all timed out. Now: one download is shared, and after a failure we wait 30 s before trying again. */
  private async ensureMaster(): Promise<void> {
    if (this.masterLoaded) return;
    if (Date.now() - this.masterFailAt < 30_000) throw new Error(`Angel One instrument master failed: ${this.masterWhy} (retrying shortly; set ANGEL_TOKENS to skip it)`);
    this.masterInflight ??= this.loadMaster().catch((e: unknown) => { this.masterFailAt = Date.now(); this.masterWhy = e instanceof Error ? e.message : String(e); console.error(`[angel] master download failed: ${this.masterWhy}`); throw e; }).finally(() => { this.masterInflight = null; });
    await this.masterInflight;
  }

  /* ---------- symbol -> token ---------- */
  private async resolve(symbol: string): Promise<{ exch: string; token: string; tsym: string }> {
    const name = symbol.toUpperCase();
    const fixed = FIXED[name] ?? this.tokens.get(name);
    if (fixed) return { ...fixed, tsym: name };
    await this.ensureMaster();
    const hit = this.tokens.get(name);
    if (!hit) throw new Error(`Angel One: no NSE token for ${name} (add it to ANGEL_TOKENS)`);
    return { ...hit, tsym: name };
  }

  private async loadMaster(): Promise<void> {
    const res = await this.fetchFn(MASTER_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Instrument master HTTP ${res.status}`);
        if (!res.body) throw new Error("Instrument master: empty body");
    // Stream + parse row by row instead of JSON.parse on the whole 40 MB file (OOM on Render free).
    const rows: ScripRow[] = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let pos = 0;
      for (;;) {
        const s = buf.indexOf("{", pos);
        const e = s === -1 ? -1 : buf.indexOf("}", s);
        if (s === -1 || e === -1) break;
        pos = e + 1;
        try {
          const r = JSON.parse(buf.slice(s, e + 1)) as ScripRow;
          if ((r.exch_seg === "NSE" && r.symbol?.endsWith("-EQ")) || r.exch_seg === "NFO") rows.push(r);
        } catch { /* skip bad row */ }
      }
      buf = buf.slice(pos);
    }
    if (rows.length === 0) throw new Error("Instrument master parsed 0 rows");
    const nowMs = Date.now();
    const fno = new Map<string, FnoContract[]>();
    for (const r of rows) {
      if (r.exch_seg === "NFO") {   // live futures + options (next 75 days) for the F&O signals
        const c = parseFnoRow(r, nowMs);
        if (c) (fno.get(c.name) ?? fno.set(c.name, []).get(c.name)!).push(c);
        continue;
      }
      if (r.exch_seg === "NSE" && r.symbol?.endsWith("-EQ") && r.token) {
        const n = r.symbol.slice(0, -3).toUpperCase();
        if (!this.tokens.has(n)) this.tokens.set(n, { exch: "NSE", token: r.token });
      }
    }
    this.fnoByName = fno;
    this.masterAt = Date.now();
        this.masterLoaded = true;
    // Tell the owner the tokens of the scanned symbols once, so ANGEL_TOKENS can skip this big download after the next restart.
    const want = (process.env.SCAN_SYMBOLS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const line = want.filter((s) => this.tokens.has(s)).map((s) => `${s}:${this.tokens.get(s)!.token}`).join(",");
    if (line) console.log(`[angel] instrument master loaded. To skip this download on the next start, set ANGEL_TOKENS=${line}`);
  }

  /* ---------- F&O signals: futures + call/put (weekly and monthly) ---------- */
  private fnoByName = new Map<string, FnoContract[]>();
  private masterAt = 0;

  /** Last traded price of NFO contracts (one LTP quote call for up to 50 tokens). */
  private async nfoLtps(tokens: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const data = (await this.post("/rest/secure/angelbroking/market/v1/quote/", {
      mode: "LTP", exchangeTokens: { NFO: tokens.slice(0, 50) },
    }, "quote", 1100)) as { fetched?: Record<string, unknown>[] } | null;
    for (const q of data?.fetched ?? []) {
      const p = Number(q.ltp), t = String(q.symbolToken ?? "");
      if (t && Number.isFinite(p) && p > 0) out.set(t, p);
    }
    return out;
  }

  /** Futures + call/put ideas for a cash signal. Null for stocks without F&O or when F&O signals are switched off (FNO_SIGNALS=false). */
  async getFnoPlan(input: FnoSignalInput): Promise<FnoPlan | null> {
    const cfg = loadFnoConfig();
    if (!cfg.enabled) return null;
    if (!this.masterLoaded || Date.now() - this.masterAt > 12 * 3_600_000) await this.loadMaster();
    const list = this.fnoByName.get(input.symbol.toUpperCase());
    if (!list || list.length === 0) return null;
    const sel = selectFnoContracts(list, input.spot, input.direction, cfg, input.now);
    const tokens = [...(sel.future ? [sel.future.token] : []), ...sel.options.map((o) => o.contract.token)];
    if (tokens.length === 0) return null;
    return buildFnoPlan(input, sel, await this.nfoLtps(tokens), cfg);
  }

  /* ---------- candles ---------- */
  private async rawCandles(symbol: string, interval: string, fromMs: number, toMs: number): Promise<Candle[]> {
    const inst = await this.resolve(symbol);
    const data = await this.post("/rest/secure/angelbroking/historical/v1/getCandleData", {
      exchange: inst.exch, symboltoken: inst.token, interval, fromdate: istStamp(fromMs), todate: istStamp(toMs),
    }, "candle", 600);
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

  /** NSE has no funding / long-short data. Real here: order-book imbalance, plus F&O PCR and OI build-up for stocks that have F&O. */
  async getDerivatives(symbol: string, _tf: Timeframe): Promise<DerivativesInput> {
    let bookImbalance: number | null = null;
    try { bookImbalance = (await this.getOrderBook(symbol)).imbalance; } catch { /* leave null */ }
    let pcr: number | null = null, oiBuildup: OiBuildup | null = null, oiChangePct: number | null = null;
    try { const f = await this.fnoFor(symbol); pcr = f.pcr; oiBuildup = f.buildup?.kind ?? null; oiChangePct = f.buildup?.oiChangePct ?? null; } catch { /* leave null */ }
    return { fundingRate: null, oiChangePct, longShortRatio: null, bookImbalance, pcr, oiBuildup, asOf: Date.now(), source: "angelone" };
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

  /** Today's reference numbers from the same Angel quote: previous close (c), open, high, low and day volume. Reads the quote cache that lastPrices() just filled. */
  quoteExtras(symbols: string[]): Record<string, { c: number; o: number; h: number; l: number; v: number }> {
    const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const out: Record<string, { c: number; o: number; h: number; l: number; v: number }> = {};
    for (const s of symbols) {
      const hit = this.quoteCache.get(s);
      if (!hit || Date.now() - hit.at > 15_000) continue;
      const c = n(hit.q.close);
      if (c > 0) out[s] = { c, o: n(hit.q.open), h: n(hit.q.high), l: n(hit.q.low), v: n(hit.q.tradeVolume) };
    }
    return out;
  }

  /** One Angel quote call for many symbols (up to 50 tokens per request). */
  private async quoteMany(symbols: string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const todo: { s: string; exch: string; token: string }[] = [];
    for (const s of symbols) {
      const hit = this.quoteCache.get(s);
      if (hit && Date.now() - hit.at < 2000) { out.set(s, hit.q); continue; }
      try {
        const inst = await this.resolve(s);
        todo.push({ s, exch: inst.exch, token: inst.token });
      } catch { /* the per-symbol fallback reports this error */ }
    }
    for (let i = 0; i < todo.length; i += 50) {
      const chunk = todo.slice(i, i + 50);
      const exchangeTokens: Record<string, string[]> = {};
      for (const t of chunk) (exchangeTokens[t.exch] ??= []).push(t.token);
      const data = (await this.post("/rest/secure/angelbroking/market/v1/quote/", {
        mode: "FULL", exchangeTokens,
      }, "quote", 1100)) as { fetched?: Record<string, unknown>[] } | null;
      for (const q of data?.fetched ?? []) {
        const tok = String(q.symbolToken ?? "");
        for (const t of chunk) {
          if (t.token === tok) { out.set(t.s, q); this.quoteCache.set(t.s, { at: Date.now(), q }); }
        }
      }
    }
    return out;
  }

  private async lastPricesRaw(symbols: string[], errors: ProviderError[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    let pending = symbols;
    try {
      const found = await this.quoteMany(symbols);
      pending = [];
      for (const s of symbols) {
        const p = Number(found.get(s)?.ltp);
        if (Number.isFinite(p) && p > 0) out[s] = p; else pending.push(s);
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError("UPSTREAM", "ERR", err instanceof Error ? err.message : "unknown error");
      if (pe.category === "AUTH_FAILED") { errors.push(pe); console.error(`lastPrices: ${pe.category} ${pe.code}: ${pe.message}`); return out; }
      pending = symbols; // batch failed: fall back to one call per symbol
    }
    for (const s of pending) {
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
