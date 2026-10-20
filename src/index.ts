import { Hono } from "hono";
import { cors } from "hono/cors";
import { connect } from "./db/client";
import { knownBusCount } from "./db/bus-registry";
import { busRoutes } from "./routes/buses";
import { locationRoutes } from "./routes/locations";
import { stopRoutes } from "./routes/stops";
import { driverRoutes } from "./routes/drivers";
import { wsRoutes } from "./routes/ws";
import { hubOf } from "./lib/hub";
import { createLogger, parseLevel } from "./lib/logger";
import { trustedOrigins, type AppEnv } from "./env";
import createAuth from "./lib/auth";

export { LiveHub } from "./live/live-hub";

const app = new Hono<AppEnv>();

const SLOW_MS = 1000;

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
    url.pathname === "/stats";

  if (!(level === "info" && quiet)) {
    log[level](`${c.req.method} ${url.pathname}`, {
      status,
      ms,
      ua: c.req.header("user-agent"),
    });
  }
});

// ---- CORS (credentialed, only for trusted web-app origins) ---------------------------
app.use("/api/*", (c, next) =>
  cors({
    origin: (origin) => (trustedOrigins(c.env).has(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["content-type", "authorization", "x-request-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["set-auth-token", "x-request-id"],
    maxAge: 600,
  })(c, next),
);

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

// ---- Better Auth: /api/auth/* (sign-in, sign-up, sessions, admin plugin) --------------
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env, c.get("db")).handler(c.req.raw));

// ---- write guard: every non-GET request (and driver lists) needs an admin session -----
// Live location is NOT written over HTTP at all; see routes/ws.ts (/ws/publish).
const READ = new Set(["GET", "HEAD", "OPTIONS"]);
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/auth/")) return next();
  if (READ.has(c.req.method) && !/\/drivers(\/|$)/.test(path)) return next();

  const session = await createAuth(c.env, c.get("db")).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (session.user.banned || session.user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  c.set("user", { id: session.user.id, email: session.user.email, role: session.user.role });
  await next();
});

app.route("/api", busRoutes);
app.route("/api", locationRoutes);
app.route("/api", stopRoutes);
app.route("/api", driverRoutes);

// ---- websockets: public subscriber (/ws) + authenticated publisher (/ws/publish) -----
app.route("/", wsRoutes);

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
