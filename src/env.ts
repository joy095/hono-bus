import type { Hono } from "hono";
import type { LiveHub } from "./live/live-hub";
import type { Db } from "./db/client";
import type { Logger } from "./lib/logger";

export type Env = {
  HYPERDRIVE: Hyperdrive;
  LIVE_HUB: DurableObjectNamespace<LiveHub>;
  INGEST_TOKEN?: string;
  LOG_LEVEL?: string;
  LIVE_TICK_MS?: string;
  PERSIST_MS?: string;
  STOP_REFRESH_MS?: string;
  STOP_EXIT_MARGIN_M?: string;
  STOP_STALE_MS?: string;
  STOP_ARRIVE_MAX_KMH?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; log: Logger };
};

export type App = Hono<AppEnv>;

export const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
};
