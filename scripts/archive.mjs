// The walkable tile archive (`.wta`) — one file per slice per version, replacing one
// object per cell. SPEC.md §11 is the normative description; this file is the reference
// implementation of it and is shared by `pack-archives.mjs` (writer) and
// `verify-coverage.mjs` (reader). Ausculta's `apps/mobile/src/tiles/archive.ts` is the
// second implementation, and it decodes only — the two agree because §11 is the contract,
// not because either one imports the other.
//
// ════════════════════════════════════════════════════════════════════════════════════
// WHY NOT PMTiles v3, byte for byte
// ════════════════════════════════════════════════════════════════════════════════════
//
// PMTiles is what motivated this (docs/PMTILES-SCOPING.md in ausculta has the costing) and
// the packaging idea is taken wholesale: one archive, a directory, HTTP range requests,
// static hosting, no backend. What is NOT taken is the byte format, and the reason is
// specific rather than aesthetic.
//
// A PMTiles v3 directory is keyed by a `tileId` that every reader in that ecosystem derives
// from (z, x, y) by Hilbert order. This grid is not z/x/y: cells are `<latIdx>/<lngIdx>` on
// a fixed 0.01° lat/lng grid, and a tile id has to be *invented* — `(i + 9000) × 36001 +
// (j + 18000)`. Writing those ids into a spec-conformant v3 file produces something every
// PMTiles tool will happily OPEN, report as valid, and then read the WRONG TILE from. That
// is strictly worse than being unreadable. It is the same failure this project already
// paid for once — a module that resolved, type-checked and bundled while returning
// placeholder values — and the lesson recorded from it is *assert on a value, never on a
// shape*. A format that fails loudly is worth more than one that fails plausibly.
//
// Two lesser reasons, both real: v3's header has no tile type for "gzipped JSON" and
// mandates min/max zoom fields this grid has no honest value for; and v3 caps the root
// directory at 16 KiB, which forces leaf directories and a second round trip for archives
// this size — machinery bought to solve a problem the numbers below say we do not have.
//
// WHAT IS TAKEN FROM v3, deliberately and verbatim in spirit: the DIRECTORY ENCODING.
// Columnar, delta-varint ids, and implicit offsets for an archive whose tiles are written
// contiguously in id order. That is where the size lives, and copying a solved problem is
// free. MEASURED on the two trial bakes (2026-07-31), directory GZIPPED as stored:
//
//     slice                  ver   tiles    tile bytes   directory  B/entry  overhead
//     district-of-columbia   v5      188    15,231,413         608     3.23    0.006%
//     vermont                v5   28,445   146,156,824      56,245     1.98    0.039%
//     vermont                v5c  18,486     3,179,256      23,676     1.28    0.754%
//
// Two bytes an entry, so a 100k-tile state carries a ~200 KB directory: one range request,
// once, cached on the device for as long as the archive it describes exists. The prototype
// that argued for this format used a naive fixed-width directory and measured 3,760 B for
// district-of-columbia's 188 tiles; the columnar form is 608.
//
// The magic is `WTA1`, which no PMTiles reader accepts. That is the point.
//
// ════════════════════════════════════════════════════════════════════════════════════
// LAYOUT
// ════════════════════════════════════════════════════════════════════════════════════
//
//   0                    header, 128 bytes, fixed (below)
//   128                  metadata: gzip(JSON), self-description for a file on disk
//   metaOffset+metaLen   directory: gzip(columnar varints)
//   tileDataOffset       tile bodies, concatenated, ascending tile id, NO padding.
//                        Each body is the EXACT `.json.gz` byte string the object layout
//                        published — same gzip, same bytes, verified on write.
//
// The header is fixed-size and first so a reader with no index can bootstrap from a single
// `Range: bytes=0-127`. In practice the client never does: `index.json` carries the
// directory's byte range, so the directory is one request and the header is for tooling
// and for a file sitting on a disk.
//
// DETERMINISM IS A REQUIREMENT, not a nicety. Nothing in the archive carries a timestamp —
// `bakedAt` lives in the index sidecar, not in the file — and Node's gzip writes MTIME 0.
// So the same tiles pack to the same bytes, `sha256(file)` is a content identity, and
// "did this slice change" is one comparison instead of a quarter of a million.
import { gzipSync, gunzipSync } from 'node:zlib';

export const MAGIC = 'WTA1';
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 128;

/** Cells per degree. `TILE_DEG` is 0.01, so 100. Written into the header rather than
 *  assumed, because a reader that guesses the grid produces coordinates that are wrong
 *  rather than absent. */
