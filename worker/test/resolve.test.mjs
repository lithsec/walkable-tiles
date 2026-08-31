// Tests for the Worker's resolution core, against REAL archives — the massachusetts v5
// fixture in `out-bake/`, which is sharded (`massachusetts-a` + `massachusetts-b`), so
// shard-family resolution is exercised on the genuine article rather than a synthetic.
//
// No Cloudflare anywhere: `resolve.mjs` is pure, so `loadDirectory` is a file read here
// and an R2 range read in production. Run from the repo root:
//
//     node --test worker/test/
//
// Two kinds of assertion, deliberately:
//   - AGREEMENT with `scripts/archive.mjs` (the reference implementation the packer and
//     verifier share). The Worker's core is a Buffer-free PORT of it, and a port that
//     merely "looks the same" is exactly the failure the repo has paid for before —
//     so tileId, directory decode and cover bits are compared value for value.
//   - BYTE IDENTITY of a resolved tile against the per-cell object the bake wrote
//     (`out-bake/massachusetts/v5/<i>/<j>.json.gz`) — the packer's own promise (§11.1:
//     each body is the EXACT `.json.gz` byte string) checked end to end through the
//     Worker's own code path.
//
// The fixture archives are multi-GB local bake output and are NOT in git; when they are
// absent (fresh clone, CI) every fixture-dependent test SKIPS rather than fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, open, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTilePath,
  tileId,
  decodeDirectory,
  findTile,
  coverHas,
  bboxHas,
  candidateSlices,
  resolveTile,
  gunzip,
} from '../src/resolve.mjs';

// The reference implementation — Node-only (Buffer, zlib), which is why the Worker
// ports it instead of importing it, and why THIS file can import it to cross-check.
import * as reference from '../../scripts/archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'out-bake', 'massachusetts');
const ARCHIVE_DIR = join(FIXTURE, 'archive', 'v5');

const haveFixtures = await access(join(ARCHIVE_DIR, 'index.json')).then(
  () => true,
  () => false,
);
const skip = haveFixtures ? false : 'out-bake/massachusetts fixtures not on disk';

/** The fixture's index.json — the same document the Worker fetches from R2. */
async function loadIndex() {
  return JSON.parse(await readFile(join(ARCHIVE_DIR, 'index.json'), 'utf8'));
}

/** Range-read a slice of the entry's `.wta` from disk — the test's stand-in for
 *  `env.TILES.get(path, {range})`. */
async function readRange(entry, offset, length) {
  const fh = await open(join(ARCHIVE_DIR, basename(entry.path)), 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    assert.equal(bytesRead, length, 'short read from archive');
    return new Uint8Array(buf);
  } finally {
    await fh.close();
  }
}

/** Directory loader injected into resolveTile — fetch the `dir` range, gunzip through
 *  the Worker's own gunzip, decode through the Worker's own decoder. Memoized by digest
 *  like the Worker's cache. */
const dirMemo = new Map();
async function loadDirectory(entry) {
  let dir = dirMemo.get(entry.sha256);
  if (!dir) {
    dir = decodeDirectory(await gunzip(await readRange(entry, entry.dir[0], entry.dir[1])));
    dirMemo.set(entry.sha256, dir);
  }
  return dir;
}

// ── URL parsing ─────────────────────────────────────────────────────────────────────

test('parseTilePath: the shipped URL shape, negative j included', () => {
  // A real US cell: lat 42.36, lng -71.07 → i=4236, j=-7107.
  assert.deepEqual(parseTilePath('/v4/4236/-7107.json.gz'), { version: 'v4', i: 4236, j: -7107 });
  assert.deepEqual(parseTilePath('/v5/4123/-7351.json.gz'), { version: 'v5', i: 4123, j: -7351 });
  assert.deepEqual(parseTilePath('/v5c/-34/1512.json.gz'), { version: 'v5c', i: -34, j: 1512 });
});

test('parseTilePath: everything else is not a tile request', () => {
  for (const p of [
    '/v4/archive/index.json', //          the passthrough surface, not a tile
    '/v4/archive/arizona-1006b2a28d48.wta',
    '/v5/habitat/vermont.jsonl',
    '/v6/1/2.json.gz', //                 unknown version prefix
    '/v4/1/2.json', //                    wrong extension
    '/v4/1.5/2.json.gz', //               not integers
    '/v4/9000/0.json.gz', //              i out of the injective grid (max 8999)
    '/v4/0/-18001.json.gz', //            j out of the grid
    '/v4/1/2.json.gz/extra',
    '/v4//2.json.gz',
  ]) {
    assert.equal(parseTilePath(p), null, p);
  }
});

