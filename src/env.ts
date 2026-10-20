import type { Hono } from "hono";
import type { LiveHub } from "./live/live-hub";
import type { Db } from "./db/client";
import type { Logger } from "./lib/logger";

export type Env = {
  HYPERDRIVE: Hyperdrive;
  LIVE_HUB: DurableObjectNamespace<LiveHub>;
  LOG_LEVEL?: string;
  LIVE_TICK_MS?: string;
  PERSIST_MS?: string;
  STOP_REFRESH_MS?: string;
  STOP_EXIT_MARGIN_M?: string;
  STOP_STALE_MS?: string;
  STOP_ARRIVE_MAX_KMH?: string;
  BETTER_AUTH_SECRET: string; // secret: openssl rand -base64 32
  BETTER_AUTH_URL: string; // public origin of this Worker, e.g. https://api.example.com
  TRUSTED_ORIGINS?: string; // comma-separated web app origins (CORS, cookies, publisher WebSocket Origin check)
  ADMIN_EMAILS?: string; // comma-separated; accounts created with these emails get the admin role
  WS_SWEEP_MS?: string; // idle sweep interval (default 30000)
  WS_PUBLISHER_IDLE_MS?: string; // release publisher sockets with no location for this long (default 120000)
  WS_SUBSCRIBER_IDLE_MS?: string; // release subscriber sockets with no message/ping for this long (default 90000)
};

export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; log: Logger; user?: { id: string; role?: string | null; email: string } };
};

export type App = Hono<AppEnv>;

export const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
};

export const csv = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Origins allowed to use credentialed requests / publisher sockets from a browser. */
export const trustedOrigins = (env: Pick<Env, "TRUSTED_ORIGINS" | "BETTER_AUTH_URL">) => {
  const out = new Set(csv(env.TRUSTED_ORIGINS).map((o) => o.replace(/\/$/, "")));
  try {
    out.add(new URL(env.BETTER_AUTH_URL).origin);
  } catch {
    /* validated at startup by Better Auth */
  }
  return out;
};
