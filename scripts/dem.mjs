// Copernicus GLO-30 elevation, read straight off AWS Open Data with no credentials,
// no GDAL, and no npm dependency (SPEC.md §10.9).
//
// WHY THIS FILE EXISTS AT ALL. `mountain` cannot be classified from OSM: OSM has no
// elevation. The one thing that separates "a city IN the mountains" from "a big hill
// inside a city" is the RADIUS at which relief is measured (SPEC §10.4), and measuring
// relief needs a DEM. GLO-30 is the choice because it is global, free, ~30 m, and needs
// no account — a European slice bakes the same day a US one does, which is not true of
// USGS 3DEP.
//
// WHY IT IS TIFF BY HAND INSTEAD OF `gdal_translate`. The bake's entire toolchain is node
// + osmium + awscli + jq, installed by two apt lines in .github/workflows/bake.yml, and
// the repo has no package.json at all. Adding GDAL (or geotiff.js, or a python geo stack)
// to buy `read one float from a raster` would be the largest dependency here by an order.
// The Copernicus COGs need exactly three things node already has: HTTP range requests,
// zlib inflate, and the TIFF floating-point predictor undone by hand.
//
// WHAT THE PRODUCT ACTUALLY IS, measured 2026-07-30 against
// Copernicus_DSM_COG_10_N44_00_W073_00_DEM.tif (44,874,301 B):
//
//   3600 rows x 3600 cols float32, PIXEL-IS-POINT (GeoTIFF key 1025 = 2)
//   tiled 1024 x 1024, Compression 8 (Adobe Deflate), Predictor 3 (float)
//   overviews at 1800 / 900 / 450 in later IFDs — DELIBERATELY UNUSED, see below
//
// PIXEL-IS-POINT is the detail that decides the sampling rule. The tie point puts post
// (0,0) exactly on the tile's NW degree corner, so posts sit on a lattice with no
// half-pixel offset and no per-tile origin to get wrong: tile N44_00_W073_00 holds
// ky in (44*3600, 45*3600] and kx in [-73*W, -72*W).
//
// ── THE ONE THING THAT WILL BITE ANYBODY WHO ASSUMES: LONGITUDE IS DECIMATED ─────────
//
// Rows are 1 arc-second EVERYWHERE (height is always 3600). COLUMNS are not. Above 50°N
// the archive drops longitude resolution to keep posts roughly square on the ground, and
// the tile gets NARROWER — measured, by fetching the headers:
//
//   N44 3600    N52 2400    N59 2400    N63 1800    N68 1800    N71 1200    N76 1200
//
// This module got that wrong first, and the failure was silent and total: Keswick, ringed
// by 900 m fells, reported 0 m of relief, and Amsterdam reported 0 m as well so nothing
// looked odd. Assuming 3600 columns on a 2400-column tile makes the block index run off
// the end of the row and read the NEXT row's block — a perfectly valid float32 array from
// somewhere else in the raster. `typeof elev === 'number'` was true throughout.
//
// So the width is READ from each tile's own header and carried as `W` through every post
// index, and `elevPost` throws if a caller hands it a W the tile disagrees with. The
// self-check at the bottom now covers 44°N, 53°N, 54°N and 63°N for exactly this reason.
//
// THE OVERVIEWS ARE NOT USED, and that is a normativity decision rather than a
// performance one. IFD 3 is 450 x 450 and 617 KB against the full tile's 44.9 MB — 70x
// cheaper — but it is GDAL's AVERAGE of 8x8 full-resolution posts, and averaging a summit
// is exactly the operation that destroys the quantity being measured. Worse, a plpgsql
// port re-deriving SPEC §10.4 would have to reproduce GDAL's overview generation to get
// the same answer, which turns a published data product into an implementation detail of
// one C library. Full resolution costs bandwidth; the overview costs the ability to say
// what the number means.
//
// Missing tiles are an ANSWER, not a failure: the archive publishes no tile for open
// ocean, so a 404 means "no land here" and the caller abstains (SPEC §10.4). Any other
// HTTP status is a real error and aborts the bake — an elevation source that half-works
// would silently un-classify a mountain range.
import { inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// The AWS Open Data mirror of the Copernicus DEM GLO-30 (2021 release, ~30 m).
// Anonymous HTTPS, no credentials, no requester-pays. Range requests are supported
// (`Accept-Ranges: bytes`), which is the whole reason block-level fetching is possible.
export const DEM_BASE = process.env.DEM_BASE || 'https://copernicus-dem-30m.s3.amazonaws.com';
// Rows per degree of LATITUDE. Constant over the whole archive — unlike columns.
export const DEM_ROWS_PER_DEG = 3600;
// Where fetched COG blocks live BETWEEN bakes. Deliberately outside the slice's temp dir:
// bake-slice.sh mktemp's a working directory and rm -rf's it on exit, so a cache inside it
// would re-download hundreds of MB on every re-run of the same slice — which is precisely
// what a --trial calibration loop does over and over.
export const DEM_CACHE_DIR =
  process.env.DEM_CACHE_DIR || join(homedir(), '.cache', 'walkable-tiles', 'dem');

const HTTP_RETRIES = 4;

/** `N44_00_W073_00` — the SW corner of the 1° tile, zero-padded as the archive names it. */
export function demTileName(latDeg, lngDeg) {
  const ns = latDeg < 0 ? 'S' : 'N';
  const ew = lngDeg < 0 ? 'W' : 'E';
  return (
    `${ns}${String(Math.abs(latDeg)).padStart(2, '0')}_00_` +
    `${ew}${String(Math.abs(lngDeg)).padStart(3, '0')}_00`
  );
}

const tileUrl = (name) =>
  `${DEM_BASE}/Copernicus_DSM_COG_10_${name}_DEM/Copernicus_DSM_COG_10_${name}_DEM.tif`;

// Which 1° tile row holds post row `ky`. NOT a plain floor: pixel-is-point puts row 0 on
// the tile's NORTH edge, so tile N44 owns ky in (44*3600, 45*3600] — the post exactly on
// lat 44 belongs to N43.
export const tileLatOf = (ky) => Math.floor((ky - 1) / DEM_ROWS_PER_DEG);

// THE POST NEAREST A SPAWN CELL'S CENTRE, in exact integer arithmetic and no floats.
// A cell centre is at (c + 0.5)·0.0015°, so the post index is round((2c+1)·3·W / 4000) —
// a half-integer for one cell in five when W = 3600. Rounding a float there is a coin toss
// decided by whether 0.0015·W's binary representation lands above or below the tie, and
// Ausculta's server re-derives this in plpgsql. So the tie is settled in integers instead:
// floor(((2c+1)·3W + 2000) / 4000) is round-half-up on the exact rational, identical in
// JS, in plpgsql and by hand. (Latitude uses W = DEM_ROWS_PER_DEG.)
export const postForCell = (c, W) => Math.floor(((2 * c + 1) * 3 * W + 2000) / 4000);

async function fetchRange(url, a, b) {
  let lastErr;
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    try {
      const r = await fetch(url, { headers: a === undefined ? {} : { Range: `bytes=${a}-${b}` } });
      if (r.status === 404 || r.status === 403) return null; // no such tile — see file header
      if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Minimal classic-TIFF IFD-0 reader. Deliberately not a TIFF library: it reads the tags
// this one product carries and throws on anything else, because a DEM that silently
// decodes as something other than what it is would be a wrong elevation, not a crash.
function parseIfd0(buf) {
  if (buf.readUInt16LE(0) !== 0x4949) throw new Error('DEM: not a little-endian TIFF');
  if (buf.readUInt16LE(2) !== 42) throw new Error('DEM: not a classic TIFF');
  const off = buf.readUInt32LE(4);
  const n = buf.readUInt16LE(off);
  const tags = {};
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = buf.readUInt16LE(e);
    const typ = buf.readUInt16LE(e + 2);
    const cnt = buf.readUInt32LE(e + 4);
    const sz = SIZE[typ] ?? 1;
    const vo = sz * cnt <= 4 ? e + 8 : buf.readUInt32LE(e + 8);
    if (vo + sz * cnt > buf.length) throw new Error(`DEM: IFD value for tag ${tag} past header window`);
    const vals = new Array(cnt);
    for (let k = 0; k < cnt; k++) {
      const p = vo + k * sz;
      vals[k] =
        typ === 3 ? buf.readUInt16LE(p) :
        typ === 4 ? buf.readUInt32LE(p) :
        typ === 12 ? buf.readDoubleLE(p) :
        typ === 1 ? buf.readUInt8(p) : null;
    }
    tags[tag] = vals;
  }
  const need = (t, want, what) => {
    if (tags[t]?.[0] !== want) throw new Error(`DEM: ${what} is ${tags[t]?.[0]}, expected ${want}`);
  };
  need(258, 32, 'BitsPerSample');
  need(259, 8, 'Compression'); // 8 = Adobe Deflate
  need(277, 1, 'SamplesPerPixel');
  need(317, 3, 'Predictor'); // 3 = floating point
  need(339, 3, 'SampleFormat'); // 3 = IEEE float
  if (tags[257][0] !== DEM_ROWS_PER_DEG)
    throw new Error(`DEM: tile is ${tags[257][0]} rows, expected ${DEM_ROWS_PER_DEG}`);
  return {
    width: tags[256][0], // COLUMNS PER DEGREE — 3600 below 50°, less above. Never assumed.
    height: tags[257][0],
    tileW: tags[322][0],
    tileH: tags[323][0],
    offsets: tags[324],
    counts: tags[325],
  };
}

// TIFF Predictor 3, undone. libtiff's `fpAcc`, and it is two steps that are easy to
// mistake for one: first a byte-wise running sum along the whole ROW buffer, then a
// de-shuffle from planar byte order (all byte-0s, then all byte-1s, …) back into
// little-endian float32s. Getting only the first step right yields plausible-looking
// garbage, which is why the module self-checks known summits at load.
function undoFpPredictor(row, wc) {
  const cc = wc * 4;
  for (let i = 1; i < cc; i++) row[i] = (row[i] + row[i - 1]) & 0xff;
  const tmp = Buffer.from(row);
  for (let i = 0; i < wc; i++) {
    row[4 * i + 3] = tmp[i];
    row[4 * i + 2] = tmp[wc + i];
    row[4 * i + 1] = tmp[2 * wc + i];
    row[4 * i + 0] = tmp[3 * wc + i];
  }
}

/**
 * A GLO-30 reader with a two-level cache: compressed COG blocks on disk (survive a
 * re-bake), decoded Float32Array blocks in memory (bounded, LRU).
 *
 * Access is deliberately two-phase — `await ensureBox(...)` for a lat/lng rectangle, then
 * synchronous `elevPost(...)`. One `await` per sampled post would be ~2 million promises
 * for a state; one per band is a few dozen.
 */
export class Dem {
  constructor({ cacheDir = DEM_CACHE_DIR, maxBlocks = 96 } = {}) {
    this.cacheDir = cacheDir;
    this.maxBlocks = maxBlocks;
    this.headers = new Map(); // tileName -> ifd | null (null = tile not published)
    this.bands = new Map(); // tileLat -> columns-per-degree | null (no land in range)
    this.blocks = new Map(); // `${tileName}/${bi}` -> Float32Array | null
    this.bytesFetched = 0;
    this.bytesFromCache = 0;
    this.blocksFetched = 0;
    this.headersFetched = 0;
    this.tilesMissing = new Set();
    this.tilesUsed = new Set();
    mkdirSync(this.cacheDir, { recursive: true });
  }

  async header(name) {
    if (this.headers.has(name)) return this.headers.get(name);
    const dir = join(this.cacheDir, name);
    const hp = join(dir, 'ifd.json');
    const absent = join(dir, 'ABSENT');
    let ifd = null;
    if (existsSync(absent)) {
      this.tilesMissing.add(name);
    } else if (existsSync(hp)) {
      ifd = JSON.parse(readFileSync(hp, 'utf8'));
    } else {
      // 64 KB is far more than the IFD needs (the value arrays sit within the first ~1 KB)
      // and is one round trip; the alternative is two, to read a length first.
      const head = await fetchRange(tileUrl(name), 0, 65535);
      this.headersFetched++;
      mkdirSync(dir, { recursive: true });
      if (head === null) {
        writeFileSync(absent, '');
        this.tilesMissing.add(name);
      } else {
        this.bytesFetched += head.length;
        ifd = parseIfd0(head);
        writeFileSync(hp, JSON.stringify(ifd));
      }
    }
    if (ifd) this.tilesUsed.add(name);
    this.headers.set(name, ifd);
    return ifd;
  }

  /**
   * Columns per degree for a whole 1° latitude band — the decimation the file header
   * warns about. Read from the first tile in `[lngLo, lngHi]` that exists rather than
   * from a hardcoded latitude table, because the published band edges and the archive's
   * actual ones do not agree (the handbook says 5" above 75°; N76 measures 1200, i.e. 3").
   * `null` means no tile in that range at all, which is the sea and is an answer.
   */
  async bandWidth(tileLat, lngLo, lngHi) {
    if (this.bands.has(tileLat)) return this.bands.get(tileLat);
    let W = null;
    for (let tLng = Math.floor(lngLo); tLng <= Math.floor(lngHi); tLng++) {
      const ifd = await this.header(demTileName(tileLat, tLng));
      if (ifd) { W = ifd.width; break; }
    }
    this.bands.set(tileLat, W);
    return W;
  }

  async block(name, bi) {
    const key = `${name}/${bi}`;
    const hit = this.blocks.get(key);
    if (hit !== undefined) {
      this.blocks.delete(key); // LRU: reinsert at the end
      this.blocks.set(key, hit);
      return hit;
    }
    const ifd = await this.header(name);
    if (!ifd) return this.#store(key, null);
    const dir = join(this.cacheDir, name);
    const bp = join(dir, `${bi}.z`);
    let raw;
    if (existsSync(bp)) {
      raw = readFileSync(bp);
      this.bytesFromCache += raw.length;
    } else {
      const off = ifd.offsets[bi];
      const len = ifd.counts[bi];
      if (off === undefined) throw new Error(`DEM: ${name} has no block ${bi} of ${ifd.offsets.length}`);
      raw = await fetchRange(tileUrl(name), off, off + len - 1);
      if (raw === null) throw new Error(`DEM: block ${key} vanished mid-bake`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(bp, raw);
      this.bytesFetched += raw.length;
      this.blocksFetched++;
    }
    const inf = inflateSync(raw);
    const px = ifd.tileW * ifd.tileH;
    if (inf.length !== px * 4)
      throw new Error(`DEM: block ${key} inflated to ${inf.length}, expected ${px * 4}`);
    for (let r = 0; r < ifd.tileH; r++)
      undoFpPredictor(inf.subarray(r * ifd.tileW * 4, (r + 1) * ifd.tileW * 4), ifd.tileW);
    return this.#store(key, new Float32Array(inf.buffer, inf.byteOffset, px));
  }

  #store(key, val) {
    this.blocks.set(key, val);
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value;
      if (oldest === key) break;
      this.blocks.delete(oldest);
    }
    return val;
  }

  /**
   * Load every block covering a lat/lng rectangle, so `elevPost` can be synchronous.
   * A one-post margin is added on every side: callers work in exact post indices and the
   * rounding that turns a degree into a post must never fall outside what was loaded.
   */
  async ensureBox(lngLo, lngHi, latLo, latHi) {
    const kyLo = Math.round(latLo * DEM_ROWS_PER_DEG) - 1;
    const kyHi = Math.round(latHi * DEM_ROWS_PER_DEG) + 1;
    const want = new Map(); // tileName -> Set(blockIndex)
    for (let tLat = tileLatOf(kyLo); tLat <= tileLatOf(kyHi); tLat++) {
      const W = await this.bandWidth(tLat, lngLo, lngHi);
      if (!W) continue;
      const north = DEM_ROWS_PER_DEG * (tLat + 1);
      const kxLo = Math.floor(lngLo * W) - 1;
      const kxHi = Math.ceil(lngHi * W) + 1;
      for (let tLng = Math.floor(kxLo / W); tLng <= Math.floor(kxHi / W); tLng++) {
        const name = demTileName(tLat, tLng);
        const ifd = await this.header(name);
        if (!ifd) continue;
        if (ifd.width !== W)
          throw new Error(`DEM: band ${tLat} is ${W} wide but ${name} is ${ifd.width}`);
        const rowLo = Math.max(0, north - Math.min(kyHi, north));
        const rowHi = Math.min(ifd.height - 1, north - Math.max(kyLo, DEM_ROWS_PER_DEG * tLat + 1));
        const colLo = Math.max(0, kxLo - tLng * W);
        const colHi = Math.min(W - 1, kxHi - tLng * W);
        if (rowLo > rowHi || colLo > colHi) continue;
        const perRow = Math.ceil(ifd.width / ifd.tileW);
        let set = want.get(name);
        if (!set) want.set(name, (set = new Set()));
        for (let r = Math.floor(rowLo / ifd.tileH); r <= Math.floor(rowHi / ifd.tileH); r++)
          for (let c = Math.floor(colLo / ifd.tileW); c <= Math.floor(colHi / ifd.tileW); c++)
            set.add(r * perRow + c);
      }
    }
    let total = 0;
    for (const s of want.values()) total += s.size;
    if (total > this.maxBlocks) this.maxBlocks = total; // a band must fit, or it thrashes
    for (const [name, set] of want)
      for (const bi of [...set].sort((a, b) => a - b)) await this.block(name, bi);
  }

  /**
   * Elevation at post (kx, ky) of a band whose width is `W`, or NaN where the archive
   * publishes no tile. `W` is passed in rather than looked up because kx is only
   * meaningful relative to it — see the decimation note in the file header.
   */
  elevPost(kx, ky, W) {
    const tLat = tileLatOf(ky);
    const tLng = Math.floor(kx / W);
    const name = demTileName(tLat, tLng);
    const ifd = this.headers.get(name);
    if (ifd === undefined) throw new Error(`DEM: ${name} not ensured before elevPost(${kx},${ky})`);
    if (ifd === null) return NaN;
    if (ifd.width !== W) throw new Error(`DEM: ${name} is ${ifd.width} wide, caller assumed ${W}`);
    const row = DEM_ROWS_PER_DEG * (tLat + 1) - ky;
    const col = kx - tLng * W;
    const perRow = Math.ceil(ifd.width / ifd.tileW);
    const bi = Math.floor(row / ifd.tileH) * perRow + Math.floor(col / ifd.tileW);
    const blk = this.blocks.get(`${name}/${bi}`);
    if (blk === undefined) throw new Error(`DEM: block ${name}/${bi} not ensured`);
    if (blk === null) return NaN;
    return blk[(row % ifd.tileH) * ifd.tileW + (col % ifd.tileW)];
  }

  /**
   * The DROP at a summit: the post under the point, minus the lowest post within
   * `radiusM`. NaN if the archive has no tile there. Loads what it needs, so it is async;
   * this is the peak-prominence path (SPEC §10.8), thousands of peaks and not millions.
   *
   * DROP, NOT RANGE, and the difference is the whole filter. `max − min` over the window
   * counts summits HIGHER than the peak, so a 265 m knob beside an 800 m mountain scores
   * as if it were the mountain: measured on the vermont trial, ranking by range put Table
   * Rock, The Cobble and Bear Mount in the state's twelve anchors and left out Mount
   * Mansfield, Killington Peak and Camels Hump. That is a cliff detector. `self − min` is
   * how far the ground falls away from THIS summit, which is what prominence means.
   *
   * The window is a disc in METRES, the same rule as `buildReliefGrid` one grid finer. A
   * square counted in POSTS would be 39% wider than tall at 44°N — and above 50°N, where
   * columns are decimated, it would be narrower than tall. Neither is a disc.
   */
  async dropAtPoint(lat, lng, radiusM, mPerDeg) {
    const ky = Math.round(lat * DEM_ROWS_PER_DEG);
    const W = await this.bandWidth(tileLatOf(ky), lng - 1, lng + 1);
    if (!W) return NaN;
    const postNS = mPerDeg / DEM_ROWS_PER_DEG;
    const postEW = (mPerDeg / W) * Math.cos((lat * Math.PI) / 180);
    const { ry, rx } = reliefWindow(radiusM, postNS, postEW);
    await this.ensureBox(
      lng - (rx[0] + 1) / W, lng + (rx[0] + 1) / W,
      lat - (ry + 1) / DEM_ROWS_PER_DEG, lat + (ry + 1) / DEM_ROWS_PER_DEG,
    );
    const kx = Math.round(lng * W);
    // The summit's own post, not the window's max: a peak node a few tens of metres off
    // the true top costs a metre or two here (Mount Mansfield's node reads 1333.3 against
    // 1334.3 for the best post within 600 m), whereas taking the max would let the node
    // claim any higher ground that happens to be near it — the very thing DROP exists to
    // stop, reintroduced at the other end.
    const self = this.elevPost(kx, ky, W);
    if (Number.isNaN(self)) return NaN;
    let lo = Infinity;
    for (let dy = -ry; dy <= ry; dy++) {
      const r = rx[Math.abs(dy)];
      if (r < 0) continue;
      for (let x = kx - r; x <= kx + r; x++) {
        const e = this.elevPost(x, ky + dy, W);
        if (!Number.isNaN(e) && e < lo) lo = e;
      }
    }
    return self - lo;
  }

  summary() {
    const mb = (b) => (b / 1e6).toFixed(1) + ' MB';
    return (
      `${this.tilesUsed.size} DEM tiles (${this.tilesMissing.size} not published), ` +
      `${this.blocksFetched} blocks + ${this.headersFetched} headers fetched = ${mb(this.bytesFetched)}, ` +
      `${mb(this.bytesFromCache)} re-read from ${this.cacheDir}`
    );
  }
}

// ── the relief FIELD (SPEC §10.4's `regional relief`) ──────────────────────────────────
//
// This module owns the elevation and the arithmetic; `tile.mjs` owns the constants and
// the rule that reads them. The split is where the normativity is: "max − min of the DEM
// posts nearest the spawn-cell centres inside a disc" is a definition, and "the disc is
// 5 km and the threshold is 500 m" is a calibration, and the second is the one that gets
// re-argued.

// Sliding-window max (or min) of half-width r, ignoring NaN, in O(n) via a monotonic
// deque. The naive form is O(n·r) and r is ~40, which over a state's millions of cells in
// 61 row offsets is the difference between seconds and an hour.
function slideExtreme(src, off, n, r, out, isMax, dq) {
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + r);
    while (next <= hi) {
      const v = src[off + next];
      if (!Number.isNaN(v)) {
        while (tail > head && (isMax ? v >= src[off + dq[tail - 1]] : v <= src[off + dq[tail - 1]])) tail--;
        dq[tail++] = next;
      }
      next++;
    }
    while (tail > head && dq[head] < i - r) head++;
    out[i] = tail > head ? src[off + dq[head]] : NaN;
  }
}