// ── agreement with the reference implementation ─────────────────────────────────────

test('tileId agrees with scripts/archive.mjs across the grid, corners included', () => {
  const is = [-9000, -1, 0, 1, 4236, 8999];
  const js = [-18000, -7107, -1, 0, 1, 17999];
  for (const i of is) {
    for (const j of js) {
      assert.equal(tileId(i, j), reference.tileId(i, j), `tileId(${i}, ${j})`);
    }
  }
});

test('decodeDirectory agrees with the reference on a real directory', { skip }, async () => {
  const index = await loadIndex();
  const b = index.slices.find((s) => s.slice === 'massachusetts-b');
  const gz = await readRange(b, b.dir[0], b.dir[1]);
  const ours = decodeDirectory(await gunzip(gz));
  const theirs = reference.decodeDirectory(
    (await import('node:zlib')).gunzipSync(Buffer.from(gz)),
  );
  assert.equal(ours.ids.length, theirs.ids.length);
  assert.equal(ours.ids.length, b.tileCount, 'directory entry count matches the sidecar');
  assert.deepEqual(ours.ids, theirs.ids);
  assert.deepEqual(ours.lengths, theirs.lengths);
  assert.deepEqual(ours.offsets, theirs.offsets);
  // Implicit offsets must add up to exactly the sidecar's tileBytes — a value check on
  // the whole prefix sum, not a shape check.
  const last = ours.ids.length - 1;
  assert.equal(ours.offsets[last] + ours.lengths[last], b.tileBytes);
});

test('coverHas agrees with the reference over both shards', { skip }, async () => {
  const index = await loadIndex();
  for (const entry of index.slices) {
    const [minI, maxI, minJ, maxJ] = entry.bbox;
    // Sample every block corner across the bbox plus a ring outside it.
    for (let i = minI - 15; i <= maxI + 15; i += 10) {
      for (let j = minJ - 15; j <= maxJ + 15; j += 10) {
        assert.equal(
          coverHas(entry.cover, i, j, entry.coverBlock),
          reference.coverHas(entry.cover, i, j, entry.coverBlock),
          `${entry.slice} cover at (${i}, ${j})`,
        );
      }
    }
  }
});

// ── ownership: bbox, cover, shard families ──────────────────────────────────────────

test('shard family: each shard owns its own cells and only those', { skip }, async () => {
  const index = await loadIndex();
  const a = index.slices.find((s) => s.slice === 'massachusetts-a');
  const b = index.slices.find((s) => s.slice === 'massachusetts-b');
  assert.ok(a && b, 'fixture is the sharded massachusetts family');

  // A cell from the middle of each shard's directory — genuinely-written cells, with
  // negative j throughout (Massachusetts is west of Greenwich).
  for (const entry of [a, b]) {
    const dir = await loadDirectory(entry);
    const id = dir.ids[dir.ids.length >> 1];
    const j = (id % 36001) - 18000;
    const i = (id - (j + 18000)) / 36001 - 9000;
    assert.ok(j < 0, 'fixture cells have negative j');
    assert.ok(bboxHas(entry.bbox, i, j));

    const candidates = candidateSlices(index, i, j);
    assert.ok(
      candidates.some((c) => c.slice === entry.slice),
      `${entry.slice} is a candidate for its own cell (${i}, ${j})`,
    );

    const resolved = await resolveTile(index, i, j, loadDirectory);
    assert.equal(resolved.kind, 'tile');
    assert.equal(resolved.entry.slice, entry.slice, `cell (${i}, ${j}) resolves to its writer`);
  }

  // The two shards split by rows (pack-archives.mjs keeps shard covers disjoint), so a
  // cell of b's must never resolve through a even though both share the family bbox band.
  const dirB = await loadDirectory(b);
  const dirA = await loadDirectory(a);
  assert.equal(findTile(dirA, dirB.ids[0]), -1, "a's directory does not list b's first cell");
});

