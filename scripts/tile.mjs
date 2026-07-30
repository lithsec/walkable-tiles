#!/usr/bin/env node
// OSM GeoJSON-Seq (stdin) -> walkable tiles, gzipped, one file per grid cell.
// Writes BOTH formats from one pass:
//   v4 (unchanged, byte-identical to before v5 existed — Cologra depends on it)
//   v5 = the v4 payload + landcover/landmarks/habitat for Ausculta (SPEC.md §10)
//
// Grid + v4 payload match apps/mobile/src/run/osm.ts EXACTLY so tiles are a drop-in
// for the app's live fetch path:
//   TILE_DEG   = 0.01      cell key = `${floor(lat/0.01)}:${floor(lng/0.01)}`
//   BOX_HALF_M = 1200      each tile holds all data within 1200 m of the cell CENTER
//   payload v4 = { v:4, ways:[{points,foot}], names:[string|null], crossings:[{lat,lng}] }
//   payload v5 = { v:5, ...v4 keys..., landcover, landmarks, habitat }   (additive)
//     …and v5's ways may additionally carry `lit` (boolean) and `access`
//     ('private'|'no'|'permissive'), written ONLY when OSM tags them. v4's way objects
//     are spelled out field-by-field below and never see either, so v4 stays byte-identical.
//
// Input: `osmium export <filtered.pbf> -f geojsonseq --add-unique-id=type_id`
// Output: <out>/v4/<i>/<j>.json.gz  +  <out>/hashes.json  (cellKey -> sha256 of the
// uncompressed JSON, used by bake-slice.sh to upload only changed tiles), and the
// same pair for v5 (<out>/v5/…, <out>/hashes-v5.json), plus the habitat sidecar
// <out>/habitat-<slice>.jsonl (one line per non-rural spawn cell — SPEC.md §10.4).
//
// Usage: node tile.mjs --out <dir> [--slice <name>] [--poly <file> | --bbox minLng,minLat,maxLng,maxLat]
// Ownership: a cell is WRITTEN by this slice iff its center is inside the poly/bbox,
// so exactly one slice writes each cell even though Geofabrik extracts overlap at seams.
// The habitat sidecar applies the same rule at spawn-cell granularity.
import readline from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const TILE_DEG = 0.01;
const BOX_HALF_M = 1200;
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'track', 'living_street']);
const ROAD = new Set(['residential', 'service', 'unclassified']);
const WALK = new Set([...FOOT, ...ROAD]);

