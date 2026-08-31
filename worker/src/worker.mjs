// The tile Worker: serves the shipped app's per-cell URLs out of the packed archives.
//
// The app (already shipped) fetches `GET /<ver>/<i>/<j>.json.gz` and treats 404 as
// "empty cell", any 200 as a gzip JSON payload. The bake stopped publishing per-cell
// objects (SPEC.md §11 — one `.wta` archive per slice per version), so something has to
// translate the old URL shape into a range read of the new archives. That something is
// this Worker, attached to the same hostname (`tiles.walktiles.xyz`) the app already
// holds, in front of the same R2 bucket.
//
// SPEC §11 says "there is no compatibility layer and there should not be one" — that was
// written for the archive-native client. The BUILDS IN THE FIELD still speak per-cell
// URLs, and this Worker is what lets the bucket move to archives without stranding them.
//
// Request handling, in order:
//
//   1. Optional token gate (HOSTING.md §5): if the `TILES_TOKEN` secret is set, refuse
//      requests without a matching `x-tiles-token` header. No secret = open (today's
//      behavior).
//   2. Tile URL (`/v4|v5|v5c/<i>/<j>.json.gz`):
//      a. the literal R2 object first — the July 2026 per-cell objects for five states
//         are still in the bucket and MUST keep working until they are deleted;
//      b. on miss, resolve through `<ver>/archive/index.json` (which slice's coverage
//         claims the cell — shard families like `florida-a`/`florida-b` are just more
//         entries), fetch that archive's directory once, and range-read the tile's bytes
//         out of the `.wta`. Headers mirror what the legacy objects serve (probed live
//         2026-08-31): `content-type: application/json`, `content-encoding: gzip`,
//         `cache-control: public, max-age=604800` — the R2 custom domain stores the gzip
//         bytes with `content-encoding: gzip` metadata and Cloudflare transcodes for
//         non-gzip clients, which `encodeBody: 'manual'` reproduces here.
//      c. HOLE (a claimed block, no directory entry) and UNBAKED (no claimant) are both
//         404 — the shipped app cannot tell them apart and treats 404 as "empty cell" —
//         distinguished only by an `x-tiles-status` debug header.
//   3. Everything else GETtable is passed through to the bucket untouched, WITH range
//      support: `/v4/archive/*.wta` (the archive-native client range-reads these),
//      `.idx.json`, `index.json`, habitat/atlas/landmark sidecars, hash manifests, build
//      stamps. Other consumers read those; this Worker must not get in their way.
//
// Caching (the Worker sits where the plain custom domain's edge cache used to):
//
//   - Tile bodies from archives: Cache API, keyed by a synthetic URL that INCLUDES THE
//     ARCHIVE DIGEST — a republish is a new digest, so invalidation is structural, no
//     purge and no clock. Stored raw (no content-encoding) and re-wrapped on the way
//     out, so the entry can never be transcoded behind our back.
//   - Legacy per-cell objects: Cache API keyed by path, 7 days — the same TTL the bake
//     uploaded them with and the edge already gave them.
//   - `index.json`: in-isolate, 60 s — the sidecar TTL the publisher chose (§11.4).
//   - Archive directories (~1 MB gzipped for a big slice — NEVER per request): gz bytes
//     in the Cache API keyed by digest (immutable, 1 year), decoded form in a small
//     in-isolate LRU.
import {
  parseTilePath,
  resolveTile,
  decodeDirectory,
  gunzip,
} from './resolve.mjs';

/** Sidecar/index TTL, from SPEC §11.4 — the publisher writes `cache-control: max-age=60`
 *  on `index.json` and this Worker honors the same freshness in-isolate. */
const INDEX_TTL_MS = 60_000;

/** What the legacy per-cell objects serve today and archive-resolved tiles mirror. */
const TILE_CACHE_CONTROL = 'public, max-age=604800';

/** 404s: five minutes, matching the pre-archive behavior the app was built against
 *  ("a 404 means empty cell — permanent for ocean, transient for a region not baked
 *  yet", so the TTL assumes the worse one). */
const MISS_CACHE_CONTROL = 'public, max-age=300';

/** Browser dev parity with scripts/serve-local.mjs: without these a browser client
 *  cannot send `Range` at all, and the failure is a CORS preflight rejection that says
 *  nothing about ranges. The native app ignores them. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, x-tiles-token',
  'access-control-expose-headers': 'content-range, content-length',
  'accept-ranges': 'bytes',
};

// ── in-isolate state ────────────────────────────────────────────────────────────────
// Isolates are recycled at Cloudflare's whim; both maps are pure caches and rebuild
// from R2 on a cold start. Module scope is the documented place for this.

/** version → { at, promise-of-index-json (null = no index published for the version) } */
const indexCache = new Map();

/** archive sha256 → decoded directory. A decoded 224k-tile directory is a few MB of
 *  arrays, so the LRU is capped well inside the isolate's 128 MB. */
