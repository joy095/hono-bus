import { DurableObject } from "cloudflare:workers";
import { connect } from "../db/client";
import { cellOf } from "../lib/geo";
import { createLogger, parseLevel, type Logger } from "../lib/logger";
import type { LocationUpdate } from "../lib/location";
import { num, type Env } from "../env";
import {
  StopIndex,
  trackStop,
  type Stop,
  type StopEvent,
  type StopPresence,
  type TrackOptions,
} from "./stop-tracker";

const MAX_TOPICS_PER_SOCKET = 100;
const ATTACHMENT_LIMIT = 1900; // hibernation attachments are capped at 2048 bytes
const CELL_RE = /^-?\d{1,4}:-?\d{1,4}$/;
const OUTBOX_RETRY_MS = 5000;
const OUTBOX_BATCH = 200;
const OUTBOX_MAX = 100_000;

type BusState = { loc: LocationUpdate; ms: number; stop?: StopPresence };
type Outbox = { key: string; ev: StopEvent };

/**
 * One instance holds the live state for the fleet:
 *  - latest position per bus (durable, survives restarts)
 *  - WebSocket subscriptions (hibernatable: idle sockets cost nothing)
 *  - stop geofencing; ONLY stop arrivals/departures are written to Postgres
 */
export class LiveHub extends DurableObject<Env> {
  private log: Logger;
  private tickMs: number;
  private persistMs: number;
  private stopRefreshMs: number;
  private track: TrackOptions;

  private buses = new Map<number, BusState>();
  private pending = new Map<number, LocationUpdate>(); // newest per bus, awaiting fan-out
  private dirty = new Set<number>(); // buses whose snapshot needs saving
  private lastPersist = 0;

  private outbox: Outbox[] = [];
  private seq = 0;
  private droppedEvents = 0;
  private lastError: string | null = null;

  private stops = new StopIndex();
  private stopsLoadedAt = 0;

  private index: Map<string, Set<WebSocket>> | null = null; // topic -> sockets (rebuilt after hibernation)
  private alarmAt = 0;
  private published = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger(parseLevel(env.LOG_LEVEL), { do: "LiveHub" });
    this.tickMs = num(env.LIVE_TICK_MS, 500);
    this.persistMs = num(env.PERSIST_MS, 15_000);
    this.stopRefreshMs = num(env.STOP_REFRESH_MS, 60_000);
    this.track = {
      exitMarginM: num(env.STOP_EXIT_MARGIN_M, 30),
      staleMs: num(env.STOP_STALE_MS, 600_000),
      arriveMaxSpeedKmh: num(env.STOP_ARRIVE_MAX_KMH, 0),
    };

