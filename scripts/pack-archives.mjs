#!/usr/bin/env node
// Pack an existing bake output into `.wta` archives — one file per slice per version,
// instead of one object per cell. SPEC.md §11 is the format; `scripts/archive.mjs` is the
// encoder.
//
// ════════════════════════════════════════════════════════════════════════════════════
// IT RUNS FROM AN OUT_DIR AND NEVER FROM A BAKE
// ════════════════════════════════════════════════════════════════════════════════════
//
// A full bake is 6–10 hours of download, osmium, tiling and DEM sampling. The packaging is
// minutes. Those must not be coupled, which is exactly why `R2_UPLOAD_ONLY=1` exists and
// why `bake-all.sh` stopped deleting OUT_DIR. This script takes the same input that flag
// takes — a directory with `v4/`, `v5/`, `v5c/` trees — and produces archives from it, so
// changing your mind about packaging costs a command rather than another overnight run.
//
// ════════════════════════════════════════════════════════════════════════════════════
// THE BYTES ARE NOT TOUCHED, AND THAT IS CHECKED RATHER THAN CLAIMED
// ════════════════════════════════════════════════════════════════════════════════════
//
// This is a packaging change. A tile body in the archive is the EXACT `.json.gz` byte
// string the object layout published — nothing is recompressed or re-serialised. After
// writing, the archive is REOPENED, its directory decoded from the file, and every tile
// pulled back by its offset and compared byte-for-byte with the source file. An archive
// that fails that comparison is deleted rather than published.
//
// Verifying all of them is the default because the alternative reads as a check and is
// not one: `--fast` samples 512 tiles, which is the right trade for a 200k-tile slice
// during development and the wrong one for a publish.
//
// Usage:
//   node scripts/pack-archives.mjs --out <OUT_DIR> --slice <name> [--dest <dir>]
//                                  [--versions v4,v5,v5c] [--fast] [--json]
//
// Writes, per version:
//   <dest>/<ver>/<slice>-<sha12>.wta  the archive, named by its own digest (see
//                                     CONTENT-ADDRESSED, below, for why)
//   <dest>/<ver>/<slice>.idx.json     the index sidecar — bbox, coverage bitmap, directory
//                                     byte range, sha256, and the archive's path. This is
//                                     what the publisher uploads beside the archive and
//                                     what `index.json` is rebuilt from.
//   <dest>/<ver>/index.json           rebuilt from every sidecar present locally, so a
//                                     trial bake is servable and probeable with no bucket.
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  COVER_BLOCK,
  decodeDirectory,
  decodeHeader,
  encodeCover,
  encodeDirectory,
  FORMAT_VERSION,
  GRID_DENOM,
  HEADER_BYTES,
  MAGIC,
  tileId,
  tileRange,
} from './archive.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 && args[k + 1] && !args[k + 1].startsWith('--') ? args[k + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const OUT = flag('out');
const SLICE = flag('slice');
const DEST = flag('dest', OUT ? join(OUT, 'archive') : null);
const VERSIONS = (flag('versions', 'v4,v5,v5c') ?? '').split(',').filter(Boolean);
const FAST = has('fast');
const AS_JSON = has('json');

if (!OUT || !SLICE) {
  console.error('usage: pack-archives.mjs --out <OUT_DIR> --slice <name> [--dest <dir>] [--versions v4,v5,v5c] [--fast]');
  process.exit(2);
}

/** Every `<ver>/<i>/<j>.json.gz` under `OUT`, as `{i, j, path, size}`, sorted by tile id.
 *  Sizes come from `stat`, not from reading: a 1 GB slice does not need to be in memory to
 *  be indexed, and the write pass streams. */
function listTiles(verDir) {
  const out = [];
  for (const iName of readdirSync(verDir)) {
    const iPath = join(verDir, iName);
    if (!statSync(iPath).isDirectory()) continue;
    const i = Number(iName);
    if (!Number.isInteger(i)) continue;
    for (const f of readdirSync(iPath)) {
      if (!f.endsWith('.json.gz')) continue;
      const j = Number(f.slice(0, -'.json.gz'.length));
      if (!Number.isInteger(j)) continue;
      const p = join(iPath, f);
      out.push({ i, j, path: p, size: statSync(p).size });
    }
  }
  out.sort((a, b) => tileId(a.i, a.j) - tileId(b.i, b.j));
  return out;
}