// ---- v5 constants (normative — SPEC.md §10 documents these values; change both) ----
const CELL_DEG = 0.0015; // Ausculta spawn-cell grid (packages/content/src/habitat.ts density)
// TILE_DEG / CELL_DEG == 20/3 exactly (both are exact decimals), so a tile's spawn-cell
// range is pure integer math: rows/cols alternate 7,8,7 as the tile index mod 3 walks.
const CELL_RATIO_N = 20;
const CELL_RATIO_D = 3;
const M_PER_DEG = 111320; // meters per degree of latitude (and of longitude at cos(lat)=1)
const SIMPLIFY_TOL_M = 10; // Douglas-Peucker tolerance — shapes stay recognizable at ~500 m viewport
const LC_MIN_AREA_M2 = 2000; // drop landcover rings smaller than this before clipping
const LC_MIN_CLIPPED_M2 = 1000; // drop per-tile clipped slivers smaller than this
const LC_CLASSES = ['water', 'wood', 'green', 'field']; // precedence order when tags overlap
const LANDMARKS_PER_TILE = 6;
// At most this many SETTLEMENT landmarks (tier 0/1) in one tile. A metro packs several
// place=city/town nodes inside one city radius — Boston, Cambridge, Somerville, Brookline
// are all within 8 km of each other — and without a cap they would take every slot in the
// tile and push out the parks that make the drawn page legible.
const SETTLEMENTS_PER_TILE = 2;
// How far from a settlement's centre NODE that settlement is listed as a landmark.
// This is PROXIMITY, not membership: OSM maps a settlement's extent as a
// boundary=administrative relation, which this bake deliberately does not carry (see
// SPEC §10.2). A flat 1200 m would make "you walked through Provo" almost always false-
// negative — you can walk all day inside a city without passing within 1.2 km of its
// centre node — so the radius scales with the place class. It is an approximation and the
// spec says so; it never claims containment.
const PLACE_RADIUS_M = { city: 8000, town: 4000, village: 2000, suburb: 2000, hamlet: 1200 };
// Landmark kinds by TIER — the first sort key inside a tile (SPEC §10.2). Footprint area
// only breaks ties WITHIN a tier, which is what stops a zero-area settlement node from
// sorting last and being truncated away: measured on the live bake, downtown Wichita's
// three landmark slots are three city parks, so "Wichita" itself would never have shipped.
const LANDMARK_TIER = {
  city: 0,
  town: 0,
  village: 1,
  hamlet: 1,
  suburb: 1,
  peak: 2,
  national_park: 3,
  protected_area: 3,
  park: 4,
  nature_reserve: 4,
  common: 4,
  cemetery: 4,
  library: 4,
};
const PLACE_KINDS = new Set(['city', 'town', 'village', 'hamlet', 'suburb']);
// A tier-0/1 landmark is a settlement; SETTLEMENTS_PER_TILE applies to exactly these.
const isSettlement = (kind) => LANDMARK_TIER[kind] <= 1;
// Candidate-tile ceiling for containment binning of one area landmark (~a 500 km square).
// A pathological protected_area spanning an ocean must not turn into a 10^6-cell loop;
// above the cap the landmark falls back to centroid-proximity binning alone.
const LM_COVER_MAX_CELLS = 200000;
// OSM `lit` -> boolean, for the values that are UNAMBIGUOUS. Everything else — `limited`,
// `interval`, `seasonal`, an unrecognised value, or no tag at all — is OMITTED rather than
// guessed. Absent means UNKNOWN and must never be read as "unlit": this field exists to
// keep street-safety from routing a player down a dark path, and a fabricated `false` is
// worse than a gap because the gap is visible and the fabrication is not.
const LIT_YES = new Set(['yes', '24/7', 'sunset-sunrise', 'dusk-dawn', 'automatic']);
const LIT_NO = new Set(['no', 'disused']);
// The three access values worth carrying: all three mean "do not route a player here".
// `destination`, `customers`, `agricultural` etc. are omitted — they are not a clean
// no, and a wrong restriction is as bad as a missing one.
const ACCESS_KINDS = new Set(['private', 'no', 'permissive']);
const HAB_STEP_M = 20; // way length is credited to spawn cells in steps of this size
// Habitat classifier thresholds — v1, normative (SPEC.md §10.4). Rules apply IN ORDER.
const HAB = {
  GREEN_COVER_MIN: 0.5, //  1. woodland|greenspace: ≥ this fraction of the cell's 2x2 samples
  //                                   covered by green OR wood landcover (the UNION, exactly
  //                                   revision 1's test), AND any foot-group way present
  //                                   (trackless forest is rural, a wood with a path through
  //                                   it is walkable green). Which of the two it becomes is
  //                                   a separate question — see greenKind().
  URBAN_LEN_MIN: 900, //    2. urban: ≥ this many m of walkable way in the cell, and…
  URBAN_RES_SHARE_MAX: 0.35, //        …residential share ≤ this
  PATH_LEN_MIN: 120, //     3. woodland|greenspace: ≥ this many m of pure foot way, and…
  PATH_SHARE_MIN: 0.7, //              …foot share ≥ this
  RES_LEN_MIN: 120, //      4. residential: ≥ this many m of residential/living_street, and…
  RES_SHARE_MIN: 0.4, //               …residential share ≥ this
  //                        5. rural: everything else (the default — sidecar omits it)
};
// Grid characters (SPEC §10.3), matching Ausculta's HABITAT_CODE exactly.
//
// `g` is RETIRED, not reused: revision 1's `g` meant "wood OR green" and revision 2 splits
// that in two, so re-spending the character would make an old tile and a new tile disagree
// about what `g` claims — a client would silently read every greenspace cell as woodland.
// The client does not map `g` to either successor either; it decodes to nothing and the
// cell falls back to rural. Legacy cells go quiet rather than wrong.
//
// `m` (mountain) is reserved by the client's vocabulary and is NOT emitted here: the
// mountain classifier needs an elevation source this bake does not have (Copernicus
// GLO-30, regional relief). Reserving the character now is free; the named peaks with
// `ele` that revision 2 adds are that classifier's calibration set.
const HAB_CODE = { urban: 'u', residential: 'r', woodland: 'w', greenspace: 's', rural: '.' };

// ---- args ----
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = opt('--out') || 'out';
const SLICE = opt('--slice') || 'slice';
const polyPath = opt('--poly');
const bboxArg = opt('--bbox');

let ownRings = null;
let bbox = null;
if (polyPath) ownRings = parsePoly(readFileSync(polyPath, 'utf8'));
else if (bboxArg) {
  const b = bboxArg.split(',').map(Number);
  bbox = { minLng: b[0], minLat: b[1], maxLng: b[2], maxLat: b[3] };
}

const cellCenter = (i, j) => ({ lat: (i + 0.5) * TILE_DEG, lng: (j + 0.5) * TILE_DEG });

function ownsLatLng(lat, lng) {
  if (ownRings) return pointInRings(lng, lat, ownRings);
  if (bbox) return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
  return true; // unconstrained -> own everything (single-slice local test)
}

function owns(i, j) {
  const c = cellCenter(i, j);
  return ownsLatLng(c.lat, c.lng);
}

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR;
  const dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Cells whose CENTER is within `radiusM` of (lat,lng). At the default BOX_HALF_M and
// 0.01 deg (~1.1 km) that's this cell plus the ring of neighbors it reaches — ~3x3
// candidates, filtered by true distance. Landmark binning passes a larger radius for
// settlement nodes (PLACE_RADIUS_M); ways and crossings always use BOX_HALF_M, so v4 is
// untouched by the parameter existing.
function cellsNear(lat, lng, radiusM = BOX_HALF_M) {
  const latPad = radiusM / 111320 + TILE_DEG;
  const lngPad = radiusM / (111320 * Math.cos(lat * Math.PI / 180)) + TILE_DEG;
  const iMin = Math.floor((lat - latPad) / TILE_DEG);
  const iMax = Math.floor((lat + latPad) / TILE_DEG);
  const jMin = Math.floor((lng - lngPad) / TILE_DEG);
  const jMax = Math.floor((lng + lngPad) / TILE_DEG);
  const out = [];
  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const c = cellCenter(i, j);
      if (haversineM(lat, lng, c.lat, c.lng) <= radiusM) out.push(i + ':' + j);
    }
  }
  return out;
}

