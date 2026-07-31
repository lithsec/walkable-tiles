#!/usr/bin/env node
// Prove published coverage BY VALUE, through the public CDN — now THROUGH THE ARCHIVES.
//
// The failure this exists to catch: an HTTP 200 is true for an empty tile, and a
// hash manifest is happy to claim tiles the bucket never received. `aws s3 ls`
// counting objects proves shape, not content — a bake that uploaded 200k zero-ish
// tiles passes every count-based check there is. So every probe here asserts on
// something only real OSM data can produce: way counts, named streets, crossings,
// landcover polygons, and geometry that actually falls inside the cell it was
// served for.
//
// ── WHAT THE ARCHIVE FORMAT ADDS TO THAT ──────────────────────────────────────────────
//
// This script used to GET an object per probe and read the status code. Under SPEC §11 a
// tile is a byte range inside a per-slice `.wta`, so the whole resolution path — index,
// coverage bitmap, directory, range — sits between the probe and the answer, and EVERY
// STEP OF IT IS A NEW WAY TO PASS VACUOUSLY. In particular:
//
//   • an `index.json` that parses is not an index that COVERS anything;
//   • a directory that decodes is not a directory that CONTAINS the cell;
//   • and a directory lookup can succeed and return NOTHING, which is the format's whole
//     point and is also indistinguishable from a broken decoder if nobody checks.
//
// So absence is now checked as a SPECIFIC absence rather than as a status code:
//
//   expect: 'empty'      the cell must be a HOLE — a published slice's bitmap CLAIMS this
//                        ground and its directory does not list the cell. Baked, empty,
//                        permanent. Asserting this proves the slice reaches here.
//   expect: 'uncovered'  NO published slice claims this ground at all. Not baked. This is
//                        the probe that catches a bake writing cells it does not own.
//
// Under the object layout both were "404" and this file could not tell them apart, which
// meant the two probes below labelled `unbaked` were asserting the same thing as the ocean
// probes. They are not the same thing and now they do not pass for the same reason.
//
// Usage:
//   TILES_HOST=https://tiles.example.com node scripts/verify-coverage.mjs
//   ... --slice utah          only probes for one slice
//   ... --json                machine-readable result
//   ... --local <dir>         resolve against a LOCAL pack (an OUT_DIR's `archive/`) with
//                             no network at all — the same resolver, a different byte
//                             source. This is what makes a `--trial` bake verifiable.
// Exits non-zero if any probe fails, so it can gate a bake.
import { readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { coverHas, decodeDirectory, findTile } from './archive.mjs';

const args = process.argv.slice(2);
const onlySlice = args.includes('--slice') ? args[args.indexOf('--slice') + 1] : null;
const asJson = args.includes('--json');
const LOCAL = args.includes('--local') ? args[args.indexOf('--local') + 1] : null;

const HOST = (process.env.TILES_HOST || process.env.EXPO_PUBLIC_TILES_HOST || '').replace(/\/$/, '');
if (!HOST && !LOCAL) {
  console.error('set TILES_HOST (or EXPO_PUBLIC_TILES_HOST) to the CDN origin, or pass --local <archive dir>');
  process.exit(2);
}

const TILE_DEG = 0.01;
const cellOf = (lat, lng) => [Math.floor(lat / TILE_DEG), Math.floor(lng / TILE_DEG)];

// ── The byte source. Two transports, ONE resolver. ────────────────────────────────────
//
// `--local` is not a second implementation of the lookup — it is the same functions over a
// file descriptor instead of a `Range` header, which is the only way a local check can be
// evidence about the published one.

async function readRange(version, path, offset, length) {
  if (LOCAL) {
    // Published layout is `<ver>/archive/<slice>-<sha>.wta`; a local pack is flat under
    // `<dest>/<ver>/`. Only the DIRECTORY differs — the file name is the same, and it is
    // the digest, so a local probe is reading the exact bytes an upload would send.
    const file = join(LOCAL, version, basename(path));
    const fd = openSync(file, 'r');
    try {
      const b = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, b, got, length - got, offset + got);
        if (n === 0) break;
        got += n;
      }
      if (got !== length) throw new Error(`short read ${got}/${length} from ${file}`);
      return b;
    } finally {
      closeSync(fd);
    }
  }
  const res = await fetch(`${HOST}/${path}`, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  // A 200 means the origin ignored `Range` and is handing back the whole archive. That is
  // a gigabyte for a big slice, and it is the one status that would otherwise look like a
  // pass. The client refuses it for the same reason (apps/mobile/src/tiles/archive.ts).
  if (res.status !== 206) throw new Error(`range ${offset}+${length} on ${path}: HTTP ${res.status}, expected 206`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== length) throw new Error(`range ${offset}+${length} on ${path} returned ${buf.length} B`);
  return buf;
}