/** Stream `paths` into `stream` in order, hashing as we go. Streaming rather than
 *  `Buffer.concat` because a big slice's v5 tree is on the order of a gigabyte and the
 *  concat form needs it twice over. */
async function appendTiles(stream, tiles, hash) {
  for (const t of tiles) {
    await new Promise((resolve, reject) => {
      const rs = createReadStream(t.path);
      rs.on('data', (chunk) => {
        hash.update(chunk);
        if (!stream.write(chunk)) {
          rs.pause();
          stream.once('drain', () => rs.resume());
        }
      });
      rs.on('end', resolve);
      rs.on('error', reject);
    });
  }
}

function writeAll(stream, buf, hash) {
  hash.update(buf);
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/** Read `len` bytes at `off` from an open fd. The verification path deliberately goes
 *  through the FILE rather than through the buffer that was just written — the claim being
 *  checked is about what landed on disk. */
function readAt(fd, off, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, off + got);
    if (n === 0) break;
    got += n;
  }
  if (got !== len) throw new Error(`archive: short read at ${off} (${got}/${len})`);
  return b;
}

// ════════════════════════════════════════════════════════════════════════════════════
// SHARDING, AND THE 512 MB CEILING THAT FORCED IT
// ════════════════════════════════════════════════════════════════════════════════════
//
// Cloudflare will not cache an object over 512 MB (Free/Pro/Business). Measured against the
// live bucket on 2026-08-10: massachusetts 442.5 MB HIT, kansas 482.6 MB HIT, utah 724.9 MB
// BYPASS, arizona 885.0 MB BYPASS, florida 1162.6 MB BYPASS. Three of five live slices were
// therefore serving EVERY tile from R2 origin, which is the one thing the archive format was
// built to stop paying for. No cache rule fixes it — the objects already publish
// `immutable, max-age=31536000` — and nothing was misconfigured. They were simply too big.
//
// The measurement PMTILES-SCOPING asked for was taken, honestly, on district-of-columbia
// (15 MB) and vermont (146 MB). Both sit under the ceiling. Baking whole states walked past
// it without anyone looking at a response header.
//
// WHY THIS NEEDS NO CLIENT CHANGE, which is the part worth checking before believing it.
// `candidateSlices` in apps/mobile/src/tiles/archive.ts is
// `index.slices.filter((s) => coverHas(s, i, j))` — a filter over ENTRIES by coverage
// bitmap, with no uniqueness assumption on the slice name — and the resolver already loops
// candidates, because a 0.1 degree block straddling a slice boundary has always produced
// two. A shard is just another entry with a disjoint cover. `entry.slice` is used for
// exactly two things in the client: the directory cache key and a sort order. So shards get
// DISTINCT names (`florida-a`, `florida-b`); same-named shards would collide on that cache
// key and thrash, each evicting the last, which the sha guard makes correct but ruinous.
//
// SPLIT ON COVERAGE-BLOCK ROWS, never mid-block. A block is COVER_BLOCK cells of latitude;
// splitting inside one would make two shards claim it, costing a wasted directory fetch on
// every lookup in that band. Rows keep each shard's cover a clean disjoint set. A single row
// larger than the target is packed whole and warned about rather than split — the alternative
// is a shard whose coverage interleaves another's, and correctness beats the last few MB.
const MAX_ARCHIVE_BYTES = Number(flag('max-bytes', String(450 * 1024 * 1024)));

/** `a`, `b`, … `z`, `aa`, `ab`, … — a stable suffix per shard index. */
function shardSuffix(k) {
  const a = 'a'.charCodeAt(0);
  return k < 26
    ? String.fromCharCode(a + k)
    : String.fromCharCode(a + Math.floor(k / 26) - 1) + String.fromCharCode(a + (k % 26));
}

/** Partition tiles (already in tile-id order, so latitude-major) into groups no larger than
 *  MAX_ARCHIVE_BYTES, cutting only on coverage-block row boundaries. */
