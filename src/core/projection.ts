// The world map's projection: Mercator, the flat map people know from web maps, cropped to
// 84°N..58°S (Antarctica is left out: nothing a home talks to is there). Shared by the
// generated outline and the page.

const NORTH = 84;
const SOUTH = -58;
const rad = (deg: number) => (deg * Math.PI) / 180;
/** Mercator's y for a latitude, in radians of longitude; growing northwards. */
const yOf = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(Math.max(-85, Math.min(85, lat))) / 2));

/** The map's size in its own units: longitude -180..180 by latitude 84°N..58°S. */
export const MAP_W = 1000;
export const MAP_H = (MAP_W * (yOf(NORTH) - yOf(SOUTH))) / (2 * Math.PI);
/** The southern edge: land entirely below it is left out of the outline. */
export const MAP_SOUTH = SOUTH;

/** Longitude and latitude in degrees → map units, the origin at the top left (84°N, 180°W). */
export function project(lon: number, lat: number): [number, number] {
  const k = MAP_W / (2 * Math.PI);
  return [((lon + 180) / 360) * MAP_W, (yOf(NORTH) - yOf(lat)) * k];
}
