import type { Db } from "mongodb";
import type { FinalSignal } from "../models/signal.js";
import type { SignalStore } from "./store.js";
import { inr, tgSend } from "./tracker.js";
import { IST_OFFSET_MS, isTradingDay, istParts } from "../../shared/indianMarket.js";

/**
 * Daily Telegram report, sent once after the market closes (default 15:40 IST, trading days only).
 * Env: DAILY_SUMMARY=false (turn off), DAILY_SUMMARY_TIME=08:40 (IST), DAILY_SUMMARY_TEST=true (send once at boot).
 */
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LINE = "━━━━━━━━━━━━━━━━━━";
const MAX_ROWS = 14;   // keeps one message under Telegram's 4096 character limit

type Result = "WIN" | "LOSS" | "BE" | "RUNNING" | "PENDING" | "SKIPPED";
interface Row { s: FinalSignal; result: Result; r: number | null; tag: string }

const dirSign = (s: FinalSignal): number => (s.direction === "LONG" ? 1 : -1);

/** R multiple of a finished trade, measured at the exit price. */
function rOf(s: FinalSignal, exit: number): number | null {
  const sl = s.stopLoss.price;
  if (sl === null) return null;
  const risk = Math.abs(s.entry.ideal - sl);
  if (!(risk > 0)) return null;
  return (dirSign(s) * (exit - s.entry.ideal)) / risk;
}

export function classify(s: FinalSignal): Row {
  const o = s.outcome;
  if (o?.closed) {
    const r = rOf(s, o.exit);
    if (o.status === "BE_HIT" || (r !== null && Math.abs(r) < 0.05)) return { s, result: "BE", r: 0, tag: "Breakeven" };
    if (o.status === "SL_HIT") return { s, result: "LOSS", r: r ?? -1, tag: "Stop-loss hit" };
    const n = o.status === "TP3_HIT" ? 3 : o.status === "TP2_HIT" ? 2 : 1;
    if (r !== null && r < 0) return { s, result: "LOSS", r, tag: "Trailing stop" };
    return { s, result: "WIN", r, tag: n === 3 ? "All 3 targets" : `TP${n} hit, then trailed out` };
  }
  if (o && (o.status === "TP1_HIT" || o.status === "TP2_HIT")) {
    return { s, result: "RUNNING", r: null, tag: `${o.status === "TP2_HIT" ? "TP2" : "TP1"} hit, still open` };
  }
  if (s.status === "CANCELLED" || s.status === "EXPIRED") return { s, result: "SKIPPED", r: null, tag: "Entry never triggered" };
  if (s.entered) return { s, result: "RUNNING", r: null, tag: "In trade" };
  return { s, result: "PENDING", r: null, tag: "Waiting for entry" };
}

const signedR = (r: number): string => `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)}R`;
const bar = (pct: number): string => { const f = Math.max(0, Math.min(10, Math.round(pct / 10))); return "▰".repeat(f) + "▱".repeat(10 - f); };
const icon: Record<Result, string> = { WIN: "✅", LOSS: "❌", BE: "➖", RUNNING: "⏳", PENDING: "🕒", SKIPPED: "⚪" };

const dateLabel = (ms: number): string =>
  new Date(ms + IST_OFFSET_MS).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** Signals created on the given IST day (yyyy-mm-dd), real trade signals only. */
export function signalsOfDay(all: FinalSignal[], ymd: string): FinalSignal[] {
  return all
    .filter((s) => (s.direction === "LONG" || s.direction === "SHORT") && istParts(Date.parse(s.timestamps.createdAt)).ymd === ymd)
    .sort((a, b) => a.timestamps.createdAt.localeCompare(b.timestamps.createdAt));
}

/** The last trading day before `now` (Monday morning -> Friday). */
export function prevTradingDay(now: number = Date.now()): number {
  for (let i = 1; i <= 10; i++) {
    const t = now - i * 86_400_000;
    if (isTradingDay(t, process.env)) return t;
  }
  return now - 86_400_000;
}

