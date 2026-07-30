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

const HABITAT_NAME = { u: 'urban', r: 'residential', w: 'woodland', s: 'greenspace', m: 'mountain', '.': 'rural' };

const habitat = new Map();
const landmarkKinds = new Map();
const landcoverKinds = new Map();
const namedLandmarks = [];
let tileCount = 0;
let waysTotal = 0;
let waysLit = 0;
let waysAccess = 0;
let withEle = 0;
let unknownCodes = new Set();

for (const f of tiles(v5)) {
  tileCount++;
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
    if (lm.ele !== undefined && lm.ele !== null) withEle++;
    if (namedLandmarks.length < 4000) namedLandmarks.push(lm);
  }
  // The habitat grid is one character per spawn cell. Cells straddle tile edges and appear
  // in up to four tiles, so count DISTINCT cells rather than characters or the overlap
  // inflates whichever classes happen to sit on a boundary.
  const h = d.habitat;
  if (h?.cells) {
    for (let dy = 0; dy < h.rows; dy++) {
      for (let dx = 0; dx < h.cols; dx++) {
        const code = h.cells[dy * h.cols + dx];
        const name = HABITAT_NAME[code];
        if (!name) { unknownCodes.add(code); continue; }
        habitat.set(`${h.cx0 + dx}:${h.cy0 + dy}`, name);
      }
    }
  }
}

const counts = new Map();
for (const cls of habitat.values()) counts.set(cls, (counts.get(cls) ?? 0) + 1);
const cells = habitat.size;

const pct = (n, d) => (d === 0 ? '  —  ' : `${((100 * n) / d).toFixed(1)}%`.padStart(6));
const row = (k, n, d) => `  ${String(k).padEnd(14)} ${String(n).padStart(8)}  ${pct(n, d)}`;

console.log(`\n${tileCount} v5 tiles in ${path.relative(process.cwd(), outDir)}\n`);

console.log(`── habitat classes, over ${cells.toLocaleString()} DISTINCT spawn cells ──`);
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(row(k, n, cells));
if (!counts.has('woodland') || !counts.has('greenspace')) {
  console.log('\n  !! one half of the green split is EMPTY — that is the thing to look at.');
} else {
  const w = counts.get('woodland');
  const s = counts.get('greenspace');
  console.log(`\n  woodland : greenspace = ${(w / s).toFixed(2)} : 1`);
  console.log('  Both non-zero is necessary, not sufficient — a 50:1 ratio would say the');
  console.log('  threshold is wrong even though nothing is technically broken.');
}
if (unknownCodes.size > 0) {
  console.log(`\n  !! grid characters this inspector does not know: ${[...unknownCodes].join(' ')}`);
  console.log('     A legacy `g` here means the tiler was not re-run.');
}

console.log(`\n── landcover polygons ──`);
for (const [k, n] of [...landcoverKinds].sort((a, b) => b[1] - a[1])) console.log(row(k, n, 0));

console.log(`\n── landmark kinds ──`);
for (const [k, n] of [...landmarkKinds].sort((a, b) => b[1] - a[1])) console.log(row(k, n, 0));
console.log(`  ${String('with ele').padEnd(14)} ${String(withEle).padStart(8)}   (peaks carry elevation)`);

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
