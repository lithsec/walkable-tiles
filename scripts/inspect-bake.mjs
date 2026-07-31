#!/usr/bin/env node
// Look at what a LOCAL bake actually produced, before spending anything on R2.
//
//   node scripts/inspect-bake.mjs [out-dir]        (default: ./out)
//
// WHY THIS EXISTS. `verify-coverage.mjs` proves published coverage by value, but it probes
// the CDN — so it can only ever answer questions about tiles that have already been paid
// for and uploaded. A classifier change is exactly the thing you want to look at BEFORE
// that: a full v5 re-bake of the five live slices is ~4-7 hours and ~$4-5, and discovering
// that woodland and greenspace did not separate is a discovery worth making for the price
// of a 21 MB download.
//
// So this reads the tiles on disk and reports what the classifiers DID, rather than
// asserting what they should have done. It deliberately does not pass or fail: the question
// "did the split produce two classes that look like two different places" is a judgement,
// and the numbers below are what a person needs to make it.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  B64,
  FEAT_CHARS,
  HABITAT_BIT,
  classifyFeatures,
  classesOf,
  decodeFeatures,
  displayClass,
} from './habitat.mjs';

const outDir = path.resolve(process.argv[2] ?? 'out');
const v5 = path.join(outDir, 'v5');
if (!existsSync(v5)) {
  console.error(`no v5 tiles at ${v5}\n  bake one first, e.g.:\n` +
    `    R2_DRY_RUN=1 OUT_DIR=${outDir} ./scripts/bake-slice.sh <pbf-url> <slice>`);
  process.exit(1);
}

function* tiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* tiles(p);
    else if (p.endsWith('.json.gz')) yield p;
  }
}

// The tile grid, verbatim from the bake (`tile.mjs`) and from the app
// (`@lithsec/audio_modules/tiles`). Declared here rather than imported because this script
// has no dependency on either tree — and asserted against nothing, so it is the one number
// in this file that must be kept in step by hand.
const TILE_DEG = 0.01;
const M_PER_DEG_LAT = 111320;

const HABITAT_NAMES = Object.keys(HABITAT_BIT);
// Named summits, for the peak-prominence report below. `ele` is what the tile SHIPS (the
// OSM tag); the score that ranks it is local drop from the DEM (SPEC §10.8), and the two
// disagreeing is the entire point of revision 3 — so both are printed side by side.
const peakEles = [];

const habitat = new Map(); // cell -> class MASK (multi-label, SPEC §10.4)
const featSat = { res: 0, foot: 0, road: 0 }; // cells at the 2,550 m quantisation ceiling
let featMax = { res: 0, foot: 0, road: 0, relief: 0 };
let reliefMissing = 0;
const landmarkKinds = new Map();
// Landmark counts have to be reported in TWO columns and the first one is a trap. A
// landmark is listed from every tile proximity or containment reaches, so "the District has
// 341 parks" is 341 tile LISTINGS of 121 distinct places. Anything that reads as a fact
// about the ground — how many parks, how many summits, how big the anchor sidecar will be —
// is the distinct count, keyed on the point exactly as the anchor key is.
const landmarkAnchors = new Map(); // `<kind>@<latE6>,<lngE6>` -> landmark entry
const landcoverKinds = new Map();
const flaggedAnchors = new Map(); // the same key, for entries carrying `anchor: true`
const namedLandmarks = [];
// Compressed bytes on disk per cell, for BOTH fidelities. These feed the only number that
// justifies the coarse layer's existence: what one zoomed-out view actually costs to fetch
// (see `reportCoarse`). Keyed `i:j`, and the byte count is the gzipped file — what crosses
// the wire and what `TILE_EVICTION.maxBytes` counts, not the JSON's length.
const v5Bytes = new Map();
let tileCount = 0;
let waysTotal = 0;
let waysLit = 0;
let waysAccess = 0;
let withEle = 0;
let malformedFeat = 0;
let legacyCellsGrids = 0;

/** `<root>/<i>/<j>.json.gz` -> `i:j`, the cell key both hash manifests use. */
function cellKeyOf(root, file) {
  const rel = path.relative(root, file);
  const m = /^(-?\d+)[/\\](-?\d+)\.json\.gz$/.exec(rel);
  return m ? `${m[1]}:${m[2]}` : null;
}