test('candidates come back in slice-name order', { skip }, async () => {
  const index = await loadIndex();
  // Force an overlap: duplicate the index with shards listed in reverse.
  const shuffled = { ...index, slices: [...index.slices].reverse() };
  const a = index.slices.find((s) => s.slice === 'massachusetts-a');
  const dirA = await loadDirectory(a);
  const id = dirA.ids[0];
  const j = (id % 36001) - 18000;
  const i = (id - (j + 18000)) / 36001 - 9000;
  const names = candidateSlices(shuffled, i, j).map((c) => c.slice);
  assert.deepEqual(names, [...names].sort(), 'sorted regardless of index order');
});

// ── the two 404s ────────────────────────────────────────────────────────────────────

test('hole: a claimed block with no directory entry resolves to hole, not unbaked', { skip }, async () => {
  const index = await loadIndex();
  const a = index.slices.find((s) => s.slice === 'massachusetts-a');
  const dirA = await loadDirectory(a);
  const present = new Set(dirA.ids);

  // Walk a's covered blocks until we find a cell the cover claims but no shard wrote —
  // ocean and pondwater inside the coastline guarantee plenty.
  let holeCell = null;
  outer: for (let i = a.bbox[0]; i <= a.bbox[1] && !holeCell; i++) {
    for (let j = a.bbox[2]; j <= a.bbox[3]; j++) {
      if (!coverHas(a.cover, i, j, a.coverBlock)) continue;
      if (present.has(tileId(i, j))) continue;
      const r = await resolveTile(index, i, j, loadDirectory);
      if (r.kind === 'hole') {
        holeCell = [i, j];
        assert.ok(r.tried.includes('massachusetts-a'), 'the claiming shard was consulted');
        break outer;
      }
      // (kind 'tile' here means the OTHER shard wrote it — keep looking.)
    }
  }
  assert.ok(holeCell, 'found a hole cell inside claimed coverage');
});

test('unbaked: a cell in no slice bbox, and a bbox cell in an unclaimed block', { skip }, async () => {
  const index = await loadIndex();

  // Far outside every bbox (mid-Kansas i/j are nowhere near this fixture's index).
  assert.deepEqual(await resolveTile(index, 3800, -9900, loadDirectory), { kind: 'unbaked' });
  // And on the far side of the world, positive j.
  assert.deepEqual(await resolveTile(index, 5148, 12, loadDirectory), { kind: 'unbaked' });

  // Inside a bbox but in a block the cover does not claim (SPEC §11.5: the bbox alone
  // cannot answer — massachusetts-a's rectangle reaches over open water). If the fixture
  // happens to claim every block of its bbox, there is nothing to assert — but say so.
  const a = index.slices.find((s) => s.slice === 'massachusetts-a');
  let found = null;
  outer: for (let i = a.bbox[0]; i <= a.bbox[1]; i += 3) {
    for (let j = a.bbox[2]; j <= a.bbox[3]; j += 3) {
      if (candidateSlices(index, i, j).length === 0) {
        found = [i, j];
        break outer;
      }
    }
  }
  assert.ok(found, 'the bbox contains at least one unclaimed block');
  const r = await resolveTile(index, found[0], found[1], loadDirectory);
  assert.equal(r.kind, 'unbaked', `bbox cell (${found}) in an unclaimed block is unbaked, not a hole`);
});

// ── byte identity ───────────────────────────────────────────────────────────────────

test('a resolved tile is byte-identical to the per-cell object the bake wrote', { skip }, async () => {
  const index = await loadIndex();
  for (const entry of index.slices) {
    const dir = await loadDirectory(entry);
    // First, middle and last cell of each shard — the offsets most likely to expose an
    // off-by-one in the implicit-offset prefix sum.
    for (const k of [0, dir.ids.length >> 1, dir.ids.length - 1]) {
      const id = dir.ids[k];
      const j = (id % 36001) - 18000;
      const i = (id - (j + 18000)) / 36001 - 9000;

      const resolved = await resolveTile(index, i, j, loadDirectory);
      assert.equal(resolved.kind, 'tile');
      assert.equal(resolved.entry.slice, entry.slice);
      assert.equal(resolved.length, dir.lengths[k]);

      const fromArchive = await readRange(resolved.entry, resolved.offset, resolved.length);
      const fromObject = new Uint8Array(await readFile(join(FIXTURE, 'v5', String(i), `${j}.json.gz`)));
      assert.deepEqual(fromArchive, fromObject, `tile (${i}, ${j}) of ${entry.slice}`);
      // And it really is a gzip body — the payload contract the app depends on.
      assert.equal(fromArchive[0], 0x1f);
      assert.equal(fromArchive[1], 0x8b);
    }
  }
});
