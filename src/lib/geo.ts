/**
 * Cell size = 1/20 degree (~5.5 km). Clients compute the same cell ids for
 * their map viewport and subscribe to them:
 *   cell = `${Math.floor(lat * 20)}:${Math.floor(lng * 20)}`   // Bengaluru -> "259:1551"
 */
export const CELL_SCALE = 20;
export const cellIndex = (deg: number) => Math.floor(deg * CELL_SCALE);
export const cellOf = (lat: number, lon: number) =>
  `${cellIndex(lat)}:${cellIndex(lon)}`;

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
