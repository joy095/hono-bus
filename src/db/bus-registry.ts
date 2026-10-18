import { buses } from "./schema/bus-schema";
import type { Db } from "./client";

/**
 * Per-isolate cache of valid bus IDs (replaces the per-batch JOIN validation).
 * Isolates are short-lived and not shared, so each isolate just re-checks the DB
 * at most once every 5s when it sees an unknown id, and re-reads the set every 60s.
 */
const TTL_MS = 60_000;
const MISS_RECHECK_MS = 5_000;

let ids = new Set<number>();
let lastRefresh = 0;

async function refresh(db: Db) {
  const rows = await db.select({ id: buses.id }).from(buses);
  ids = new Set(rows.map((r) => r.id));
  lastRefresh = Date.now();
}

export async function isKnownBus(db: Db, id: number): Promise<boolean> {
  const age = Date.now() - lastRefresh;
  if (ids.has(id) && age < TTL_MS) return true;
  if (age < MISS_RECHECK_MS) return ids.has(id);
  await refresh(db);
  return ids.has(id);
}

export const knownBusCount = () => ids.size;