const cells = new Map(); // key -> { ways:Map<id,way>, crossings:Map<coord,{lat,lng}> }
function cell(key) {
  let c = cells.get(key);
  if (!c) {
    c = { ways: new Map(), crossings: new Map() };
    cells.set(key, c);
  }
  return c;
}

function addWay(id, points, foot, name, lit, access) {
  const touched = new Set();
  for (const p of points) for (const k of cellsNear(p.lat, p.lng)) touched.add(k);
  for (const k of touched) {
    const c = cell(k);
    // points shared by ref, not copied. `lit`/`access` are undefined for the vast
    // majority of ways and are only ever WRITTEN into the v5 payload (SPEC §10.6) —
    // the v4 write loop below spells its way objects out field by field, so v4 stays
    // byte-identical whatever is attached here.
    if (!c.ways.has(id)) c.ways.set(id, { points, foot, name, lit, access });
  }
}

// OSM `lit=*` -> boolean | undefined. See LIT_YES/LIT_NO: undefined is ABSTENTION.
function wayLit(pr) {
  const v = pr.lit;
  if (LIT_YES.has(v)) return true;
  if (LIT_NO.has(v)) return false;
  return undefined;
}

// OSM `access=*` -> one of ACCESS_KINDS | undefined. Absent means no restriction is
// mapped, which is not the same claim as "public" — it is the absence of one.
function wayAccess(pr) {
  return ACCESS_KINDS.has(pr.access) ? pr.access : undefined;
}

function addCrossing(lat, lng) {
  const ck = lat.toFixed(6) + ',' + lng.toFixed(6);
  for (const k of cellsNear(lat, lng)) cell(k).crossings.set(ck, { lat, lng });
}

// ================================ v5 state =================================
// Kept OUT of `cells` so the v4 write loop below (and hashes.json) is untouched
// by landcover-only or landmark-only cells — v4 output stays byte-identical.
const lcPolys = []; // { cls, rings:[[ [lng,lat], … ]…] } — rings open (no dup last), [0]=outer
const lcByCell = new Map(); // tileKey -> [lcPolys index]  (clipped lazily at write time)
const lmByCell = new Map(); // tileKey -> [{ name, lat, lng, kind, area }]
const hab = new Map(); // `${cx}:${cy}` (Ausculta cellId order: cx=lng, cy=lat) ->
//                        { foot, res, road, wmask, gmask } — meters per way group + the
//                        2x2 cover-sample bits, wood and green kept APART (SPEC §10.4)

function landcoverClass(pr) {
  // Precedence when a feature carries tags from several classes: LC_CLASSES order.
  if (pr.natural === 'water' || pr.waterway === 'riverbank' || pr.landuse === 'reservoir' || pr.landuse === 'basin')
    return 'water';
  if (pr.natural === 'wood' || pr.landuse === 'forest') return 'wood';
  if (
    pr.leisure === 'park' || pr.leisure === 'garden' || pr.leisure === 'common' ||
    pr.landuse === 'grass' || pr.landuse === 'meadow' || pr.landuse === 'recreation_ground' ||
    pr.landuse === 'village_green'
  )
    return 'green';
  if (pr.landuse === 'farmland' || pr.landuse === 'farmyard' || pr.landuse === 'orchard') return 'field';
  return null;
}

// Landmark kind, most-specific tag first (SPEC §10.2). Order is load-bearing for the
// three US national parks this was checked against — Everglades, Grand Canyon and Zion
// are ALL tagged `boundary=protected_area` + `leisure=nature_reserve` and NONE of them
// carries `boundary=national_park`, so a `leisure` test placed first would have quietly
// classed every US national park as a local nature reserve. `protect_class=2` is IUCN
// category II ("National Park") and `protected_area=national_park` is the US tagging;
// Grand Canyon has only the latter, Everglades and Zion have both.
function landmarkKind(pr) {
  if (pr.boundary === 'national_park') return 'national_park';
  if (pr.boundary === 'protected_area')
    return pr.protect_class === '2' || pr.protected_area === 'national_park'
      ? 'national_park'
      : 'protected_area';
  if (pr.natural === 'peak') return 'peak';
  if (PLACE_KINDS.has(pr.place)) return pr.place;
  if (pr.leisure === 'park') return 'park';
  if (pr.amenity === 'library') return 'library';
  if (pr.landuse === 'cemetery') return 'cemetery';
  if (pr.leisure === 'nature_reserve') return 'nature_reserve';
  if (pr.leisure === 'common') return 'common';
  return null;
}

