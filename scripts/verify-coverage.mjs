#!/usr/bin/env node
// Prove published coverage BY VALUE, through the public CDN.
//
// The failure this exists to catch: an HTTP 200 is true for an empty tile, and a
// hash manifest is happy to claim tiles the bucket never received. `aws s3 ls`
// counting objects proves shape, not content — a bake that uploaded 200k zero-ish
// tiles passes every count-based check there is. So every probe here asserts on
// something only real OSM data can produce: way counts, named streets, crossings,
// landcover polygons, and geometry that actually falls inside the cell it was
// served for.
//
// Usage:
//   TILES_HOST=https://tiles.example.com node scripts/verify-coverage.mjs
//   ... --slice utah          only probes for one slice
//   ... --json                machine-readable result
// Exits non-zero if any probe fails, so it can gate a bake.

const HOST = (process.env.TILES_HOST || process.env.EXPO_PUBLIC_TILES_HOST || '').replace(/\/$/, '');
if (!HOST) {
  console.error('set TILES_HOST (or EXPO_PUBLIC_TILES_HOST) to the CDN origin');
  process.exit(2);
}

const args = process.argv.slice(2);
const onlySlice = args.includes('--slice') ? args[args.indexOf('--slice') + 1] : null;
const asJson = args.includes('--json');

const TILE_DEG = 0.01;
const cellOf = (lat, lng) => [Math.floor(lat / TILE_DEG), Math.floor(lng / TILE_DEG)];

// `expect`:
//   dense  — a built-up cell. Must have lots of ways, named streets, crossings.
//   sparse — real but thin (desert track, levee, farm road). Must have >=1 way and
//            must NOT 404, but no volume floor: asserting density here would be
//            asserting a lie about the terrain.
//   empty  — must 404. A 200 here means a tile was written where there is no data,
//            which is how "we published 200k empty tiles" looks from outside.
//
// Choosing an `empty` probe needs care in v5, which writes landcover-only cells. A
// *mapped* water body (Great Salt Lake is a `natural=water` polygon) legitimately has
// a v5 tile with zero ways, so asserting 404 there would be asserting a bug that is
// not one. Open sea works because OSM has no ocean polygon; an unbaked region works
// because nothing was written at all. Probes over mapped lakes stay v4-only.
//
// Landmarks are deliberately not asserted: SPEC §10.2 caps them at 3 per tile and a
// legitimately dense cell can carry zero named parks or libraries.
const PROBES = [
  // slice, label, lat, lng, expect, versions
  ['massachusetts', 'downtown Boston', 42.3601, -71.0589, 'dense', ['v4', 'v5']],
  ['massachusetts', 'downtown Springfield', 42.1015, -72.5898, 'dense', ['v4', 'v5']],
  ['massachusetts', 'Atlantic E of Cape Ann', 42.65, -70.4, 'empty', ['v4', 'v5']],

  ['utah', 'downtown Salt Lake City', 40.7608, -111.891, 'dense', ['v4', 'v5']],
  ['utah', 'downtown Provo', 40.2338, -111.6585, 'dense', ['v4', 'v5']],
  ['utah', 'Capitol Reef backcountry', 38.1049, -111.5999, 'sparse', ['v4', 'v5']],
  // v4-only: the lake surface is a mapped natural=water polygon, so v5 has a
  // landcover-only tile here and a 404 assertion would be wrong.
  ['utah', 'Great Salt Lake open water', 41.1, -112.5, 'empty', ['v4']],

  // Nothing should exist outside the published slices. This is the probe that catches
  // a bake writing cells it does not own — the seam rule failing open.
  ['unbaked', 'central Nevada (no slice baked)', 39.5, -117.0, 'empty', ['v4', 'v5']],
  ['unbaked', 'mid-Pacific', 30.0, -150.0, 'empty', ['v4', 'v5']],

  // ── v4 AND v5 for the three states whose v5 bake is pending ────────────────────────
  //
  // These carried `['v4']` only, which made this verifier PASS VACUOUSLY for the exact run
  // it would be used to check: bake v5 for arizona, publish nothing, and a v4-only probe
  // list still reports every probe green. A checker that silently checks nothing is worse
  // than no checker, so v5 is listed here BEFORE it exists and these probes are expected to
  // FAIL until the bake lands. That failure is the feature — it is the difference between
  // "v5 is live" and "v5 was never asked about".
  ['arizona', 'downtown Phoenix', 33.4484, -112.074, 'dense', ['v4', 'v5']],
  ['arizona', 'downtown Tucson', 32.2226, -110.9747, 'dense', ['v4', 'v5']],
  ['arizona', 'Sonoran desert S of Gila Bend', 32.75, -112.85, 'sparse', ['v4', 'v5']],

  ['florida', 'downtown Miami', 25.7617, -80.1918, 'dense', ['v4', 'v5']],
  ['florida', 'downtown Orlando', 28.5384, -81.3789, 'dense', ['v4', 'v5']],
  ['florida', 'Everglades L-28 levee', 25.85, -80.85, 'sparse', ['v4', 'v5']],
  ['florida', 'Atlantic E of Miami Beach', 25.76, -79.99, 'empty', ['v4', 'v5']],

  ['kansas', 'downtown Wichita', 37.6872, -97.3301, 'dense', ['v4', 'v5']],
  ['kansas', 'downtown Topeka', 39.0473, -95.6752, 'dense', ['v4', 'v5']],
  ['kansas', 'Gove County farmland', 38.75, -100.55, 'sparse', ['v4', 'v5']],
];

