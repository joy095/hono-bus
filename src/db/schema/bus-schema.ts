import {
  pgTable,
  bigint,
  text,
  doublePrecision,
  real,
  timestamp,
  index,
  unique,
  primaryKey,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const buses = pgTable("buses", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  busNumber: text("bus_number").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const busStops = pgTable("bus_stops", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  radiusM: real("radius_m").notNull().default(50),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const busStopVisits = pgTable(
  "bus_stop_visits",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    busId: bigint("bus_id", { mode: "number" }).notNull(),
    stopId: bigint("stop_id", { mode: "number" })
      .notNull()
      .references(() => busStops.id, { onDelete: "cascade" }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull(),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    distanceM: real("distance_m"),
  },
  (t) => [
    unique("bus_stop_visits_bus_id_arrived_at_key").on(t.busId, t.arrivedAt),
    index("idx_visits_stop_time").on(t.stopId, t.arrivedAt.desc()),
  ],
);

/** Which signed-in users (drivers) may publish live location for which bus. Admins may publish for any bus. */
export const busDrivers = pgTable(
  "bus_drivers",
  {
    busId: bigint("bus_id", { mode: "number" })
      .notNull()
      .references(() => buses.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.busId, t.userId] }), index("idx_bus_drivers_user").on(t.userId)],
);