// The window's shape, as whole cells: for each row offset dy, the largest column offset
// whose centre is still within `radiusM`. A DISC and not a square, and the difference is
// not cosmetic — a square of half-width R reaches R·√2 into its corners, which measured
// on Vermont is the difference between "the Green Mountains" and "most of the state": at
// R = 5 km the square calls 59.2% of Vermont's spawn cells mountain at a 450 m threshold
// and the disc calls 50.3%. The corner is not a rounding error, it is a 41% longer reach
// in the direction of whatever the nearest mountain happens to be.
//
// `rx[dy] = -1` means the row is outside the disc entirely.
export function reliefWindow(radiusM, cellNSm, cellEWm) {
  const ry = Math.ceil(radiusM / cellNSm);
  const rx = new Int32Array(ry + 1);
  for (let dy = 0; dy <= ry; dy++) {
    const dm = dy * cellNSm;
    rx[dy] = dm > radiusM ? -1 : Math.floor(Math.sqrt(radiusM * radiusM - dm * dm) / cellEWm);
  }
  return { ry, rx };
}

/**
 * Regional relief over a rectangle of spawn cells: for every cell, max − min of the DEM
 * post nearest each cell centre inside the disc of radius `radiusM` (SPEC §10.4).
 *
 * The disc is not separable, so this is a horizontal sliding pass per ROW OFFSET —
 * 2·ry+1 passes of half-width rx[|dy|] — accumulated into the answer. That is O(N·ry)
 * rather than a separable O(N), and it is the price of the shape; measured at ~8 s for
 * Vermont's 2.5 million cells, which is nothing beside the bake it sits inside.
 *
 * Latitude enters `rx` once, for the grid's middle row, rather than per row. A slice
 * spans a few degrees and cos changes the column count by a few percent across it;
 * recomputing per row would make the window depend on a float comparison at every row
 * boundary, which is the kind of thing a plpgsql port gets subtly wrong. The window is a
 * property of the SLICE's latitude band, stated once and printed in the bake log.
 */