for (const f of tiles(v5)) {
  tileCount++;
  const k = cellKeyOf(v5, f);
  if (k) v5Bytes.set(k, statSync(f).size);
  const d = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));

  for (const w of d.ways ?? []) {
    waysTotal++;
    // `lit` / `access` ride on the way object rather than a parallel array.
    if (w.lit !== undefined) waysLit++;
    if (w.access !== undefined) waysAccess++;
  }
  for (const lc of d.landcover ?? []) {
    landcoverKinds.set(lc.kind, (landcoverKinds.get(lc.kind) ?? 0) + 1);
  }
  for (const lm of d.landmarks ?? []) {
    landmarkKinds.set(lm.kind, (landmarkKinds.get(lm.kind) ?? 0) + 1);
    if (lm.kind === 'peak' && typeof lm.ele === 'number') peakEles.push(lm.ele);
    if (lm.ele !== undefined && lm.ele !== null) withEle++;
    const ak = `${lm.kind}@${Math.round(lm.lat * 1e6)},${Math.round(lm.lng * 1e6)}`;
    if (!landmarkAnchors.has(ak)) landmarkAnchors.set(ak, lm);
    if (lm.anchor === true) flaggedAnchors.set(ak, lm);
    if (namedLandmarks.length < 4000) namedLandmarks.push(lm);
  }
  // The habitat grid is FEAT_CHARS base64url characters of MEASUREMENT per spawn cell
  // (SPEC §10.3); the class is derived here, by the same `scripts/habitat.mjs` the tiler and
  // the client run. Cells straddle tile edges and appear in up to four tiles, so count
  // DISTINCT cells rather than characters or the overlap inflates whichever classes happen
  // to sit on a boundary.
  const h = d.habitat;
  if (h?.cells) legacyCellsGrids++;
  if (h?.feat) {
    for (let dy = 0; dy < h.rows; dy++) {
      for (let dx = 0; dx < h.cols; dx++) {
        const f = decodeFeatures(h.feat, dy * h.cols + dx);
        if (f === null) { malformedFeat++; continue; }
        habitat.set(`${h.cx0 + dx}:${h.cy0 + dy}`, classifyFeatures(f));
        // The quantisation ceilings, reported rather than assumed. 8 bits at 10 m saturates
        // at 2,550 m of one way group inside a 167 m cell; if a real slice ever reaches it
        // the encoding is wrong and this is the line that says so.
        if (f.res >= 2550) featSat.res++;
        if (f.foot >= 2550) featSat.foot++;
        if (f.road >= 2550) featSat.road++;
        if (f.res > featMax.res) featMax.res = f.res;
        if (f.foot > featMax.foot) featMax.foot = f.foot;
        if (f.road > featMax.road) featMax.road = f.road;
        if (f.relief === null) reliefMissing++;
        else if (f.relief > featMax.relief) featMax.relief = f.relief;
      }
    }
  }
}

// TWO tables, because multi-label makes them different questions. `counts` is the LABEL
// share — how many cells carry each class at all, which is what a creature's weight sees.
// `display` is what one plate per cell would say (SPEC §10.4's display precedence), which
// is what the map paints. Under first-match-wins these were the same number; they are not
// any more, and reporting only one of them is how the woodland collapse hid for a day.
const counts = new Map();
const display = new Map();
let multi = 0;
for (const mask of habitat.values()) {
  const cs = classesOf(mask);
  if (cs.length > 1) multi++;
  for (const cls of cs) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  const d = displayClass(mask);
  display.set(d, (display.get(d) ?? 0) + 1);
}
const cells = habitat.size;

const pct = (n, d) => (d === 0 ? '  —  ' : `${((100 * n) / d).toFixed(1)}%`.padStart(6));
const row = (k, n, d) => `  ${String(k).padEnd(14)} ${String(n).padStart(8)}  ${pct(n, d)}`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
/** Percentile off an ascending array. Index, not interpolation — these are byte totals of
 *  real views, so the honest answer is "one of the views actually cost this". */
const at = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);

console.log(`\n${tileCount} v5 tiles in ${path.relative(process.cwd(), outDir)}\n`);

