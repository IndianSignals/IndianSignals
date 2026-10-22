import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";

import type { ServerConfig } from "./config/env.js";
import authRouter from "./routes/auth.js";
import { getMongoDB } from "./db/mongodb.js";
import signalsRouter from "./routes/signals.js";
import candlesRouter from "./routes/candles.js";
import pricesRouter from "./routes/prices.js";
import pushRouter from "./routes/push.js";

import { createEngineRouter } from "./routes/engine.js";
import { createBacktestRouter } from "./engine/backtestReport.js";
import type { EngineService } from "./engine/scanner.js";
import type { SignalStore } from "./engine/store.js";
import { createSettingsRouter } from "./routes/settings.js";
import type { SettingsService } from "./engine/settingsStore.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { PresetService } from "./engine/presetStore.js";

export interface AppDeps {
  engine?: EngineService;
  store?: SignalStore;
  settings?: SettingsService;
  presets?: PresetService;
}

export function createApp(config: ServerConfig, deps: AppDeps = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // CORS (frontend on GitHub Pages -> API on Render)
  const allowedOrigins = config.corsOrigins.length
    ? config.corsOrigins
    : ["https://indiansignals.github.io"];

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  });

  app.use(express.json({ limit: "100kb" }));

  // Health check
  app.get("/api/v1/health", async (_req, res) => {
    try {
      await getMongoDB().command({ ping: 1 });
      res.json({ status: "ok", database: "connected" });
    } catch {
      res.status(503).json({ status: "degraded", database: "disconnected" });
    }
  });

  // Admin login
  app.use("/api/v1", authRouter);
  app.use("/api/v1", signalsRouter);
  app.use("/api/v1", candlesRouter);
    app.use("/api/v1", pricesRouter);
  app.use("/api/v1", pushRouter);

  if (deps.engine && deps.store) app.use("/api/v1", createEngineRouter(deps.engine, deps.store));
  if (deps.settings) app.use("/api/v1", createSettingsRouter(deps.settings, deps.presets));
  app.use("/engine", createBacktestRouter(config.scan, deps.settings));

    // Serve the built frontend (dist/web) + SPA fallback
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir));
    app.get(/^\/(?!api\/|engine\/).*/, (_req, res) => {
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  // 404
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  // Error handler
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      console.error("Server error:", err);

      res.status(500).json({
        error: {
          code: "internal_error",
          message: "Internal server error",
        },
      });
    }
  );

  return app;
}