export const GRID_DENOM = 100;

/** Coverage-bitmap block edge, in CELLS. 10 cells = 0.1° ≈ 11 km.
 *
 *  This is what makes "empty" and "not baked yet" different answers rather than the same
 *  404 (CLAUDE.md records the trap: a 404 caches for 5 minutes because it cannot tell
 *  them apart). A slice's bbox alone cannot do it — Vermont's bounding rectangle contains
 *  a large piece of New York, so "inside the bbox and not in the directory" would call
 *  unbaked New York a permanent hole. A bitmap of the blocks the slice actually WROTE
 *  tiles into follows the state's shape, and it costs nothing: Vermont is 24 × 21 blocks,
 *  63 bytes, 84 characters of base64. */
export const COVER_BLOCK = 10;

/** The tile id. Injective over the whole grid and small enough to stay an exact integer
 *  (max ≈ 6.5e8, inside uint32), which matters because the client decodes the directory
 *  into typed arrays rather than a 100k-entry Map. */
export function tileId(i, j) {
  return (i + 9000) * 36001 + (j + 18000);
}

export function cellOfTileId(id) {
  const j = (id % 36001) - 18000;
  const i = (id - (j + 18000)) / 36001 - 9000;
  return [i, j];
}

// ── varints (LEB128, unsigned) ──────────────────────────────────────────────────────

function pushVarint(out, n) {
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function readVarint(buf, state) {
  let result = 0;
  let shift = 1;
  for (;;) {
    const b = buf[state.p++];
    if (b === undefined) throw new Error('archive: varint ran off the end of the directory');
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) return result;
    shift *= 128;
  }
}

// ── directory ───────────────────────────────────────────────────────────────────────

/**
 * Encode a directory. `entries` must be sorted by id ascending, with no duplicates, and
 * the tile bodies must be concatenated in exactly this order — the offsets are IMPLICIT
 * (a prefix sum of the lengths) and there is no way to express a gap.
 *
 * Dropping v3's explicit offset column costs the ability to dedupe identical tiles and to
 * carry leaf directories. Neither is worth a third of the directory here: tile bodies are
 * per-cell geometry and are essentially never equal, and the numbers in the header say a
 * flat directory stays under 111 KB for a 28,445-tile slice.
 */
export function encodeDirectory(entries) {
  const out = [];
  pushVarint(out, entries.length);
  let prev = 0;
  for (const e of entries) {
    const delta = e.id - prev;
    if (delta <= 0) throw new Error(`archive: directory not strictly ascending at id ${e.id}`);
    pushVarint(out, delta);
    prev = e.id;
  }
  for (const e of entries) pushVarint(out, e.length);
  return Buffer.from(out);
}

/** Decode a directory body into `{ids, lengths, offsets}` plain arrays. The client uses
 *  typed arrays for the same job; this one is for tooling and stays readable. */
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

/** Binary search for a tile id. Returns the entry index, or -1 for a HOLE — which is an
 *  ANSWER ("this cell was baked and holds nothing"), not a failure. */
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

// ── coverage bitmap ─────────────────────────────────────────────────────────────────

export function coverBlockOf(i, j) {
  return [Math.floor(i / COVER_BLOCK), Math.floor(j / COVER_BLOCK)];
}

/**
 * How wide an interior gap the coverage fill will close, in BLOCKS. 8 blocks ≈ 88 km.
 *
 * A block with no tile in it is usually water or emptiness the bake DID look at, and
 * leaving it unclaimed makes the client call it "not baked" and retry it every five
 * minutes forever — the exact behaviour the archives exist to end. So a gap between two
 * claimed blocks ON THE SAME ROW is filled: the slice demonstrably owns ground on both
 * sides of it at that latitude.
 *
 * Bounded, because the argument stops being true for a wide one. Cape Cod Bay is ~40 km
 * and gets filled; Lake Michigan is ~150 km and does not, so a slice with two lobes cannot
 * quietly claim whatever sits between them. Over the limit the answer reverts to "not
 * baked", which is the conservative direction: a client that retries too often is a bill,
 * a client that caches a wrong "empty" for thirty days is a region with no ground in it.
 */
export const COVER_FILL_MAX = 8;

/** Build the block bitmap from the cells the slice actually wrote, plus the bounded
 *  row-wise interior fill above. Row-major over `[bi0..bi1] × [bj0..bj1]`, LSB-first
 *  within each byte. */