console.log(`── habitat LABELS, over ${cells.toLocaleString()} DISTINCT spawn cells ──`);
console.log('  (multi-label: a cell is every class its features earn, so these sum past 100%)');
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(row(k, n, cells));
console.log(`\n  ${multi.toLocaleString()} cells carry more than one class (${pct(multi, cells).trim()})`);
console.log(`\n── the DISPLAY class (one plate per cell, SPEC §10.4 precedence) ──`);
for (const [k, n] of [...display].sort((a, b) => b[1] - a[1])) console.log(row(k, n, cells));
console.log(`\n── feature record, ${FEAT_CHARS} base64url chars per cell ──`);
console.log(`  max in this slice: res ${featMax.res} m, foot ${featMax.foot} m, road ${featMax.road} m ` +
  `(ceiling 2550), relief ${featMax.relief} m (ceiling 5100)`);
console.log(`  cells at a length ceiling: res ${featSat.res}, foot ${featSat.foot}, road ${featSat.road}`);
console.log(`  cells with NO DEM coverage (relief abstains): ${reliefMissing.toLocaleString()}`);
if (malformedFeat) console.log(`  !! ${malformedFeat} malformed feature records`);
if (legacyCellsGrids) console.log(`  !! ${legacyCellsGrids} tiles still carry a revision-3 \`cells\` grid`);
if (!counts.has('woodland') || !counts.has('greenspace')) {
  console.log('\n  !! one half of the green split is EMPTY — that is the thing to look at.');
} else {
  const w = counts.get('woodland');
  const s = counts.get('greenspace');
  console.log(`\n  woodland : greenspace = ${(w / s).toFixed(2)} : 1`);
  console.log('  Both non-zero is necessary, not sufficient — a 50:1 ratio would say the');
  console.log('  threshold is wrong even though nothing is technically broken.');
}


reportAtlas();
reportCoarse();

console.log(`\n── landcover polygons ──`);
for (const [k, n] of [...landcoverKinds].sort((a, b) => b[1] - a[1])) console.log(row(k, n, 0));

// TILE LISTINGS vs DISTINCT ANCHORS. The second column is the one that is a fact about the
// ground; the first is a fact about how many tiles a feature happens to touch. Reading
// `national_park 127` off the left column is how "the District has 127 national parks"
// gets said out loud about a city that has none.
const distinctByKind = new Map();
for (const lm of landmarkAnchors.values())
  distinctByKind.set(lm.kind, (distinctByKind.get(lm.kind) ?? 0) + 1);
console.log(`\n── landmark kinds ──`);
console.log(`  ${'kind'.padEnd(16)}${'listings'.padStart(9)}${'distinct'.padStart(10)}`);
for (const [k, n] of [...landmarkKinds].sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(16)}${String(n).padStart(9)}${String(distinctByKind.get(k) ?? 0).padStart(10)}`);
console.log(
  `  ${'TOTAL'.padEnd(16)}${String([...landmarkKinds.values()].reduce((a, b) => a + b, 0)).padStart(9)}` +
    `${String(landmarkAnchors.size).padStart(10)}`,
);
console.log(`  ${String('with ele').padEnd(14)} ${String(withEle).padStart(8)}   (peaks carry elevation)`);
// The `ele` SPREAD is what makes the prominence filter necessary rather than nice: the
// District's named summits are 28-123 m and Vermont's are 51-1,340 m, so the two OVERLAP
// and no absolute elevation threshold can separate a city hill from a mountain. The anchor
// list below is where to see what replaced it.
if (peakEles.length) {
  const sorted = [...new Set(peakEles)].sort((a, b) => a - b);
  console.log(
    `  ${String('ele range').padEnd(14)} ${String(sorted[0] + '-' + sorted[sorted.length - 1] + ' m').padStart(8)}` +
      `   median ${sorted[Math.floor(sorted.length / 2)]} m over ${sorted.length} distinct values`,
  );
}
if (distinctByKind.get('national_park'))
  console.log(
    `\n  national_park is non-zero — check the NAMES below. NPS administrative units\n` +
      `  ("Anacostia Park Section D") reaching this kind is what NP_MIN_AREA_M2 exists to stop.`,
  );

console.log(`\n── per-way attributes, over ${waysTotal.toLocaleString()} ways ──`);
console.log(row('lit', waysLit, waysTotal));
console.log(row('access', waysAccess, waysTotal));

// The names are the point of the landmark work — a histogram cannot show that "Wichita"
// finally beat three city parks, but a list can.
const byKind = new Map();
for (const lm of namedLandmarks) {
  if (!byKind.has(lm.kind)) byKind.set(lm.kind, new Set());
  byKind.get(lm.kind).add(lm.name);
}
console.log(`\n── a sample of the names, by kind ──`);
for (const [k, names] of [...byKind].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${k} (${names.size}): ${[...names].slice(0, 6).join(', ')}`);
}
console.log('');

