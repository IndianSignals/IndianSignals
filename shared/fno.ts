/**
 * F&O signals: turns a cash LONG/SHORT signal into Futures + Call/Put (weekly and monthly expiry) ideas.
 * Pure functions only: the broker adapter loads contracts and quotes, this file decides and calculates.
 *
 * Rules (NSE, 2026): only NIFTY has weekly options. BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 and all stocks
 * are monthly only. Weekly is detected from the contract list itself (expiries about 7 days apart), not hard-coded.
 * Options are BUY-only: LONG -> buy CE, SHORT -> buy PE. Premium levels are delta estimates, not live greeks.
 */

export type FnoSide = "LONG" | "SHORT";
export type ExpiryKind = "weekly" | "monthly";
export type ExpiryLabel = ExpiryKind | "weekly+monthly";
export type StrikeChoice = "ATM" | "ITM1" | "OTM1";

export interface FnoContract {
  token: string; symbol: string; name: string;
  type: "FUT" | "CE" | "PE";
  expiry: number;     // ms, 15:30 IST on the expiry day
  strike: number;     // rupees (0 for futures)
  lotSize: number;
}

export interface FnoConfig {
  enabled: boolean;
  strike: StrikeChoice;
  minDte: number;               // skip option expiries closer than this many calendar days (default 1 = never trade expiry day)
  expiries: ExpiryKind[];       // which expiries to show
  maxLossPct: number;           // option stop is never wider than this % of premium
  delta?: number;               // override the delta used for premium targets
}

export const DEFAULT_FNO_CONFIG: Readonly<FnoConfig> = Object.freeze({
  enabled: true, strike: "ATM", minDte: 1, expiries: ["weekly", "monthly"] as ExpiryKind[], maxLossPct: 40,
});

export function loadFnoConfig(env: Record<string, string | undefined> = process.env): FnoConfig {
  const st = (env.FNO_STRIKE ?? "ATM").toUpperCase();
  const ex = (env.FNO_EXPIRIES ?? "weekly,monthly").toLowerCase().split(",").map((x) => x.trim()).filter((x): x is ExpiryKind => x === "weekly" || x === "monthly");
  const num = (v: string | undefined, d: number): number => { const n = Number(v); return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? n : d; };
  const delta = env.FNO_DELTA !== undefined && Number.isFinite(Number(env.FNO_DELTA)) && Number(env.FNO_DELTA) > 0 && Number(env.FNO_DELTA) <= 1 ? Number(env.FNO_DELTA) : undefined;
  return {
    enabled: (env.FNO_SIGNALS ?? "true").toLowerCase() !== "false",
    strike: st === "ITM1" || st === "OTM1" ? st : "ATM",
    minDte: Math.max(0, Math.floor(num(env.FNO_MIN_DTE, 1))),
    expiries: ex.length ? ex : ["weekly", "monthly"],
    maxLossPct: Math.min(90, Math.max(5, num(env.FNO_MAX_LOSS_PCT, 40))),
    ...(delta !== undefined ? { delta } : {}),
  };
}

/* ---------- dates ---------- */
const IST_MS = 5.5 * 3_600_000, DAY = 86_400_000;
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const istDay = (ms: number): number => Math.floor((ms + IST_MS) / DAY);
const monthKey = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 7);
const isoDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** "28OCT2026" -> ms at 15:30 IST that day. */
export function parseExpiry(s: string): number | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{4})$/.exec(String(s ?? "").trim().toUpperCase());
  if (!m) return null;
  const mo = MONTHS[m[2]!];
  return mo === undefined ? null : Date.UTC(Number(m[3]), mo, Number(m[1]), 10, 0);
}

export interface ScripRow { token?: string; symbol?: string; name?: string; exch_seg?: string; instrumenttype?: string; expiry?: string; strike?: string; lotsize?: string }

/** One row of the Angel One instrument master -> FnoContract. Null for anything that is not a live NFO future or option within 75 days. */
export function parseFnoRow(r: ScripRow, now: number): FnoContract | null {
  if (r.exch_seg !== "NFO" || !r.token || !r.symbol || !r.name) return null;
  const it = (r.instrumenttype ?? "").toUpperCase();
  const isFut = it === "FUTIDX" || it === "FUTSTK", isOpt = it === "OPTIDX" || it === "OPTSTK";
  if (!isFut && !isOpt) return null;
  const expiry = parseExpiry(r.expiry ?? "");
  if (expiry === null) return null;
  const dte = istDay(expiry) - istDay(now);
  if (dte < 0 || dte > 75) return null;
  const lotSize = Number(r.lotsize);
  if (!(lotSize > 0)) return null;
  let type: FnoContract["type"] = "FUT";
  if (isOpt) {
    const sfx = r.symbol.slice(-2).toUpperCase();
    if (sfx !== "CE" && sfx !== "PE") return null;
    type = sfx;
  }
  const strike = isOpt ? Number(r.strike) / 100 : 0;   // Angel stores strike x 100
  if (isOpt && !(strike > 0)) return null;
  return { token: r.token, symbol: r.symbol, name: r.name.toUpperCase(), type, expiry, strike, lotSize };
}