const dirCache = new Map();
const DIR_CACHE_MAX = 8;

// ── helpers ─────────────────────────────────────────────────────────────────────────

async function loadIndex(env, version) {
  const now = Date.now();
  const hit = indexCache.get(version);
  if (hit && now - hit.at < INDEX_TTL_MS) return hit.promise;
  const promise = (async () => {
    const obj = await env.TILES.get(`${version}/archive/index.json`);
    return obj ? await obj.json() : null;
  })();
  indexCache.set(version, { at: now, promise });
  // Never cache a FAILURE for 60 s — a transient R2 error would otherwise blank a whole
  // version until the entry aged out. (`null` — index genuinely absent — is cached.)
  promise.catch(() => indexCache.delete(version));
  return promise;
}

/** The directory for one index entry, decoded. Keyed by the archive's sha256 in BOTH
 *  caches, so a republished slice (new digest) misses cleanly and the old entry ages
 *  out — no purge, no clock (SPEC §11.7 step 3). */
async function loadDirectoryCached(env, ctx, entry) {
  const seen = dirCache.get(entry.sha256);
  if (seen) {
    // Refresh recency: Map iteration order is insertion order, so delete+set is an LRU.
    dirCache.delete(entry.sha256);
    dirCache.set(entry.sha256, seen);
    return seen;
  }
  const cacheKey = new Request(`https://wta-internal/dir/${entry.sha256}`);
  const cache = caches.default;
  let gz;
  const cached = await cache.match(cacheKey);
  if (cached) {
    gz = new Uint8Array(await cached.arrayBuffer());
  } else {
    const obj = await env.TILES.get(entry.path, {
      range: { offset: entry.dir[0], length: entry.dir[1] },
    });
    if (!obj) throw new Error(`archive missing: ${entry.path}`);
    gz = new Uint8Array(await obj.arrayBuffer());
    // The archive is content-addressed and immutable, so its directory is too.
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(gz, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }),
      ),
    );
  }
  const dir = decodeDirectory(await gunzip(gz));
  dirCache.set(entry.sha256, dir);
  if (dirCache.size > DIR_CACHE_MAX) dirCache.delete(dirCache.keys().next().value);
  return dir;
}

/** A tile response shaped exactly like the live legacy objects (probe recorded in the
 *  header comment). `encodeBody: 'manual'` tells the runtime the body is ALREADY the
 *  declared encoding — without it, workerd would treat the gzip bytes as plaintext and
 *  encode them again. */
function tileResponse(gzBytes, extra = {}) {
  return new Response(gzBytes, {
    encodeBody: 'manual',
    headers: {
      ...CORS,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'cache-control': TILE_CACHE_CONTROL,
      ...extra,
    },
  });
}

function miss(status, extra = {}) {
  return new Response('not found', {
    status,
    headers: { ...CORS, 'cache-control': MISS_CACHE_CONTROL, ...extra },
  });
}

/** `Range` header → R2 range options. Single ranges only (`bytes=a-b`, `bytes=a-`,
 *  `bytes=-n`); a multipart or unparseable range returns null and the object is served
 *  whole with a 200, which HTTP permits and the archive client refuses by status. */
function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  if (m[1] && m[2]) {
    const offset = Number(m[1]);
    const end = Number(m[2]);
    if (end < offset) return null;
    return { offset, length: end - offset + 1 };
  }
  if (m[1]) return { offset: Number(m[1]) };
  return { suffix: Number(m[2]) };
}

// ── the two request kinds ───────────────────────────────────────────────────────────

/** Anything that is not a tile URL: hand the bucket's object back untouched, with range
 *  support (the archive-native client MUST get a 206 for a ranged `.wta` read — a 200
 *  would be the entire archive, about a gigabyte for a big slice, onto a phone). */
async function passthrough(request, env, pathname) {
  const key = decodeURIComponent(pathname.slice(1));
  if (!key || key.includes('..')) return miss(404);

  const range = parseRange(request.headers.get('range'));
  let obj;
  try {
    obj = await env.TILES.get(key, range ? { range } : undefined);
  } catch {
    // R2 throws on an unsatisfiable range; answer 416 with the real size so the caller
    // can correct itself, the way serve-local.mjs does.
    const head = await env.TILES.head(key);
    if (!head) return miss(404);
    return new Response(null, {
      status: 416,
      headers: { ...CORS, 'content-range': `bytes */${head.size}` },
    });
  }
  if (!obj) return miss(404);

  const headers = new Headers(CORS);
  obj.writeHttpMetadata(headers); // content-type, content-encoding, cache-control as uploaded
  headers.set('etag', obj.httpEtag);

  const init = { headers };
  // Stored-gzip objects (the per-cell tiles were uploaded that way) must not be
  // re-encoded by the runtime — same reasoning as tileResponse().
  if (obj.httpMetadata?.contentEncoding) init.encodeBody = 'manual';

  if (obj.range) {
    const offset = obj.range.offset ?? obj.size - obj.range.suffix;
    const length = obj.range.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    init.status = 206;
  }
  return new Response(obj.body, init);
}

