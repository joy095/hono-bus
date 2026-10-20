import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { buses, busDrivers } from "../db/schema/bus-schema";
import { connect } from "../db/client";
import { trustedOrigins, type AppEnv } from "../env";
import createAuth from "../lib/auth";
import { hubOf } from "../lib/hub";
import { validBusId } from "../lib/location";
import { CLOSE, HUB_HEADERS } from "../lib/protocol";

export const wsRoutes = new Hono<AppEnv>();

const isUpgrade = (h: string | undefined) => h?.toLowerCase() === "websocket";

/**
 * Browsers can't read the HTTP status of a failed WebSocket handshake, so a client could never tell
 * "not signed in" from "network down" and would retry forever. Instead we complete the handshake and
 * close immediately with an application close code (see CLOSE) the client treats as final.
 */
function refuse(code: number, reason: string) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** Rebuild the request for the hub with only headers we set ourselves (client-sent x-hub-* is never trusted). */
function toHub(req: Request, set: Partial<Record<keyof typeof HUB_HEADERS, string>>) {
  const headers = new Headers(req.headers);
  for (const h of Object.values(HUB_HEADERS)) headers.delete(h);
  for (const [k, v] of Object.entries(set)) headers.set(HUB_HEADERS[k as keyof typeof HUB_HEADERS], v);
  return new Request(req, { headers });
}

// ---- public, read-only --------------------------------------------------------------
// ws(s)://host/ws[?busId=1]          no credentials needed
//  -> {"op":"sub","busIds":[1,2],"cells":["259:1551"]}   (also "unsub")
//  <- {"type":"hello", ...}  {"type":"location", busId, ...}  {"type":"locations", cell, items:[[busId,lat,lng,speedKmh,ms],...]}
// Keepalive: send the text "ping" every ~25s; the hub answers "pong" without waking up.
wsRoutes.get("/ws", (c) => {
  if (!isUpgrade(c.req.header("upgrade"))) return c.json({ error: "Expected WebSocket upgrade" }, 426);

  const param = c.req.query("busId");
  if (param !== undefined && !validBusId(Number(param))) return c.json({ error: "Invalid busId" }, 400);

  return hubOf(c.env).fetch(toHub(c.req.raw, {}));
});

// ---- authenticated publisher: the only way to update a bus location -------------------
// ws(s)://host/ws/publish?busId=1     cookie session (browser) or `Authorization: Bearer <token>` (native app)
//  -> {"op":"loc","latitude":12.97,"longitude":77.59,"speedKmh":31,"recordedAt":"...","id":"7"}
//  -> {"op":"locs","items":[{...},{...}],"id":"8"}          (backlog flushed after a reconnect)
//  <- {"type":"ack","id":"7","accepted":1,"applied":1,"rejected":[]}
// Allowed for: admins, and users assigned to the bus in bus_drivers.
wsRoutes.get("/ws/publish", async (c) => {
  if (!isUpgrade(c.req.header("upgrade"))) return c.json({ error: "Expected WebSocket upgrade" }, 426);

  const busId = Number(c.req.query("busId"));
  if (!validBusId(busId)) return refuse(CLOSE.BAD_REQUEST, "invalid busId");

  // CSWSH guard: a browser always sends Origin; cookies must not be usable from a foreign site.
  const origin = c.req.header("origin");
  if (origin && !trustedOrigins(c.env).has(origin)) return refuse(CLOSE.FORBIDDEN, "origin not allowed");

  const conn = connect(c.env);
  let userId: string;
  let expiresAt: number;
  try {
    const session = await createAuth(c.env, conn.db).api.getSession({ headers: c.req.raw.headers });
    if (!session) return refuse(CLOSE.UNAUTHORIZED, "sign in required");
    if (session.user.banned) return refuse(CLOSE.FORBIDDEN, "account disabled");

    userId = session.user.id;
    expiresAt = new Date(session.session.expiresAt).getTime();

    const [bus] = await conn.db.select({ id: buses.id }).from(buses).where(eq(buses.id, busId)).limit(1);
    if (!bus) return refuse(CLOSE.NOT_FOUND, "unknown bus");

    if (session.user.role !== "admin") {
      const [assigned] = await conn.db
        .select({ busId: busDrivers.busId })
        .from(busDrivers)
        .where(and(eq(busDrivers.busId, busId), eq(busDrivers.userId, userId)))
        .limit(1);
      if (!assigned) return refuse(CLOSE.FORBIDDEN, "not assigned to this bus");
    }
  } catch (err) {
    c.get("log").error("publisher auth failed", err instanceof Error ? err : { err });
    return c.json({ error: "Service unavailable" }, 503, { "Retry-After": "2" }); // transient: client backs off and retries
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }

  return hubOf(c.env).fetch(
    toHub(c.req.raw, {
      role: "publisher",
      bus: String(busId),
      user: userId,
      exp: String(expiresAt),
    }),
  );
});