/** `reportDay` = any timestamp inside the IST day to report on (default: the previous trading day). */
export function buildDailySummary(all: FinalSignal[], now: number = Date.now(), reportDay: number = prevTradingDay(now)): string {
  const day = istParts(reportDay).ymd;
  const rows = signalsOfDay(all, day).map(classify);
  const head = `📊 <b>DAILY SIGNAL REPORT</b>\n🗓 ${dateLabel(reportDay)} · Previous session recap 🌅\n${LINE}`;
  const foot = `\n${LINE}\n⚠️ <i>Not financial advice. Results are measured on signal levels, not actual orders.</i>`;
  if (rows.length === 0) return `${head}\n\n😴 <b>Us din koi signal nahi bana.</b>\nNo-trade days are part of the game — capital safe hai.${foot}`;

  const count = (r: Result): number => rows.filter((x) => x.result === r).length;
  const wins = count("WIN"), losses = count("LOSS"), be = count("BE"), open = count("RUNNING"), pend = count("PENDING"), skip = count("SKIPPED");
  const closed = wins + losses + be;
  const net = rows.reduce((t, x) => t + (x.r ?? 0), 0);
  const winRate = closed > 0 ? Math.round((wins / closed) * 100) : null;
  const mood = closed === 0 ? "📈" : net > 0 ? "🔥" : net < 0 ? "🧊" : "⚖️";

  const lines: string[] = [head, ""];
  lines.push(`🧾 Signals: <b>${rows.length}</b>`);
  lines.push(`✅ ${wins} Win   ❌ ${losses} Loss   ➖ ${be} BE   ⏳ ${open} Open${pend + skip ? `   ⚪ ${pend + skip} Not triggered` : ""}`);
  lines.push("");
  lines.push(winRate === null ? "🎯 Win rate: <b>—</b> (no closed trade yet)" : `🎯 Win rate: <b>${winRate}%</b>\n${bar(winRate)}`);
  if (closed > 0) lines.push(`${mood} Net result: <b>${signedR(net)}</b>`);

  const done = rows.filter((x) => x.r !== null && x.result !== "BE");
  if (done.length > 0) {
    const best = done.reduce((a, b) => ((b.r ?? 0) > (a.r ?? 0) ? b : a));
    const worst = done.reduce((a, b) => ((b.r ?? 0) < (a.r ?? 0) ? b : a));
    lines.push("");
    if ((best.r ?? 0) > 0) lines.push(`🏆 Best: <b>${esc(best.s.symbol)}</b> ${signedR(best.r ?? 0)}`);
    if ((worst.r ?? 0) < 0) lines.push(`💔 Worst: <b>${esc(worst.s.symbol)}</b> ${signedR(worst.r ?? 0)}`);
  }

  lines.push("", LINE, "📋 <b>Signal by signal</b>", "");
  for (const x of rows.slice(0, MAX_ROWS)) {
    const dot = x.s.direction === "LONG" ? "🟢" : "🔴";
    const res = x.r !== null ? ` <b>${signedR(x.r)}</b>` : "";
    lines.push(`${dot} <b>${esc(x.s.symbol)}</b> ${x.s.direction} · ⭐${x.s.score.total}\n    ${icon[x.result]} ${x.tag}${res}`);
  }
  if (rows.length > MAX_ROWS) lines.push(`… +${rows.length - MAX_ROWS} more`);

  const live = rows.filter((x) => x.result === "RUNNING" || x.result === "PENDING");
  if (live.length > 0) {
    lines.push("", LINE, "🔭 <b>Still alive (carry-over)</b>", "");
    for (const x of live.slice(0, 6)) {
      lines.push(`${x.result === "RUNNING" ? "⏳" : "🕒"} ${esc(x.s.symbol)} ${x.s.direction} · Entry ${inr(x.s.entry.ideal)} · SL ${inr(x.s.stopLoss.price)} · TP1 ${inr(x.s.takeProfit.tp1)}`);
    }
  }
  lines.push(foot);
  return lines.join("\n");
}

export async function sendDailySummary(store: SignalStore, now: number = Date.now(), reportDay: number = prevTradingDay(now)): Promise<string> {
  const all = await store.listHistory({ limit: 500 });
  const text = buildDailySummary(all, now, reportDay);
  const res = await tgSend(text);
  console.log(`[daily-summary] ${res}`);
  return res;
}

/** One report per day, even across restarts / several instances: the first one to insert today's marker wins. */
async function claimDay(db: Db | undefined, ymd: string): Promise<boolean> {
  if (!db) return true;
  try {
    await db.collection<{ _id: string }>("daily_summary").insertOne({ _id: ymd, at: new Date() } as never);
    return true;
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) console.warn("[daily-summary] marker failed, skipping:", e instanceof Error ? e.message : e);
    return false;   // already sent today (or database trouble: better no report than a duplicate)
  }
}
async function releaseDay(db: Db | undefined, ymd: string): Promise<void> {
  if (db) await db.collection<{ _id: string }>("daily_summary").deleteOne({ _id: ymd } as never).catch(() => undefined);
}

export function startDailySummary(store: SignalStore, db?: Db): void {
  if ((process.env.DAILY_SUMMARY ?? "true").toLowerCase() === "false") return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(process.env.DAILY_SUMMARY_TIME ?? "08:40");
  const at = m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : 08 * 60 + 40;
    let lastSent = "";
  let fails = 0;
  if ((process.env.DAILY_SUMMARY_TEST ?? "").toLowerCase() === "true") void sendDailySummary(store).catch((e: unknown) => console.warn("[daily-summary] test failed:", e));
  setInterval(() => {
    const now = Date.now();
    const { ymd, minutes } = istParts(now);
    // Window of 60 min after the set time: a restart later than that will not resend an old report.
    if (ymd === lastSent || !isTradingDay(now, process.env) || minutes < at || minutes >= at + 60) return;
        lastSent = ymd;
    void (async () => {
      if (!(await claimDay(db, ymd))) return;
      const res = await sendDailySummary(store, now).catch((e: unknown) => { console.warn("[daily-summary] failed:", e); return "failed"; });
      if (res === "failed" && ++fails < 3) { await releaseDay(db, ymd); lastSent = ""; }   // Telegram refused: try again in 30s, 3 times at most
    })();
  }, 30_000).unref();
  console.log(`[daily-summary] Telegram report every trading day at ${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")} IST`);
}