async function readIndex(version) {
  if (LOCAL) {
    const f = join(LOCAL, version, 'index.json');
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8'));
  }
  const res = await fetch(`${HOST}/${version}/archive/index.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`index.json for ${version}: HTTP ${res.status}`);
  return await res.json();
}

const indexCache = new Map();
const dirCache = new Map();

async function archiveIndex(version) {
  if (!indexCache.has(version)) indexCache.set(version, await readIndex(version));
  return indexCache.get(version);
}

async function directoryFor(version, entry) {
  const key = `${version}/${entry.slice}/${entry.sha256}`;
  if (!dirCache.has(key)) {
    const gz = await readRange(version, entry.path, entry.dir[0], entry.dir[1]);
    dirCache.set(key, decodeDirectory(gunzipSync(gz)));
  }
  return dirCache.get(key);
}

/**
 * Resolve one cell the way the client does. Returns one of:
 *   {kind:'tile', body, bytes, slice}  — real bytes, pulled by offset
 *   {kind:'hole', slice}               — covered by a slice, absent from its directory
 *   {kind:'uncovered'}                 — no published slice claims this ground
 *   {kind:'noindex'}                   — nothing published under this prefix at all
 */
async function resolveCell(version, i, j) {
  const index = await archiveIndex(version);
  if (!index || !Array.isArray(index.slices)) return { kind: 'noindex' };
  const candidates = index.slices
    .filter((s) => coverHas(s.cover, i, j, s.coverBlock))
    .sort((a, b) => (a.slice < b.slice ? -1 : 1));
  if (candidates.length === 0) return { kind: 'uncovered' };
  for (const entry of candidates) {
    const dir = await directoryFor(version, entry);
    const k = findTile(dir, (i + 9000) * 36001 + (j + 18000));
    if (k < 0) continue;
    const off = entry.tileData[0] + dir.offsets[k];
    const buf = await readRange(version, entry.path, off, dir.lengths[k]);
    return { kind: 'tile', slice: entry.slice, bytes: buf.length, body: buf };
  }
  return { kind: 'hole', slice: candidates[0].slice };
}

// `expect`:
//   dense     — a built-up cell. Must have lots of ways, named streets, crossings.
//   sparse    — real but thin (desert track, levee, farm road). Must have >=1 way and must
//               resolve to a tile, but no volume floor: asserting density here would be
//               asserting a lie about the terrain.
//   empty     — must be a HOLE: a published slice covers this ground and its directory has
//               no tile for the cell. A tile here means one was written where there is no
//               data, which is how "we published 200k empty tiles" looks from outside.
//   uncovered — no published slice claims this ground at all. See the archive note above:
//               `empty` and `uncovered` used to be the same 404 and are now different
//               answers, so an `empty` probe no longer passes for an unbaked region.
//
// Choosing an `empty` probe needs care in v5, which writes landcover-only cells. A
// *mapped* water body (Great Salt Lake is a `natural=water` polygon) legitimately has
// a v5 tile with zero ways, so asserting 404 there would be asserting a bug that is
// not one. Open sea works because OSM has no ocean polygon; an unbaked region works
// because nothing was written at all. Probes over mapped lakes stay v4-only.
//
// A probe may carry a 7th element, `want` — a VALUE assertion about the v5 terrain layers
// of that cell (ignored for v4, which has none). This is how a new tile field gets a
// checker BEFORE it exists: the probe is added red and goes green when the bake lands.
//   want.landmark  { kind | kindIn, nameIncludes, eleMin, eleMax, anchor }
//                  at least one landmark must match every field given.
//   want.attrWays  at least this many ways must carry `lit` or `access` (SPEC §10.6).
//   want.habitatHas / want.habitatLacks
//                  characters that must / must not appear in `habitat.cells` (SPEC §10.3).
//
// Landmarks were deliberately NOT asserted before revision 2, because §10.2 capped them at
// 3 per tile sorted by footprint and a legitimately dense cell can carry zero named parks.
// Revision 2's tiering is what makes them assertable: a settlement, a peak or a national
// park now outranks the local parks in the cell that contains it, so its absence is a
// pipeline fault rather than a plausible ranking outcome.
const PROBES = [
  // slice, label, lat, lng, expect, versions
  ['massachusetts', 'downtown Boston', 42.3601, -71.0589, 'dense', ['v4', 'v5']],
  ['massachusetts', 'downtown Springfield', 42.1015, -72.5898, 'dense', ['v4', 'v5']],
  ['massachusetts', 'Atlantic E of Cape Ann', 42.65, -70.4, 'empty', ['v4', 'v5']],

  ['utah', 'downtown Salt Lake City', 40.7608, -111.891, 'dense', ['v4', 'v5']],
  ['utah', 'downtown Provo', 40.2338, -111.6585, 'dense', ['v4', 'v5']],
  ['utah', 'Capitol Reef backcountry', 38.1049, -111.5999, 'sparse', ['v4', 'v5']],
  // v4-only: the lake surface is a mapped natural=water polygon, so v5 has a
  // landcover-only tile here and a hole assertion would be wrong.
  ['utah', 'Great Salt Lake open water', 41.1, -112.5, 'empty', ['v4']],

  // Nothing should exist outside the published slices. This is the probe that catches
  // a bake writing cells it does not own — the seam rule failing open.
  ['unbaked', 'central Nevada (no slice baked)', 39.5, -117.0, 'uncovered', ['v4', 'v5']],
  ['unbaked', 'mid-Pacific', 30.0, -150.0, 'uncovered', ['v4', 'v5']],

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

  // ── REVISION 2 FIELDS: settlements, peaks, national parks, per-way lit/access ────────
  //
  // These are RED until the re-bake lands, on purpose and for the same reason the arizona/
  // florida/kansas v5 probes above were added red: a verifier that only probes what already
  // exists passes vacuously for the exact run it would be used to check. It passed 27/27
  // while three whole states had no v5 at all.
  //
  // Every cell below already returns 200 today (checked), so the failure when you run this
  // now is the `want` assertion — the field is genuinely absent, not the tile.
  //
  // `expect: 'any'` means "must be served, must be the right version, must satisfy `want`"
  // with NO way/geometry floor. A summit cell or the interior of a national park is thin
  // by nature; asserting density there would be asserting a lie about the terrain, the same
  // reason `sparse` carries no volume floor.

  // Settlement names — the field with no substitute today. Both are `place=city` NODES
  // sitting inside their own downtown cell, and both cells currently list three city parks
  // and nothing else, which is exactly the truncation §10.2's tiering fixes.
  ['kansas', 'Wichita is named in its own downtown cell', 37.6872, -97.3301, 'dense', ['v5'],
    { landmark: { kind: 'city', nameIncludes: 'Wichita' } }],
  ['massachusetts', 'Boston is named in its own downtown cell', 42.3601, -71.0589, 'dense', ['v5'],
    { landmark: { kind: 'city', nameIncludes: 'Boston' } }],

  // A named summit WITH its elevation. `ele` is checked against a range, not a value: it is
  // the mountain classifier's free calibration set, and a calibration set with a wrong
  // number in it is worse than a smaller one. Mount Timpanogos is 3581 m. The cell already
  // lists "Mount Timpanogos Wilderness" as a nature_reserve, so `kind: 'peak'` is what
  // distinguishes the summit node from the protected area around it.
  ['utah', 'Mount Timpanogos summit carries name + ele', 40.3907, -111.6457, 'any', ['v5'],
    { landmark: { kind: 'peak', nameIncludes: 'Timpanogos', eleMin: 3000, eleMax: 4000 } }],

  // An ANCHOR, flagged in its own tile (SPEC §10.8). This is the only probe that checks the
  // regional cap from the outside, and Mount Timpanogos is the right subject twice over: at
  // 3,581 m it is far and away the most significant thing in its 0.5° cell, and Utah's
  // 219,882 km² earns ~105 anchors, so it is nowhere near the count cap's edge. The claim
  // being made is narrow and worth stating: the anchor is present in the tile that CONTAINS
  // it. An anchor truncated out of its own tile is an anchor no client can ever spawn at,
  // and that is exactly the failure anchors-sort-first exists to prevent.
  ['utah', 'Mount Timpanogos is an anchor in its own tile', 40.3907, -111.6457, 'any', ['v5'],
    { landmark: { kind: 'peak', nameIncludes: 'Timpanogos', anchor: true } }],

  // National parks, probed from DEEP INSIDE rather than near the centroid — that is the
  // half of §10.2 that containment binning adds. Both parks are already in today's filter
  // (`leisure=nature_reserve` matches them) and both these cells list ZERO landmarks today.
  // `kindIn` accepts either bucket because the national_park/protected_area split turns on
  // tags that individual parks are inconsistent about.
  ['florida', 'Everglades NP named 6 km inside it (Royal Palm)', 25.382, -80.609, 'any', ['v5'],
    { landmark: { kindIn: ['national_park', 'protected_area'], nameIncludes: 'Everglades' } }],
  ['arizona', 'Grand Canyon NP named inside it (the Village)', 36.0544, -112.1401, 'any', ['v5'],
    { landmark: { kindIn: ['national_park', 'protected_area'], nameIncludes: 'Grand Canyon' } }],

  // Per-way `lit`/`access`. The floor is ONE way in a 1200 m radius of a downtown, across
  // three different cities — enough to prove the channel is populated, and deliberately not
  // a coverage percentage. OSM `lit` coverage in the US is genuinely thin, so a percentage
  // floor would be this verifier asserting a lie about the data rather than about the bake.
  ['massachusetts', 'Boston ways carry lit/access', 42.3601, -71.0589, 'dense', ['v5'], { attrWays: 1 }],
  ['florida', 'Miami ways carry lit/access', 25.7617, -80.1918, 'dense', ['v5'],
    { attrWays: 1, habitatLacks: 'm' }],
  ['utah', 'Salt Lake City ways carry lit/access', 40.7608, -111.891, 'dense', ['v5'], { attrWays: 1 }],

  // The habitat split (SPEC §10.3/§10.4): `g` retired, `w` woodland, `s` greenspace.
  // Each cell below was read off the LIVE grid before the probe was written, so the
  // expectation is grounded in the tile that exists rather than in a hope about one:
  //   Blue Hills Reservation      50 `g` cells, landcover carries `wood`  -> must yield `w`
  //   Boston Common / Public Gdn  19 `g` cells, landcover has NO `wood`   -> must yield `s`
  //   Liberty Park, Salt Lake     27 `g` cells, landcover has NO `wood`   -> must yield `s`
  // `habitatLacks: 'g'` is the retirement proof, and it is the assertion that would catch
  // the one mistake that really matters here: re-spending `g` for one of the two halves.
  ['massachusetts', 'Blue Hills reads as woodland', 42.2115, -71.085, 'any', ['v5'],
    { habitatHas: 'w', habitatLacks: 'g' }],
  ['massachusetts', 'Boston Common reads as greenspace', 42.355, -71.0656, 'dense', ['v5'],
    { habitatHas: 's', habitatLacks: 'g' }],
  ['utah', 'Liberty Park reads as greenspace', 40.746, -111.876, 'any', ['v5'],
    { habitatHas: 's', habitatLacks: 'g' }],

  // `mountain` (SPEC §10.4, revision 3). RED until the slices are re-baked, which is what
  // makes it a check rather than decoration — the same way the revision-2 probes above were
  // written red and went green when that bake landed.
  //
  // Provo, not a summit, and that is the point: it is a dense CITY whose regional relief
  // measures 1,371 m over a 5 km disc because Mount Timpanogos is four kilometres away. It
  // is the owner's "a city IN the mountains counts" case, asserted on the one live slice
  // that has real mountains. Salt Lake City would be the tempting choice and is a bad probe
  // — downtown measures 528 m against a 500 m threshold, so it asserts the calibration
  // rather than the pipeline.
  ['utah', 'Provo reads as mountain', 40.2338, -111.6585, 'dense', ['v5'], { habitatHas: 'm' }],
  // The other direction, and it is the assertion DC's trial bake exists to make: a flat
  // city must produce NO mountain cell. Miami's relief is 26 m over the same disc. A rule
  // that over-claims is worse than one that under-claims, because the class is invisible
  // from inside the app and a wrong `m` reads as a working feature.
  ['massachusetts', 'Boston is not mountain', 42.3601, -71.0589, 'dense', ['v5'],
    { habitatLacks: 'm' }],

  // ── THE TRIAL SLICES ────────────────────────────────────────────────────────────────
  //
  // Neither is published, and both are baked locally by `bake-states.sh --trial`. They are
  // here so `--local <OUT_DIR>/archive --slice vermont` verifies a pack END TO END with no
  // bucket and no credentials — index, coverage bitmap, directory, byte range, and a value
  // assertion on the bytes that come back. That is the only check available before an
  // upload, and it is the one that would catch a packer that indexed the wrong offsets.
  ['district-of-columbia', 'the National Mall', 38.8895, -77.0230, 'dense', ['v4', 'v5']],
  ['district-of-columbia', 'Rock Creek Park', 38.9500, -77.0450, 'dense', ['v4', 'v5'],
    { habitatHas: 'w' }],
  // Inside DC's cover blocks, outside its tiles — south of the Anacostia, ground the
  // District's .poly does not own. A HOLE, and the probe that separates the two absences:
  // the bitmap claims the block, the directory does not list the cell. Verified against the
  // packed directory before the probe was written (201 such cells in DC's cover).
  ['district-of-columbia', 'a covered cell the bake never wrote', 38.795, -77.095, 'empty', ['v5']],
  ['district-of-columbia', 'central Nevada', 39.5, -117.0, 'uncovered', ['v4', 'v5']],

  ['vermont', 'downtown Burlington', 44.4759, -73.2121, 'dense', ['v4', 'v5']],
  // A real thin cell — 9 ways, 51 points inside it. Chosen off the packed directory rather
  // than off a map, because a `sparse` probe over a cell whose only geometry belongs to a
  // neighbour asserts nothing about this slice.
  ['vermont', 'back roads NW of Bennington', 43.005, -73.135, 'sparse', ['v4', 'v5']],
  ['vermont', 'a covered cell the bake never wrote', 42.725, -73.295, 'empty', ['v5']],
  ['vermont', 'mid-Pacific', 30.0, -150.0, 'uncovered', ['v4', 'v5']],
];

const FLOORS = { ways: 200, named: 20, crossings: 50, ptsInCell: 100 };

async function probe(ver, lat, lng) {
  const [i, j] = cellOf(lat, lng);
  const where = `${ver}/${i}/${j}`;
  let r;
  try {
    r = await resolveCell(ver, i, j);
  } catch (err) {
    return { i, j, url: where, kind: 'error', error: String(err.message ?? err) };
  }
  if (r.kind !== 'tile') return { i, j, url: where, kind: r.kind, slice: r.slice ?? null };
  const buf = r.body;
  // A tile body inside an archive is the published `.json.gz` byte for byte, so it is
  // always gzip here — no transparent decoding happens on a byte range. The plain-text
  // branch stays for the day the CDN grows one.
  let tile;
  try {
    tile = JSON.parse(buf.toString('utf8'));
  } catch {
    tile = JSON.parse(gunzipSync(buf).toString('utf8'));
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
    url: where,
    kind: 'tile',
    slice: r.slice,
    bytes: buf.length,
    v: tile.v,
    ways: ways.length,
    named: (tile.names ?? []).filter(Boolean).length,
    crossings: (tile.crossings ?? []).length,
    landcover: (tile.landcover ?? []).length,
    landmarks: tile.landmarks ?? [],
    habitatCells: tile.habitat?.cells ?? '',
    // SPEC §10.6 — a way carries these only when OSM tagged them, so counting the ways
    // that have EITHER is the cheapest proof the channel exists at all.
    attrWays: ways.filter((w) => w.lit !== undefined || w.access !== undefined).length,
    ptsInCell,
    sampleName: (tile.names ?? []).find(Boolean) ?? null,
  };
}

// Does any landmark in the tile match every field of `w`? Returns the reason it did not,
// or null. Names are matched by SUBSTRING: "Mount Timpanogos" vs "Mt. Timpanogos" is an
// OSM editorial choice this checker has no business failing on, but the substring is still
// something only the real feature can produce.
function landmarkMiss(landmarks, w) {
  const kinds = w.kindIn ?? (w.kind ? [w.kind] : null);
  const hit = landmarks.find(
    (lm) =>
      (!kinds || kinds.includes(lm.kind)) &&
      (!w.nameIncludes || (typeof lm.name === 'string' && lm.name.includes(w.nameIncludes))) &&
      (w.eleMin === undefined || (typeof lm.ele === 'number' && lm.ele >= w.eleMin)) &&
      (w.eleMax === undefined || (typeof lm.ele === 'number' && lm.ele <= w.eleMax)) &&
      // `anchor` is written only when true (SPEC §10.2), so `anchor: true` asserts the
      // flag is present. There is no `anchor: false` assertion and there should not be:
      // absent means "this slice did not rank it", which a tile near a slice border says
      // about a landmark the neighbouring slice does anchor.
      (w.anchor === undefined || lm.anchor === true),
  );
  if (hit) return null;
  const want = [
    kinds ? `kind ${kinds.join('|')}` : null,
    w.nameIncludes ? `name ~ "${w.nameIncludes}"` : null,
    w.eleMin !== undefined || w.eleMax !== undefined ? `ele ${w.eleMin ?? '-'}..${w.eleMax ?? '-'}` : null,
    w.anchor ? 'anchor' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const got = landmarks.length
    ? landmarks
        .map((lm) => `${lm.kind}:${lm.name}${lm.ele !== undefined ? `@${lm.ele}` : ''}${lm.anchor ? '*' : ''}`)
        .join(' / ')
    : '(none)';
  return `no landmark matching {${want}} — tile has ${got}`;
}

function judge(expect, ver, r, want) {
  const bad = [];
  // A transport failure is never an absence. Under the object layout a dead origin and an
  // empty cell were both "not 200"; here they are different values and conflating them
  // would let a completely unreachable CDN pass every `empty` probe in the list.
  if (r.kind === 'error') {
    bad.push(`could not resolve: ${r.error}`);
    return bad;
  }
  if (expect === 'empty') {
    // A HOLE: some published slice CLAIMS this ground and its directory does not list the
    // cell. `uncovered` is not good enough — it would pass for a slice that was never
    // published at all, which is exactly the vacuous pass this file exists to prevent.
    if (r.kind === 'hole') return bad;
    if (r.kind === 'uncovered') bad.push('no published slice covers this cell — expected a HOLE inside a covered slice');
    else if (r.kind === 'noindex') bad.push(`nothing published under ${ver}/archive/`);
    else bad.push(`expected a hole (baked, empty), got a ${r.bytes} B tile from ${r.slice}`);
    return bad;
  }
  if (expect === 'uncovered') {
    if (r.kind === 'uncovered') return bad;
    if (r.kind === 'hole') bad.push(`slice ${r.slice} claims ground it does not own`);
    else if (r.kind === 'noindex') bad.push(`nothing published under ${ver}/archive/ — this probe proves nothing`);
    else bad.push(`a ${r.bytes} B tile exists here, served from ${r.slice}`);
    return bad;
  }
  if (r.kind === 'noindex') {
    bad.push(`nothing published under ${ver}/archive/`);
    return bad;
  }
  if (r.kind === 'uncovered') {
    bad.push('no published slice covers this cell — the slice is not baked');
    return bad;
  }
  if (r.kind === 'hole') {
    bad.push('the archive covers this cell and holds no tile for it (bake dropped it)');
    return bad;
  }
  const wantV = ver === 'v5' ? 5 : 4;
  if (r.v !== wantV) bad.push(`payload says v=${r.v}, expected v=${wantV}`);
  // Field probes (`any`) carry no volume floor — see the PROBES header.
  if (want && ver === 'v5') {
    if (want.landmark) {
      const miss = landmarkMiss(r.landmarks, want.landmark);
      if (miss) bad.push(miss);
    }
    if (want.attrWays !== undefined && r.attrWays < want.attrWays) {
      bad.push(`ways carrying lit/access ${r.attrWays} < ${want.attrWays} (SPEC §10.6 field absent)`);
    }
    const tally = () => {
      const n = {};
      for (const ch of r.habitatCells) n[ch] = (n[ch] ?? 0) + 1;
      return JSON.stringify(n);
    };
    for (const ch of want.habitatHas ?? '') {
      if (!r.habitatCells.includes(ch)) bad.push(`habitat grid has no '${ch}' cell — grid is ${tally()}`);
    }
    for (const ch of want.habitatLacks ?? '') {
      if (r.habitatCells.includes(ch))
        bad.push(`habitat grid contains '${ch}', which this cell must not have — grid is ${tally()}`);
    }
  }
  if (expect === 'any') return bad;
  if (r.ways < 1) bad.push('zero ways — the archive holds a tile here with no content in it');
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

for (const [slice, label, lat, lng, expect, versions, want] of PROBES) {
  if (onlySlice && slice !== onlySlice) continue;
  for (const ver of versions) {
    const r = await probe(ver, lat, lng);
    const bad = judge(expect, ver, r, want);
    if (bad.length) failed++;
    results.push({ slice, label, ver, expect, ...r, problems: bad });
    if (!asJson) {
      const tag = bad.length ? 'FAIL' : 'ok  ';
      const detail =
        r.kind !== 'tile'
          ? r.kind === 'hole'
            ? `HOLE in ${r.slice}`
            : r.kind === 'error'
              ? `ERROR ${r.error}`
              : r.kind
          : `${r.bytes}B ${r.slice} ways=${r.ways} named=${r.named} xings=${r.crossings}` +
            (ver === 'v5' ? ` landcover=${r.landcover} lm=${r.landmarks.length} litAcc=${r.attrWays}` : '') +
            ` inCell=${r.ptsInCell}` +
            (r.sampleName ? ` "${r.sampleName}"` : '');
      console.log(`${tag} ${slice}/${ver} ${label} [${expect}] ${r.i}/${r.j}  ${detail}`);
      for (const b of bad) console.log(`       ↳ ${b}`);
    }
  }
}

if (asJson) console.log(JSON.stringify({ host: LOCAL ? `file://${LOCAL}` : HOST, failed, results }, null, 2));
else console.log(`\n${results.length - failed}/${results.length} probes passed against ${LOCAL ? `local pack ${LOCAL}` : HOST}`);

process.exit(failed ? 1 : 0);
