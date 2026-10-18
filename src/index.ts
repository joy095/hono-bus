import { Hono } from "hono";
import { connect } from "./db/client";
import { knownBusCount } from "./db/bus-registry";
import { busRoutes } from "./routes/buses";
import { locationRoutes } from "./routes/locations";
import { stopRoutes } from "./routes/stops";
import { hubOf } from "./lib/hub";
import { createLogger, parseLevel } from "./lib/logger";
import type { AppEnv } from "./env";
import createAuth from "./lib/auth";

export { LiveHub } from "./live/live-hub";

const app = new Hono<AppEnv>();

const HOT_PATH = /^\/api\/(buses\/\d+\/location|locations\/batch)$/;
const SLOW_MS = 1000;

app.all("/api/auth/*", async (c) => {
  const { sql, db } = connect(c.env);

  try {
    const auth = createAuth(db);

    return await auth.handler(c.req.raw);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
});

// ---- request logging + request id --------------------------------------------
app.use("*", async (c, next) => {
  const start = performance.now();
  const reqId = (c.req.header("x-request-id") ?? crypto.randomUUID()).slice(
    0,
    128,
  );
  const url = new URL(c.req.url);
  const log = createLogger(parseLevel(c.env.LOG_LEVEL), {
    reqId,
    ip: c.req.header("cf-connecting-ip"),
  });
  c.set("log", log);

  await next();

  // Responses forwarded from the Durable Object (incl. the 101 upgrade) have immutable headers.
  if (c.res.status !== 101) {
    try {
      c.res.headers.set("x-request-id", reqId);
    } catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("x-request-id", reqId);
    }
  }
  const ms = Math.round((performance.now() - start) * 100) / 100;
  const status = c.res.status;
  const level =
    status >= 500 ? "error" : status >= 400 || ms > SLOW_MS ? "warn" : "info";
  const quiet =
    url.pathname === "/health" ||
    url.pathname === "/stats" ||
    (c.req.method === "POST" && HOT_PATH.test(url.pathname));

  if (!(level === "info" && quiet)) {
    log[level](`${c.req.method} ${url.pathname}`, {
      status,
      ms,
      ua: c.req.header("user-agent"),
    });
  }
});

// ---- optional auth for writes (set INGEST_TOKEN as a Worker secret) -----------
async function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return (crypto.subtle as any).timingSafeEqual(ha, hb) as boolean;
}

app.use("/api/*", async (c, next) => {
  const token = c.env.INGEST_TOKEN;
  if (token && c.req.method !== "GET") {
    const given =
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!(await safeEqual(given, token)))
      return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// ---- DB connection per request ------------------------------------------------
app.use("/api/*", async (c, next) => {
  const conn = connect(c.env);
  c.set("db", conn.db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
});

app.route("/api", busRoutes);
app.route("/api", locationRoutes);
app.route("/api", stopRoutes);

// ---- websocket: forwarded to the Durable Object -------------------------------
// ws://host/ws?busId=1   (busId optional; subscribe later with messages)
// -> {"op":"sub","busIds":[1,2],"cells":["259:1551"]}   (also "unsub")
// <- {"type":"location", busId, latitude, longitude, speedKmh, recordedAt}
// <- {"type":"locations", cell, items:[[busId,lat,lng,speedKmh,recordedAtMs],...]}
app.get("/ws", (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }
  const param = c.req.query("busId");
  if (param !== undefined) {
    const id = Number(param);
    if (!Number.isSafeInteger(id) || id < 1)
      return c.json({ error: "Invalid busId" }, 400);
  }
  return hubOf(c.env).fetch(c.req.raw);
});

app.get("/health", (c) => c.json({ status: "ok", service: "bus-tracking" }));

app.get("/stats", async (c) =>
  c.json({
    hub: await hubOf(c.env).stats(),
    busesCachedInIsolate: knownBusCount(),
  }),
);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  c.get("log")?.error("request failed", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