// OSM `ele` -> integer metres, peaks only. Values carry units and separators in the wild
// ("3581", "3581 m", "1,234"), so parse the leading float and refuse anything outside the
// range a terrestrial summit can occupy — a bad `ele` in a calibration set is worse than
// a missing one, and this set exists to calibrate the future mountain classifier.
function parseEle(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const e = Number.parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(e) || e < -500 || e > 9000) return undefined;
  return Math.round(e);
}

const round6 = (x) => Number(x.toFixed(6));
const mPerDegLng = (lat) => M_PER_DEG * Math.cos(lat * Math.PI / 180);

// Douglas-Peucker on an open ring, tolerance in meters (planar approximation is fine
// at these sizes). First/last points anchored; degenerate anchors fall back to
// point-distance so closed shapes still simplify.
function simplifyRing(ring, cosLat) {
  const pts = ring;
  const n = pts.length;
  if (n <= 4) return pts.slice();
  const sx = M_PER_DEG * cosLat;
  const sy = M_PER_DEG;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = SIMPLIFY_TOL_M * SIMPLIFY_TOL_M;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0] * sx, ay = pts[a][1] * sy;
    const dx = pts[b][0] * sx - ax, dy = pts[b][1] * sy - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * sx - ax, py = pts[i][1] * sy - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx, ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// Shoelace area in m² of an open ring (implicit closure).
function ringAreaM2(ring, cosLat) {
  const sx = M_PER_DEG * cosLat;
  const sy = M_PER_DEG;
  let sum = 0;
  for (let a = 0; a < ring.length; a++) {
    const p = ring[a], q = ring[(a + 1) % ring.length];
    sum += p[0] * sx * q[1] * sy - q[0] * sx * p[1] * sy;
  }
  return Math.abs(sum / 2);
}

function ringCentroid(ring) {
  // Planar centroid in degrees — landmarks only need a plausible label point.
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const cross = p[0] * q[1] - q[0] * p[1];
    a2 += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a2) < 1e-12) return { lat: ring[0][1], lng: ring[0][0] }; // degenerate
  return { lng: cx / (3 * a2), lat: cy / (3 * a2) };
}

// Tiles a landmark is listed in: every cell whose CENTER is within `radiusM` of the
// label point, UNION every cell whose center falls INSIDE the landmark's own footprint.
//
// The union is the fix for the field this bake exists to add. Centroid proximity alone is
// right for a town park (smaller than the 1200 m box) and useless for a national park —
// measured on the live v5 tiles: the cell over Royal Palm, 6 km inside Everglades National
// Park, carries ZERO landmarks today, even though the park IS already in the osmium filter
// (`a/leisure=nature_reserve` matches it). The park was never missing from the bake; it was
// only ever listed within 1200 m of its centroid, which is open sawgrass nobody walks.
// Keeping the proximity term as well means nothing that ships today stops shipping — a
// small polygon containing no tile center at all still gets its neighbourhood.
function addLandmark(name, lat, lng, kind, area, ele, radiusM, coverRings) {
  const keys = new Set(cellsNear(lat, lng, radiusM ?? BOX_HALF_M));
  if (coverRings) for (const k of cellsInsideRings(coverRings)) keys.add(k);
  for (const k of keys) {
    let list = lmByCell.get(k);
    if (!list) lmByCell.set(k, (list = []));
    list.push({ name, lat, lng, kind, area, ele });
  }
}

// Cell keys whose CENTER falls inside the (even-odd) ring set.
//
// SCANLINE, not a point-in-polygon per candidate cell, and the difference is not
// cosmetic: the polygons this runs on are state-scale (Utah is ~65% federal land, most of
// it one boundary=protected_area or another), so the naive form is O(rows x cols x
// ringPoints) — for one 5,000-point polygon over a 300 x 300 tile bbox that is 4.5x10^9
// operations, minutes per feature. Crossings are computed ONCE per row and filled as
// spans instead: O(rows x ringPoints + cells). Same even-odd rule as `rasterizeCover`
// above, which solves the identical problem one grid finer, so holes work.
//
// Bounded by LM_COVER_MAX_CELLS: above that the polygon is not a landmark anyone walks
// through, it is a mapping artefact, and the caller falls back to proximity alone.
function cellsInsideRings(rings) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
      if (x < minLng) minLng = x;
      if (x > maxLng) maxLng = x;
    }
  if (!Number.isFinite(minLat)) return [];
  const iMin = Math.floor(minLat / TILE_DEG), iMax = Math.floor(maxLat / TILE_DEG);
  const jMin = Math.floor(minLng / TILE_DEG), jMax = Math.floor(maxLng / TILE_DEG);
  if ((iMax - iMin + 1) * (jMax - jMin + 1) > LM_COVER_MAX_CELLS) return [];
  const out = [];
  for (let i = iMin; i <= iMax; i++) {
    const y = (i + 0.5) * TILE_DEG;
    if (y < minLat || y > maxLat) continue;
    const xs = [];
    for (const r of rings)
      for (let a = 0; a < r.length; a++) {
        const [x1, y1] = r[a];
        const [x2, y2] = r[(a + 1) % r.length];
        if (y1 > y !== y2 > y) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
      }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = xs[k], xb = xs[k + 1];
      for (let j = Math.floor(xa / TILE_DEG); j <= Math.floor(xb / TILE_DEG); j++) {
        const x = (j + 0.5) * TILE_DEG;
        if (x >= xa && x < xb) out.push(i + ':' + j);
      }
    }
  }
  return out;
}