const FLOORS = { ways: 200, named: 20, crossings: 50, ptsInCell: 100 };

async function probe(ver, lat, lng) {
  const [i, j] = cellOf(lat, lng);
  const url = `${HOST}/${ver}/${i}/${j}.json.gz`;
  const res = await fetch(url);
  if (res.status === 404) return { i, j, url, status: 404 };
  if (!res.ok) return { i, j, url, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  // The CDN may or may not have already decoded content-encoding: gzip for us.
  let tile;
  try {
    tile = JSON.parse(buf.toString('utf8'));
  } catch {
    tile = JSON.parse((await import('node:zlib')).gunzipSync(buf).toString('utf8'));
  }
  const ways = tile.ways ?? [];
  let ptsInCell = 0;
  for (const w of ways) {
    for (const p of w.points ?? []) {
      if (Math.floor(p.lat / TILE_DEG) === i && Math.floor(p.lng / TILE_DEG) === j) ptsInCell++;
    }
  }
  return {
    i,
    j,
    url,
    status: 200,
    bytes: buf.length,
    v: tile.v,
    ways: ways.length,
    named: (tile.names ?? []).filter(Boolean).length,
    crossings: (tile.crossings ?? []).length,
    landcover: (tile.landcover ?? []).length,
    ptsInCell,
    sampleName: (tile.names ?? []).find(Boolean) ?? null,
  };
}

function judge(expect, ver, r) {
  const bad = [];
  if (expect === 'empty') {
    if (r.status !== 404) bad.push(`expected 404 (no data here), got ${r.status}`);
    return bad;
  }
  if (r.status === 404) {
    bad.push('404 — tile absent (slice not published, or bake dropped it)');
    return bad;
  }
  if (r.status !== 200) {
    bad.push(`HTTP ${r.status}`);
    return bad;
  }
  const wantV = ver === 'v5' ? 5 : 4;
  if (r.v !== wantV) bad.push(`payload says v=${r.v}, expected v=${wantV}`);
  if (r.ways < 1) bad.push('zero ways — served a 200 with no content');
  // Geometry must land in the cell it was served for. Catches a mis-keyed bake,
  // which no byte-count check can see.
  if (r.ptsInCell < 1) bad.push('no way geometry inside this cell');
  if (expect === 'dense') {
    if (r.ways < FLOORS.ways) bad.push(`ways ${r.ways} < ${FLOORS.ways}`);
    if (r.named < FLOORS.named) bad.push(`named streets ${r.named} < ${FLOORS.named}`);
    if (r.crossings < FLOORS.crossings) bad.push(`crossings ${r.crossings} < ${FLOORS.crossings}`);
    if (r.ptsInCell < FLOORS.ptsInCell) bad.push(`points in cell ${r.ptsInCell} < ${FLOORS.ptsInCell}`);
    // v5's whole reason to exist is the terrain layer; a v5 tile over a city with no
    // landcover polygon means the landcover pass silently produced nothing.
    if (ver === 'v5' && r.landcover < 1) bad.push('v5 dense cell has no landcover polygons');
  }
  return bad;
}

const results = [];
let failed = 0;

for (const [slice, label, lat, lng, expect, versions] of PROBES) {
  if (onlySlice && slice !== onlySlice) continue;
  for (const ver of versions) {
    const r = await probe(ver, lat, lng);
    const bad = judge(expect, ver, r);
    if (bad.length) failed++;
    results.push({ slice, label, ver, expect, ...r, problems: bad });
    if (!asJson) {
      const tag = bad.length ? 'FAIL' : 'ok  ';
      const detail =
        r.status === 404
          ? '404'
          : `${r.bytes}B ways=${r.ways} named=${r.named} xings=${r.crossings}` +
            (ver === 'v5' ? ` landcover=${r.landcover}` : '') +
            ` inCell=${r.ptsInCell}` +
            (r.sampleName ? ` "${r.sampleName}"` : '');
      console.log(`${tag} ${slice}/${ver} ${label} [${expect}] ${r.i}/${r.j}  ${detail}`);
      for (const b of bad) console.log(`       ↳ ${b}`);
    }
  }
}

if (asJson) console.log(JSON.stringify({ host: HOST, failed, results }, null, 2));
else console.log(`\n${results.length - failed}/${results.length} probes passed against ${HOST}`);

process.exit(failed ? 1 : 0);