function shardTiles(tiles) {
  const total = tiles.reduce((a, t) => a + t.size, 0);
  if (MAX_ARCHIVE_BYTES <= 0 || total <= MAX_ARCHIVE_BYTES) return [tiles];

  const rows = [];
  let row = null;
  for (const t of tiles) {
    const br = Math.floor(t.i / COVER_BLOCK);
    if (row === null || row.br !== br) {
      row = { br, tiles: [], size: 0 };
      rows.push(row);
    }
    row.tiles.push(t);
    row.size += t.size;
  }

  const groups = [];
  let g = null;
  for (const r of rows) {
    // The `g.tiles.length > 0` guard is load-bearing: without it a single row bigger than the
    // target would open a fresh group and immediately overflow it, forever.
    if (g === null || (g.tiles.length > 0 && g.size + r.size > MAX_ARCHIVE_BYTES)) {
      g = { tiles: [], size: 0 };
      groups.push(g);
    }
    if (r.size > MAX_ARCHIVE_BYTES) {
      console.warn(
        `[pack] WARNING: coverage-block row ${r.br} is ${r.size} B on its own, over the ` +
          `${MAX_ARCHIVE_BYTES} B target. Packed whole — this shard will not edge-cache.`,
      );
    }
    g.tiles.push(...r.tiles);
    g.size += r.size;
  }
  return groups.map((x) => x.tiles);
}

async function packVersion(version) {
  const verDir = join(OUT, version);
  if (!existsSync(verDir)) return null;
  const all = listTiles(verDir);
  if (all.length === 0) return null;

  const groups = shardTiles(all);
  const destDir = join(DEST, version);
  mkdirSync(destDir, { recursive: true });

  const out = [];
  for (let k = 0; k < groups.length; k++) {
    const sliceName = groups.length === 1 ? SLICE : `${SLICE}-${shardSuffix(k)}`;
    out.push(await packShard(version, groups[k], sliceName));
  }

  // ── RETIRE THE PREVIOUS GENERATION, family-wide, and only once every shard succeeded ──
  //
  // The family is `<slice>` plus `<slice>-<suffix>`, so re-sharding a slice that was packed
  // whole must drop the whole archive AND its sidecar. Leaving the stale sidecar would be the
  // real bug: `rebuildIndex` globs every `.idx.json`, so the index would advertise the old
  // one-piece archive AND the new shards, double-covering every cell and pointing at a path
  // the publisher no longer uploads.
  //
  // AFTER, not before: a failure mid-pack leaves the previous generation intact.
  const keepIdx = new Set(out.map((r) => `${r.sliceName}.idx.json`));
  const keepWta = new Set(out.map((r) => r.archiveName));
  const family = new RegExp(`^${SLICE}(-[a-z]{1,2})?(-[0-9a-f]{12})?\\.(wta|idx\\.json)$`);
  for (const f of readdirSync(destDir)) {
    if (!family.test(f)) continue;
    if (keepIdx.has(f) || keepWta.has(f)) continue;
    rmSync(join(destDir, f), { force: true });
  }

  return out;
}