/* ---------- selection ---------- */
export interface FnoSelection {
  future: FnoContract | null;
  options: { expiryKind: ExpiryLabel; contract: FnoContract }[];
  notes: string[];
}

export function selectFnoContracts(all: FnoContract[], spot: number, side: FnoSide, cfg: FnoConfig, now: number): FnoSelection {
  const today = istDay(now);
  const dte = (ms: number): number => istDay(ms) - today;
  const notes: string[] = [];

  // Future: near month, rolled to the next month in the last 2 days
  const future = all.filter((c) => c.type === "FUT" && dte(c.expiry) >= 3).sort((a, b) => a.expiry - b.expiry)[0] ?? null;

  const right: "CE" | "PE" = side === "LONG" ? "CE" : "PE";
  const expiries = [...new Set(all.filter((c) => c.type === "CE" || c.type === "PE").map((c) => c.expiry))].sort((a, b) => a - b);
  const lastOfMonth = new Map<string, number>();
  for (const e of expiries) lastOfMonth.set(monthKey(e), Math.max(lastOfMonth.get(monthKey(e)) ?? 0, e));
  const hasWeekly = expiries.length >= 2 && expiries[1]! - expiries[0]! <= 8 * DAY;
  const eligible = expiries.filter((e) => dte(e) >= cfg.minDte);
  const monthly = eligible.find((e) => lastOfMonth.get(monthKey(e)) === e);
  const weekly = hasWeekly ? eligible[0] : undefined;

  const wanted: { at: number; kind: ExpiryLabel }[] = [];
  if (cfg.expiries.includes("weekly")) {
    if (weekly !== undefined) wanted.push({ at: weekly, kind: weekly === monthly && cfg.expiries.includes("monthly") ? "weekly+monthly" : "weekly" });
    else notes.push("No weekly options for this underlying (NSE lists weekly options only on NIFTY); monthly is shown.");
  }
  if (cfg.expiries.includes("monthly") && monthly !== undefined && !wanted.some((w) => w.at === monthly)) wanted.push({ at: monthly, kind: "monthly" });
  if (wanted.length === 0 && cfg.expiries.includes("weekly") && monthly !== undefined) wanted.push({ at: monthly, kind: "monthly" });

  const options: FnoSelection["options"] = [];
  for (const w of wanted) {
    const chain = all.filter((c) => c.type === right && c.expiry === w.at).sort((a, b) => a.strike - b.strike);
    if (chain.length === 0) continue;
    let atm = 0;
    for (let i = 1; i < chain.length; i++) if (Math.abs(chain[i]!.strike - spot) < Math.abs(chain[atm]!.strike - spot)) atm = i;
    const itmStep = right === "CE" ? -1 : 1;   // CE is in the money at lower strikes, PE at higher strikes
    const idx = cfg.strike === "ATM" ? atm : cfg.strike === "ITM1" ? atm + itmStep : atm - itmStep;
    options.push({ expiryKind: w.kind, contract: chain[Math.max(0, Math.min(chain.length - 1, idx))]! });
  }
  return { future, options, notes };
}

/* ---------- plan ---------- */
export interface FnoSignalInput {
  symbol: string; direction: FnoSide; spot: number;
  entry: number; stop: number; tp1: number; tp2: number; tp3: number; now: number;
}
export interface FnoLeg {
  kind: "FUTURE" | "OPTION";
  tradingSymbol: string; token: string; exchange: "NFO";
  expiry: string; expiryKind: ExpiryLabel | "monthly"; daysToExpiry: number;
  right?: "CE" | "PE"; strike?: number;
  lotSize: number; ltp: number;
  entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number;
  costPerLot: number;     // options: premium x lot. futures: contract value (not margin)
  riskPerLot: number;     // loss per lot if the stop is hit
  note?: string;
}
export interface FnoPlan { underlying: string; side: FnoSide; spot: number; asOf: number; legs: FnoLeg[]; warnings: string[] }

const r2 = (n: number): number => Math.round(n * 100) / 100;
const tick = (n: number): number => Math.max(0.05, r2(Math.round(n / 0.05) * 0.05));

/** Cash signal -> FnoSignalInput. Null when the signal has no complete trade plan. */
export function fnoInputFromSignal(s: { symbol: string; direction: string; market: { currentPrice: number }; entry: { ideal: number }; stopLoss: { price: number | null }; takeProfit: { tp1: number | null; tp2: number | null; tp3: number | null } }, now: number): FnoSignalInput | null {
  if (s.direction !== "LONG" && s.direction !== "SHORT") return null;
  const { tp1, tp2, tp3 } = s.takeProfit, stop = s.stopLoss.price;
  if (stop === null || tp1 === null || tp2 === null || tp3 === null) return null;
  return { symbol: s.symbol, direction: s.direction, spot: s.market.currentPrice, entry: s.entry.ideal, stop, tp1, tp2, tp3, now };
}

