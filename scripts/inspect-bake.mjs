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
// Named summits, for the peak-prominence report below. `ele` is what the tile SHIPS (the
// OSM tag); the score that ranks it is local drop from the DEM (SPEC §10.8), and the two
// disagreeing is the entire point of revision 3 — so both are printed side by side.
const peakEles = [];

const habitat = new Map();
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
    if (lm.kind === 'peak' && typeof lm.ele === 'number') peakEles.push(lm.ele);
    if (lm.ele !== undefined && lm.ele !== null) withEle++;
    const ak = `${lm.kind}@${Math.round(lm.lat * 1e6)},${Math.round(lm.lng * 1e6)}`;
    if (!landmarkAnchors.has(ak)) landmarkAnchors.set(ak, lm);
    if (lm.anchor === true) flaggedAnchors.set(ak, lm);
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

reportAtlas();

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
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
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
    const mask = (bx, by) => B64.indexOf(a.blocks[(by - a.by0) * a.cols + (bx - a.bx0)]);
    const blockDeg = a.blockCells * a.cellDeg;
    const latMid = (a.by0 + a.rows / 2) * blockDeg;
    const kmNS = (blockDeg * 111.32).toFixed(1);
    const kmEW = (blockDeg * 111.32 * Math.cos((latMid * Math.PI) / 180)).toFixed(1);

    let occupied = 0;
    const perClass = new Map(a.classes.map((c) => [c, 0]));
    for (let i = 0; i < a.blocks.length; i++) {
      const m = B64.indexOf(a.blocks[i]);
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
    for (const line of readFileSync(path.join(outDir, side), 'utf8').split('\n')) {
      if (!line) continue;
      const c = JSON.parse(line);
      const k = Math.floor(c.cx / a.blockCells) + ':' + Math.floor(c.cy / a.blockCells);
      let e = fromSidecar.get(k);
      if (!e) fromSidecar.set(k, (e = new Map()));
      e.set(c.class, (e.get(c.class) ?? 0) + 1);
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
    console.log(`\n  ── the same classes over ${ownedTotal.toLocaleString()} SLICE-OWNED non-rural cells ──`);
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
          // `rural` is the one class the sidecar omits by design (SPEC §10.7), so the
          // atlas legitimately carries a bit nothing here can back. Everything else must
          // be backed — INCLUDING `mountain`, which was skipped while the bit could only
          // ever be 0. Leaving it skipped once revision 3 started setting it would have
          // made the one new bit the only unverified one in the artifact.
          if (c === 'rural') return;
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
    const GLYPH = { urban: 'U', residential: 'R', woodland: 'W', greenspace: 'S', rural: ',', mountain: 'M' };
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