async function packShard(version, tiles, sliceName) {
  const entries = tiles.map((t) => ({ id: tileId(t.i, t.j), length: t.size }));
  for (let k = 1; k < entries.length; k++) {
    if (entries[k].id === entries[k - 1].id) {
      throw new Error(`${version}: duplicate cell for tile id ${entries[k].id}`);
    }
  }

  const dirRaw = encodeDirectory(entries);
  const { gzipSync } = await import('node:zlib');
  const dirGz = gzipSync(dirRaw, { level: 9 });

  const bbox = tiles.reduce(
    (acc, t) => [Math.min(acc[0], t.i), Math.max(acc[1], t.i), Math.min(acc[2], t.j), Math.max(acc[3], t.j)],
    [Infinity, -Infinity, Infinity, -Infinity],
  );
  const tileDataLength = entries.reduce((a, e) => a + e.length, 0);

  const metaGz = gzipSync(
    Buffer.from(
      JSON.stringify({
        format: MAGIC,
        formatVersion: FORMAT_VERSION,
        slice: sliceName,
        version,
        gridDenom: GRID_DENOM,
        tileCount: entries.length,
        bbox,
        contentType: 'application/json',
        contentEncoding: 'gzip',
      }),
    ),
    { level: 9 },
  );

  const metaOffset = HEADER_BYTES;
  const dirOffset = metaOffset + metaGz.length;
  const tileDataOffset = dirOffset + dirGz.length;

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt8(1, 5);
  header.writeUInt8(1, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32LE(GRID_DENOM, 8);
  header.writeUInt32LE(entries.length, 12);
  header.writeInt32LE(bbox[0], 16);
  header.writeInt32LE(bbox[1], 20);
  header.writeInt32LE(bbox[2], 24);
  header.writeInt32LE(bbox[3], 28);
  header.writeBigUInt64LE(BigInt(metaOffset), 32);
  header.writeBigUInt64LE(BigInt(metaGz.length), 40);
  header.writeBigUInt64LE(BigInt(dirOffset), 48);
  header.writeBigUInt64LE(BigInt(dirGz.length), 56);
  header.writeBigUInt64LE(BigInt(tileDataOffset), 64);
  header.writeBigUInt64LE(BigInt(tileDataLength), 72);

  const destDir = join(DEST, version);
  mkdirSync(destDir, { recursive: true });
  // Written under a temporary name and RENAMED to its digest once it is hashed and
  // verified — see the CONTENT-ADDRESSED note below.
  const archivePath = join(destDir, `${sliceName}.wta.tmp`);

  const hash = createHash('sha256');
  const stream = createWriteStream(archivePath);
  await writeAll(stream, header, hash);
  await writeAll(stream, metaGz, hash);
  await writeAll(stream, dirGz, hash);
  await appendTiles(stream, tiles, hash);
  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });

  const sha256 = hash.digest('hex');
  const bytes = statSync(archivePath).size;
  const expectBytes = tileDataOffset + tileDataLength;
  if (bytes !== expectBytes) {
    rmSync(archivePath);
    throw new Error(`${version}: archive is ${bytes} B, header says ${expectBytes} B`);
  }

  // ── VERIFY, from the file, through the directory the file itself carries ───────────
  const fd = openSync(archivePath, 'r');
  let checked = 0;
  let holeCell = null;
  // Deterministic sample under --fast: an even stride from the first tile. Not random — a
  // check you cannot re-run on the same tiles is a check you cannot debug.
  const stride = FAST && tiles.length > 512 ? Math.floor(tiles.length / 512) : 1;
  try {
    const h = decodeHeader(readAt(fd, 0, HEADER_BYTES));
    if (h.tileCount !== entries.length) throw new Error(`${version}: header tileCount ${h.tileCount}`);
    const dir = decodeDirectory(gunzipSync(readAt(fd, h.dirOffset, h.dirLength)));
    if (dir.ids.length !== entries.length) throw new Error(`${version}: directory holds ${dir.ids.length} entries`);

    for (let k = 0; k < tiles.length; k += stride) {
      const t = tiles[k];
      const range = tileRange(h, dir, t.i, t.j);
      if (!range) throw new Error(`${version}: ${t.i}/${t.j} is a HOLE in an archive that packed it`);
      const got = readAt(fd, range.offset, range.length);
      const want = readFileSync(t.path);
      if (!got.equals(want)) {
        throw new Error(`${version}: ${t.i}/${t.j} came back ${got.length} B, differs from the ${want.length} B object`);
      }
      checked++;
    }
    // A HOLE must read as a hole: pick a cell inside the bbox that was never written, so
    // "absent" is proved by value rather than assumed from the count. `null` here would
    // be the bug that makes an empty cell indistinguishable from an unbaked region.
    const present = new Set(entries.map((e) => e.id));
    for (let i = bbox[0]; i <= bbox[1] && !holeCell; i++) {
      for (let j = bbox[2]; j <= bbox[3]; j++) {
        if (present.has(tileId(i, j))) continue;
        if (tileRange(h, dir, i, j) !== null) throw new Error(`${version}: ${i}/${j} resolved but was never packed`);
        holeCell = [i, j];
        break;
      }
    }
  } catch (err) {
    closeSync(fd);
    rmSync(archivePath, { force: true });
    throw err;
  }
  closeSync(fd);

  // ── CONTENT-ADDRESSED, and it is the cache-control decision rather than a flourish ──
  //
  // An archive at a fixed key is a MUTABLE object at a stable URL, which forces a short
  // `cache-control` on a gigabyte file (so a republish is seen) and therefore re-validation
  // on a file that never changes in place. Naming it by its digest inverts that: the
  // archive is immutable and cacheable for a year, and `index.json` — one kilobyte — is the
  // only thing with a short TTL. A republish is then a new object plus a new index, which
  // is atomic by construction: no client ever sees a directory that disagrees with its
  // tiles, because the two can no longer come from different generations of the same key.
  //
  // The publisher keeps the PREVIOUS generation alive rather than deleting it, because a
  // client holding an index up to an hour old is still asking for it.
  const name = `${sliceName}-${sha256.slice(0, 12)}.wta`;
  const finalPath = join(destDir, name);
  // Retiring older generations moved to `packVersion`: with sharding it is a decision about
  // the whole FAMILY (`florida`, `florida-a`, `florida-b`), and a shard cannot see its
  // siblings. Doing it here would have each shard delete the others as it finished.
  renameSync(archivePath, finalPath);

  const cover = encodeCover(tiles.map((t) => [t.i, t.j]));
  const sidecar = {
    slice: sliceName,
    version,
    path: `${version}/archive/${name}`,
    bytes,
    sha256,
    tileCount: entries.length,
    tileBytes: tileDataLength,
    grid: GRID_DENOM,
    bbox,
    dir: [dirOffset, dirGz.length],
    dirBytesRaw: dirRaw.length,
    tileData: [tileDataOffset, tileDataLength],
    coverBlock: COVER_BLOCK,
    cover,
  };
  writeFileSync(join(destDir, `${sliceName}.idx.json`), JSON.stringify(sidecar));

  return {
    version,
    sliceName,
    archiveName: name,
    archivePath: finalPath,
    tiles: entries.length,
    objectBytes: tileDataLength,
    archiveBytes: bytes,
    dirBytes: dirGz.length,
    dirBytesRaw: dirRaw.length,
    overheadBytes: bytes - tileDataLength,
    verified: checked,
    verifiedAll: stride1(tiles.length, checked),
    holeCell,
    sha256,
    coverBytes: Buffer.from(cover.bits, 'base64').length,
  };
}