    // Keepalive that doesn't wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      const [busRows, obRows, stops, alarm] = await Promise.all([
        ctx.storage.list<BusState>({ prefix: "bus:" }),
        ctx.storage.list<StopEvent>({ prefix: "ob:" }),
        ctx.storage.get<Stop[]>("stops"),
        ctx.storage.getAlarm(),
      ]);
      for (const [k, v] of busRows) this.buses.set(Number(k.slice(4)), v);
      for (const [key, ev] of obRows) {
        this.outbox.push({ key, ev });
        this.seq = Math.max(this.seq, Number(key.slice(3)));
      }
      if (stops) this.stops.set(stops);
      this.alarmAt = alarm ?? 0;
      if (this.outbox.length) this.schedule(0);
    });
  }

  // ---- RPC (called from the Worker) -------------------------------------------

  /** Accept GPS points: update live state, detect stop visits, queue fan-out. */
  async ingest(items: LocationUpdate[]): Promise<{ applied: number }> {
    await this.ensureStops();
    let applied = 0;
    for (const loc of items) if (this.apply(loc)) applied++;
    if (this.pending.size) this.schedule(this.tickMs);
    return { applied };
  }

  latest(busId: number): LocationUpdate | undefined {
    return this.buses.get(busId)?.loc;
  }

  async refreshStops() {
    this.stopsLoadedAt = 0;
    await this.ensureStops();
  }

  stats() {
    return {
      tracked: this.buses.size,
      pending: this.pending.size,
      published: this.published,
      sockets: this.ctx.getWebSockets().length,
      stops: this.stops.size,
      outboxQueued: this.outbox.length,
      droppedStopEvents: this.droppedEvents,
      lastError: this.lastError,
    };
  }

  // ---- ingest internals ---------------------------------------------------------

  private apply(loc: LocationUpdate): boolean {
    const t = Date.parse(loc.recordedAt);
    const prev = this.buses.get(loc.busId);
    if (prev && t <= prev.ms) return false; // stale / out-of-order

    const { presence, events } = trackStop(this.stops, loc.busId, prev?.stop, loc, t, this.track);
    const state: BusState = { loc, ms: t, stop: presence };
    this.buses.set(loc.busId, state);
    this.pending.set(loc.busId, loc); // coalesce: only the newest per bus per tick
    this.dirty.add(loc.busId);

    if (events.length) this.queueEvents(loc.busId, state, events);
    return true;
  }

  private queueEvents(busId: number, state: BusState, events: StopEvent[]) {
    const writes: Record<string, unknown> = { [`bus:${busId}`]: state };
    for (const ev of events) {
      if (this.outbox.length >= OUTBOX_MAX) {
        this.droppedEvents++;
        continue;
      }
      const key = `ob:${String(++this.seq).padStart(12, "0")}`;
      this.outbox.push({ key, ev });
      writes[key] = ev;
    }
    this.dirty.delete(busId); // saved together with the event, atomically
    void this.ctx.storage.put(writes);
    this.schedule(0);
  }

  private async ensureStops() {
    if (Date.now() - this.stopsLoadedAt < this.stopRefreshMs) return;
    this.stopsLoadedAt = Date.now(); // also throttles retries when the DB is down

    const conn = connect(this.env);
    try {
      const rows = await conn.sql<Stop[]>`
        SELECT id, name, latitude, longitude, radius_m AS "radiusM" FROM bus_stops`;
      const stops = [...rows];
      this.stops.set(stops);
      await this.ctx.storage.put("stops", stops);
    } catch (err) {
      this.lastError = `stops refresh: ${err}`;
      this.log.error("stop refresh failed; using previous list", err instanceof Error ? err : { err });
    } finally {
      await conn.close();
    }
  }

  // ---- alarm: fan-out tick, snapshot persistence, outbox flush ---------------------

  private schedule(ms: number) {
    const at = Date.now() + ms;
    if (this.alarmAt && this.alarmAt > Date.now() && this.alarmAt <= at) return;
    this.alarmAt = at;
    void this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    this.alarmAt = 0;

    try {
      this.tick();
      if (this.dirty.size && Date.now() - this.lastPersist >= this.persistMs) {
        await this.persistDirty();
      }
      const ok = await this.flushOutbox();

      if (this.outbox.length) this.schedule(ok ? 0 : OUTBOX_RETRY_MS);
      else if (this.pending.size) this.schedule(this.tickMs);
      else if (this.dirty.size)
        this.schedule(Math.max(this.tickMs, this.lastPersist + this.persistMs - Date.now()));
    } catch (err) {
      this.lastError = `alarm: ${err}`;
      this.log.error("alarm failed", err instanceof Error ? err : { err });
      this.schedule(OUTBOX_RETRY_MS);
    }
  }

  private async persistDirty() {
    const ids = [...this.dirty];
    this.dirty.clear();
    this.lastPersist = Date.now();
    for (let i = 0; i < ids.length; i += 128) {
      const chunk: Record<string, BusState> = {};
      for (const id of ids.slice(i, i + 128)) {
        const st = this.buses.get(id);
        if (st) chunk[`bus:${id}`] = st;
      }
      await this.ctx.storage.put(chunk);
    }
  }

  /** Write queued arrive/depart events to Postgres, in order. Returns false on failure (retried). */
  private async flushOutbox(): Promise<boolean> {
    if (!this.outbox.length) return true;

    const batch = this.outbox.slice(0, OUTBOX_BATCH);
    const conn = connect(this.env);
    try {
      const { sql } = conn;
      await sql.begin((tx) =>
        batch.map(({ ev }) =>
          ev.type === "arrive"
            ? // WHERE EXISTS: a stop deleted meanwhile can't poison the queue. ON CONFLICT: retries are idempotent.
              tx`
                INSERT INTO bus_stop_visits (bus_id, stop_id, arrived_at, distance_m)
                SELECT ${ev.busId}::bigint, ${ev.stopId}::bigint, ${ev.arrivedAt}::timestamptz, ${ev.distanceM}::real
                WHERE EXISTS (SELECT 1 FROM bus_stops WHERE id = ${ev.stopId}::bigint)
                ON CONFLICT (bus_id, arrived_at) DO NOTHING`
            : tx`
                UPDATE bus_stop_visits SET departed_at = ${ev.departedAt}::timestamptz
                WHERE bus_id = ${ev.busId}::bigint AND arrived_at = ${ev.arrivedAt}::timestamptz
                  AND departed_at IS NULL`,
        ),
      );
    } catch (err) {
      this.lastError = `outbox flush: ${err}`;
      this.log.error("stop-visit flush failed; will retry", err instanceof Error ? err : { err });
      return false;
    } finally {
      await conn.close();
    }

    this.outbox.splice(0, batch.length);
    await this.ctx.storage.delete(batch.map((b) => b.key));
    return true;
  }

  // ---- WebSocket fan-out --------------------------------------------------------------

  private getIndex() {
    if (this.index) return this.index;
    const idx = new Map<string, Set<WebSocket>>();
    for (const ws of this.ctx.getWebSockets()) {
      for (const topic of this.topicsOf(ws)) {
        let set = idx.get(topic);
        if (!set) idx.set(topic, (set = new Set()));
        set.add(ws);
      }
    }
    return (this.index = idx);
  }

  private topicsOf(ws: WebSocket): string[] {
    return (ws.deserializeAttachment() as string[] | null) ?? [];
  }

  private tick() {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();

    const idx = this.getIndex();
    if (idx.size === 0) return; // nobody listening

    const cells = new Map<string, (number | null)[][]>();

    for (const loc of batch.values()) {
      // Per-bus topic: only serialize if someone is actually listening.
      const subs = idx.get(`bus:${loc.busId}`);
      if (subs?.size) this.broadcast(subs, JSON.stringify({ type: "location", ...loc }));

      const cell = cellOf(loc.latitude, loc.longitude);
      if (!idx.get(`cell:${cell}`)?.size) continue;
      let items = cells.get(cell);
      if (!items) cells.set(cell, (items = []));
      items.push([loc.busId, loc.latitude, loc.longitude, loc.speedKmh, Date.parse(loc.recordedAt)]);
    }

    // ONE message per cell per tick, compact tuples.
    for (const [cell, items] of cells) {
      this.broadcast(idx.get(`cell:${cell}`)!, JSON.stringify({ type: "locations", cell, items }));
    }
  }

  private broadcast(sockets: Set<WebSocket>, payload: string) {
    for (const ws of sockets) {
      try {
        ws.send(payload);
        this.published++;
      } catch {
        // socket is closing; webSocketClose/Error will clean it up
      }
    }
  }

  private subscribe(ws: WebSocket, topic: string) {
    const topics = this.topicsOf(ws);
    if (topics.includes(topic) || topics.length >= MAX_TOPICS_PER_SOCKET) return;
    const next = [...topics, topic];
    if (JSON.stringify(next).length > ATTACHMENT_LIMIT) return;

    ws.serializeAttachment(next);
    const idx = this.getIndex();
    let set = idx.get(topic);
    if (!set) idx.set(topic, (set = new Set()));
    set.add(ws);

    // Send the last known position immediately so the map isn't empty until the next tick.
    if (topic.startsWith("bus:")) {
      const snap = this.latest(Number(topic.slice(4)));
      if (snap) ws.send(JSON.stringify({ type: "location", ...snap }));
    }
  }

  private unsubscribe(ws: WebSocket, topic: string) {
    const topics = this.topicsOf(ws);
    if (!topics.includes(topic)) return;
    ws.serializeAttachment(topics.filter((t) => t !== topic));
    const set = this.getIndex().get(topic);
    set?.delete(ws);
    if (set?.size === 0) this.getIndex().delete(topic);
  }

  private dropSocket(ws: WebSocket) {
    if (!this.index) return;
    for (const topic of this.topicsOf(ws)) {
      const set = this.index.get(topic);
      set?.delete(ws);
      if (set?.size === 0) this.index.delete(topic);
    }
  }

  // ---- WebSocket entry points (hibernation API) ---------------------------------------

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const param = new URL(req.url).searchParams.get("busId");
    let busId: number | null = null;
    if (param !== null) {
      busId = Number(param);
      if (!Number.isSafeInteger(busId) || busId < 1) {
        return Response.json({ error: "Invalid busId" }, { status: 400 });
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment([] as string[]);
    if (busId !== null) this.subscribe(server, `bus:${busId}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 4096) return;

    let msg: { op?: unknown; busIds?: unknown; cells?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.op !== "sub" && msg.op !== "unsub") return;

    const topics: string[] = [];
    if (Array.isArray(msg.busIds)) {
      for (const id of msg.busIds.slice(0, 50)) {
        if (Number.isSafeInteger(id) && id > 0) topics.push(`bus:${id}`);
      }
    }
    if (Array.isArray(msg.cells)) {
      for (const c of msg.cells.slice(0, 50)) {
        if (typeof c === "string" && CELL_RE.test(c)) topics.push(`cell:${c}`);
      }
    }

    for (const topic of topics) {
      if (msg.op === "sub") this.subscribe(ws, topic);
      else this.unsubscribe(ws, topic);
    }

    ws.send(JSON.stringify({ type: "subscriptions", count: this.topicsOf(ws).length }));
  }

  webSocketClose(ws: WebSocket, code: number) {
    this.dropSocket(ws);
    try {
      ws.close(code >= 1000 && code < 1005 ? code : 1000);
    } catch {
      /* already closed */
    }
  }

  webSocketError(ws: WebSocket) {
    this.dropSocket(ws);
  }
}
