import { describe, expect, it } from "vitest";
import { AngelMarketData, totp } from "../server/engine/angelMarketData.js";
import { isMarketOpen, isTradingDay, roundToTick } from "../shared/indianMarket.js";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("TOTP (RFC 6238 vectors, SHA1)", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
  it("matches the RFC test values", () => {
    expect(totp(secret, 59_000)).toBe("287082");
    expect(totp(secret, 1_111_111_109_000)).toBe("081804");
  });
});

describe("NSE hours", () => {
  const ist = (s: string): number => Date.parse(`${s}+05:30`);
  it("open 09:15-15:30 IST on weekdays only", () => {
    expect(isMarketOpen(ist("2026-10-19T09:14:00"), {})).toBe(false);
    expect(isMarketOpen(ist("2026-10-19T09:15:00"), {})).toBe(true);
    expect(isMarketOpen(ist("2026-10-19T15:29:00"), {})).toBe(true);
    expect(isMarketOpen(ist("2026-10-19T15:30:00"), {})).toBe(false);
    expect(isMarketOpen(ist("2026-10-17T11:00:00"), {})).toBe(false); // Saturday
  });
  it("respects NSE_HOLIDAYS", () => {
    expect(isTradingDay(ist("2026-10-20T11:00:00"), { NSE_HOLIDAYS: "2026-10-20" })).toBe(false);
  });
  it("rounds to the 0.05 tick", () => expect(roundToTick(100.07)).toBe(100.05));
});

describe("AngelMarketData with a mocked API", () => {
  it("logs in with TOTP, fetches closed candles and an LTP", async () => {
    Object.assign(process.env, { ANGEL_API_KEY: "k", ANGEL_CLIENT_CODE: "C1", ANGEL_PASSWORD: "1234", ANGEL_TOTP_SECRET: "GEZDGNBVGY3TQOJQ", ANGEL_TOKENS: "RELIANCE:2885" });
    const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
    const now = Date.parse("2026-10-19T10:30:00+05:30");
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body, auth: (init?.headers as Record<string, string>)?.Authorization });
      if (url.includes("loginByPassword")) return json({ status: true, data: { jwtToken: "JWT" } });
      if (url.includes("getCandleData")) return json({ status: true, data: [
        ["2026-10-19T09:15:00+05:30", 100, 102, 99, 101, 1000],
        ["2026-10-19T09:30:00+05:30", 101, 103, 100, 102, 900],
        ["2026-10-19T10:15:00+05:30", 102, 104, 101, 103, 800], // still forming at 10:30? no, closed at 10:30
        ["2026-10-19T10:30:00+05:30", 103, 105, 102, 104, 700], // forming
      ] });
      if (url.includes("market/v1/quote")) return json({ status: true, data: { fetched: [{ ltp: 2950.5, percentChange: 1.2, tradeVolume: 1000, depth: { buy: [{ price: 2950, quantity: 10 }], sell: [{ price: 2950.1, quantity: 30 }] } }] } });
      return json({ status: false, message: "unexpected" }, 404);
    }) as unknown as typeof fetch;

    const md = new AngelMarketData(5000, fetchFn);
    const candles = await md.getCandles("RELIANCE", "15m", 10, now);
    expect(candles.map((c) => c.close)).toEqual([101, 102, 103]); // forming 10:30 bar dropped
    expect(calls[0]!.url).toContain("loginByPassword");
    expect(calls[0]!.body.clientcode).toBe("C1");
    expect(String(calls[0]!.body.totp)).toMatch(/^\d{6}$/);
    expect(calls.find((c) => c.url.includes("getCandleData"))!.auth).toBe("Bearer JWT");
    expect(calls.find((c) => c.url.includes("getCandleData"))!.body).toMatchObject({ exchange: "NSE", symboltoken: "2885", interval: "FIFTEEN_MINUTE" });

    expect((await md.lastPrices(["RELIANCE"])).RELIANCE).toBe(2950.5);
    const d = await md.getDerivatives("RELIANCE", "15m");
    expect(d.fundingRate).toBeNull();
    expect(d.bookImbalance).toBeCloseTo(-0.5);
  });

  it("fails clearly without credentials", async () => {
    delete process.env.ANGEL_API_KEY;
    const md = new AngelMarketData(1000, (async () => json({})) as unknown as typeof fetch);
    await expect(md.getCandles("RELIANCE", "15m", 5, Date.now())).rejects.toThrow(/credentials missing/);
  });
});
