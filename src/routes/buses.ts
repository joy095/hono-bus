import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { buses } from "../db/schema/bus-schema";
import type { AppEnv } from "../env";

export const busRoutes = new Hono<AppEnv>();

busRoutes.get("/buses", async (c) => {
  const rows = await c.get("db").select().from(buses);
  return c.json(rows);
});

busRoutes.post("/buses", async (c) => {
  const body = await c.req.json().catch(() => undefined);

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as any).busNumber !== "string" ||
    !(body as any).busNumber.trim() ||
    (body as any).busNumber.length > 50
  ) {
    return c.json({ error: "busNumber is required" }, 400);
  }

  try {
    const [bus] = await c
      .get("db")
      .insert(buses)
      .values({ busNumber: (body as { busNumber: string }).busNumber.trim() })
      .returning();
    return c.json(bus, 201);
  } catch (error) {
    // drizzle wraps driver errors; the Postgres code may be on `cause`
    const code = (error as any)?.code ?? (error as any)?.cause?.code;
    if (code === "23505") return c.json({ error: "Bus number already exists" }, 409);
    throw error;
  }
});

busRoutes.get("/buses/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "Invalid bus ID" }, 400);

  const [bus] = await c.get("db").select().from(buses).where(eq(buses.id, id)).limit(1);
  return bus ? c.json(bus) : c.json({ error: "Bus not found" }, 404);
});
