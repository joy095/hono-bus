ALTER TABLE "bus_location_history" DROP CONSTRAINT "bus_location_history_bus_id_buses_id_fk";
--> statement-breakpoint
DROP INDEX "idx_bus_history_bus_time";--> statement-breakpoint
CREATE INDEX "idx_bus_history_bus_time_p" ON "bus_location_history" USING btree ("bus_id","recorded_at");--> statement-breakpoint
ALTER TABLE "bus_location_history" DROP COLUMN "id";