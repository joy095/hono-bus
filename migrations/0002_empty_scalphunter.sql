CREATE TABLE "bus_stop_visits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bus_stop_visits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bus_id" bigint NOT NULL,
	"stop_id" bigint NOT NULL,
	"arrived_at" timestamp with time zone NOT NULL,
	"departed_at" timestamp with time zone,
	"distance_m" real,
	CONSTRAINT "bus_stop_visits_bus_id_arrived_at_key" UNIQUE("bus_id","arrived_at")
);
--> statement-breakpoint
CREATE TABLE "bus_stops" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bus_stops_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"radius_m" real DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "bus_current_location" CASCADE;--> statement-breakpoint
DROP TABLE "bus_location_history" CASCADE;--> statement-breakpoint
ALTER TABLE "bus_stop_visits" ADD CONSTRAINT "bus_stop_visits_stop_id_bus_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."bus_stops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_visits_stop_time" ON "bus_stop_visits" USING btree ("stop_id","arrived_at" DESC NULLS LAST);