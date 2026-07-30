# Bake orchestration spec — GitHub Actions matrix

How the whole world gets baked on free runners, spread across the month, with
near-zero writes. Grounded in the app's real tile scheme (`TILE_DEG=0.01`,
`tileKey`, `BOX_HALF_M=1200`, v4 payload — see `README.md`).

---

## 1. Why this shape

- **Free compute.** Public repo → unlimited GitHub Actions minutes. Every slice
  is a Geofabrik country/state extract (≤ a few GB PBF), osmium streams, tiles
  flush per-cell → each job fits a free `ubuntu-latest` runner's disk. No VM, no
  AWS, no PostGIS.
- **Region-spread.** `slices.json` assigns each slice a `day` (1–28). The daily
  cron bakes only that day's slices, so a single run is small and the globe still
  refreshes monthly. Days 29–31 are folded into 28 so nothing is skipped in short
  months.
- **Parallel but bounded.** GitHub runs ~20 matrix jobs concurrently; we cap at
  16 (`max-parallel`) to leave headroom. Even the whole world in one day is
  feasible (`force_all`) — spreading is a freshness/tidiness choice, not a limit.

## 2. Workflow structure (`.github/workflows/bake.yml`)

Two jobs:

1. **`plan`** — reads `slices.json`, computes today's day-of-month, and emits the
   selected slices as a matrix via `jq` → `GITHUB_OUTPUT`. Selection precedence:
   `workflow_dispatch.slice` (one) › `force_all` (all) › `day == today`.
2. **`bake`** — `strategy.matrix` from the plan output, one runner per slice:
   install osmium, free disk, run `scripts/bake-slice.sh <url> <name>`, upload a
   log artifact. `fail-fast: false` so one bad slice never aborts the rest.

Key knobs:

- `concurrency: bake-tiles` + `cancel-in-progress: false` — never interrupt an
  in-flight upload; a new day's run queues behind an unfinished one.
- `timeout-minutes: 120` per slice — a hung download/parse is killed, not left to
  burn the run.
- `permissions: contents: read` — the workflow only needs the repo; R2 creds come
  from secrets, never the `GITHUB_TOKEN`.

## 3. Slice sizing rules

- Keep each slice ≤ ~2 GB PBF so it downloads + parses well inside the runner's
  disk and the 120 min budget. Use Geofabrik **sub-extracts** (US states, Japan
  `kanto`, France `ile-de-france`) rather than continents.
- Split any oversized country into its Geofabrik children and give them the same
  `day` (they'll run as parallel matrix entries).
- Growth is just data: add rows to `slices.json`, no workflow change. Start with
  launch metros (the sample slices), expand outward.

## 4. Boundary tiles — exactly-one-writer rule

The 1200 m box overspills the 1.1 km cell, and slices tile independently, so a
cell straddling two slices could be written twice (last-writer-wins = whichever
runner finishes last, non-deterministic).

**Rule: a slice writes a cell iff the cell _center_ falls inside that slice's
region.** Implementation in `bake-slice.sh` / `tile.mjs`:

- Each Geofabrik extract already includes a small buffer past its polygon, so a
  border slice still has the neighbor geometry needed to fill a boundary cell's
  1200 m box — it just doesn't _own_ (write) cells centered outside itself.
- Determine ownership by the slice's bounding polygon (Geofabrik ships a `.poly`
  per extract) or, as a coarse-but-safe first cut, the extract's bbox.
- Consequence: every cell is written by exactly one slice → deterministic,
  no double writes, no cross-slice race. A cell whose center sits in an un-listed
  region simply isn't baked yet → app 404 → Overpass fallback.

## 5. Diff-gated upload (keeps writes ~zero)

Inside each slice, after assembling tiles:

1. Compute a stable content hash (e.g. SHA-256 of the canonical JSON pre-gzip)
   per owned cell.
2. Fetch the slice's previous `v4/hashes/<slice>.json` from R2.
3. **PUT only cells whose hash changed** (R2 Class-A write), plus deletes for
   cells that lost all data.
4. Overwrite `v4/hashes/<slice>.json` and write the slice's stamp to
   `v4/build/<slice>.json` (timestamp, tile/changed counts, bytes). Per-slice
   files avoid a multi-runner read-modify-write race on one shared `build.json`;
   an aggregate view is just the directory listing.