export async function buildReliefGrid(dem, { cxLo, cxHi, cyLo, cyHi, cellDeg, mPerDeg, radiusM, onBand }) {
  const cellNS = cellDeg * mPerDeg;
  const latMid = ((cyLo + cyHi + 1) / 2) * cellDeg;
  const { ry, rx } = reliefWindow(radiusM, cellNS, cellNS * Math.cos((latMid * Math.PI) / 180));
  const exLo = cxLo - rx[0], exHi = cxHi + rx[0];
  const eyLo = cyLo - ry, eyHi = cyHi + ry;
  const W = exHi - exLo + 1;
  const H = eyHi - eyLo + 1;
  const elev = new Float32Array(W * H);
  const lngLo = exLo * cellDeg, lngHi = (exHi + 1) * cellDeg;

  // Column resolution is a property of the 1° LATITUDE BAND, so it is resolved per band
  // and the longitude post index is recomputed per row. A slice that straddles 50°N —
  // England, and every Nordic one — has two different lattices inside one grid.
  const BAND = 128; // cell rows per `ensureBox` — ~0.19°, about one COG block row
  for (let y0 = eyLo; y0 <= eyHi; y0 += BAND) {
    const y1 = Math.min(eyHi, y0 + BAND - 1);
    await dem.ensureBox(
      lngLo, lngHi,
      postForCell(y0, DEM_ROWS_PER_DEG) / DEM_ROWS_PER_DEG,
      postForCell(y1, DEM_ROWS_PER_DEG) / DEM_ROWS_PER_DEG,
    );
    for (let cy = y0; cy <= y1; cy++) {
      const ky = postForCell(cy, DEM_ROWS_PER_DEG);
      const cols = await dem.bandWidth(tileLatOf(ky), lngLo, lngHi);
      const base = (cy - eyLo) * W;
      if (!cols) { elev.fill(NaN, base, base + W); continue; }
      for (let cx = exLo; cx <= exHi; cx++)
        elev[base + (cx - exLo)] = dem.elevPost(postForCell(cx, cols), ky, cols);
    }
    onBand?.(y1 - eyLo + 1, H);
  }

  const cols = cxHi - cxLo + 1, rows = cyHi - cyLo + 1;
  const wMax = new Float32Array(cols * rows).fill(-Infinity);
  const wMin = new Float32Array(cols * rows).fill(Infinity);
  const rowMax = new Float32Array(W), rowMin = new Float32Array(W), dq = new Int32Array(W);
  for (let dy = -ry; dy <= ry; dy++) {
    const r = rx[Math.abs(dy)];
    if (r < 0) continue;
    for (let cy = cyLo; cy <= cyHi; cy++) {
      const base = (cy + dy - eyLo) * W;
      slideExtreme(elev, base, W, r, rowMax, true, dq);
      slideExtreme(elev, base, W, r, rowMin, false, dq);
      const dst = (cy - cyLo) * cols;
      for (let cx = cxLo; cx <= cxHi; cx++) {
        const a = rowMax[cx - exLo], b = rowMin[cx - exLo];
        if (!Number.isNaN(a) && a > wMax[dst + cx - cxLo]) wMax[dst + cx - cxLo] = a;
        if (!Number.isNaN(b) && b < wMin[dst + cx - cxLo]) wMin[dst + cx - cxLo] = b;
      }
    }
  }

  const relief = new Float32Array(cols * rows);
  for (let cy = cyLo; cy <= cyHi; cy++)
    for (let cx = cxLo; cx <= cxHi; cx++) {
      const i = (cy - cyLo) * cols + (cx - cxLo);
      // The CELL'S OWN post decides whether there is an answer at all. A window that
      // clips an unpublished ocean tile still has land in it and still has a relief; a
      // cell whose own ground is not in the archive has no elevation to be relative to,
      // and abstains (SPEC §10.4).
      relief[i] = Number.isNaN(elev[(cy - eyLo) * W + (cx - exLo)]) ? NaN : wMax[i] - wMin[i];
    }
  return {
    cxLo, cyLo, cols, rows, ry, rx, radiusM,
    /** Regional relief in metres at a spawn cell, or NaN outside the grid / off-DEM. */
    at(cx, cy) {
      if (cx < cxLo || cx > cxLo + cols - 1 || cy < cyLo || cy > cyLo + rows - 1) return NaN;
      return relief[(cy - cyLo) * cols + (cx - cxLo)];
    },
  };
}