export function encodeCover(cells) {
  let bi0 = Infinity;
  let bi1 = -Infinity;
  let bj0 = Infinity;
  let bj1 = -Infinity;
  const blocks = new Set();
  for (const [i, j] of cells) {
    const [bi, bj] = coverBlockOf(i, j);
    blocks.add(`${bi}:${bj}`);
    if (bi < bi0) bi0 = bi;
    if (bi > bi1) bi1 = bi;
    if (bj < bj0) bj0 = bj;
    if (bj > bj1) bj1 = bj;
  }
  if (blocks.size === 0) return { origin: [0, 0], dims: [0, 0], bits: '' };
  const rows = bi1 - bi0 + 1;
  const cols = bj1 - bj0 + 1;
  const grid = new Uint8Array(rows * cols);
  for (const key of blocks) {
    const [bi, bj] = key.split(':').map(Number);
    grid[(bi - bi0) * cols + (bj - bj0)] = 1;
  }
  // Bounded row-wise interior fill — see COVER_FILL_MAX.
  for (let r = 0; r < rows; r++) {
    let last = -1;
    for (let c = 0; c < cols; c++) {
      if (!grid[r * cols + c]) continue;
      if (last >= 0 && c - last - 1 > 0 && c - last - 1 <= COVER_FILL_MAX) {
        for (let k = last + 1; k < c; k++) grid[r * cols + k] = 1;
      }
      last = c;
    }
  }
  const bytes = Buffer.alloc(Math.ceil((rows * cols) / 8));
  for (let bit = 0; bit < rows * cols; bit++) {
    if (grid[bit]) bytes[bit >> 3] |= 1 << (bit & 7);
  }
  return { origin: [bi0, bj0], dims: [rows, cols], bits: bytes.toString('base64') };
}

/** Does this slice claim the block containing cell `(i, j)`? `block` comes from the index
 *  entry's `coverBlock` rather than from the constant, so a bitmap baked at one block size
 *  is still read at that size after the constant moves. */