Because month-over-month OSM churn is small, most slices re-upload only a handful
of tiles → Class-A writes stay negligible even re-baking the planet.

**How the changed set actually goes up.** The diff decides *which* tiles; getting
them there is a throughput problem, and the obvious shape is the wrong one. One
`aws s3 cp` per object under `xargs -P 16` measures **15.6 objects/s** on a 12-core
machine — the box saturates on Python interpreter startup, not on the network. A
first-bake slice is 100k–250k objects *per version*, so that shape is 3–5 hours of
process spawning per slice, which is also how a slice blows the workflow's
120-minute `timeout-minutes`.

Instead the changed tiles are hardlinked into a staging tree mirroring the R2
layout (`cpio -pdl`, one process, ~1,250 files/s, no bytes copied) and the tree is
handed to a single `aws s3 cp --recursive`, which reuses its own connection pool:
**160 objects/s**, a 10× improvement, same bytes and same headers. A single
recursive cp is equivalent to N individual ones precisely because every tile in a
bake takes identical metadata (`application/json`, `gzip`, 7 d).

Two properties this shape must keep:

- **`AWS_ENDPOINT_URL` stays an exported env var.** It is no longer load-bearing for
  the tile PUTs (they run in the main shell now), but the manifest and sidecar copies
  and any future child process still depend on it. A shell-function wrapper alone
  once sent every tile to `s3.auto.amazonaws.com` while the manifest copy succeeded,
  leaving a manifest that claimed tiles the bucket never received.
- **Staging is verified by counting, not by exit code.** `cpio` reports per-file
  failures on stderr and still exits 0. An empty stage feeds `cp --recursive` an
  empty tree, which uploads nothing and succeeds — reproducing that same
  manifest-claims-what-the-bucket-lacks state from the other direction. So
  `upload_version` asserts staged == changed and aborts otherwise. (This is not
  hypothetical: on macOS `mktemp -d` returns a path under the `/var` → `/private/var`
  symlink, which BSD `cpio -p` refuses to write through.)

## 6. App wiring (the client half)

Implemented in `apps/mobile/src/run/osm.ts`. The app wants everything within
`BOX_HALF_M` (1200 m) of the runner; that box spans a 2–3 cell block, so the
client fetches the covering cells and merges them (baked tiles overlap at seams,
so the same way appears in adjacent cells — deduped on endpoints + length):

```
loadTilePayload(pos, box):
  if TILES_HOST unset -> skip to PostGIS/Overpass          // env var gates the whole path
  cells = every 0.01° cell the box touches
  tiles = fetch ${TILES_HOST}/v4/<i>/<j>.json.gz for each  // bounded concurrency
          404 -> empty cell (not an error);  other non-OK -> that cell errors
  if every cell errored -> null (real miss) -> PostGIS -> Overpass
  else -> merge + dedupe ways/names/crossings
```