/** A per-cell tile URL: legacy object first, then archive resolution. */
async function serveTile(request, env, ctx, cell) {
  const { version, i, j } = cell;
  const cache = caches.default;

  // ── 2a. the literal object — July legacy cells must keep working ──────────────────
  // Cached under the plain path so repeat hits in a colo stop paying a Class-B read,
  // exactly what the edge cache did for the bare custom domain.
  const legacyKey = new Request(`https://wta-internal/obj/${version}/${i}/${j}.json.gz`);
  const cachedLegacy = await cache.match(legacyKey);
  if (cachedLegacy) {
    return tileResponse(await cachedLegacy.arrayBuffer(), { 'x-tiles-source': 'object' });
  }
  const legacy = await env.TILES.get(`${version}/${i}/${j}.json.gz`);
  if (legacy) {
    const bytes = await legacy.arrayBuffer();
    // Stored WITHOUT content-encoding on purpose: the Cache API may transcode bodies it
    // believes are encoded, and a transcoded tile is a corrupted tile. Raw in, raw out,
    // headers reconstructed on exit.
    ctx.waitUntil(
      cache.put(
        legacyKey,
        new Response(bytes.slice(0), { headers: { 'cache-control': TILE_CACHE_CONTROL } }),
      ),
    );
    return tileResponse(bytes, { 'x-tiles-source': 'object' });
  }

  // ── 2b. archive resolution ────────────────────────────────────────────────────────
  let index;
  try {
    index = await loadIndex(env, version);
  } catch {
    // Infrastructure failure is 503, NEVER 404 — the app caches a 404 as "this cell is
    // empty", and a wrong "empty" is invisible; a 503 makes the cell error and the app
    // fall back down its chain (PostGIS → Overpass).
    return new Response('index unavailable', { status: 503, headers: { ...CORS, 'cache-control': 'no-store' } });
  }

  let resolved;
  try {
    resolved = await resolveTile(index, i, j, (entry) => loadDirectoryCached(env, ctx, entry));
  } catch {
    return new Response('archive unavailable', { status: 503, headers: { ...CORS, 'cache-control': 'no-store' } });
  }

  if (resolved.kind !== 'tile') {
    // HOLE and UNBAKED are the same 404 to the shipped app (it treats 404 as "empty
    // cell"); the debug header keeps the distinction observable from a curl.
    return miss(404, { 'x-tiles-status': resolved.kind });
  }

  // The cache key CARRIES THE ARCHIVE DIGEST: a republished slice is a new digest, so
  // every cached tile of the old generation simply stops being addressed — invalidation
  // by construction (the same trick the index entry's `dir` cache uses, SPEC §11.4).
  const sha12 = resolved.entry.sha256.slice(0, 12);
  const tileKey = new Request(`https://wta-internal/tile/${sha12}/${version}/${i}/${j}`);
  const cachedTile = await cache.match(tileKey);
  if (cachedTile) {
    return tileResponse(await cachedTile.arrayBuffer(), {
      'x-tiles-source': `archive ${resolved.entry.slice}-${sha12}`,
    });
  }

  const obj = await env.TILES.get(resolved.entry.path, {
    range: { offset: resolved.offset, length: resolved.length },
  });
  if (!obj) {
    // Index and archive disagree — a generation was retired under us mid-flight. The
    // 60 s index TTL heals it; until then, error rather than fabricate an empty cell.
    return new Response('archive retired', { status: 503, headers: { ...CORS, 'cache-control': 'no-store' } });
  }
  const bytes = await obj.arrayBuffer();
  ctx.waitUntil(
    cache.put(
      tileKey,
      new Response(bytes.slice(0), { headers: { 'cache-control': TILE_CACHE_CONTROL } }),
    ),
  );
  return tileResponse(bytes, { 'x-tiles-source': `archive ${resolved.entry.slice}-${sha12}` });
}

// ── entry ───────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: { ...CORS, allow: 'GET, HEAD, OPTIONS' } });
    }

    // HOSTING.md §5 — the optional soft gate. Unset secret = open, which is today's
    // behavior; the app already sends `x-tiles-token` when built with a token.
    if (env.TILES_TOKEN && request.headers.get('x-tiles-token') !== env.TILES_TOKEN) {
      return new Response('forbidden', { status: 403, headers: CORS });
    }

    const { pathname } = new URL(request.url);
    const cell = parseTilePath(pathname);
    const res = cell
      ? await serveTile(request, env, ctx, cell)
      : await passthrough(request, env, pathname);

    // HEAD gets the same status and headers with the body dropped.
    return request.method === 'HEAD' ? new Response(null, res) : res;
  },
};
