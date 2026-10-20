import { Hono } from "hono";
import { hubOf } from "../lib/hub";
import { validBusId } from "../lib/location";
import type { AppEnv } from "../env";

/**
 * Read-only. Live locations are written ONLY through the authenticated publisher WebSocket
 * (GET /ws/publish?busId=…); there is deliberately no HTTP write path. Use the public WebSocket
 * (GET /ws) for live updates; this snapshot endpoint is for one-off lookups.
 */
export const locationRoutes = new Hono<AppEnv>();

locationRoutes.get("/buses/:id{[0-9]+}/location", async (c) => {
  const busId = Number(c.req.param("id"));
  if (!validBusId(busId)) return c.json({ error: "Invalid bus ID" }, 400);

  const live = await hubOf(c.env).latest(busId);
  return live ? c.json(live) : c.json({ error: "No location available" }, 404);
});
