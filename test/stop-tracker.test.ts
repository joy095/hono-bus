import test from "node:test";
import assert from "node:assert/strict";
import { StopIndex, trackStop, type StopPresence, type StopEvent } from "../src/live/stop-tracker";

// Stop at Majestic, Bengaluru; radius 50 m. 0.0001 deg lat ~ 11.1 m.
const index = new StopIndex();
index.set([{ id: 7, name: "Majestic", latitude: 12.9767, longitude: 77.5713, radiusM: 50 }]);
const opts = { exitMarginM: 30, staleMs: 600_000, arriveMaxSpeedKmh: 0 };
const T0 = Date.parse("2026-10-18T10:00:00Z");

const ping = (dLat: number, tSec: number, speedKmh: number | null = 5) => ({
  p: {
    latitude: 12.9767 + dLat,
    longitude: 77.5713,
    speedKmh,
    recordedAt: new Date(T0 + tSec * 1000).toISOString(),
  },
  t: T0 + tSec * 1000,
});

function run(pings: ReturnType<typeof ping>[], o = opts) {
  let presence: StopPresence | undefined;
  const events: StopEvent[] = [];
  for (const { p, t } of pings) {
    const r = trackStop(index, 1, presence, p, t, o);
    presence = r.presence;
    events.push(...r.events);
  }
  return events;
}

test("no events while far from any stop", () => {
  assert.deepEqual(run([ping(0.01, 0), ping(0.01, 15)]), []);
});

test("arrive once, then depart with last-seen time", () => {
  const ev = run([ping(0.01, 0), ping(0.0002, 15), ping(0.0001, 30), ping(0.0002, 45), ping(0.01, 60)]);
  assert.equal(ev.length, 2);
  assert.equal(ev[0]!.type, "arrive");
  assert.equal((ev[0] as any).arrivedAt, new Date(T0 + 15_000).toISOString());
  assert.equal(ev[1]!.type, "depart");
  assert.equal((ev[1] as any).departedAt, new Date(T0 + 45_000).toISOString());
  assert.equal((ev[1] as any).arrivedAt, (ev[0] as any).arrivedAt);
});

test("GPS jitter between radius and radius+margin does not split the visit", () => {
  // 0.00055 deg ~ 61 m: outside the 50 m radius but inside 50+30.
  const ev = run([ping(0.0001, 0), ping(0.00055, 15), ping(0.0001, 30), ping(0.01, 45)]);
  assert.deepEqual(ev.map((e) => e.type), ["arrive", "depart"]);
});

test("stale visit is closed at last ping and a new arrival is recorded", () => {
  const ev = run([ping(0.0001, 0), ping(0.0001, 3600)]);
  assert.deepEqual(ev.map((e) => e.type), ["arrive", "depart", "arrive"]);
  assert.equal((ev[1] as any).departedAt, new Date(T0).toISOString());
});

test("fast pass-by ignored when arriveMaxSpeedKmh is set", () => {
  const o = { ...opts, arriveMaxSpeedKmh: 25 };
  assert.deepEqual(run([ping(0.0001, 0, 40)], o), []);
  assert.equal(run([ping(0.0001, 0, 10)], o).length, 1);
  assert.equal(run([ping(0.0001, 0, null)], o).length, 1);
});

test("deleted stop closes the visit", () => {
  const empty = new StopIndex();
  const r = trackStop(empty, 1, { stopId: 7, arrivedAt: "x", lastMs: T0 }, ping(0.0001, 10).p, T0 + 10_000, opts);
  assert.deepEqual(r.events.map((e) => e.type), ["depart"]);
  assert.equal(r.presence, undefined);
});