// A live self-check, run by `node scripts/dem.mjs`. Asserts on a VALUE and not on a
// shape, for the reason CLAUDE.md records: `typeof dem === 'object'` is true of an empty
// module, and a predictor undone by half returns plausible floats. The last three cases
// are ABOVE 50°N on purpose — that is where longitude decimation lives, and reading a
// 2400-wide tile as if it were 3600 wide returned real-looking elevations from the wrong
// place and reported the Lake District as flat.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dem = new Dem({});
  const cases = [
    ['Mount Mansfield, VT   (44°N)', 44.543947, -72.81431, 1339, 40],
    ['Point Reno, DC        (38°N)', 38.95403, -77.07932, 125, 30],
    ['Snowdon, Wales        (53°N)', 53.068444, -4.076111, 1085, 40],
    ['Skiddaw, Cumbria      (54°N)', 54.649722, -3.144167, 931, 40],
    ['Åreskutan, Sweden     (63°N)', 63.426, 13.0819, 1420, 45],
  ];
  let bad = 0;
  for (const [what, lat, lng, expect, tol] of cases) {
    const ky = Math.round(lat * DEM_ROWS_PER_DEG);
    const W = await dem.bandWidth(tileLatOf(ky), lng - 1, lng + 1);
    const kx = Math.round(lng * W);
    await dem.ensureBox(lng - 0.02, lng + 0.02, lat - 0.02, lat + 0.02);
    let hi = -Infinity;
    for (let y = ky - 20; y <= ky + 20; y++)
      for (let x = kx - 20; x <= kx + 20; x++) hi = Math.max(hi, dem.elevPost(x, y, W));
    const ok = Math.abs(hi - expect) <= tol;
    if (!ok) bad++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${what}: DEM max nearby = ${hi.toFixed(1)} m, published ${expect} m` +
        `  [W=${W}]`,
    );
  }
  console.log(dem.summary());
  process.exit(bad ? 1 : 0);
}