// Bin a landcover polygon to every tile whose ±1200 m clip box intersects its bbox.
function binLandcover(idx) {
  const outer = lcPolys[idx].rings[0];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [x, y] of outer) {
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
    if (x < minLng) minLng = x;
    if (x > maxLng) maxLng = x;
  }
  const latHalf = BOX_HALF_M / M_PER_DEG;
  const iMin = Math.floor((minLat - latHalf) / TILE_DEG) - 1;
  const iMax = Math.floor((maxLat + latHalf) / TILE_DEG) + 1;
  for (let i = iMin; i <= iMax; i++) {
    const cLat = (i + 0.5) * TILE_DEG;
    if (cLat + latHalf < minLat || cLat - latHalf > maxLat) continue;
    const lngHalf = BOX_HALF_M / mPerDegLng(cLat);
    const jMin = Math.floor((minLng - lngHalf) / TILE_DEG) - 1;
    const jMax = Math.floor((maxLng + lngHalf) / TILE_DEG) + 1;
    for (let j = jMin; j <= jMax; j++) {
      const cLng = (j + 0.5) * TILE_DEG;
      if (cLng + lngHalf < minLng || cLng - lngHalf > maxLng) continue;
      const k = i + ':' + j;
      let list = lcByCell.get(k);
      if (!list) lcByCell.set(k, (list = []));
      list.push(idx);
    }
  }
}

function habCell(cx, cy) {
  const k = cx + ':' + cy;
  // wmask / gmask: the 2x2 sample bits covered by `wood` and by `green` landcover
  // respectively. Revision 1 kept one shared `mask`, which is the whole reason a deep
  // forest and a municipal park collapsed into one class: the tiler HAS the distinction at
  // the landcover layer (LC_CLASSES separates them) and threw it away here.
  let st = hab.get(k);
  if (!st) hab.set(k, (st = { foot: 0, res: 0, road: 0, wmask: 0, gmask: 0 }));
  return st;
}

// Credit a walkable way's length to the spawn cells it crosses: each segment is cut
// into ceil(len / HAB_STEP_M) equal steps and each step's length goes to the cell
// containing the step midpoint (normative — SPEC.md §10.4).
function habAddWay(points, hw) {
  const grp =
    hw === 'residential' || hw === 'living_street' ? 'res' : FOOT.has(hw) ? 'foot' : 'road';
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s], b = points[s + 1];
    const len = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (!len) continue;
    const n = Math.max(1, Math.ceil(len / HAB_STEP_M));
    const step = len / n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      habCell(Math.floor(lng / CELL_DEG), Math.floor(lat / CELL_DEG))[grp] += step;
    }
  }
}

// Mark each spawn cell's 2x2 samples (at 0.25/0.75 of the cell in each axis) covered by
// this polygon — scanline over all rings, even-odd (holes work). `field` selects which
// mask: 'wmask' for a `wood` polygon, 'gmask' for a `green` one. A sample inside both a
// wood and a park sets both bits, which is what lets greenKind() see the overlap.
function rasterizeCover(rings, field) {
  let minLat = Infinity, maxLat = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p[1] < minLat) minLat = p[1];
      if (p[1] > maxLat) maxLat = p[1];
    }
  const cyMin = Math.floor(minLat / CELL_DEG);
  const cyMax = Math.floor(maxLat / CELL_DEG);
  for (let cy = cyMin; cy <= cyMax; cy++) {
    for (const subY of [0.25, 0.75]) {
      const y = (cy + subY) * CELL_DEG;
      if (y < minLat || y > maxLat) continue;
      const xs = [];
      for (const r of rings) {
        for (let a = 0; a < r.length; a++) {
          const [x1, y1] = r[a];
          const [x2, y2] = r[(a + 1) % r.length];
          if (y1 > y !== y2 > y) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = xs[k], xb = xs[k + 1];
        for (let cx = Math.floor(xa / CELL_DEG); cx <= Math.floor(xb / CELL_DEG); cx++) {
          for (const subX of [0.25, 0.75]) {
            const x = (cx + subX) * CELL_DEG;
            if (x >= xa && x < xb)
              habCell(cx, cy)[field] |= 1 << ((subY === 0.75 ? 2 : 0) + (subX === 0.75 ? 1 : 0));
          }
        }
      }
    }
  }
}

