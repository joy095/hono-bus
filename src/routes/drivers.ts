import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { busDrivers, buses } from "../db/schema/bus-schema";
import { user } from "../db/schema/auth-schema";
import type { AppEnv } from "../env";

/** Admin-only (enforced by the /api write guard for PUT/DELETE; GET is guarded below). */
export const driverRoutes = new Hono<AppEnv>();

driverRoutes.get("/buses/:id{[0-9]+}/drivers", async (c) => {
  if (c.get("user")?.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const rows = await c
    .get("db")
    .select({ userId: user.id, name: user.name, email: user.email })
    .from(busDrivers)
    .innerJoin(user, eq(user.id, busDrivers.userId))
    .where(eq(busDrivers.busId, Number(c.req.param("id"))));
  return c.json(rows);
});

driverRoutes.put("/buses/:id{[0-9]+}/drivers/:userId", async (c) => {
  const busId = Number(c.req.param("id"));
  const userId = c.req.param("userId");
  const db = c.get("db");

  const [[bus], [u]] = await Promise.all([
    db.select({ id: buses.id }).from(buses).where(eq(buses.id, busId)).limit(1),
    db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1),
  ]);
  if (!bus) return c.json({ error: "Bus not found" }, 404);
  if (!u) return c.json({ error: "User not found" }, 404);

  await db.insert(busDrivers).values({ busId, userId }).onConflictDoNothing();
  return c.json({ busId, userId }, 201);
});

driverRoutes.delete("/buses/:id{[0-9]+}/drivers/:userId", async (c) => {
  await c
    .get("db")
    .delete(busDrivers)
    .where(and(eq(busDrivers.busId, Number(c.req.param("id"))), eq(busDrivers.userId, c.req.param("userId"))));
  return c.body(null, 204);
});