reportAnchors();

// ── the anchor set (SPEC §10.8) ───────────────────────────────────────────────────────
// This list IS the ranking, and it is the only part of the landmark work a histogram
// cannot show. "1,291 named summits" and "12 anchors" are both just numbers; "Mount
// Mansfield, Killington Peak, Camels Hump" is the thing a person can actually judge, and
// the failure it is looking for — four named bumps on one mountain taking four slots — is
// obvious to a reader and invisible to a counter.
function reportAnchors() {
  const sidecars = readdirSync(outDir).filter(
    (f) => f.startsWith('landmarks-') && f.endsWith('.jsonl'),
  );
  if (sidecars.length === 0) {
    console.log('── landmark anchors ──\n  no landmarks-<slice>.jsonl — the tiler predates the anchor cap.\n');
    return;
  }
  for (const f of sidecars) {
    const lines = readFileSync(path.join(outDir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    console.log(`── landmark anchors — ${f} (${lines.length}) ──`);
    for (const a of [...lines].sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0)))
      console.log(`  ${a.kind.padEnd(16)}${(a.ele !== undefined ? a.ele + ' m' : '').padStart(7)}  ${a.name}`);
    // Every anchor MUST also be flagged in the tile that carries it, or the client can
    // never learn it exists — a sidecar row with no tile flag is a creature the server
    // will accept a claim for and the app will never spawn.
    const unflagged = lines.filter((a) => !flaggedAnchors.has(a.key));
    const orphaned = [...flaggedAnchors.keys()].filter((k) => !lines.some((a) => a.key === k));
    console.log(
      `\n  sidecar rows with no \`anchor: true\` in any tile: ${unflagged.length}` +
        `${unflagged.length ? ' !! -> ' + unflagged.map((a) => a.name).join(', ') : ''}`,
    );
    console.log(`  tile flags with no sidecar row: ${orphaned.length}${orphaned.length ? ' !!' : ''}\n`);
  }
}

// ── the coarse landcover layer (SPEC §10.10) ──────────────────────────────────────────
//
// This artifact exists for exactly one number, so this is the report that prints it: WHAT
// ONE ZOOMED-OUT VIEW COSTS TO FETCH. Everything else here — counts, bytes, polygons per
// kind — is context for that.
//
// The number is not "average tile size × number of tiles". A tile's neighbours are like it
// (cities are next to cities, forest is next to forest), so the view a player actually pays
// for is a WINDOW sum, and the distribution of window sums is far more skewed than the
// distribution of tiles. So: build a byte raster per cell for both fidelities, prefix-sum
// it, and slide the app's own request window — `tileCellsAroundCell`, reproduced here
// including its cos(lat)-at-the-CELL-CENTRE rule — over every cell that has a v5 tile. The
// p50 is what a typical view costs and the max is what the worst place in the slice costs;
// the max is the one that has to fit in a 128 MiB cache.
/** The app's request set size for `radiusM`, at the latitude of row `i`. Mirrors
 *  `@lithsec/audio_modules/tiles`' `tileCellsAroundCell` exactly — cos(lat) is taken at the
 *  CELL CENTRE there, and taking it anywhere else here would report a window the client
 *  never asks for. */
function windowRadii(i, radiusM) {
  const cellLatM = TILE_DEG * M_PER_DEG_LAT;
  const centreLat = (i + 0.5) * TILE_DEG;
  const cellLngM = cellLatM * (Math.cos((centreLat * Math.PI) / 180) || 1);
  return [
    Math.max(1, Math.ceil(radiusM / cellLatM)),
    Math.max(1, Math.ceil(radiusM / Math.max(1, cellLngM))),
  ];
}

/** Window sums over a sparse `i:j -> bytes` map, evaluated at every cell in `at`. Returns
 *  the sums sorted ascending so percentiles are an index. O(cells) after the prefix sum,
 *  which matters: the naive form is O(cells × window) and a 5 km window is 165 cells. */
