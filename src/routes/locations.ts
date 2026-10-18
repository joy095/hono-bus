import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isKnownBus } from "../db/bus-registry";
import { hubOf } from "../lib/hub";
import {
  parseLocation,
  validBusId,
  type LocationUpdate,
} from "../lib/location";
import type { AppEnv } from "../env";

export const locationRoutes = new Hono<AppEnv>();

const MAX_BATCH = 1000;
const limit = bodyLimit({
  maxSize: 1_000_000, // a batch of 1000 points is ~120 KB
  onError: (c) => c.json({ error: "Payload too large" }, 413),
});

const unavailable = (c: { json: Function }) =>
  c.json({ error: "Live hub unavailable" }, 503, { "Retry-After": "1" });

locationRoutes.post("/locations/batch", limit, async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const items =
    typeof body === "object" && body !== null
      ? (body as { items?: unknown }).items
      : undefined;

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
    return c.json({ error: `items must be an array of 1-${MAX_BATCH}` }, 400);
  }

  const db = c.get("db");
  const now = Date.now();
  const rejected: { index: number; reason: string }[] = [];
  const accepted: LocationUpdate[] = [];

  for (let i = 0; i < items.length; i++) {
    const busId = (items[i] as { busId?: unknown } | null)?.busId;

    if (!validBusId(busId)) {
      rejected.push({ index: i, reason: "invalid_busId" });
      continue;
    }
    if (!(await isKnownBus(db, busId))) {
      rejected.push({ index: i, reason: "unknown_bus" });
      continue;
    }

    const parsed = parseLocation(busId, items[i], now);
    if (typeof parsed === "string") rejected.push({ index: i, reason: parsed });
    else accepted.push(parsed);
  }

  if (accepted.length > 0) {
    try {
      await hubOf(c.env).ingest(accepted);
    } catch (err) {
      c.get("log").error("hub ingest failed", err instanceof Error ? err : { err });
      return unavailable(c);
    }
  }

  return c.json({ accepted: accepted.length, rejected }, 202);
});

locationRoutes.get("/buses/:id{[0-9]+}/location", async (c) => {
  const busId = Number(c.req.param("id"));
  if (!validBusId(busId)) return c.json({ error: "Invalid bus ID" }, 400);

  const live = await hubOf(c.env).latest(busId);
  return live ? c.json(live) : c.json({ error: "No location available" }, 404);
});

locationRoutes.post("/buses/:id{[0-9]+}/location", limit, async (c) => {
  const busId = Number(c.req.param("id"));
  if (!validBusId(busId)) return c.json({ error: "Invalid bus ID" }, 400);

  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: "Invalid JSON" }, 400);

  if (!(await isKnownBus(c.get("db"), busId))) return c.json({ error: "Bus not found" }, 404);

  const location = parseLocation(busId, body, Date.now());
  if (typeof location === "string") {
    return c.json({ error: "Invalid GPS payload", reason: location }, 400);
  }

  try {
    await hubOf(c.env).ingest([location]);
  } catch (err) {
    c.get("log").error("hub ingest failed", err instanceof Error ? err : { err });
    return unavailable(c);
  }

  return c.json({ accepted: true, busId, recordedAt: location.recordedAt }, 202);
});