// Landcover/landmark area feature: simplify + area-threshold each polygon, then bin.
function addArea(g, cls, kind, name) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let totalArea = 0;
  let best = null; // largest outer ring, for the landmark centroid
  let bestArea = -1;
  const coverRings = []; // every kept ring across every part — even-odd, so holes work
  for (const rings of polys) {
    let outer = rings[0];
    if (!outer || outer.length < 4) continue;
    const cosLat = Math.cos(outer[0][1] * Math.PI / 180);
    outer = simplifyRing(outer, cosLat);
    if (outer.length && outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1])
      outer = outer.slice(0, -1); // store rings open; closure is implicit
    if (outer.length < 3) continue;
    const area = ringAreaM2(outer, cosLat);
    if (area < LC_MIN_AREA_M2) continue;
    totalArea += area;
    if (area > bestArea) { bestArea = area; best = outer; }
    const kept = [outer];
    for (let r = 1; r < rings.length; r++) {
      let hole = simplifyRing(rings[r], cosLat);
      if (hole.length && hole[0][0] === hole[hole.length - 1][0] && hole[0][1] === hole[hole.length - 1][1])
        hole = hole.slice(0, -1);
      if (hole.length >= 3 && ringAreaM2(hole, cosLat) >= LC_MIN_AREA_M2) kept.push(hole);
    }
    if (kind && name) for (const r of kept) coverRings.push(r);
    if (cls) {
      const idx = lcPolys.push({ cls, rings: kept }) - 1;
      binLandcover(idx);
      if (cls === 'wood') rasterizeCover(kept, 'wmask');
      else if (cls === 'green') rasterizeCover(kept, 'gmask');
    }
  }
  if (kind && name && best) {
    const c = ringCentroid(best);
    addLandmark(name, c.lat, c.lng, kind, totalArea, undefined, BOX_HALF_M, coverRings);
  }
}

// ---- read features ----
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let auto = 0;
for await (let line of rl) {
  line = line.replace(/^\x1e/, '').trim(); // strip RFC 8142 record separator if present
  if (!line) continue;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    continue;
  }
  const g = f.geometry;
  const pr = f.properties || {};
  if (!g) continue;
  const id = String(f.id ?? pr['@id'] ?? 'x' + auto++);
  if (g.type === 'LineString') {
    const hw = pr.highway;
    if (WALK.has(hw)) {
      const points = g.coordinates.map((c) => ({ lat: c[1], lng: c[0] }));
      // `lit` and `access` need NO osmium filter line: tags-filter SELECTS objects and
      // keeps every tag on the ones it selects, so these already arrive on every way the
      // highway filter matched. They cost a filter change of exactly zero.
      addWay(id, points, FOOT.has(hw), pr.name || null, wayLit(pr), wayAccess(pr));
      habAddWay(points, hw);
    }
    if (pr.footway === 'crossing' && g.coordinates.length) {
      const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
      addCrossing(mid[1], mid[0]);
    }
  } else if (g.type === 'Point') {
    if (pr.highway === 'crossing') addCrossing(g.coordinates[1], g.coordinates[0]);
    // POINT landmarks were already the path for `n/amenity=library`, so settlements and
    // peaks — which OSM maps as nodes, not areas — need no new machinery, only a radius.
    // Area 0 is what made them fragile: see LANDMARK_TIER.
    const kind = landmarkKind(pr);
    if (kind && pr.name)
      addLandmark(
        pr.name,
        g.coordinates[1],
        g.coordinates[0],
        kind,
        0,
        kind === 'peak' ? parseEle(pr.ele) : undefined,
        PLACE_RADIUS_M[kind] ?? BOX_HALF_M,
        null,
      );
  } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    const cls = landcoverClass(pr);
    const kind = landmarkKind(pr);
    if (cls || (kind && pr.name)) addArea(g, cls, kind, pr.name || null);
  }
}

// ---- write owned, non-empty cells ----
mkdirSync(join(OUT, 'v4'), { recursive: true });
const hashes = {};
let written = 0;
for (const [key, c] of cells) {
  const [i, j] = key.split(':').map(Number);
  if (!owns(i, j)) continue;
  if (c.ways.size === 0 && c.crossings.size === 0) continue;
  const ways = [];
  const names = [];
  for (const w of c.ways.values()) {
    ways.push({ points: w.points, foot: w.foot });
    names.push(w.name);
  }
  const payload = { v: 4, ways, names, crossings: [...c.crossings.values()] };
  const json = JSON.stringify(payload);
  hashes[key] = createHash('sha256').update(json).digest('hex');
  const dir = join(OUT, 'v4', String(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(j) + '.json.gz'), gzipSync(Buffer.from(json)));
  written++;
}
writeFileSync(join(OUT, 'hashes.json'), JSON.stringify(hashes));
console.error(`[tile] ${written} tiles written to ${OUT}/v4`);

// ================================ v5 write =================================

// Sutherland-Hodgman clip of an open ring against a lat/lng rectangle.
function clipRingRect(ring, rect) {
  let pts = ring;
  for (let side = 0; side < 4; side++) {
    const out = [];
    for (let a = 0; a < pts.length; a++) {
      const p = pts[a];
      const q = pts[(a + 1) % pts.length];
      const pin = insideSide(p, side, rect);
      const qin = insideSide(q, side, rect);
      if (pin) out.push(p);
      if (pin !== qin) out.push(intersectSide(p, q, side, rect));
    }
    if (out.length < 3) return null;
    pts = out;
  }
  return pts;
}
function insideSide(p, side, r) {
  if (side === 0) return p[0] >= r.minLng;
  if (side === 1) return p[0] <= r.maxLng;
  if (side === 2) return p[1] >= r.minLat;
  return p[1] <= r.maxLat;
}
function intersectSide(p, q, side, r) {
  if (side < 2) {
    const x = side === 0 ? r.minLng : r.maxLng;
    return [x, p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0])];
  }
  const y = side === 2 ? r.minLat : r.maxLat;
  return [p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]), y];
}