function windowSums(bytes, at, radiusM) {
  let iLo = Infinity, iHi = -Infinity, jLo = Infinity, jHi = -Infinity;
  for (const k of at) {
    const c = k.indexOf(':');
    const i = Number(k.slice(0, c)), j = Number(k.slice(c + 1));
    if (i < iLo) iLo = i;
    if (i > iHi) iHi = i;
    if (j < jLo) jLo = j;
    if (j > jHi) jHi = j;
  }
  if (!Number.isFinite(iLo)) return [];
  // Pad by the widest window so a cell at the slice edge sums a real rectangle rather than
  // a clipped one — a border cell's view genuinely does reach into the neighbouring slice,
  // and counting zero there would flatter the p95.
  const [riMax, rjMax] = windowRadii(iHi, radiusM);
  const [ri2, rj2] = windowRadii(iLo, radiusM);
  const padI = Math.max(riMax, ri2) + 1;
  const padJ = Math.max(rjMax, rj2) + 1;
  const rows = iHi - iLo + 1 + 2 * padI;
  const cols = jHi - jLo + 1 + 2 * padJ;
  // Prefix sum, (rows+1) × (cols+1). Float64 because a dense metro window is ~10^8 bytes
  // and the running total over a state is ~10^9 — inside float64's exact-integer range.
  const ps = new Float64Array((rows + 1) * (cols + 1));
  for (const [k, b] of bytes) {
    const c = k.indexOf(':');
    const r = Number(k.slice(0, c)) - iLo + padI;
    const q = Number(k.slice(c + 1)) - jLo + padJ;
    if (r < 0 || r >= rows || q < 0 || q >= cols) continue;
    ps[(r + 1) * (cols + 1) + (q + 1)] += b;
  }
  for (let r = 1; r <= rows; r++)
    for (let q = 1; q <= cols; q++)
      ps[r * (cols + 1) + q] +=
        ps[(r - 1) * (cols + 1) + q] + ps[r * (cols + 1) + q - 1] - ps[(r - 1) * (cols + 1) + q - 1];
  const sum = (r0, q0, r1, q1) =>
    ps[(r1 + 1) * (cols + 1) + q1 + 1] -
    ps[r0 * (cols + 1) + q1 + 1] -
    ps[(r1 + 1) * (cols + 1) + q0] +
    ps[r0 * (cols + 1) + q0];
  const out = [];
  for (const k of at) {
    const c = k.indexOf(':');
    const i = Number(k.slice(0, c)), j = Number(k.slice(c + 1));
    const [ri, rj] = windowRadii(i, radiusM);
    const r = i - iLo + padI;
    const q = j - jLo + padJ;
    out.push(sum(Math.max(0, r - ri), Math.max(0, q - rj), Math.min(rows - 1, r + ri), Math.min(cols - 1, q + rj)));
  }
  out.sort((a, b) => a - b);
  return out;
}