Chain: **pre-baked tiles → PostGIS RPC → Overpass**, first non-empty wins. Tiles
carry `names` + `crossings` (the RPC doesn't), so **remote data finally has
crossings** — the coverage map + jaywalk/crossing-safety overlays work everywhere,
not just where Overpass ran. It's a plain `fetch` (gzip auto-decoded), independent
of the dormant Supabase backend, so it works in fully-offline builds. `TILES_HOST`
is a build-time env var — unset = feature off (pure Overpass/PostGIS), so tiles
roll out per-build with no code change. The 60 d on-device `osm_cache` and
`tileKey` are unchanged.

## 7. Secrets

Four repo secrets (Settings → Secrets → Actions). Encrypted secrets are **not**
exposed to fork PRs, so they're safe in a public repo:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`

Scope the R2 API token to **object read/write on the one bucket** — the bake
needs read (hash manifests) + write (tiles), nothing account-wide.

## 8. Observability & failure

- Each slice uploads a `bakelog-<slice>` artifact (14 d retention).
- `v4/build/<slice>.json` files are the freshness dashboard: per-slice last-baked
  timestamp, tile count, changed count, total bytes.
- A failed slice just serves last-good tiles and retries on its next assigned day
  (or via `workflow_dispatch` with `slice:`). `fail-fast:false` isolates failures.
- Optional: a tiny final job that posts a summary (slices baked, tiles changed,
  bytes) to a webhook if any slice failed.

## 9. Rollout

1. Land the sample `slices.json` (launch metros), `bake-slice.sh`, `tile.mjs`.
2. `workflow_dispatch` a single slice → validate tiles match Overpass output for
   that area (spot-check a few `tileKey`s in the app behind the flag).
3. Enable the daily cron; watch `build.json` fill in over a month.
4. Flip the app flag to R2-default / Overpass-fallback per validated region.
5. Retire the PostGIS RPC once R2 covers the live footprint.

## 10. v5 tile format — landcover, landmarks, habitat (Ausculta)

Cologra ships on v4 and v4 stays byte-identical forever; v5 is baked **beside**
it, from the same single pass over the slice, for Ausculta (audio-first
creature-collection explorer). Everything in v5 is static and derived at bake
time — nothing live, ever (that's what keeps Ausculta's client/server spawn
parity possible, see §10.4).

**Additive by construction:** a v5 payload is the v4 payload (same `ways`,
`names`, `crossings`, produced by the same code path) plus three new top-level
keys, with `v: 5`. A v4 parser pointed at a v5 tile still finds its ways.
The reverse is not true — v5-only cells exist (a lake or forest with no
walkable way gets a v5 tile but no v4 tile), so v4's 404 semantics are
unchanged.

```jsonc
{
  "v": 5,
  "ways": …, "names": …, "crossings": …,        // exactly v4's payload
  "landcover": [ { "kind": "wood", "rings": [ [ {"lat":…,"lng":…}, … ], … ] }, … ],
  "landmarks": [ { "name": "Boston Common", "lat": 42.3550, "lng": -71.0656, "kind": "park" }, … ],
  "habitat":   { "cellDeg": 0.0015, "cx0": …, "cy0": …, "cols": 7, "rows": 8, "cells": "uur.g…" }
}
```

Layout mirrors v4 everywhere: tiles at `v5/<latIdx>/<lngIdx>.json.gz`, hash
manifests at `v5/hashes/<slice>.json`, plus one new slice-level artifact —
`v5/habitat/<slice>.jsonl` (locally `out/habitat-<slice>.jsonl`), the habitat
sidecar Ausculta's server ingests (§10.4). `serve-local.mjs` serves both
prefixes. All constants below live in one place at the top of `tile.mjs`.

### 10.1 `landcover` — polygons for parchment-watercolor washes

| class | OSM tags |
|---|---|
| `water` | `natural=water`, `waterway=riverbank`, `landuse=reservoir\|basin` |
| `wood` | `natural=wood`, `landuse=forest` |
| `green` | `leisure=park\|garden\|common`, `landuse=grass\|meadow\|recreation_ground\|village_green` |
| `field` | `landuse=farmland\|farmyard\|orchard` |

When a feature matches several classes, the first match in the order above
wins (`water > wood > green > field`).

Processing (values normative):

- **Simplify** every ring with Douglas-Peucker, tolerance **10 m**
  (`SIMPLIFY_TOL_M`) — recognizable at a ~500 m viewport, cheap to ship.
- **Threshold:** drop rings under **2000 m²** (`LC_MIN_AREA_M2`) before
  clipping; after clipping to a tile, drop slivers under **1000 m²**
  (`LC_MIN_CLIPPED_M2`).
- **Clip** each polygon to the tile's ±1200 m box (the same `BOX_HALF_M`
  rectangle around the cell center that bounds v4's ways).
- **Encoding:** rings are v4's `{lat,lng}` point objects, rounded to 1e-6°
  (~0.1 m); rings are **open** (closure implicit — the last point does not
  repeat the first). `rings[0]` is the outer ring, the rest are holes; render
  with the even-odd fill rule. Entries are ordered by clipped area descending,
  so big washes paint first.

### 10.2 `landmarks` — at most 3 named places per tile

Whitelist: `leisure=park` → `park`, `amenity=library` → `library`,
`landuse=cemetery` → `cemetery`, `leisure=nature_reserve` → `nature_reserve`,
`leisure=common` → `common`. Only **named** features qualify; `name` is
verbatim OSM. Position is the polygon centroid (or the node itself for
point-mapped libraries). A tile lists every whitelisted landmark within its
1200 m box, deduped on `(kind, name)`, sorted by footprint area descending
(name ascending on ties), truncated to **3** (`LANDMARKS_PER_TILE`).

### 10.3 `habitat` — per-spawn-cell class grid

The grid is Ausculta's spawn-cell grid exactly: `cellDeg = 0.0015`
(`cx = floor(lng/0.0015)`, `cy = floor(lat/0.0015)` — cx first, as in its
spawn module's `cellId`). `TILE_DEG / cellDeg = 20/3` exactly, so a tile's
spawn-cell coverage is pure integer math (**normative**, and verified to match
float arithmetic across ±90°/±180°):

```
cy0 = floor(20·latIdx / 3)      cy1 = ceil(20·(latIdx+1) / 3) − 1     rows = cy1−cy0+1  (7 or 8)
cx0 = floor(20·lngIdx / 3)      cx1 = ceil(20·(lngIdx+1) / 3) − 1     cols = cx1−cx0+1  (7 or 8)
```

`cells` is one character per spawn cell, `rows × cols` long, **row-major,
south→north** (cy ascending is the outer loop), **west→east** (cx ascending)
within a row: index `= (cy−cy0)·cols + (cx−cx0)`. Codes: `u` urban,
`r` residential, `g` green, `.` rural. Because 20/3 is not an integer, edge
spawn cells straddle tile boundaries and appear in two (or four) tiles'
grids — the class is a function of the cell alone, so overlapping tiles agree.

### 10.4 Habitat classifier — v1, normative

The vocabulary is Ausculta's `packages/content/src/habitat.ts` exactly:
`urban | residential | green | rural`. Ausculta's server re-derives spawns
from these classes, so the classification must be reproducible from this spec
+ the OSM extract. It is a pure function of two per-cell aggregates:

**Way length per group.** Each walkable-way segment (the same osmium-filtered
ways v4 ships) is cut into `ceil(len/20 m)` equal steps and each step's length
is credited to the spawn cell containing the step **midpoint** (`HAB_STEP_M`).
Groups: `res` = `residential|living_street`, `foot` =
`footway|path|pedestrian|steps|track`, `road` = `service|unclassified`.
(`living_street` counts as `res` here even though v4's `foot` flag includes
it — habitat cares that people live on it.)

**Green cover.** Each cell has a 2×2 sample grid (at 0.25/0.75 of the cell in
each axis); a sample is covered when it falls inside a `green` or `wood`
landcover polygon (post-simplification, post-2000 m² threshold, even-odd over
the polygon's rings). `greenFrac` = covered samples / 4.

Rules apply **in order**, first match wins (`all = foot + res + road`;
thresholds are the `HAB` constant in `tile.mjs`):

1. **green** if `greenFrac ≥ 0.5` **and** `foot > 0` — trackless forest is
   rural; a wood with a path through it is walkable green. (Without the `foot`
   guard, ~40% of Massachusetts' green cells were unreachable forest.)
2. **urban** if `all ≥ 900 m` and `res/all ≤ 0.35`
3. **green** if `foot ≥ 120 m` and `foot/all ≥ 0.7`
4. **residential** if `res ≥ 120 m` and `res/all ≥ 0.4`
5. **rural** otherwise — including cells with no data at all (the default).

**Sidecar:** `out/habitat-<slice>.jsonl` — one line per **non-rural** cell
(rural-as-default keeps it small), `{"cx":…,"cy":…,"class":"green"}`, sorted
by `cy` then `cx`. The exactly-one-writer rule (§4) applies at spawn-cell
granularity: a cell is emitted iff its center is inside the slice poly. (Tile
habitat grids near slice borders may include cells classified from the
extract's buffer geometry; the sidecar is the authoritative slice-owned set.)

### 10.5 Size budget

Measured on the Massachusetts slice (first v5 bake, 2026-07):

| | tiles | total | p50 | p95 | max |
|---|---|---|---|---|---|
| v4 (gz) | 24,433 | 358.2 MB | 9.8 KB | 40.5 KB | 183.4 KB |
| v5 (gz) | 24,667 | 395.6 MB | 11.3 KB | 42.7 KB | 187.4 KB |

v5 is 1.10× v4 total bytes (p50 1.15×, p95 1.05×) including 234 v5-only
landcover cells — far inside the ~3× p95 budget. The habitat sidecar is
12.3 MB / 277k non-rural cells (116k green, 152k residential, 9k urban).
Tiling cost: +85 s over the 60 s v4-only bake for the whole state. If a later
slice blows the ~3× p95 budget, tighten `SIMPLIFY_TOL_M` / `LC_MIN_AREA_M2`
before touching the format.