function stride1(total, checked) {
  return checked === total;
}

/** Rebuild the LOCAL `index.json` from every sidecar in the destination. The published one
 *  is rebuilt the same way from the bucket (see bake-slice.sh) — sidecars are the source of
 *  truth and `index.json` is derived, so two slices publishing at once cannot corrupt it.
 *  The worst a lost race can do is omit a slice until the next rebuild, which is a gap the
 *  client reads as "not baked" — the honest answer, and a self-healing one. A
 *  read-modify-write on a shared JSON blob would instead DELETE a slice, permanently. */
function rebuildIndex(version) {
  const destDir = join(DEST, version);
  if (!existsSync(destDir)) return;
  const slices = readdirSync(destDir)
    .filter((f) => f.endsWith('.idx.json'))
    .map((f) => JSON.parse(readFileSync(join(destDir, f), 'utf8')))
    .sort((a, b) => (a.slice < b.slice ? -1 : a.slice > b.slice ? 1 : 0));
  writeFileSync(join(destDir, 'index.json'), JSON.stringify({ v: 1, version, slices }));
}

const report = [];
for (const version of VERSIONS) {
  const r = await packVersion(version);
  if (r && r.length > 0) {
    report.push(...r);
    rebuildIndex(version);
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ slice: SLICE, out: OUT, dest: DEST, archives: report }, null, 2));
} else {
  const n = (x) => x.toLocaleString('en-US');
  for (const r of report) {
    const pct = ((r.overheadBytes / r.objectBytes) * 100).toFixed(3);
    console.log(
      `[pack] ${r.sliceName} ${r.version}: ${n(r.tiles)} tiles, ${n(r.objectBytes)} B as objects -> ` +
        `${n(r.archiveBytes)} B archive (+${n(r.overheadBytes)} B, ${pct}%); ` +
        `directory ${n(r.dirBytes)} B gz / ${n(r.dirBytesRaw)} B raw, cover ${r.coverBytes} B`,
    );
    if (r.archiveBytes > 512 * 1024 * 1024) {
      console.log(
        `[pack]   WARNING: ${n(r.archiveBytes)} B is over Cloudflare's 512 MB cacheable ceiling ` +
          `— this archive will serve every tile from origin (cf-cache-status: BYPASS).`,
      );
    }
    console.log(
      `[pack]   verified ${n(r.verified)}/${n(r.tiles)} tiles byte-identical` +
        (r.verifiedAll ? ' (all)' : ' (--fast sample)') +
        (r.holeCell ? `; ${r.holeCell[0]}/${r.holeCell[1]} reads as a HOLE` : '') +
        `; sha256 ${r.sha256.slice(0, 16)}…`,
    );
  }
  if (report.length === 0) console.log(`[pack] ${SLICE}: nothing to pack under ${OUT}`);
}