function reportCoarse() {
  const v5c = path.join(outDir, 'v5c');
  if (!existsSync(v5c)) {
    console.log('── coarse landcover (v5c) ──\n  no v5c/ in this out dir (the tiler predates §10.10)\n');
    return;
  }
  const cBytes = new Map();
  let cPolys = 0;
  let cPoints = 0;
  const cKinds = new Map();
  for (const f of tiles(v5c)) {
    const k = cellKeyOf(v5c, f);
    if (!k) continue;
    cBytes.set(k, statSync(f).size);
    const d = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
    for (const lc of d.landcover ?? []) {
      cPolys++;
      cKinds.set(lc.kind, (cKinds.get(lc.kind) ?? 0) + 1);
      // Rings are FLAT [lat, lng, …] arrays — two numbers per point (§10.10).
      for (const r of lc.rings) cPoints += r.length / 2;
    }
  }
  const cTotal = [...cBytes.values()].reduce((a, b) => a + b, 0);
  const vTotal = [...v5Bytes.values()].reduce((a, b) => a + b, 0);
  // km² of ground the coarse tiles cover, at each row's own cos(lat). A cell is exactly
  // 0.01° square; nothing here needs the slice polygon, and using the cell grid keeps this
  // number comparable between a state and a city.
  let km2 = 0;
  for (const k of cBytes.keys()) {
    const i = Number(k.slice(0, k.indexOf(':')));
    const lat = (i + 0.5) * TILE_DEG;
    km2 += ((TILE_DEG * M_PER_DEG_LAT) ** 2 * Math.cos((lat * Math.PI) / 180)) / 1e6;
  }

  console.log('── coarse landcover (v5c, SPEC §10.10) ──');
  console.log(`  ${cBytes.size} coarse tiles, ${cTotal.toLocaleString()} B gz ` +
    `(${(cBytes.size ? cTotal / cBytes.size : 0).toFixed(0)} B each)`);
  console.log(`  ${cPolys.toLocaleString()} clipped polygons, ${Math.round(cPoints).toLocaleString()} points`);
  console.log(`  ${(cTotal / Math.max(1, km2)).toFixed(0)} B per km² over ${Math.round(km2).toLocaleString()} km²`);
  console.log(`  ${((100 * cTotal) / Math.max(1, vTotal)).toFixed(2)}% of the ${mb(vTotal)} the v5 tiles weigh`);
  console.log('');
  for (const [k, n] of [...cKinds].sort((a, b) => b[1] - a[1])) console.log(row(k, n, cPolys));

  // THE NUMBER. Both fidelities, the same window, over every cell a player could stand in.
  // 2,000 m is a mid-zoom look; 5,200 m is the app's own `COARSE_RADIUS_M` — the
  // half-diagonal of the widest page `MAP_SPAN_MAX_M` can draw, so it is exactly the set the
  // client asks for and exactly the set the full tiles would have had to serve instead.
  const stand = [...v5Bytes.keys()];
  for (const R of [2000, 5200]) {
    const [ri, rj] = windowRadii(Number(stand[0]?.slice(0, stand[0].indexOf(':')) ?? 0), R);
    const v = windowSums(v5Bytes, stand, R);
    const c = windowSums(cBytes, stand, R);
    console.log(`\n  ── one view at radius ${R} m: ~${(2 * ri + 1) * (2 * rj + 1)} cells ` +
      `(${2 * ri + 1} x ${2 * rj + 1} at the southern edge) ──`);
    console.log(`    ${'v5  full tiles'.padEnd(18)} p50 ${mb(at(v, 0.5)).padStart(9)}  p95 ${mb(at(v, 0.95)).padStart(9)}  max ${mb(at(v, 1)).padStart(9)}`);
    console.log(`    ${'v5c coarse'.padEnd(18)} p50 ${kb(at(c, 0.5)).padStart(9)}  p95 ${kb(at(c, 0.95)).padStart(9)}  max ${kb(at(c, 1)).padStart(9)}`);
    const ratio = (p) => (at(c, p) > 0 ? `${Math.round(at(v, p) / at(c, p))}x` : '—');
    console.log(`    ${'cheaper by'.padEnd(18)} p50 ${ratio(0.5).padStart(9)}  p95 ${ratio(0.95).padStart(9)}  max ${ratio(1).padStart(9)}`);
    console.log(`    the 128 MiB cache holds ${(134217728 / Math.max(1, at(v, 1))).toFixed(1)} such views at v5, ` +
      `${Math.round(134217728 / Math.max(1, at(c, 1))).toLocaleString()} at v5c`);
  }
  console.log('');
}

