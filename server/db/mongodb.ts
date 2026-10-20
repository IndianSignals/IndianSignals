import { MongoClient, Db } from "mongodb";
import bcrypt from "bcryptjs";

let client: MongoClient | null = null;
let db: Db | null = null;

/** The URI is read when connecting, not at import time, so modules that only import this file do not crash without MongoDB. */
export async function connectMongoDB(): Promise<Db> {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is missing");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || "indiansignals");
  console.log("[mongodb] connected");
  return db;
}

export function getMongoDB(): Db {
  if (!db) throw new Error("MongoDB is not connected");
  return db;
}

/** Creates the admin login from ADMIN_EMAIL / ADMIN_PASSWORD if it does not exist yet. Never overwrites an existing user. */
export async function ensureAdminUser(database: Db): Promise<void> {
  const users = database.collection("users");
  try {
    await users.createIndex({ email: 1 }, { unique: true });
  } catch (e) {
    console.warn("[auth] users index not created:", e);
  }
  const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return;
  if (password.length < 8) {
    console.warn("[auth] ADMIN_PASSWORD must be at least 8 chars, admin not created");
    return;
  }
  if (await users.findOne({ email })) return;
  await users.insertOne({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "admin",
    createdAt: new Date(),
  });
  console.log(`[auth] admin user created: ${email}`);
}