const toLatLng = (ring) => ring.map(([lng, lat]) => ({ lat: round6(lat), lng: round6(lng) }));

// Landcover for one tile: clip each binned polygon to the tile's ±1200 m box,
// drop slivers, order by clipped area desc (big washes paint first).
function buildLandcover(i, j, idxs) {
  if (!idxs) return [];
  const c = cellCenter(i, j);
  const rect = {
    minLat: c.lat - BOX_HALF_M / M_PER_DEG,
    maxLat: c.lat + BOX_HALF_M / M_PER_DEG,
    minLng: c.lng - BOX_HALF_M / mPerDegLng(c.lat),
    maxLng: c.lng + BOX_HALF_M / mPerDegLng(c.lat),
  };
  const cosLat = Math.cos(c.lat * Math.PI / 180);
  const out = [];
  for (const idx of idxs) {
    const poly = lcPolys[idx];
    const outer = clipRingRect(poly.rings[0], rect);
    if (!outer) continue;
    const area = ringAreaM2(outer, cosLat);
    if (area < LC_MIN_CLIPPED_M2) continue;
    const rings = [outer];
    for (let r = 1; r < poly.rings.length; r++) {
      const hole = clipRingRect(poly.rings[r], rect);
      if (hole) rings.push(hole);
    }
    out.push({ kind: poly.cls, area, rings });
  }
  out.sort((a, b) => b.area - a.area);
  return out.map((p) => ({ kind: p.kind, rings: p.rings.map(toLatLng) }));
}

// Top LANDMARKS_PER_TILE, deduped on kind+name, ordered TIER first (SPEC §10.2).
//
// Ordering by footprint alone — what this did before — is exactly backwards for the kinds
// this bake adds. A `place=city` node has no footprint at all, so it sorted LAST and was
// truncated away; a national park has an enormous one, so it would take slot 1 in every
// tile it covers. Measured on the live bake: downtown Wichita's three slots hold three
// city parks, so "Wichita" would never have shipped from the cell it names.
//
// Within a tier: area descending (unchanged for the pre-existing kinds), then distance to
// the tile centre ascending — the meaningful key for the zero-area point kinds, and a
// deterministic tiebreak for the rest in place of the old name-only one.
function buildLandmarks(i, j, list) {
  if (!list) return [];
  const byId = new Map();
  for (const lm of list) {
    const id = lm.kind + ' ' + lm.name;
    const prev = byId.get(id);
    if (!prev || lm.area > prev.area) byId.set(id, lm);
  }
  const c = cellCenter(i, j);
  const ranked = [...byId.values()]
    .map((lm) => ({ lm, dist: haversineM(c.lat, c.lng, lm.lat, lm.lng) }))
    .sort(
      (a, b) =>
        LANDMARK_TIER[a.lm.kind] - LANDMARK_TIER[b.lm.kind] ||
        b.lm.area - a.lm.area ||
        a.dist - b.dist ||
        (a.lm.name < b.lm.name ? -1 : a.lm.name > b.lm.name ? 1 : 0),
    );
  const out = [];
  let settlements = 0;
  for (const { lm } of ranked) {
    if (out.length >= LANDMARKS_PER_TILE) break;
    if (isSettlement(lm.kind) && ++settlements > SETTLEMENTS_PER_TILE) continue;
    const e = { name: lm.name, lat: round6(lm.lat), lng: round6(lm.lng), kind: lm.kind };
    if (lm.ele !== undefined) e.ele = lm.ele;
    out.push(e);
  }
  return out;
}

const bits = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

// Which of the two green-family classes a cell is, ONCE something has decided it is one.
// Deliberately a separate question from the gate: the split is a PARTITION of revision 1's
// `green`, never a redrawing of its boundary, so no cell moves in or out of the family.
//
// woodland wins a tie (a wooded corner of a large park — the real case) for two reasons.
// The one that is not taste: §10.1's landcover precedence is already `water > wood > green`,
// so a polygon carrying both `natural=wood` and `leisure=park` ALREADY resolves to `wood`.
// Letting greenspace win here would make the two layers disagree about the same square
// metre. The other: tree cover is the more distinctive fact, and the more specific claim
// is the one that had to be explicitly mapped.
//
// With NO cover evidence at all (the path rule below), greenspace is the answer, because
// woodland is a claim about tree cover and there is none to support it.
function greenKind(st) {
  const w = bits(st.wmask);
  return w > 0 && w >= bits(st.gmask) ? 'woodland' : 'greenspace';
}

// Habitat class of one spawn cell — v2 rules, IN ORDER (normative — SPEC.md §10.4).
function classifyHabitat(cx, cy) {
  const st = hab.get(cx + ':' + cy);
  if (!st) return 'rural';
  // The GATE is the union of the two masks — bit-identical to revision 1's single mask,
  // so exactly the same cells enter the green family as before.
  const coverFrac = bits(st.wmask | st.gmask) / 4;
  if (coverFrac >= HAB.GREEN_COVER_MIN && st.foot > 0) return greenKind(st);
  const all = st.foot + st.res + st.road;
  if (all >= HAB.URBAN_LEN_MIN && st.res / all <= HAB.URBAN_RES_SHARE_MAX) return 'urban';
  if (st.foot >= HAB.PATH_LEN_MIN && st.foot / all >= HAB.PATH_SHARE_MIN) return greenKind(st);
  if (st.res >= HAB.RES_LEN_MIN && st.res / all >= HAB.RES_SHARE_MIN) return 'residential';
  return 'rural';
}

