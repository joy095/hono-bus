import { DurableObject } from "cloudflare:workers";
import { connect } from "../db/client";
import { cellOf } from "../lib/geo";
import { createLogger, parseLevel, type Logger } from "../lib/logger";
import { parseLocation, validBusId, type LocationUpdate } from "../lib/location";
import { CLOSE, HUB_HEADERS, type ClientMsg } from "../lib/protocol";
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

// ---- connection lifecycle defaults (override with env vars) -------------------------
const SWEEP_MS = 30_000; // how often idle sockets are looked for
const PUBLISHER_IDLE_MS = 120_000; // publisher sent no location for this long -> release
const SUBSCRIBER_IDLE_MS = 90_000; // no message and no ping for this long -> dead peer, release
const NO_TOPIC_GRACE_MS = 30_000; // subscriber that never subscribed to anything -> release
const TOUCH_EVERY_MS = 5_000; // don't rewrite the attachment on every message
const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
const PUBLISH_MAX_ITEMS_PER_MSG = 200;
const PUBLISH_MAX_ITEMS_PER_MIN = 1_200;
const PUBLISH_MAX_MSGS_PER_MIN = 240;
const PING_MS = 25_000; // advertised to clients in "hello"

/** Per-socket state kept in the hibernation attachment (hard cap 2048 bytes). */
type Att = {
  t: string[]; // subscribed topics
  r: "s" | "p"; // subscriber | publisher
  b?: number; // publisher: the one bus it may report for
  u?: string; // publisher: user id (logging)
  x?: number; // publisher: session expiry (epoch ms)
  c: number; // connected at
  a: number; // last activity (message from client)
};

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

  private sweepMs: number;
  private publisherIdleMs: number;
  private subscriberIdleMs: number;
  private nextSweepAt = 0;
  private idleClosed = 0;
  private rate = new WeakMap<WebSocket, { start: number; msgs: number; items: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger(parseLevel(env.LOG_LEVEL), { do: "LiveHub" });
    this.tickMs = num(env.LIVE_TICK_MS, 500);
    this.persistMs = num(env.PERSIST_MS, 15_000);
    this.stopRefreshMs = num(env.STOP_REFRESH_MS, 60_000);
    this.sweepMs = num(env.WS_SWEEP_MS, SWEEP_MS);
    this.publisherIdleMs = num(env.WS_PUBLISHER_IDLE_MS, PUBLISHER_IDLE_MS);
    this.subscriberIdleMs = num(env.WS_SUBSCRIBER_IDLE_MS, SUBSCRIBER_IDLE_MS);
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
      if (this.ctx.getWebSockets().length) this.schedule(this.sweepMs);
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
    const sockets = this.ctx.getWebSockets();
    const publishers = sockets.filter((ws) => this.att(ws).r === "p").length;
    return {
      tracked: this.buses.size,
      pending: this.pending.size,
      published: this.published,
      sockets: sockets.length,
      publishers,
      subscribers: sockets.length - publishers,
      idleClosed: this.idleClosed,
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
      this.sweepIdle();
      if (this.dirty.size && Date.now() - this.lastPersist >= this.persistMs) {
        await this.persistDirty();
      }
      const ok = await this.flushOutbox();

      if (this.outbox.length) this.schedule(ok ? 0 : OUTBOX_RETRY_MS);
      else if (this.pending.size) this.schedule(this.tickMs);
      else if (this.dirty.size)
        this.schedule(Math.max(this.tickMs, this.lastPersist + this.persistMs - Date.now()));

      // Keep sweeping only while somebody is connected; with no sockets the object can go fully idle.
      if (this.ctx.getWebSockets().length) this.schedule(Math.max(0, this.nextSweepAt - Date.now()));
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

  private att(ws: WebSocket): Att {
    const v = ws.deserializeAttachment() as Att | string[] | null;
    if (Array.isArray(v)) return { t: v, r: "s", c: 0, a: 0 }; // pre-upgrade format
    return v ?? { t: [], r: "s", c: 0, a: 0 };
  }

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
    return this.att(ws).t;
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

  /** Returns true when the topic was newly added. */
  private subscribe(ws: WebSocket, topic: string): boolean {
    const att = this.att(ws);
    if (att.t.includes(topic) || att.t.length >= MAX_TOPICS_PER_SOCKET) return false;
    const next: Att = { ...att, t: [...att.t, topic] };
    if (JSON.stringify(next).length > ATTACHMENT_LIMIT) return false;

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
    return true;
  }

  private unsubscribe(ws: WebSocket, topic: string) {
    const att = this.att(ws);
    if (!att.t.includes(topic)) return;
    ws.serializeAttachment({ ...att, t: att.t.filter((t) => t !== topic) });
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

  /** Current positions for freshly subscribed cells, so a (re)connecting map fills immediately. */
  private snapshotCells(ws: WebSocket, cells: Set<string>) {
    if (!cells.size) return;
    const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;
    const out = new Map<string, (number | null)[][]>();
    for (const { loc, ms } of this.buses.values()) {
      if (ms < cutoff) continue;
      const cell = cellOf(loc.latitude, loc.longitude);
      if (!cells.has(cell)) continue;
      let items = out.get(cell);
      if (!items) out.set(cell, (items = []));
      items.push([loc.busId, loc.latitude, loc.longitude, loc.speedKmh, ms]);
    }
    for (const [cell, items] of out) {
      ws.send(JSON.stringify({ type: "locations", cell, items, snapshot: true }));
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string) {
    this.dropSocket(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private touch(ws: WebSocket, att: Att, now: number) {
    if (now - att.a < TOUCH_EVERY_MS) return;
    att.a = now;
    ws.serializeAttachment(att);
  }

  // ---- idle release ---------------------------------------------------------------------
  // Sockets are released when they are not in use; clients reconnect on demand
  // (see client/). Publishers: no location for a while. Subscribers: no message and no
  // ping (dead peer / backgrounded tab) or nothing subscribed. Expired sessions: dropped.

  private sweepIdle() {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.sweepMs;

    for (const ws of this.ctx.getWebSockets()) {
      const att = this.att(ws);

      if (att.x && now > att.x) {
        this.closeSocket(ws, CLOSE.UNAUTHORIZED, "session expired");
        continue;
      }

      if (att.r === "p") {
        if (now - att.a > this.publisherIdleMs) {
          this.idleClosed++;
          this.closeSocket(ws, CLOSE.IDLE, "idle");
        }
        continue;
      }

      // Auto-responded pings don't wake the object but do leave a timestamp.
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const last = Math.max(att.a, pinged, att.c);
      if (now - last > this.subscriberIdleMs || (att.t.length === 0 && now - att.c > NO_TOPIC_GRACE_MS)) {
        this.idleClosed++;
        this.closeSocket(ws, CLOSE.IDLE, "idle");
      }
    }
  }

  // ---- WebSocket entry points (hibernation API) ---------------------------------------
  // The Worker authenticates; this object trusts the x-hub-* headers it sets.

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const now = Date.now();
    const publisher = req.headers.get(HUB_HEADERS.role) === "publisher";
    const { 0: client, 1: server } = new WebSocketPair();

    if (publisher) {
      const busId = Number(req.headers.get(HUB_HEADERS.bus));
      if (!validBusId(busId)) return Response.json({ error: "Invalid bus" }, { status: 400 });
      const exp = Number(req.headers.get(HUB_HEADERS.exp)) || undefined;

      // One live publisher per bus: a reconnect (or a second device) replaces the old socket.
      for (const old of this.ctx.getWebSockets(`pub:${busId}`)) {
        this.closeSocket(old, CLOSE.REPLACED, "replaced by a newer connection");
      }

      this.ctx.acceptWebSocket(server, [`pub:${busId}`]);
      const att: Att = {
        t: [],
        r: "p",
        b: busId,
        u: req.headers.get(HUB_HEADERS.user)?.slice(0, 64) ?? undefined,
        x: exp,
        c: now,
        a: now,
      };
      server.serializeAttachment(att);
      server.send(JSON.stringify({ type: "hello", role: "publisher", busId, pingMs: PING_MS, idleMs: this.publisherIdleMs }));
    } else {
      const param = new URL(req.url).searchParams.get("busId");
      let busId: number | null = null;
      if (param !== null) {
        busId = Number(param);
        if (!validBusId(busId)) return Response.json({ error: "Invalid busId" }, { status: 400 });
      }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ t: [], r: "s", c: now, a: now } satisfies Att);
      server.send(JSON.stringify({ type: "hello", role: "subscriber", pingMs: PING_MS, idleMs: this.subscriberIdleMs }));
      if (busId !== null) this.subscribe(server, `bus:${busId}`);
    }

    this.schedule(this.sweepMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const att = this.att(ws);
    if (typeof raw !== "string" || raw.length > (att.r === "p" ? 65_536 : 4096)) return;

    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;

    const now = Date.now();
    this.touch(ws, att, now);

    if (att.r === "p") return this.onPublisherMessage(ws, att, msg, now);
    this.onSubscriberMessage(ws, msg);
  }

  private onSubscriberMessage(ws: WebSocket, msg: ClientMsg) {
    if (msg.op !== "sub" && msg.op !== "unsub") return;

    const topics: string[] = [];
    const newCells = new Set<string>();
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
      if (msg.op === "unsub") this.unsubscribe(ws, topic);
      else if (this.subscribe(ws, topic) && topic.startsWith("cell:")) newCells.add(topic.slice(5));
    }
    if (newCells.size) this.snapshotCells(ws, newCells);

    ws.send(JSON.stringify({ type: "subscriptions", count: this.topicsOf(ws).length }));
  }

  /**
   * {"op":"loc", latitude, longitude, speedKmh?, recordedAt?, id?}
   * {"op":"locs", items:[{latitude,...}], id?}      (buffered points after a reconnect)
   * The bus is fixed by the authenticated connection; any busId in the payload is ignored.
   */
  private async onPublisherMessage(ws: WebSocket, att: Att, msg: ClientMsg, now: number) {
    if (msg.op !== "loc" && msg.op !== "locs") return;
    const busId = att.b!;
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : undefined;

    const raw = msg.op === "loc" ? [msg] : Array.isArray(msg.items) ? msg.items.slice(0, PUBLISH_MAX_ITEMS_PER_MSG) : [];

    let r = this.rate.get(ws);
    if (!r || now - r.start > 60_000) this.rate.set(ws, (r = { start: now, msgs: 0, items: 0 }));
    r.msgs++;
    r.items += raw.length;
    if (r.msgs > PUBLISH_MAX_MSGS_PER_MIN || r.items > PUBLISH_MAX_ITEMS_PER_MIN) {
      ws.send(JSON.stringify({ type: "error", code: "rate_limited", id }));
      if (r.msgs > PUBLISH_MAX_MSGS_PER_MIN * 2) this.closeSocket(ws, CLOSE.RATE_LIMITED, "rate limited");
      return;
    }

    const accepted: LocationUpdate[] = [];
    const rejected: { index: number; reason: string }[] = [];
    raw.forEach((item, index) => {
      const parsed = parseLocation(busId, item, now);
      if (typeof parsed === "string") rejected.push({ index, reason: parsed });
      else accepted.push(parsed);
    });

    let applied = 0;
    if (accepted.length) {
      try {
        applied = (await this.ingest(accepted)).applied;
      } catch (err) {
        this.log.error("publisher ingest failed", err instanceof Error ? err : { err });
        ws.send(JSON.stringify({ type: "error", code: "unavailable", id }));
        return;
      }
    }
    if (id !== undefined || rejected.length) {
      ws.send(JSON.stringify({ type: "ack", id, accepted: accepted.length, applied, rejected }));
    }
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
