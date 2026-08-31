// The resolution core: per-cell tile URL → byte range inside a published `.wta` archive.
//
// This is the pure half of the Worker. It knows the archive format (SPEC.md §11) and the
// index/cover semantics (§11.4, §11.5, §11.7) and touches NO runtime API — no R2, no
// Cache API, no fetch. Everything I/O-shaped is injected (`loadDirectory`), which is what
// lets `worker/test/resolve.test.mjs` exercise every branch against the real archives in
// `out-bake/` from plain Node, with no Cloudflare anywhere.
//
// It is a deliberate PORT of `scripts/archive.mjs` (the repo's reference implementation),
// not an import of it: the reference uses `Buffer` and `node:zlib`, neither of which
// exists in the Workers runtime. The port keeps the identical arithmetic — same varint
// loop, same tileId formula, same cover bit order — and the test suite decodes a real
// directory through BOTH implementations and asserts they agree entry for entry, so the
// two cannot quietly drift. (Lesson recorded in archive.mjs: assert on a VALUE, never on
// a shape.)
//
// One asymmetry with SPEC §11.7 worth stating: the client resolves HOLE and UNBAKED to
// different cache TTLs; the shipped app that THIS worker serves predates archives and
// treats every 404 as "empty cell". So both outcomes leave here as distinct values
// (`hole` / `unbaked`) and the Worker collapses them to 404 — the distinction survives
// only as a debug header. When an archive-native client ships, this module already knows
// the difference.

/** Cells per degree — `TILE_DEG` is 0.01°. Same constant as scripts/archive.mjs. */
export const GRID_DENOM = 100;

/** Default coverage-bitmap block edge in cells; the index entry's own `coverBlock` wins
 *  when present, so a bitmap baked at one block size is still read at that size after the
 *  constant moves (same rule as the reference `coverHas`). */
export const COVER_BLOCK = 10;

// ── the tile URL ────────────────────────────────────────────────────────────────────

/** The shipped app's request shape: `/<ver>/<i>/<j>.json.gz` with i = floor(lat/0.01),
 *  j = floor(lng/0.01) — j negative across the Americas. Anchored and whitelisted:
 *  anything that is not exactly a tile URL is not a tile request (it may still be a real
 *  object — archives, sidecars — which the Worker passes through separately). */
const TILE_PATH = /^\/(v4|v5c|v5)\/(-?\d{1,5})\/(-?\d{1,5})\.json\.gz$/;

/** Parse a pathname into `{version, i, j}`, or null when it is not a tile URL.
 *  Bounds-checked against the grid the tileId is injective over — an out-of-range index
 *  would silently collide with another cell's id, which is the failure mode this format
 *  exists to refuse. */
export function parseTilePath(pathname) {
  const m = TILE_PATH.exec(pathname);
  if (!m) return null;
  const i = Number(m[2]);
  const j = Number(m[3]);
  if (i < -9000 || i > 8999 || j < -18000 || j > 17999) return null;
  return { version: m[1], i, j };
}

// ── tile id (SPEC §11.2) ────────────────────────────────────────────────────────────

/** Injective over the whole grid, max ≈ 6.5e8 (inside uint32). Identical to
 *  scripts/archive.mjs `tileId` — the test asserts so on values. */
export function tileId(i, j) {
  return (i + 9000) * 36001 + (j + 18000);
}

// ── directory (SPEC §11.3) ──────────────────────────────────────────────────────────

/** Unsigned LEB128, multiply-shift form so lengths past 2^32 stay exact doubles —
 *  the same loop as the reference, minus Buffer. */
function readVarint(buf, state) {
  let result = 0;
  let shift = 1;
  for (;;) {
    const b = buf[state.p++];
    if (b === undefined) throw new Error('resolve: varint ran off the end of the directory');
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) return result;
    shift *= 128;
  }
}

/**
 * Decode a directory body (already gunzipped) into `{ids, lengths, offsets}`.
 * Offsets are IMPLICIT — a prefix sum of the lengths, relative to the archive's
 * `tileData` offset — because the packer writes bodies contiguously in id order and the
 * format has no way to express a gap (§11.3).
 */
export function decodeDirectory(body) {
  const state = { p: 0 };
  const n = readVarint(body, state);
  const ids = new Array(n);
  const lengths = new Array(n);
  const offsets = new Array(n);
  let id = 0;
  for (let k = 0; k < n; k++) {
    id += readVarint(body, state);
    ids[k] = id;
  }
  let off = 0;
  for (let k = 0; k < n; k++) {
    const len = readVarint(body, state);
    lengths[k] = len;
    offsets[k] = off;
    off += len;
  }
  return { ids, lengths, offsets };
}

