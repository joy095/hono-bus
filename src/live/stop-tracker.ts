import { cellIndex, haversineM } from "../lib/geo";

export type Stop = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
};

/** Where a bus currently is, as far as stops go. */
export type StopPresence = { stopId: number; arrivedAt: string; lastMs: number };

export type StopEvent =
  | { type: "arrive"; busId: number; stopId: number; arrivedAt: string; distanceM: number }
  | { type: "depart"; busId: number; stopId: number; arrivedAt: string; departedAt: string };

export type TrackOptions = {
  /** A bus counts as departed only once it is radius + margin away (GPS jitter guard). */
  exitMarginM: number;
  /** No ping for this long while "at a stop" => visit closed at the last ping seen. */
  staleMs: number;
  /** > 0: buses faster than this don't "arrive" (just driving past). 0 = off. */
  arriveMaxSpeedKmh: number;
};

/** Grid index over stops. Cells are ~5.5 km and radii are <= 1 km, so a 3x3 lookup is exact. */
export class StopIndex {
  private cells = new Map<string, Stop[]>();
  private byId = new Map<number, Stop>();

  set(stops: Stop[]) {
    this.cells = new Map();
    this.byId = new Map();
    for (const s of stops) {
      this.byId.set(s.id, s);
      const key = `${cellIndex(s.latitude)}:${cellIndex(s.longitude)}`;
      const list = this.cells.get(key);
      if (list) list.push(s);
      else this.cells.set(key, [s]);
    }
  }

  get size() {
    return this.byId.size;
  }

  get(id: number) {
    return this.byId.get(id);
  }

  /** Nearest stop whose radius contains the point. */
  nearest(lat: number, lon: number): { stop: Stop; distanceM: number } | null {
    const cx = cellIndex(lat);
    const cy = cellIndex(lon);
    let best: { stop: Stop; distanceM: number } | null = null;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (!list) continue;
        for (const s of list) {
          const d = haversineM(lat, lon, s.latitude, s.longitude);
          if (d <= s.radiusM && (!best || d < best.distanceM)) best = { stop: s, distanceM: d };
        }
      }
    }
    return best;
  }
}

/**
 * Pure state transition: given a bus's previous stop presence and a new ping, decide
 * whether it arrived at or departed from a stop. Pings must be fed in time order.
 */
export function trackStop(
  index: StopIndex,
  busId: number,
  presence: StopPresence | undefined,
  point: { latitude: number; longitude: number; speedKmh: number | null; recordedAt: string },
  t: number,
  opts: TrackOptions,
): { presence: StopPresence | undefined; events: StopEvent[] } {
  const events: StopEvent[] = [];
  let cur = presence;

  if (cur) {
    const stop = index.get(cur.stopId);
    const stale = t - cur.lastMs > opts.staleMs;
    const inside =
      !!stop &&
      !stale &&
      haversineM(point.latitude, point.longitude, stop.latitude, stop.longitude) <=
        stop.radiusM + opts.exitMarginM;

    if (inside) return { presence: { ...cur, lastMs: t }, events };

    // Departure time = last ping seen at the stop (consistent with arrival = first ping seen there).
    events.push({
      type: "depart",
      busId,
      stopId: cur.stopId,
      arrivedAt: cur.arrivedAt,
      departedAt: new Date(cur.lastMs).toISOString(),
    });
    cur = undefined;
  }

  const slowEnough =
    opts.arriveMaxSpeedKmh <= 0 ||
    point.speedKmh === null ||
    point.speedKmh <= opts.arriveMaxSpeedKmh;
  const hit = slowEnough ? index.nearest(point.latitude, point.longitude) : null;

  if (hit) {
    cur = { stopId: hit.stop.id, arrivedAt: point.recordedAt, lastMs: t };
    events.push({
      type: "arrive",
      busId,
      stopId: hit.stop.id,
      arrivedAt: point.recordedAt,
      distanceM: Math.round(hit.distanceM * 10) / 10,
    });
  }

  return { presence: cur, events };
}
