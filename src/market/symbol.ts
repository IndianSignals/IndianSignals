/**
 * Route symbol -> NSE symbol, e.g. "reliance" | "RELIANCE.NS" | "NSE:RELIANCE" | "nifty 50" -> "RELIANCE" | "NIFTY".
 * Output matches the server's SYMBOL_RE (/^[A-Z0-9&-]{1,20}$/ in server/config/env.ts);
 * the frontend may not import server code, so the rule is mirrored here.
 * Returns null when the input cannot be a symbol (the UI then shows the empty state).
 */
const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;

export const DEFAULT_SYMBOL = "NIFTY";

/** Index names people type -> the symbol the server knows. Compared after removing spaces, "_" and "-". */
const ALIASES: Readonly<Record<string, string>> = {
  NIFTY50: "NIFTY",
  NIFTY: "NIFTY",
  NIFTYBANK: "BANKNIFTY",
  BANKNIFTY: "BANKNIFTY",
  NIFTYFINSERVICE: "FINNIFTY",
  FINNIFTY: "FINNIFTY",
  NIFTYMIDCAPSELECT: "MIDCPNIFTY",
    MIDCPNIFTY: "MIDCPNIFTY",
  SENSEX: "SENSEX",
  BSESENSEX: "SENSEX",
  CRUDE: "CRUDEOIL",
  CRUDEOIL: "CRUDEOIL",
  NATGAS: "NATURALGAS",
  NATURALGAS: "NATURALGAS",
};
const INDICES: ReadonlySet<string> = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);

export function normalizeSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/^NSE:/, "").replace(/\.NS$/, "").replace(/-EQ$/, "");
  const alias = ALIASES[s.replace(/[\s_-]/g, "")];
  if (alias) return alias;
  const t = s.replace(/[\s_]/g, ""); // keeps "&" and "-": M&M, BAJAJ-AUTO
  return SYMBOL_RE.test(t) ? t : null;
}

/** NIFTY, BANKNIFTY ... are index levels in points, not rupee prices. */
export const isIndexSymbol = (s: string): boolean => INDICES.has(s);

/** Display label. NSE symbols are shown as they are ("RELIANCE"); the view adds an NSE tag. */
export const displaySymbol = (s: string): string => s;
