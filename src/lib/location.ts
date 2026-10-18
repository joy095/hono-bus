export type LocationUpdate = {
  busId: number;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  recordedAt: string;
};

export const MAX_FUTURE_MS = 30_000;
export const MAX_AGE_MS = 60 * 60_000;

export const validBusId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

export function parseLocation(
  busId: number,
  raw: unknown,
  now: number,
): LocationUpdate | string {
  if (typeof raw !== "object" || raw === null) return "invalid_object";
  const { latitude, longitude, speedKmh, recordedAt } = raw as Record<string, unknown>;

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  )
    return "invalid_coordinates";

  if (
    speedKmh !== undefined &&
    speedKmh !== null &&
    (typeof speedKmh !== "number" ||
      !Number.isFinite(speedKmh) ||
      speedKmh < 0 ||
      speedKmh > 300)
  )
    return "invalid_speed";

  let t = now;
  if (recordedAt !== undefined) {
    t = typeof recordedAt === "string" ? Date.parse(recordedAt) : NaN;
    if (!Number.isFinite(t) || t > now + MAX_FUTURE_MS || t < now - MAX_AGE_MS) {
      return "invalid_recordedAt";
    }
  }

  return {
    busId,
    latitude,
    longitude,
    speedKmh: (speedKmh ?? null) as number | null,
    recordedAt: new Date(t).toISOString(),
  };
}