export function coverHas(cover, i, j, block = COVER_BLOCK) {
  const [rows, cols] = cover.dims;
  if (rows === 0 || cols === 0) return false;
  const bi = Math.floor(i / block);
  const bj = Math.floor(j / block);
  const r = bi - cover.origin[0];
  const c = bj - cover.origin[1];
  if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
  const bytes = Buffer.from(cover.bits, 'base64');
  const bit = r * cols + c;
  return ((bytes[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
}

// ── header ──────────────────────────────────────────────────────────────────────────

function encodeHeader(h) {
  const b = Buffer.alloc(HEADER_BYTES);
  b.write(MAGIC, 0, 'ascii');
  b.writeUInt8(FORMAT_VERSION, 4);
  b.writeUInt8(1, 5); // dirCompression: gzip
  b.writeUInt8(1, 6); // tileCompression: gzip — the bodies ARE the published .json.gz
  b.writeUInt8(0, 7); // reserved
  b.writeUInt32LE(GRID_DENOM, 8);
  b.writeUInt32LE(h.tileCount, 12);
  b.writeInt32LE(h.minI, 16);
  b.writeInt32LE(h.maxI, 20);
  b.writeInt32LE(h.minJ, 24);
  b.writeInt32LE(h.maxJ, 28);
  b.writeBigUInt64LE(BigInt(h.metaOffset), 32);
  b.writeBigUInt64LE(BigInt(h.metaLength), 40);
  b.writeBigUInt64LE(BigInt(h.dirOffset), 48);
  b.writeBigUInt64LE(BigInt(h.dirLength), 56);
  b.writeBigUInt64LE(BigInt(h.tileDataOffset), 64);
  b.writeBigUInt64LE(BigInt(h.tileDataLength), 72);
  return b;
}

export function decodeHeader(buf) {
  if (buf.length < HEADER_BYTES) throw new Error('archive: short header');
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error(`archive: bad magic ${JSON.stringify(magic)} (want ${MAGIC})`);
  const formatVersion = buf.readUInt8(4);
  if (formatVersion !== FORMAT_VERSION) throw new Error(`archive: format version ${formatVersion}`);
  return {
    formatVersion,
    dirCompression: buf.readUInt8(5),
    tileCompression: buf.readUInt8(6),
    gridDenom: buf.readUInt32LE(8),
    tileCount: buf.readUInt32LE(12),
    minI: buf.readInt32LE(16),
    maxI: buf.readInt32LE(20),
    minJ: buf.readInt32LE(24),
    maxJ: buf.readInt32LE(28),
    metaOffset: Number(buf.readBigUInt64LE(32)),
    metaLength: Number(buf.readBigUInt64LE(40)),
    dirOffset: Number(buf.readBigUInt64LE(48)),
    dirLength: Number(buf.readBigUInt64LE(56)),
    tileDataOffset: Number(buf.readBigUInt64LE(64)),
    tileDataLength: Number(buf.readBigUInt64LE(72)),
  };
}

// ── build ───────────────────────────────────────────────────────────────────────────

/**
 * Pack tiles into one archive buffer.
 *
 * `tiles` is `[{i, j, body}]` where `body` is the exact `.json.gz` Buffer the object
 * layout would have published. Nothing is recompressed, re-serialised or normalised —
 * this function only concatenates and indexes, which is what makes "the tile bytes are
 * unchanged" a property of the code rather than a claim in a commit message.
 *
 * Returns `{buffer, meta}` where `meta` is the index-sidecar entry minus the fields only
 * the publisher knows (`bakedAt`, `path`).
 */
export function buildArchive({ slice, version, tiles }) {
  const sorted = [...tiles].sort((a, b) => tileId(a.i, a.j) - tileId(b.i, b.j));
  const entries = [];
  let minI = Infinity;
  let maxI = -Infinity;
  let minJ = Infinity;
  let maxJ = -Infinity;
  let tileDataLength = 0;
  for (const t of sorted) {
    entries.push({ id: tileId(t.i, t.j), length: t.body.length });
    tileDataLength += t.body.length;
    if (t.i < minI) minI = t.i;
    if (t.i > maxI) maxI = t.i;
    if (t.j < minJ) minJ = t.j;
    if (t.j > maxJ) maxJ = t.j;
  }
  if (sorted.length === 0) {
    minI = maxI = minJ = maxJ = 0;
  }

  const dirRaw = encodeDirectory(entries);
  const dirGz = gzipSync(dirRaw, { level: 9 });

  // Deterministic by construction: no timestamp, no host, no build id. `bakedAt` belongs
  // to the index sidecar, where changing it does not change the archive's digest.
  const metaRaw = Buffer.from(
    JSON.stringify({
      format: MAGIC,
      formatVersion: FORMAT_VERSION,
      slice,
      version,
      gridDenom: GRID_DENOM,
      tileCount: entries.length,
      bbox: [minI, maxI, minJ, maxJ],
      contentType: 'application/json',
      contentEncoding: 'gzip',
    }),
  );
  const metaGz = gzipSync(metaRaw, { level: 9 });

  const metaOffset = HEADER_BYTES;
  const dirOffset = metaOffset + metaGz.length;
  const tileDataOffset = dirOffset + dirGz.length;

  const header = encodeHeader({
    tileCount: entries.length,
    minI,
    maxI,
    minJ,
    maxJ,
    metaOffset,
    metaLength: metaGz.length,
    dirOffset,
    dirLength: dirGz.length,
    tileDataOffset,
    tileDataLength,
  });

  const buffer = Buffer.concat([
    header,
    metaGz,
    dirGz,
    ...sorted.map((t) => t.body),
  ]);

  return {
    buffer,
    entries,
    meta: {
      slice,
      version,
      bytes: buffer.length,
      tileCount: entries.length,
      tileBytes: tileDataLength,
      grid: GRID_DENOM,
      bbox: [minI, maxI, minJ, maxJ],
      dir: [dirOffset, dirGz.length],
      dirBytesRaw: dirRaw.length,
      tileData: [tileDataOffset, tileDataLength],
      coverBlock: COVER_BLOCK,
      cover: encodeCover(sorted.map((t) => [t.i, t.j])),
    },
  };
}

// ── read ────────────────────────────────────────────────────────────────────────────

/** Open an in-memory archive: header + metadata + decoded directory. */
export function openArchive(buffer) {
  const header = decodeHeader(buffer);
  const meta = JSON.parse(
    gunzipSync(buffer.subarray(header.metaOffset, header.metaOffset + header.metaLength)).toString('utf8'),
  );
  const dir = decodeDirectory(
    gunzipSync(buffer.subarray(header.dirOffset, header.dirOffset + header.dirLength)),
  );
  return { header, meta, dir };
}

/** The absolute byte range of cell `(i, j)`, or `null` for a HOLE. */
export function tileRange(header, dir, i, j) {
  const k = findTile(dir, tileId(i, j));
  if (k < 0) return null;
  return { offset: header.tileDataOffset + dir.offsets[k], length: dir.lengths[k] };
}