// ── habitat atlas (SPEC §10.7) ────────────────────────────────────────────────────────
// The atlas is the artifact that lets the app say "you might find woodland creatures
// about 40 km north" without asking anybody where the player is. It is the only v5
// artifact small enough to ship whole, so the thing worth looking at here is whether it
// is small ENOUGH and whether it still says something true at that resolution.
//
// Cross-checked against the habitat SIDECAR by value, not by shape. Both come from the
// same owned-cell pass, so the four non-rural bits must agree block for block; an atlas
// derived from the tile grids instead (which carry a neighbouring extract's buffer
// geometry) would disagree exactly at the state line, and `typeof atlas === 'object'`
// would never notice.
function reportAtlas() {
  const files = readdirSync(outDir).filter((f) => f.startsWith('atlas-') && f.endsWith('.json'));
  if (files.length === 0) {
    console.log('── habitat atlas ──\n  no atlas-<slice>.json in this out dir (tiler not re-run?)\n');
    return;
  }
  for (const f of files) {
    const p = path.join(outDir, f);
    const bytes = statSync(p).size;
    const a = JSON.parse(readFileSync(p, 'utf8'));
    const slots = a.cols * a.rows;
    // `blockChars` is the artifact's own statement of its width (1 in atlas v1, 2 since
    // `water` made seven classes). Read it rather than assume it — an inspector that
    // hard-codes the width reads a v2 raster as twice as many blocks of nonsense and says
    // nothing looked wrong.
    const bc = a.blockChars ?? 1;
    const slotAt = (i) => {
      let m = 0;
      for (let k = 0; k < bc; k++) m = m * 64 + B64.indexOf(a.blocks[i * bc + k]);
      return m;
    };
    const mask = (bx, by) => slotAt((by - a.by0) * a.cols + (bx - a.bx0));
    const blockDeg = a.blockCells * a.cellDeg;
    const latMid = (a.by0 + a.rows / 2) * blockDeg;
    const kmNS = (blockDeg * 111.32).toFixed(1);
    const kmEW = (blockDeg * 111.32 * Math.cos((latMid * Math.PI) / 180)).toFixed(1);

    let occupied = 0;
    const perClass = new Map(a.classes.map((c) => [c, 0]));
    for (let i = 0; i < slots; i++) {
      const m = slotAt(i);
      if (m > 0) occupied++;
      a.classes.forEach((c, bit) => {
        if (m & (1 << bit)) perClass.set(c, perClass.get(c) + 1);
      });
    }

    console.log(`── habitat atlas — ${f} ──`);
    console.log(`  ${bytes} bytes on disk, ${occupied} occupied blocks in a ${a.cols}x${a.rows} raster`);
    console.log(`  block = ${a.blockCells} spawn cells = ${blockDeg.toFixed(4)}° ≈ ${kmNS} km N-S, ${kmEW} km E-W at ${latMid.toFixed(1)}°`);
    console.log(`  ${(bytes / Math.max(1, occupied)).toFixed(1)} B per occupied block, raster ${slots} chars`);
    console.log('');
    for (const [c, n] of [...perClass].sort((x, y) => y[1] - x[1])) console.log(row(c, n, occupied));

    // Cross-check + noise floor, both from the sidecar (which has every owned non-rural
    // cell, so it can reconstruct exactly the four non-rural bits).
    // Paired by SLICE NAME, not by "the first habitat jsonl in the directory" — a local
    // multi-slice seed accumulates several, and cross-checking Vermont's atlas against
    // Arizona's sidecar would report a spectacular disagreement about nothing.
    const side = `habitat-${a.slice}.jsonl`;
    if (!existsSync(path.join(outDir, side))) {
      console.log('\n  (no habitat sidecar beside it — cross-check skipped)\n');
      continue;
    }
    const fromSidecar = new Map(); // `${bx}:${by}` -> Map(class -> cell count)
    let classesDrift = 0;
    for (const line of readFileSync(path.join(outDir, side), 'utf8').split('\n')) {
      if (!line) continue;
      const c = JSON.parse(line);
      const k = Math.floor(c.cx / a.blockCells) + ':' + Math.floor(c.cy / a.blockCells);
      let e = fromSidecar.get(k);
      if (!e) fromSidecar.set(k, (e = new Map()));
      // Multi-label: one cell backs EVERY class it carries. Re-derived from the record `f`
      // rather than read off `classes`, so the cross-check tests the rules and not the
      // tiler's memory of them — `classes` and `f` disagreeing is itself a finding.
      const derived = classesOf(classifyFeatures(decodeFeatures(c.f)));
      if (derived.join(',') !== (c.classes ?? []).join(',')) classesDrift++;
      for (const cls of derived) e.set(cls, (e.get(cls) ?? 0) + 1);
    }
    // The headline habitat table above counts tile-grid characters, which near a slice
    // border include cells classified from the neighbouring extract's buffer geometry —
    // that is what reads Washington DC as 38% rural. These are the same classes over the
    // cells this slice actually OWNS, and they are the ones to check against geography
    // you know: DC ran 50.8% urban, Vermont's non-rural is dominated by woodland.
    let ownedTotal = 0;
    const ownedCounts = new Map();
    for (const e of fromSidecar.values())
      for (const [cls, n] of e) {
        ownedCounts.set(cls, (ownedCounts.get(cls) ?? 0) + n);
        ownedTotal += n;
      }
    console.log(`\n  ── the same LABELS over the slice's OWNED walkable cells (${ownedTotal.toLocaleString()} labels) ──`);
    if (classesDrift)
      console.log(`  !! ${classesDrift} sidecar lines whose \`classes\` disagree with re-deriving from \`f\``);
    for (const [c, n] of [...ownedCounts].sort((x, y) => y[1] - x[1])) console.log(row(c, n, ownedTotal));

    let missing = 0; // sidecar says the class is there, the atlas does not
    let extra = 0; //   atlas claims a non-rural class the sidecar has no cell for
    let outside = 0; // sidecar block not covered by the raster at all
    const thin = new Map(); // class -> blocks resting on a single spawn cell
    for (const [k, e] of fromSidecar) {
      const [bx, by] = k.split(':').map(Number);
      if (bx < a.bx0 || bx > a.bx0 + a.cols - 1 || by < a.by0 || by > a.by0 + a.rows - 1) {
        outside++;
        continue;
      }
      const m = mask(bx, by);
      for (const [cls, n] of e) {
        if (!(m & (1 << a.classes.indexOf(cls)))) missing++;
        if (n === 1) thin.set(cls, (thin.get(cls) ?? 0) + 1);
      }
    }
    for (let by = a.by0; by < a.by0 + a.rows; by++)
      for (let bx = a.bx0; bx < a.bx0 + a.cols; bx++) {
        const m = mask(bx, by);
        const e = fromSidecar.get(bx + ':' + by);
        a.classes.forEach((c, bit) => {
          // EVERY bit is checked now, `rural` included. Revision 3's sidecar omitted rural
          // so the rural bit was structurally unbackable; revision 4's filter is `all > 0`
          // rather than "non-rural", so a rural cell IS a line and the last unverified bit
          // in the artifact is gone. `water` is inside this check from its first bake — the
          // mountain rollout is the argument: a brand-new bit is exactly the one whose
          // verification must not be skipped "for now".
          if (m & (1 << bit) && !(e && e.get(c))) extra++;
        });
      }
    const ok = missing === 0 && extra === 0 && outside === 0;
    console.log(`\n  cross-check vs ${side}: ${ok ? 'AGREES' : 'DISAGREES'} — ` +
      `${missing} missing bits, ${extra} unbacked bits, ${outside} sidecar blocks off-raster`);
    if (!ok) console.log('  !! the atlas and the sidecar were not built from the same owned cells.');
    // THE NOISE FLOOR, and it is the thing to argue about. A block's bit means "at least
    // one owned spawn cell of this class", so one lone crossroads makes an 8x11 km block
    // claim urban — and the app would then tell somebody there is a city 40 km east. The
    // denominator is blocks THAT CLAIM THE CLASS, not all blocks, because that is the
    // fraction of the answers about that class which rest on a single 167 m cell.
    console.log('  blocks claiming a class on exactly ONE spawn cell, over blocks claiming it at all:');
    for (const [c, n] of [...thin].sort((x, y) => y[1] - x[1])) console.log(row(c, n, perClass.get(c) ?? 0));

    // Draw it. A raster of a state whose outline you know is the fastest possible check
    // that the block index is not transposed or off by one — and the RAREST class present
    // is the informative glyph, because in a rural state `rural` and `residential` are in
    // nearly every block and would paint over everything that distinguishes one from the next.
    const GLYPH = { urban: 'U', residential: 'R', woodland: 'W', greenspace: 'S', rural: ',', mountain: 'M', water: '~' };
    const rarest = [...perClass].filter(([, n]) => n > 0).sort((x, y) => x[1] - y[1]).map(([c]) => c);
    if (a.cols <= 160 && a.rows <= 80 && rarest.length) {
      console.log(`\n  RAREST class present in each block, north at top — ${rarest
        .map((c) => `${GLYPH[c]} ${c}`).join('  ')}  · no data:`);
      for (let by = a.by0 + a.rows - 1; by >= a.by0; by--) {
        let line = '  ';
        for (let bx = a.bx0; bx < a.bx0 + a.cols; bx++) {
          const m = mask(bx, by);
          const hit = rarest.find((c) => m & (1 << a.classes.indexOf(c)));
          line += hit ? GLYPH[hit] : '·';
        }
        console.log(line);
      }
    }
    console.log('');
  }
}