export function buildFnoPlan(input: FnoSignalInput, sel: FnoSelection, ltps: ReadonlyMap<string, number>, cfg: FnoConfig): FnoPlan | null {
  const legs: FnoLeg[] = [];
  const warnings: string[] = [...sel.notes];
  const today = istDay(input.now);
  const riskU = Math.abs(input.entry - input.stop);
  const sideWord = input.direction;

  if (sel.future) {
    const c = sel.future, ltp = ltps.get(c.token);
    if (ltp && ltp > 0) {
      const basis = ltp - input.spot;   // futures trade at a premium/discount to cash: shift the cash levels by it
      legs.push({
        kind: "FUTURE", tradingSymbol: c.symbol, token: c.token, exchange: "NFO", expiry: isoDate(c.expiry), expiryKind: "monthly", daysToExpiry: istDay(c.expiry) - today,
        lotSize: c.lotSize, ltp: r2(ltp),
        entry: tick(input.entry + basis), stopLoss: tick(input.stop + basis), tp1: tick(input.tp1 + basis), tp2: tick(input.tp2 + basis), tp3: tick(input.tp3 + basis),
        costPerLot: r2(ltp * c.lotSize), riskPerLot: r2(riskU * c.lotSize),
        note: `${sideWord} future. Cost shown is contract value, not margin.`,
      });
    }
  }

  const delta = cfg.delta ?? (cfg.strike === "ITM1" ? 0.6 : cfg.strike === "OTM1" ? 0.4 : 0.5);
  for (const o of sel.options) {
    const c = o.contract, prem = ltps.get(c.token);
    if (!prem || !(prem > 0)) continue;
    const dte = istDay(c.expiry) - today;
    const rawSl = prem - delta * riskU;
    const floor = prem * (1 - cfg.maxLossPct / 100);
    const sl = Math.max(rawSl, floor);
    const capped = rawSl < floor;
    const up = (tp: number): number => tick(prem + delta * Math.abs(tp - input.entry));
    const stopLoss = tick(sl);
    legs.push({
      kind: "OPTION", tradingSymbol: c.symbol, token: c.token, exchange: "NFO", expiry: isoDate(c.expiry), expiryKind: o.expiryKind, daysToExpiry: dte,
      right: c.type === "CE" ? "CE" : "PE", strike: c.strike,
      lotSize: c.lotSize, ltp: r2(prem),
      entry: tick(prem), stopLoss, tp1: up(input.tp1), tp2: up(input.tp2), tp3: up(input.tp3),
      costPerLot: r2(prem * c.lotSize), riskPerLot: r2((tick(prem) - stopLoss) * c.lotSize),
      ...(capped ? { note: `Stop capped at -${cfg.maxLossPct}% of premium` } : {}),
    });
    if (o.expiryKind !== "monthly" && dte <= 2) warnings.push(`${c.symbol} expires in ${dte} day(s): theta decay is very fast, keep the trade short.`);
  }

  if (legs.length === 0) return null;
  if (legs.some((l) => l.kind === "OPTION")) warnings.push(`Option stop and targets are estimates from the underlying levels (delta ${delta}), not live greeks. Check spread, volume and open interest in the option chain before entering. Options are buy-only here.`);
  return { underlying: input.symbol, side: input.direction, spot: r2(input.spot), asOf: input.now, legs, warnings };
}

/* ---------- Telegram text ---------- */
const rs = (n: number): string => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs0 = (n: number): string => "₹" + Math.round(n).toLocaleString("en-IN");

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");   // Telegram HTML: symbols like M&M must be escaped

export function fnoTelegram(p: FnoPlan): string {
  const head = `${p.side === "LONG" ? "🟢" : "🔴"}<b>${esc(p.underlying)}</b> F&amp;O ideas (spot ${rs(p.spot)})`;
  const body = p.legs.map((l) => {
    const title = l.kind === "FUTURE"
      ? `📈 <b>FUTURE ${p.side}</b> · ${esc(l.tradingSymbol)}`
      : `${l.right === "CE" ? "🟩" : "🟥"} <b>BUY ${l.right}</b> ${l.strike} · ${l.expiryKind} · exp ${l.expiry} (${l.daysToExpiry}d)`;
    return `${title}\nLot ${l.lotSize} · LTP ${rs(l.ltp)}\nEntry ${rs(l.entry)} · SL ${rs(l.stopLoss)}\nTP1 ${rs(l.tp1)} · TP2 ${rs(l.tp2)} · TP3 ${rs(l.tp3)}\n${l.kind === "OPTION" ? "Cost" : "Value"}/lot ${rs0(l.costPerLot)} · Risk/lot ${rs0(l.riskPerLot)}${l.note ? `\n<i>${l.note}</i>` : ""}`;
  });
  const warn = p.warnings.length ? `\n\n⚠️ ${p.warnings.map(esc).join("\n⚠️ ")}` : "";
  return `${head}\n\n${body.join("\n\n")}${warn}`;
}
