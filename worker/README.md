# worker/ — per-cell tiles out of the packed archives

The shipped app fetches `GET /<ver>/<i>/<j>.json.gz` (`i = floor(lat/0.01)`,
`j = floor(lng/0.01)`; `v4`, `v5`, `v5c`) and treats 404 as "empty cell". The bake
stopped publishing per-cell objects — each slice is now one immutable `.wta` archive
plus an index sidecar (SPEC.md §11) — so the builds in the field need a translator on
the same hostname. This Worker is that translator: it sits on `tiles.walktiles.xyz` in
front of the same R2 bucket and turns each per-cell URL into a range read of the owning
archive.

## What it does, per request

1. **Optional token gate** (HOSTING.md §5). If the `TILES_TOKEN` secret is set, any
   request without a matching `x-tiles-token` header is 403. Secret unset = fully open,
   which is today's behavior — the app already sends the header when built with
   `EXPO_PUBLIC_TILES_TOKEN`.
2. **Tile URLs** (`/v4/<i>/<j>.json.gz` etc.):
   - the **literal R2 object first** — the July 2026 per-cell objects (five states)
     keep working unchanged;
   - on miss, resolve through `<ver>/archive/index.json`: candidate slices are those
     whose coverage bitmap claims the cell's block (bbox as a prefilter; shard families
     like `florida-a`/`florida-b` are just more entries), each candidate's directory is
     fetched **once** and binary-searched, and the winning tile's bytes are range-read
     out of the `.wta`;
   - responses mirror what the legacy objects serve on the live host (probed
     2026-08-31): `content-type: application/json`, `content-encoding: gzip` with the
     stored gzip bytes as the body, `cache-control: public, max-age=604800`. Cloudflare
     transcodes for clients that don't accept gzip, exactly as the bare custom domain
     did.
   - A cell inside claimed coverage but absent from every candidate's directory is a
     **hole**; a cell no slice claims is **unbaked**. Both are 404 to the app (it can't
     tell them apart and treats 404 as empty); an `x-tiles-status: hole|unbaked` debug
     header keeps the distinction visible from curl.
3. **Everything else** — `/vN/archive/*.wta` (with full `Range`/206 support for the
   archive-native client), `.idx.json`, `index.json`, `habitat/`, `atlas/`,
   `landmarks/`, hash manifests, build stamps — is **passed through untouched** from
   the bucket. Other consumers read those keys; the Worker must never get in their way.

## Caching

- **Tile bodies from archives**: Cache API, keyed by a synthetic URL that includes the
  **archive digest** — a republish is a new digest, so old entries simply stop being
  addressed. No purge, no clocks.
- **Legacy objects**: Cache API by path, 7 days (the TTL they were uploaded with).
- **`index.json`**: in-isolate, 60 s — the sidecar TTL the publisher writes (§11.4).
- **Directories** (~1 MB gzipped for a big slice, never fetched per request): gz bytes
  in the Cache API keyed by digest (immutable, 1 year) + a small in-isolate LRU of
  decoded form.

The resolution logic itself lives in `src/resolve.mjs` as a pure module (no R2, no
Cache API), which is what the tests import.

## Layout

```
worker/
  wrangler.jsonc          config — placeholders for account_id / bucket_name
  src/resolve.mjs         pure resolution core (ported from scripts/archive.mjs)
  src/worker.mjs          fetch handler: gate, caches, R2, passthrough
  test/resolve.test.mjs   node:test suite against the out-bake/ fixtures
```

## Tests

From the repo root (no Cloudflare, no npm install — plain `node:test`):

```sh
node --test worker/test/resolve.test.mjs
```

The suite runs against the real sharded archives in `out-bake/massachusetts/archive/v5`
(bbox ownership with negative `j`, shard families, hole-vs-unbaked 404s, and byte
identity of a resolved tile against the per-cell object the same bake wrote), and
cross-checks the ported decoder against `scripts/archive.mjs` value for value. Without
the local bake output on disk the fixture tests skip rather than fail.

## Deploying

```sh
cd worker
# 1. Fill in the placeholders in wrangler.jsonc:
#      account_id   — dashboard → Workers & Pages → right sidebar
#      bucket_name  — the bucket the bake publishes to
npx wrangler login
npx wrangler deploy          # deploys, but serves nothing until routed

# 2. Optional token gate — only if abuse actually shows up (HOSTING.md §5):
npx wrangler secret put TILES_TOKEN
#    …then ship an app build with EXPO_PUBLIC_TILES_TOKEN set to the same value.
#    Leaving the secret unset keeps the host open (current behavior).

# 3. Route it. Uncomment the "routes" block in wrangler.jsonc and redeploy, or add the
#    route in the dashboard (Workers & Pages → walkable-tiles → Settings → Domains &
#    Routes): pattern tiles.walktiles.xyz/*, zone walktiles.xyz.
#    A Worker route takes precedence over the R2 custom domain on the same hostname,
#    so this step is the cutover — and removing the route is the instant rollback,
#    with the custom domain still there underneath.
```

Verify after routing:

```sh
# a July legacy cell — must still be a 200, x-tiles-source: object
curl -sI -H 'accept-encoding: gzip' https://tiles.walktiles.xyz/v4/4236/-7107.json.gz
# an archive-resolved cell (any covered cell with no per-cell object)
#   → 200, x-tiles-source: archive <slice>-<sha12>
# an ocean cell inside a slice's coverage → 404, x-tiles-status: hole
# somewhere unbaked → 404, x-tiles-status: unbaked
# a ranged archive read still 206s:
curl -sI -r 0-127 https://tiles.walktiles.xyz/v4/archive/index.json
```

**Once the Worker is live and verified, the July per-cell objects become deletable**:
every cell they serve resolves out of the archives through the same URLs, so removing
them frees ~2 GB of storage and their only remaining cost. Delete them *after* watching
`x-tiles-source` flip — not in the same change as the cutover.

Keep the HOSTING.md levers that live outside the Worker: the billing alert, the per-IP
rate limit and Bot Fight Mode all still apply to the routed hostname.