/** Binary search for a tile id. `-1` is a HOLE and is an ANSWER ("this cell was baked
 *  and holds nothing"), not a failure. */
export function findTile(dir, id) {
  let lo = 0;
  let hi = dir.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = dir.ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ── coverage bitmap (SPEC §11.5) ────────────────────────────────────────────────────

/** base64 → bytes without Buffer. `atob` exists in both the Workers runtime and Node. */
function base64Bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k);
  return out;
}

/** Does this slice's bitmap claim the block containing cell `(i, j)`? Row-major over
 *  block indices, LSB-first within each byte — bit-identical to the reference. */
export function coverHas(cover, i, j, block = COVER_BLOCK) {
  const [rows, cols] = cover.dims;
  if (rows === 0 || cols === 0) return false;
  const bi = Math.floor(i / block);
  const bj = Math.floor(j / block);
  const r = bi - cover.origin[0];
  const c = bj - cover.origin[1];
  if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
  const bytes = base64Bytes(cover.bits);
  const bit = r * cols + c;
  return ((bytes[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
}

/** Is `(i, j)` inside an index entry's `bbox`? Order is `[minI, maxI, minJ, maxJ]` —
 *  verified against the live `v4/archive/index.json` (arizona: [3133, 3700, -11482,
 *  -10905], which is lat 31–37°N, lng 114–109°W: Arizona), and against SPEC §11.4. */
export function bboxHas(bbox, i, j) {
  return i >= bbox[0] && i <= bbox[1] && j >= bbox[2] && j <= bbox[3];
}

// ── candidate selection & resolution (SPEC §11.7) ───────────────────────────────────

/**
 * Which published slices could own cell `(i, j)`? Bbox first as a cheap prefilter, then
 * the coverage bitmap, in slice-name order (§11.7 step 2). Shard families need no special
 * case here BECAUSE of this shape: `florida-a` and `florida-b` are ordinary index entries
 * with their own bbox and cover, and every claimant is a candidate — the loop in
 * `resolveTile` consults each one until a directory answers.
 *
 * The bitmap is the authority and the bbox only a shortcut: Vermont's bounding rectangle
 * contains a large piece of New York (§11.5), and a bbox-only test would fetch Vermont's
 * directory for every unbaked New York cell. A cell CANNOT be in a directory whose block
 * the cover does not claim — the bitmap is built from the cells the slice actually wrote
 * (plus row-fill, which only ADDS claims) — so skipping unclaimed entries never skips a
 * tile. An entry with no cover at all (never published by this packer, but cheap to
 * tolerate) falls back to bbox-only and is searched.
 */
export function candidateSlices(index, i, j) {
  if (!index || !Array.isArray(index.slices)) return [];
  return index.slices
    .filter((s) => bboxHas(s.bbox, i, j))
    .filter((s) => !s.cover || coverHas(s.cover, i, j, s.coverBlock ?? COVER_BLOCK))
    .sort((a, b) => (a.slice < b.slice ? -1 : a.slice > b.slice ? 1 : 0));
}

/**
 * Resolve one cell against one version's index. `loadDirectory(entry)` is injected and
 * must return the DECODED directory for that entry's archive (the caller owns fetching,
 * gunzip and caching — keyed by `entry.sha256`, so a republish invalidates with no clock
 * involved).
 *
 * Returns exactly one of:
 *   { kind: 'tile', entry, offset, length }   — absolute byte range inside entry.path
 *   { kind: 'hole', tried: [names] }          — some slice claims the block, none lists
 *                                               the cell; the bake looked and wrote
 *                                               nothing. Permanent. 404.
 *   { kind: 'unbaked' }                       — no slice claims it at all. Transient. 404.
 */
export async function resolveTile(index, i, j, loadDirectory) {
  const candidates = candidateSlices(index, i, j);
  if (candidates.length === 0) return { kind: 'unbaked' };
  const id = tileId(i, j);
  for (const entry of candidates) {
    const dir = await loadDirectory(entry);
    const k = findTile(dir, id);
    if (k >= 0) {
      return {
        kind: 'tile',
        entry,
        // `tileData[0]` is where the bodies start; directory offsets are relative to it.
        offset: entry.tileData[0] + dir.offsets[k],
        length: dir.lengths[k],
      };
    }
  }
  return { kind: 'hole', tried: candidates.map((c) => c.slice) };
}

// ── gunzip, runtime-agnostic ────────────────────────────────────────────────────────

/** Inflate gzip bytes via `DecompressionStream` — present in both the Workers runtime
 *  and Node ≥ 18, so the Worker and the test run the SAME decompression path. */
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
