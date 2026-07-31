# walkable-tiles

Pre-bakes the whole world's **walkable ways + street names + pedestrian
crossings** from OpenStreetMap into small static tiles, uploaded to
**Cloudflare R2** and served through a CDN. The app fetches one tile per
location instead of hitting a live PostGIS/Overpass backend.

Two consumers, two formats from one bake pass: **v4** (Cologra, shipping —
frozen, byte-identical) and **v5** (Ausculta — v4 plus landcover polygons,
capped named landmarks, and a per-spawn-cell habitat class grid; see
`SPEC.md §10`).

- **Zero serve-egress** (R2 behind Cloudflare).
- **Zero compute cost** — the bake runs entirely on free GitHub-hosted runners
  (this repo is public → unlimited Actions minutes).
- **PostGIS-free** — the bake goes `.osm.pbf` → tiles directly. No database to
  run or keep alive.

> **Code is Apache-2.0** (`LICENSE`). **Tiles are ODbL 1.0, © OpenStreetMap
> contributors** — see `DATA-LICENSE.md`. Those are two different licenses on
> two different artifacts; the code license does not relicense the data.

---

## Tile format (must match the app exactly)

The app already defines the grid and payload; the pipeline emits the same thing
so tiles are a drop-in for the live fetch path.

| Constant | Value | Meaning |
|---|---|---|
| `TILE_DEG` | `0.01°` | grid cell size (~1.1 km) |
| `tileKey(p)` | `${floor(lat/0.01)}:${floor(lng/0.01)}` | cell id → `latIdx`, `lngIdx` |
| `BOX_HALF_M` | `1200` | each tile holds all data within 1200 m of the **cell center** |

**Payload — v4, identical to `apps/mobile/src/run/osm.ts`:**

```jsonc
{
  "v": 4,
  "ways":     [ { "points": [ { "lat": 42.36, "lng": -71.06 }, … ], "foot": true } ],
  "names":    [ "Main St", null, … ],          // parallel to ways[]
  "crossings":[ { "lat": 42.361, "lng": -71.061 }, … ]
}
```

`foot` = the highway class is a pedestrian type (`footway|path|pedestrian|steps|
track|living_street`) vs a shared road (`residential|service|unclassified`).
`crossings` = `highway=crossing` nodes plus `footway=crossing` way midpoints.

**Payload — v5** = the v4 payload (identical keys, same code path) + top-level
`landcover`, `landmarks`, `habitat`, with `v: 5` — additive, so a v4 parser
pointed at a v5 tile still finds its ways. Format, classes, and the normative
habitat-classifier thresholds are specified in `SPEC.md §10`.

