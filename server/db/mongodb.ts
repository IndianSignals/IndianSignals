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
