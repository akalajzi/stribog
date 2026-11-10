// Generates src/core/world.ts, the world map's data, from public-domain sources:
// - Natural Earth's land outline and country label points, both 1:50m (detailed enough to zoom
//   into Europe; the label points include the small countries the internet runs through:
//   Singapore, Luxembourg, Hong Kong...);
// - the IANA time zone database's zone.tab, for where each time zone's city is.
//
// Run: node --import tsx scripts/world-data.ts   (needs curl and tar)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAP_H, MAP_SOUTH, MAP_W, project } from "../src/core/projection.ts";

const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const TZ = "https://data.iana.org/time-zones/tzdata-latest.tar.gz";
const OUT = resolve(import.meta.dirname, "../src/core/world.ts");

const dir = mkdtempSync(join(tmpdir(), "stribog-world-"));
const get = (url: string, name: string) => (execFileSync("curl", ["-sSfLo", join(dir, name), url]), join(dir, name));

type Ring = [number, number][];
interface Feature {
  properties: Record<string, unknown>;
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
}
const features = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { features: Feature[] }).features;

// ---- land, as one SVG path with relative moves at 0.1 map units ----------------------------
/** 1.5 → "1.5", 0.5 → ".5", -0.5 → "-.5". */
const num = (tenths: number) => (tenths / 10).toString().replace(/^(-?)0\./, "$1.");
/** Numbers in a path: a space between them only where the next one has no minus sign. */
const nums = (vs: number[]) => vs.map((v, i) => (i && v >= 0 ? " " : "") + num(v)).join("");
/** In tenths of a map unit: points closer than this to the last one kept are dropped. */
const STEP = 8;
/** In tenths of a map unit: islands smaller than this either way are dropped. */
const MIN_ISLAND = 20;
let land = "";
for (const f of features(get(`${NE}/ne_50m_land.geojson`, "land.geojson"))) {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const ring of polys.flat()) {
    // Below the map's southern edge (Antarctica): left out.
    if (ring.every(([, lat]) => lat < MAP_SOUTH)) continue;
    const pts = ring.map(([lon, lat]) => project(lon, lat).map((v) => Math.round(v * 10)) as [number, number]);
    const steps: number[] = [];
    let [px, py] = pts[0]!;
    for (const [x, y] of pts.slice(1)) {
      // Points closer than STEP tenths of a unit to the last one kept add bytes, not shape.
      if (Math.abs(x - px) < STEP && Math.abs(y - py) < STEP) continue;
      steps.push(x - px, y - py);
      [px, py] = [x, y];
    }
    // Islands smaller than a dot on the map.
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) < MIN_ISLAND && Math.max(...ys) - Math.min(...ys) < MIN_ISLAND) continue;
    land += `M${nums(pts[0]!)}l${nums(steps)}z`;
  }
}

// ---- countries: ISO code → the label point Natural Earth uses for the country's name -------
const countries: Record<string, [number, number]> = {};
for (const f of features(get(`${NE}/ne_50m_admin_0_countries.geojson`, "countries.geojson"))) {
  const p = f.properties;
  const code = [p.ISO_A2_EH, p.ISO_A2].find((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c)) as string | undefined;
  if (!code || countries[code]) continue;
  countries[code] = [Math.round(Number(p.LABEL_X) * 100) / 100, Math.round(Number(p.LABEL_Y) * 100) / 100];
}

// ---- time zones: name → the zone's principal city, and its country -------------------------
execFileSync("tar", ["-xzf", get(TZ, "tzdata.tar.gz"), "-C", dir, "zone.tab", "backward", "version"]);
const dms = (s: string, deg: number) => {
  const sign = s[0] === "-" ? -1 : 1;
  const d = Number(s.slice(1, 1 + deg));
  const m = Number(s.slice(1 + deg, 3 + deg));
  const sec = Number(s.slice(3 + deg) || 0);
  return Math.round(sign * (d + m / 60 + sec / 3600) * 100) / 100;
};
const zones: Record<string, [number, number, string]> = {};
for (const line of readFileSync(join(dir, "zone.tab"), "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [cc, coords, name] = line.split("\t");
  const m = /^([+-]\d+)([+-]\d+)$/.exec(coords ?? "");
  if (!cc || !name || !m) continue;
  zones[name] = [dms(m[2]!, 3), dms(m[1]!, 2), cc];
}
// Old and alternative names (Europe/Kiev, US/Eastern) point at the same place as their zone.
for (const line of readFileSync(join(dir, "backward"), "utf8").split("\n")) {
  const m = /^Link\s+(\S+)\s+(\S+)/.exec(line);
  if (m && zones[m[1]!] && !zones[m[2]!]) zones[m[2]!] = zones[m[1]!]!;
}
const version = readFileSync(join(dir, "version"), "utf8").trim();

const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  OUT,
  `// Generated by scripts/world-data.ts; do not edit. Sources, all public domain: Natural Earth
// (land and country label points, 1:50m) and the IANA time zone database ${version}.

/** The land, in the map's projection (see projection.ts), ${MAP_W} × ${Math.round(MAP_H)} map units. */
export const LAND = ${JSON.stringify(land)};

/** Country (ISO 3166 alpha-2) → [longitude, latitude] of the point its name is written at. */
export const COUNTRIES: Record<string, [number, number]> = ${JSON.stringify(sorted(countries))};

/** Time zone → [longitude, latitude] of its principal city, and the zone's country. */
export const ZONES: Record<string, [number, number, string]> = ${JSON.stringify(sorted(zones))};
`,
);
console.log(`${OUT}: land ${land.length} chars, ${Object.keys(countries).length} countries, ${Object.keys(zones).length} zones (tzdata ${version})`);
