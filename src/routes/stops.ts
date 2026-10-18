import { Hono } from "hono";
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { busStops, busStopVisits } from "../db/schema/bus-schema";
import type { Db } from "../db/client";
import { hubOf } from "../lib/hub";
import type { AppEnv } from "../env";

export const stopRoutes = new Hono<AppEnv>();

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---- stops ------------------------------------------------------------------

stopRoutes.get("/stops", async (c) => c.json(await c.get("db").select().from(busStops)));

stopRoutes.post("/stops", async (c) => {
  const b = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const radiusM = b?.radiusM === undefined ? 50 : b.radiusM;

  if (
    !b ||
    typeof b.name !== "string" ||
    !b.name.trim() ||
    b.name.length > 200 ||
    !isNum(b.latitude) ||
    b.latitude < -90 ||
    b.latitude > 90 ||
    !isNum(b.longitude) ||
    b.longitude < -180 ||
    b.longitude > 180 ||
    !isNum(radiusM) ||
    radiusM < 5 ||
    radiusM > 1000
  ) {
    return c.json(
      { error: "name, latitude, longitude required; radiusM optional (5-1000 m, default 50)" },
      400,
    );
  }

  const [stop] = await c
    .get("db")
    .insert(busStops)
    .values({ name: b.name.trim(), latitude: b.latitude, longitude: b.longitude, radiusM })
    .returning();

  // Make the live hub pick up the new stop immediately instead of on its next refresh.
  c.executionCtx.waitUntil(hubOf(c.env).refreshStops().catch(() => {}));
  return c.json(stop, 201);
});

stopRoutes.get("/stops/:id{[0-9]+}", async (c) => {
  const [stop] = await c
    .get("db")
    .select()
    .from(busStops)
    .where(eq(busStops.id, Number(c.req.param("id"))))
    .limit(1);
  return stop ? c.json(stop) : c.json({ error: "Stop not found" }, 404);
});

// ---- visit history ----------------------------------------------------------
// ?from=ISO &to=ISO (filter on arrivedAt)  &limit=1..500 (default 100)
// Newest first. For the next page pass to=<arrivedAt of the last row> (exclusive).

async function queryVisits(
  db: Db,
  q: { busId?: number; stopId?: number; from?: string; to?: string; limit?: string },
) {
  const from = q.from ? Date.parse(q.from) : undefined;
  const to = q.to ? Date.parse(q.to) : undefined;
  if (from !== undefined && !Number.isFinite(from)) return "invalid from";
  if (to !== undefined && !Number.isFinite(to)) return "invalid to";

  const lim = Math.min(Math.max(Math.trunc(Number(q.limit ?? 100)) || 100, 1), 500);

  const rows = await db
    .select({
      id: busStopVisits.id,
      busId: busStopVisits.busId,
      stopId: busStopVisits.stopId,
      stopName: busStops.name,
      arrivedAt: busStopVisits.arrivedAt,
      departedAt: busStopVisits.departedAt,
      distanceM: busStopVisits.distanceM,
    })
    .from(busStopVisits)
    .innerJoin(busStops, eq(busStops.id, busStopVisits.stopId))
    .where(
      and(
        q.busId !== undefined ? eq(busStopVisits.busId, q.busId) : undefined,
        q.stopId !== undefined ? eq(busStopVisits.stopId, q.stopId) : undefined,
        from !== undefined ? gte(busStopVisits.arrivedAt, new Date(from)) : undefined,
        to !== undefined ? lt(busStopVisits.arrivedAt, new Date(to)) : undefined,
      ),
    )
    .orderBy(desc(busStopVisits.arrivedAt))
    .limit(lim);

  return rows.map((r) => ({
    ...r,
    dwellSeconds: r.departedAt
      ? Math.round((r.departedAt.getTime() - r.arrivedAt.getTime()) / 1000)
      : null,
  }));
}

stopRoutes.get("/buses/:id{[0-9]+}/stop-history", async (c) => {
  const stopId = c.req.query("stopId");
  const res = await queryVisits(c.get("db"), {
    busId: Number(c.req.param("id")),
    stopId: stopId ? Number(stopId) : undefined,
    from: c.req.query("from"),
    to: c.req.query("to"),
    limit: c.req.query("limit"),
  });
  return typeof res === "string" ? c.json({ error: res }, 400) : c.json(res);
});

stopRoutes.get("/stops/:id{[0-9]+}/visits", async (c) => {
  const res = await queryVisits(c.get("db"), {
    stopId: Number(c.req.param("id")),
    from: c.req.query("from"),
    to: c.req.query("to"),
    limit: c.req.query("limit"),
  });
  return typeof res === "string" ? c.json({ error: res }, 400) : c.json(res);
});