// Per-tile habitat block: every spawn cell intersecting the tile's 0.01° extent,
// row-major, south→north rows (cy ascending), west→east within a row (cx ascending).
function buildHabitat(i, j) {
  const cy0 = Math.floor((i * CELL_RATIO_N) / CELL_RATIO_D);
  const cy1 = Math.ceil(((i + 1) * CELL_RATIO_N) / CELL_RATIO_D) - 1;
  const cx0 = Math.floor((j * CELL_RATIO_N) / CELL_RATIO_D);
  const cx1 = Math.ceil(((j + 1) * CELL_RATIO_N) / CELL_RATIO_D) - 1;
  let s = '';
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) s += HAB_CODE[classifyHabitat(cx, cy)];
  return { cellDeg: CELL_DEG, cx0, cy0, cols: cx1 - cx0 + 1, rows: cy1 - cy0 + 1, cells: s };
}

mkdirSync(join(OUT, 'v5'), { recursive: true });
const v5Keys = new Set([...cells.keys(), ...lcByCell.keys(), ...lmByCell.keys()]);
const hashes5 = {};
let written5 = 0;
for (const key of v5Keys) {
  const [i, j] = key.split(':').map(Number);
  if (!owns(i, j)) continue;
  const c = cells.get(key);
  const ways = [];
  const names = [];
  if (c)
    for (const w of c.ways.values()) {
      // v5 ONLY: the per-way attributes ride ON the way object rather than in a parallel
      // array (SPEC §10.6). The client's seam-dedupe merge carries the way object by
      // reference and drops anything not attached to it, so a parallel array would force a
      // second, divergent dedupe app-side — which is precisely how a seam-duplicated way
      // quietly doubles a street's weight in the walk graph. Written only when tagged, so
      // an untagged way costs nothing and ABSENT keeps meaning UNKNOWN.
      const way = { points: w.points, foot: w.foot };
      if (w.lit !== undefined) way.lit = w.lit;
      if (w.access !== undefined) way.access = w.access;
      ways.push(way);
      names.push(w.name);
    }
  const crossings = c ? [...c.crossings.values()] : [];
  const landcover = buildLandcover(i, j, lcByCell.get(key));
  const landmarks = buildLandmarks(i, j, lmByCell.get(key));
  if (!ways.length && !crossings.length && !landcover.length && !landmarks.length) continue;
  const payload = { v: 5, ways, names, crossings, landcover, landmarks, habitat: buildHabitat(i, j) };
  const json = JSON.stringify(payload);
  hashes5[key] = createHash('sha256').update(json).digest('hex');
  const dir = join(OUT, 'v5', String(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(j) + '.json.gz'), gzipSync(Buffer.from(json)));
  written5++;
}
writeFileSync(join(OUT, 'hashes-v5.json'), JSON.stringify(hashes5));

// Habitat sidecar: one line per OWNED non-rural spawn cell (rural is the default,
// so omitting it keeps the file small). Sorted by cy, then cx — deterministic.
const sidecar = [];
for (const k of hab.keys()) {
  const [cx, cy] = k.split(':').map(Number);
  const cls = classifyHabitat(cx, cy);
  if (cls === 'rural') continue;
  if (!ownsLatLng((cy + 0.5) * CELL_DEG, (cx + 0.5) * CELL_DEG)) continue;
  sidecar.push({ cx, cy, cls });
}
sidecar.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
writeFileSync(
  join(OUT, `habitat-${SLICE}.jsonl`),
  sidecar.map((s) => JSON.stringify({ cx: s.cx, cy: s.cy, class: s.cls })).join('\n') + (sidecar.length ? '\n' : ''),
);
console.error(
  `[tile] v5: ${written5} tiles, ${lcPolys.length} landcover polys, ` +
    `${sidecar.length} non-rural habitat cells -> ${OUT}/v5, ${OUT}/habitat-${SLICE}.jsonl`,
);

// ---- Geofabrik .poly parser + even-odd point test ----
// Even-odd across ALL rings handles holes correctly regardless of winding: a point
// inside an outer ring AND a hole ring counts twice (even) -> outside.
function parsePoly(text) {
  const rings = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].trim();
    if (t === '') continue;
    if (k === 0) continue; // polygon file name
    if (t === 'END') {
      if (cur) {
        rings.push(cur);
        cur = null;
      }
      continue; // a second END (cur null) closes the file
    }
    const parts = t.split(/\s+/);
    if (parts.length === 1) {
      cur = []; // ring header: "1", "2", "!3", ...
      continue;
    }
    if (cur && parts.length >= 2) cur.push([Number(parts[0]), Number(parts[1])]);
  }
  return rings;
}

function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const xi = ring[a][0];
      const yi = ring[a][1];
      const xj = ring[b][0];
      const yj = ring[b][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
