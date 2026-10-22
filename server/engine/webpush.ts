import { createHash, createPrivateKey, generateKeyPairSync, sign, type JsonWebKeyInput } from "node:crypto";
import type { Db, Document } from "mongodb";

/**
 * Web Push to phones/browsers that tapped "Enable alerts" on the site. Zero dependencies.
 * Push is sent WITHOUT a payload (no encryption needed); the service worker then asks GET /push/latest for the text.
 * VAPID keys are created once and kept in MongoDB (collection push_config), so nothing has to be set in Render.
 */

export interface PushItem { id: number; title: string; body: string; at: number; to?: string }

const ALLOWED_HOSTS = ["googleapis.com", "mozilla.com", "push.apple.com", "windows.com"];   // real push services only (blocks SSRF)
const MAX_SUBS = 500;
const b64u = (b: Buffer): string => b.toString("base64url");
export const endpointHash = (endpoint: string): string => createHash("sha1").update(endpoint).digest("hex").slice(0, 16);

export function isPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 600) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

let db: Db | null = null;
let publicKey = "";
type Jwk = JsonWebKeyInput["key"];
let privateJwk: Jwk | null = null;
const items: PushItem[] = [];
let lastId = 0;
const recent = new Map<string, number>();   // text -> time, so a Telegram retry does not buzz the phone twice

const subs = (): ReturnType<Db["collection"]> => db!.collection("push_subs");

export async function initPush(database: Db): Promise<void> {
  db = database;
  const cfg = database.collection<Document>("push_config");
  const doc = await cfg.findOne({ _id: "vapid" as never });
  if (doc?.publicKey && doc?.privateJwk) {
    publicKey = String(doc.publicKey);
    privateJwk = doc.privateJwk as Jwk;
  } else {
    const { privateKey, publicKey: pub } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const p = pub.export({ format: "jwk" }), k = privateKey.export({ format: "jwk" });
    publicKey = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(String(p.x), "base64url"), Buffer.from(String(p.y), "base64url")]));
    privateJwk = k;
    await cfg.replaceOne({ _id: "vapid" as never }, { _id: "vapid", publicKey, privateJwk, createdAt: new Date() } as never, { upsert: true });
    console.log("[push] VAPID keys created");
  }
  console.log(`[push] ready, ${await subs().countDocuments()} subscribed device(s)`);
}

export const pushReady = (): boolean => db !== null && privateJwk !== null;
export const vapidPublicKey = (): string => publicKey;

export async function addSub(endpoint: string): Promise<boolean> {
  if (!pushReady()) return false;
  if (!(await subs().findOne({ _id: endpoint as never })) && (await subs().countDocuments()) >= MAX_SUBS) return false;
  await subs().updateOne({ _id: endpoint as never }, { $set: { at: new Date() } }, { upsert: true });
  return true;
}
export async function removeSub(endpoint: string): Promise<void> { if (pushReady()) await subs().deleteOne({ _id: endpoint as never }); }
export async function hasSub(endpoint: string): Promise<boolean> { return pushReady() && !!(await subs().findOne({ _id: endpoint as never })); }

/** VAPID JWT (ES256). */
function vapidHeader(endpoint: string): string {
  const aud = new URL(endpoint).origin;
  const enc = (o: object): string => b64u(Buffer.from(JSON.stringify(o)));
  const data = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:admin@indiansignals.github.io" })}`;
  const sig = sign("sha256", Buffer.from(data), { key: createPrivateKey({ key: privateJwk!, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${data}.${b64u(sig)}, k=${publicKey}`;
}

async function sendOne(endpoint: string): Promise<void> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: vapidHeader(endpoint), TTL: "3600", Urgency: "high", "Content-Length": "0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) await removeSub(endpoint);   // phone unsubscribed or app removed
    else if (!res.ok) console.warn(`[push] ${new URL(endpoint).hostname} answered HTTP ${res.status}`);
  } catch (e) { console.warn(`[push] send failed: ${e instanceof Error ? e.message : String(e)}`); }
}

function remember(title: string, body: string, to?: string): void {
  lastId = Math.max(lastId + 1, Date.now());
  items.push({ id: lastId, title, body, at: Date.now(), ...(to ? { to } : {}) });
  while (items.length > 20) items.shift();
}

/** What a device has not seen yet (newer than `since`, last 30 min). Test alerts go only to the device that asked. */
export function latestFor(since: number, device: string): PushItem[] {
  const min = Date.now() - 30 * 60_000;
  return items.filter((i) => i.id > since && i.at >= min && (!i.to || i.to === device)).slice(-5);
}

export async function notifyAll(title: string, body: string): Promise<void> {
  if (!pushReady()) return;
  const key = `${title}|${body}`, now = Date.now();
  for (const [k, t] of recent) if (now - t > 10 * 60_000) recent.delete(k);
  if (recent.has(key)) return;
  recent.set(key, now);
  remember(title, body);
  const list = await subs().find({}).limit(MAX_SUBS).toArray();
  await Promise.all(list.map((s) => sendOne(String(s._id))));
}

export async function notifyOne(endpoint: string, title: string, body: string): Promise<void> {
  if (!pushReady()) return;
  remember(title, body, endpointHash(endpoint));
  await sendOne(endpoint);
}

/** Turns a Telegram HTML message into a short phone notification. */
export function pushFromTelegram(html: string): void {
  const lines = html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map((l) => l.trim()).filter((l) => l && !/^⚠/.test(l));
  if (lines.length === 0) return;
  void notifyAll(lines[0]!.slice(0, 80), lines.slice(1).join(" · ").slice(0, 220)).catch((e: unknown) => console.warn(`[push] ${e instanceof Error ? e.message : String(e)}`));
}
