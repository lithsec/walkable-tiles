#!/usr/bin/env node
// OSM GeoJSON-Seq (stdin) -> v4 walkable tiles, gzipped, one file per grid cell.
//
// Grid + payload match apps/mobile/src/run/osm.ts EXACTLY so tiles are a drop-in
// for the app's live fetch path:
//   TILE_DEG   = 0.01      cell key = `${floor(lat/0.01)}:${floor(lng/0.01)}`
//   BOX_HALF_M = 1200      each tile holds all data within 1200 m of the cell CENTER
//   payload v4 = { v:4, ways:[{points,foot}], names:[string|null], crossings:[{lat,lng}] }
//
// Input: `osmium export <filtered.pbf> -f geojsonseq --add-unique-id=type_id`
// Output: <out>/v4/<i>/<j>.json.gz  +  <out>/hashes.json  (cellKey -> sha256 of the
// uncompressed JSON, used by bake-slice.sh to upload only changed tiles).
//
// Usage: node tile.mjs --out <dir> [--poly <file> | --bbox minLng,minLat,maxLng,maxLat]
// Ownership: a cell is WRITTEN by this slice iff its center is inside the poly/bbox,
// so exactly one slice writes each cell even though Geofabrik extracts overlap at seams.
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

// ---- args ----
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = opt('--out') || 'out';
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

function owns(i, j) {
  const c = cellCenter(i, j);
  if (ownRings) return pointInRings(c.lng, c.lat, ownRings);
  if (bbox) return c.lat >= bbox.minLat && c.lat <= bbox.maxLat && c.lng >= bbox.minLng && c.lng <= bbox.maxLng;
  return true; // unconstrained -> own everything (single-slice local test)
}

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR;
  const dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Cells whose CENTER is within BOX_HALF_M of (lat,lng). At 0.01 deg (~1.1 km) that's
// this cell plus the ring of neighbors it reaches — ~3x3 candidates, filtered by true distance.
function cellsNear(lat, lng) {
  const latPad = BOX_HALF_M / 111320 + TILE_DEG;
  const lngPad = BOX_HALF_M / (111320 * Math.cos(lat * Math.PI / 180)) + TILE_DEG;
  const iMin = Math.floor((lat - latPad) / TILE_DEG);
  const iMax = Math.floor((lat + latPad) / TILE_DEG);
  const jMin = Math.floor((lng - lngPad) / TILE_DEG);
  const jMax = Math.floor((lng + lngPad) / TILE_DEG);
  const out = [];
  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const c = cellCenter(i, j);
      if (haversineM(lat, lng, c.lat, c.lng) <= BOX_HALF_M) out.push(i + ':' + j);
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

function addWay(id, points, foot, name) {
  const touched = new Set();
  for (const p of points) for (const k of cellsNear(p.lat, p.lng)) touched.add(k);
  for (const k of touched) {
    const c = cell(k);
    if (!c.ways.has(id)) c.ways.set(id, { points, foot, name }); // points shared by ref, not copied
  }
}

function addCrossing(lat, lng) {
  const ck = lat.toFixed(6) + ',' + lng.toFixed(6);
  for (const k of cellsNear(lat, lng)) cell(k).crossings.set(ck, { lat, lng });
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
      addWay(id, points, FOOT.has(hw), pr.name || null);
    }
    if (pr.footway === 'crossing' && g.coordinates.length) {
      const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
      addCrossing(mid[1], mid[0]);
    }
  } else if (g.type === 'Point') {
    if (pr.highway === 'crossing') addCrossing(g.coordinates[1], g.coordinates[0]);
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