Baking to the **cell center** (not a runner's exact position) makes every tile
deterministic and cacheable. Because the 1200 m box overspills the 1.1 km cell,
a way near a boundary lands in ~4 neighboring tiles — accepted duplication
(~4–5×) that keeps the app's coverage behavior byte-for-byte identical and lets
`ensureCoverage`'s edge-refetch work unchanged.

---

## R2 layout

**Tiles are published as ARCHIVES, not as one object per cell** (SPEC.md §11, as of
2026-07-31). A slice is one `.wta` file per version; a tile is an HTTP byte range inside it.

```
walkable-tiles/
  v4/build/<slice>.json           # per-slice last-baked stamp, counts, bytes, PHASE TIMINGS
  v4/hashes/<slice>.json          # content hash per tile — still published, no longer a gate
  v4/archive/index.json           # every published v4 slice: bbox, coverage bitmap, digest
  v4/archive/<slice>.idx.json     # one slice's entry (index.json is rebuilt from these)
  v4/archive/<slice>-<sha12>.wta  # the archive; content-addressed, immutable
  v5/hashes/<slice>.json
  v5/archive/…                    # same three, v5
  v5c/archive/…                   # same three, v5c (the coarse layer, SPEC.md §10.10)
  v5/habitat/<slice>.jsonl   # habitat sidecar — non-rural spawn cells (SPEC.md §10.4)
  v5/landmarks/<slice>.jsonl # anchor sidecar — the few named things significant enough to
                             #   hold a creature, after the regional cap (SPEC.md §10.8).
                             #   Tens per state: vermont 12, district-of-columbia 1.
  v5/atlas/<slice>.json      # habitat atlas for the client (SPEC.md §10.7)
```

- Served from `${TILES_HOST}`, the Cloudflare custom domain in front of R2 — supplied to the
  app as a build-time env var, never committed here. (The data is ODbL, so the host is
  operational config, not a true secret.)
- A client fetches `index.json` (1 h TTL), then one **ranged** GET for a slice's directory,
  then one ranged GET per tile. **Ranged GETs must answer 206**; a 200 means the origin
  ignored `Range` and is about to hand back the whole archive, and both the client and the
  verifier refuse it.
- **Cache-Control:** the `.wta` is `max-age=31536000, immutable` (safe, because its key
  contains its own digest); `index.json` and the sidecars are `max-age=60`. A republish is a
  new object plus a new index — atomic, and no purge.
- **"Empty" and "not baked yet" are now different answers.** A cell inside a slice's
  coverage bitmap with no directory entry is a **hole** — permanent, cached 30 days. A cell
  no published slice covers is **unbaked** — transient, cached 5 minutes. That distinction
  was impossible under one-object-per-cell, where both were a 404; SPEC.md §11.5.
- Only **data-bearing** cells are written (oceans/empty land skipped), cutting
  ~2 B theoretical cells to ~5–10 M real ones.

Why: a full v5 + v5c re-bake was ~1.2–1.3 M Class-A writes, essentially the entire $6–9 cost
of a bake. It is now about fifteen objects. Nothing is saved at RUNTIME — a range request is
the same Class-B read, and the client issues the same number of tile requests it did before.
See ausculta's `docs/PMTILES-SCOPING.md` for the costing and SPEC.md §11 for the format
(including why this is not PMTiles v3 byte-for-byte).

### What is actually published

The bucket is not the world yet, and **v4 and v5 coverage differ** — v4 was seeded
first, v5 came with the Ausculta format. A slice is only *refreshed* if it is also a
row in `slices.json`; publishing tiles without adding the row leaves them frozen at
whatever OSM said the day they were baked.

| Slice | v4 (ways) | v5 (terrain) | in `slices.json` |
|---|---|---|---|
| massachusetts | yes | yes | yes |
| utah | yes | yes | yes |
| arizona | yes | **no** | yes |
| florida | yes | **no** | yes |
| kansas | yes | **no** | yes |
| virginia | yes | **no** | **no** |
| maryland | yes | **no** | **no** |

Everything else is absent from `index.json`, which the client reads as **not baked** —
distinguishable from ocean since the archive move, and retried on the short clock rather
than cached as emptiness. **A region with v4 but no v5 renders ways with no landcover wash,
landmarks, or habitat grid**: Ausculta's terrain layer degrades silently rather
than erroring, so a missing v5 slice is invisible from inside the app. The only
proof of coverage is fetching a tile and looking at its contents.

Washington DC is a hole in an otherwise-covered region: the `virginia` and
`maryland` extracts each own only their own side of the boundary, and
`district-of-columbia` was never baked, so cells over the District have neither
version.

**Only `massachusetts` and `utah` have `hashes/` manifests.** The other slices' tiles were
pushed without one, so their *completeness is unproven* — the manifest is the only per-cell
record of what a bake intended to write. Since the archive move that is a documentation gap
rather than an upload cost: a missing manifest no longer means "re-upload every tile",
because "changed" is now one `sha256` over the whole archive (SPEC.md §11.6).

**Nothing in this table is packed yet.** The archives land with the next publish; until then
the bucket holds the object layout and the app cannot read it. That is deliberate — nobody
is using the app, so there is no compatibility layer and there should not be one.

---

## How a bake works (per slice)

1. **Download** the slice's `.osm.pbf` from Geofabrik.
2. **`osmium tags-filter`** →
   `w/highway=footway,path,pedestrian,steps,track,living_street,residential,service,unclassified`
   + `n/highway=crossing` + `w/footway=crossing`.
3. **Transform** each feature to v4 fields; bin every way into the tiles within
   1200 m of any of its points (dedupe per `(cell, wayId)`); bin crossings by cell.
   A cell is **owned** by the slice iff its center falls inside the slice polygon
   (see boundary rule in `SPEC.md`) — so exactly one slice writes each cell.
4. **Elevation** (v5 only): fetch the Copernicus GLO-30 blocks the slice's spawn
   cells fall on, by HTTP range from AWS Open Data — no credentials — and derive
   regional relief for `mountain` and local drop for the peak ranking
   (`SPEC.md` §10.4, §10.8, §10.9). Cached under `DEM_CACHE_DIR` between bakes;
   cold cost measured at 11.7 MB for the District and 255.2 MB for Vermont.
5. **Assemble** each owned cell's v4/v5/v5c payload → gzip.
6. **Pack** (`scripts/pack-archives.mjs`): concatenate the tiles of each version into one
   `.wta` with a directory and a coverage bitmap (SPEC.md §11). The tile BYTES are not
   touched, and the packer proves it — it re-opens the archive it just wrote, decodes the
   directory from the file, pulls every tile back by offset and compares it with the source
   object. It reads only `OUT_DIR`, so packaging never costs a re-bake.
7. **Publish:** upload the archive (immutable, content-addressed), then its index sidecar,
   then rebuild `index.json` from every sidecar in the bucket, then retire the
   generation-before-last. Skipped entirely if the archive's `sha256` matches the published
   one — which is what "changed" means now.

**Every phase is timed.** The log prints `⏱ <phase>: <seconds>` and a `TOTAL`, and the
per-slice `build/<slice>.json` carries a `phases` object. The log used to name the phases
with no timestamps at all, which made a 6–10 hour run unattributable — fine for one state,
useless for planning a globe.

The osmium steps stream (low memory); tiles flush per-cell, so any Geofabrik
country/state extract fits a free runner's disk. Step 4 is the one pass that
holds a whole slice in memory at once — one float per spawn cell over the
slice's bounding box, ~10 MB for Vermont and ~0.5 GB for California.

---

## Repo layout

```
.github/workflows/bake.yml   # the daily matrix workflow (see SPEC.md)
slices.json                  # Geofabrik extracts × assigned day-of-month
scripts/gen-slices.mjs       # generate a whole-world slice list from Geofabrik's index
scripts/bake-all.sh          # one-time local seed: bake every slice → R2 (resumable)
scripts/bake-slice.sh        # download → filter → tile → pack → publish (timed per phase)
scripts/archive.mjs          # the .wta format (SPEC.md §11) — encode + decode, shared
scripts/pack-archives.mjs    # OUT_DIR → one archive per version, verified byte-for-byte
scripts/tile.mjs             # OSM features → v4 tiles + gzip
scripts/dem.mjs              # Copernicus GLO-30 reader (COG over HTTP range, no deps)
scripts/inspect-bake.mjs     # look at what a LOCAL bake produced, before paying for it
scripts/serve-local.mjs      # serve baked tiles locally like the CDN (dev only)
scripts/verify-coverage.mjs  # prove published coverage by value through the CDN
LICENSE  NOTICE  DATA-LICENSE.md
SPEC.md                      # matrix / scheduling / boundary / diff design
HOSTING.md                   # cost model + Cloudflare abuse hardening
```

## Local development

Nothing here needs the public repo or R2 to iterate — everything runs on your
machine, and you only `git push` when you're happy. Fastest loop first.

**1. Tile logic only (no osmium, sub-second).** Feed synthetic GeoJSON-Seq
straight into the tiler:

```bash
printf '%s\n' \
'{"type":"Feature","id":"w1","properties":{"highway":"footway","name":"River Path"},"geometry":{"type":"LineString","coordinates":[[-71.06,42.36],[-71.061,42.361]]}}' \
'{"type":"Feature","id":"n9","properties":{"highway":"crossing"},"geometry":{"type":"Point","coordinates":[-71.0595,42.3595]}}' \
| node scripts/tile.mjs --out ./out
```

**2. Real data, dry-run (needs `osmium-tool` + `jq`; `brew install osmium-tool jq`).**
Use a small dense extract like DC to keep it quick, and `OUT_DIR` to keep the tiles:

```bash
OUT_DIR=./out R2_DRY_RUN=1 ./scripts/bake-slice.sh \
  https://download.geofabrik.de/north-america/us/district-of-columbia-latest.osm.pbf dc
# even faster: clip a tiny bbox from any .pbf first —
# osmium extract -b -71.07,42.35,-71.05,42.37 big.osm.pbf -o small.osm.pbf
```

**3. Full loop with the app.** Serve `./out` like the CDN, then point the app at it:

```bash
node scripts/serve-local.mjs ./out            # http://localhost:8788
# Serves BOTH layouts: /v5/archive/… with real Range support (206, content-range) — which
# is what the app reads — and the /v5/<i>/<j>.json.gz objects the packer packs. An unranged
# GET of a .wta answers 416 rather than a gigabyte, the same refusal the client makes.
# iOS simulator can use localhost; a real device on your LAN uses your Mac's IP.
# In the app build:  EXPO_PUBLIC_TILES_HOST=http://localhost:8788
```

**3b. Verify a pack with no server at all.** `--local` points the verifier at an `OUT_DIR`'s
`archive/` and resolves through the same index → bitmap → directory → range path it uses
against the CDN, reading a file descriptor instead of a `Range` header:

```bash
node scripts/verify-coverage.mjs --local ./out/archive --slice district-of-columbia
```

**4. Validate the workflow itself** (the matrix/plan logic) without pushing, via
[`act`](https://github.com/nektos/act) (needs Docker):

```bash
act workflow_dispatch -W .github/workflows/bake.yml --input slice=dc
```

**Staging the real end-to-end (Actions + R2) privately.** A public repo can't hide
its Actions runs, so if you want to rehearse the live upload before it's on public
`main`, push to a throwaway **private** repo, run the workflow there with real R2
secrets, then fast-forward the validated commit onto the public repo. For
everything else, local dry-run + `serve-local.mjs` is enough.

## Direct (upload) usage

```bash
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=walkable-tiles
./scripts/bake-slice.sh <pbf-url> <slice-name>
```

**Re-publishing without re-baking.** Tiling a big slice costs a download plus tens of
minutes of CPU. `R2_UPLOAD_ONLY=1` reuses an `OUT_DIR` that already has tiles *and* its
three hash manifests, and goes straight to pack + publish:

```bash
OUT_DIR=./out R2_UPLOAD_ONLY=1 ./scripts/bake-slice.sh <pbf-url> <slice-name>
```

Safe to re-run: if the packed archive's `sha256` matches the published one, nothing is
uploaded at all. This is also the path a **packaging** change takes — the archive format can
be changed and republished from an existing bake output without repeating the 6–10 hours,
which is the whole reason `bake-all.sh` stopped deleting `OUT_DIR`.

Note the manifests in `OUT_DIR` belong to **whichever slice tiled last** — `OUT_DIR`
accumulates tiles across a multi-slice local seed, but `hashes.json` does not, so always
pass the slice name whose manifests are currently on disk.

`R2_CONCURRENCY` (default 128) sets in-flight requests per `aws` process. It matters far
less than it did: a publish is now a handful of PUTs, not hundreds of thousands.

## Verifying a bake

```bash
TILES_HOST=https://tiles.example.com node scripts/verify-coverage.mjs
TILES_HOST=…                          node scripts/verify-coverage.mjs --slice utah
                                      node scripts/verify-coverage.mjs --local ./out/archive
```

Counting objects in the bucket proves nothing about them: **an HTTP 200 is true for
an empty tile**, and a hash manifest will happily claim tiles the bucket never
received. So this fetches known coordinates through the CDN and asserts on things
only real OSM data produces — way counts, named streets, crossings, v5 landcover
polygons, and geometry that actually falls inside the cell it was served for (which
is what catches a mis-keyed bake). Cells expected to be thin are asserted thin, not
dense: a desert track cell must have ≥1 way and must resolve to a tile, but demanding volume
there would be asserting a lie about the terrain.

Since the archive move it also checks the two absences SEPARATELY, because a directory
lookup can succeed while returning nothing and that is indistinguishable from a broken
decoder if nobody asserts on it:

* `empty` — the cell must be a **hole**: a published slice's coverage bitmap claims this
  ground and its directory has no tile for the cell. A tile here is what "we published 200k
  empty tiles" looks like from outside.
* `uncovered` — **no** published slice claims this ground. This is the probe that catches a
  bake writing cells it does not own.

Under the object layout both were "expect 404", so an `empty` probe passed for a region that
had never been baked at all.

Exits non-zero on any failure, so it can gate a bake. Add probes when you add a
slice; a slice with no probe is a slice nobody can prove.

## Whole-world first upload (local seed)

Rather than waiting a full month for the day-spread CI to trickle in global coverage,
seed the entire world once from your machine, then let the schedule keep it fresh.
CI needs no change: `bake-slice.sh` compares each slice's packed archive against the
`sha256` this seed publishes, so subsequent scheduled runs upload only slices whose tiles
actually moved — a whole slice at a time now, not a whole tile at a time (SPEC.md §11.6).

```bash
# 1. Generate the world slice list (leaf Geofabrik extracts, ~500 regions).
node scripts/gen-slices.mjs > slices.world.json

# 2. Seed everything to R2 — resumable, bounded concurrency. Hours to run.
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=walkable-tiles
JOBS=3 ./scripts/bake-all.sh slices.world.json
#   re-run to retry any failed slices (finished ones are skipped via .bake-state/)
```

Point CI at the same coverage: replace `slices.json` with `slices.world.json` (or
commit the generated list as `slices.json`) so the daily matrix refreshes the whole
world across the month.

Notes:
- **Needs `osmium-tool jq awscli` locally** (`brew install osmium-tool jq awscli`) plus Node.
- **One-time write cost.** The first upload writes every tile (~5–10 M objects) — R2
  Class-A writes at $4.50/M (1 M free) ≈ **$25–45, once** — under the OBJECT layout. Under
  archives (SPEC.md §11) the same seed is a few thousand writes and rounds to zero; the
  write count is now proportional to the number of SLICES, not to the number of cells.
  Storage/reads/egress are unchanged and are cents (see `HOSTING.md`).
- **Bandwidth + politeness.** Keep `JOBS` low (≤3–4); this pulls hundreds of extracts
  from Geofabrik. Each slice's `.pbf` is deleted after tiling.
- **A few giant leaf regions** may need more heap; `bake-slice.sh` runs Node with
  `--max-old-space-size=12288`. If one OOMs it's marked failed — split it into
  smaller Geofabrik sub-extracts in `slices.world.json` and re-run.

## App wiring

The app change is small: `walkableWaysRemote(pos)` resolves a cell through
`v4/archive/index.json` → the slice directory → a byte range, and returns the **full v4
payload** (ways + names + crossings) instead of the ways-only PostGIS RPC — which also fixes
the current gap where remote tiles carry no crossings. Overpass stays as the miss fallback.
See `SPEC.md §6` for the client half and `§11.7` for the resolution path and its measured
request cost (11 requests for a cold block, 0 for a warm one).

Ausculta already reads this layout: `apps/mobile/src/tiles/archive.ts` (format),
`resolver.ts` (transport and the two caches), `cache.ts` (the read-through, TTLs, eviction
and the prefetch ring), with the properties asserted in `evals/tiles.test.ts`.
