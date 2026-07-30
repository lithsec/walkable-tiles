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
  "ways": …, "names": …, "crossings": …,        // exactly v4's payload, plus the
  //                                               optional per-way `lit`/`access` of §10.6
  "landcover": [ { "kind": "wood", "rings": [ [ {"lat":…,"lng":…}, … ], … ] }, … ],
  "landmarks": [ { "name": "Boston Common", "lat": 42.3550, "lng": -71.0656, "kind": "park" },
                 { "name": "Wichita", "lat": 37.6889, "lng": -97.3361, "kind": "city" },
                 { "name": "Mount Timpanogos", "lat": 40.3907, "lng": -111.6457,
                   "kind": "peak", "ele": 3581 }, … ],
  "habitat":   { "cellDeg": 0.0015, "cx0": …, "cy0": …, "cols": 7, "rows": 8, "cells": "uur.ws…" }
}
```

### 10.0 Revision 2 (2026-07) — still `v: 5`, and why

Revision 2 adds eight landmark kinds (§10.2), an optional `ele` on a landmark, two optional
per-way attributes (§10.6), and **splits the `green` habitat class into `woodland` and
`greenspace`** (§10.3, §10.4). Nothing is removed and no key changes meaning, so **the
version is not bumped** — this is additive over revision 1 in exactly the way v5 was
additive over v4. A revision-1 client skips landmark kinds it does not know (its parser
already whitelists), ignores way keys it does not read, and decodes an unknown habitat
character to nothing. Three behaviour changes such a client *will* see, all degradation
rather than breakage:

- `LANDMARKS_PER_TILE` rises 3 → 6. A revision-1 client that defensively clamps at 3 keeps
  the first three kinds it RECOGNISES, which are the same parks it lists today.
- A protected area also tagged `leisure=nature_reserve` now classifies as `national_park`
  or `protected_area` instead of `nature_reserve` (§10.2 — every US national park checked
  is tagged this way). A revision-1 client skips the unknown kind and falls through.
- The habitat grid character `g` no longer appears; `w` and `p` replace it (§10.3). A
  revision-1 client reads both as unknown and the cell falls back to rural — it
  under-claims rather than mis-claims, which is why `g` is retired rather than re-spent.

Revision-1 tiles stay valid `v: 5` and parse unchanged, so the two revisions coexist on the
CDN for as long as any slice goes un-rebaked. **The reason to bake revision 2 into every
field at once is that a tile is baked whole:** a field discovered missing later costs the
entire bake again, and the bake gets an order more expensive with every slice added.

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

### 10.2 `landmarks` — at most 6 named places per tile

Only **named** features qualify; `name` is verbatim OSM. An entry is
`{name, lat, lng, kind}`, plus `ele` (integer metres) on a `peak` that carries a
parseable `ele` tag.

**Vocabulary and tier.** The `kind` whitelist, with its TIER — the first sort key inside a
tile. Matching is in this table's order, most specific tag first:

| kind | tier | OSM |
|---|---|---|
| `city`, `town` | 0 | `place=city\|town` (NODE) |
| `village`, `hamlet`, `suburb` | 1 | `place=village\|hamlet\|suburb` (NODE) |
| `peak` | 2 | `natural=peak` (NODE), with `ele` when tagged |
| `national_park` | 3 | `boundary=national_park`, **or** `boundary=protected_area` with `protect_class=2` or `protected_area=national_park` |
| `protected_area` | 3 | `boundary=protected_area` otherwise |
| `park` | 4 | `leisure=park` |
| `library` | 4 | `amenity=library` (area or NODE) |
| `cemetery` | 4 | `landuse=cemetery` |
| `nature_reserve` | 4 | `leisure=nature_reserve` |
| `common` | 4 | `leisure=common` |

The `boundary` rows sit ABOVE `leisure` deliberately. Everglades, Grand Canyon and Zion
are all tagged `boundary=protected_area` + `leisure=nature_reserve`, and **none** carries
`boundary=national_park` — a `leisure` test placed first quietly classes every US national
park as a local nature reserve. `protect_class=2` is IUCN category II ("National Park");
Grand Canyon has only `protected_area=national_park`, so both signals are needed.

**Position.** The node itself for point-mapped kinds (settlements, peaks, some libraries);
the largest part's polygon centroid for area kinds.

**Which tiles list it.** The union of two rules:

- **Proximity** — every tile whose centre is within `R` of the label point. `R` is
  `BOX_HALF_M` (1200 m) for everything except settlements, which use
  `PLACE_RADIUS_M`: city **8000 m**, town **4000 m**, village/suburb **2000 m**,
  hamlet **1200 m**. This is proximity to the settlement's centre NODE and **is not a
  claim of membership** — OSM maps a settlement's extent as `boundary=administrative`,
  which this bake deliberately does not carry (§10, filter note). A flat 1200 m would make
  a settlement almost always a false negative: a walk can stay inside a city all day and
  never pass within 1.2 km of its centre node.
- **Containment** — for area kinds, every tile whose centre falls inside the feature's own
  (simplified, even-odd) rings. Proximity alone is right for a town park, smaller than the
  1200 m box, and useless for a national park: measured on the live v5 bake, the tile over
  Royal Palm — 6 km inside Everglades National Park — carries **zero** landmarks, even
  though the park is already in the osmium filter. It was never missing; it was only ever
  listed within 1200 m of a centroid that sits in open sawgrass. Bounded at
  `LM_COVER_MAX_CELLS` = 200,000 candidate tiles (~a 500 km square); a polygon past that is
  a mapping artefact, not a place, and falls back to proximity alone.

**Ordering and truncation.** Deduped on `(kind, name)` keeping the largest footprint, then
sorted by **tier ascending, footprint area descending, distance to the tile centre
ascending, name ascending**, and truncated to **6** (`LANDMARKS_PER_TILE`). At most
**2** (`SETTLEMENTS_PER_TILE`) of those may be tier 0/1.

Tier before area is the whole point of the ordering: area alone is exactly backwards for
the kinds this revision adds. A settlement node has NO footprint, so it sorted last and was
truncated away — measured on the live bake, downtown Wichita's three slots hold three city
parks, so `Wichita` would never have shipped from the cell it names. A national park has an
enormous footprint, so it would have taken slot 1 in every tile it covers. Within a tier the
order is unchanged from revision 1 (area descending), so the pre-existing kinds keep their
relative ranking; distance replaces name as the first tiebreak, which is the only
meaningful key for the zero-area point kinds.

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
within a row: index `= (cy−cy0)·cols + (cx−cx0)`. Because 20/3 is not an integer, edge
spawn cells straddle tile boundaries and appear in two (or four) tiles'
grids — the class is a function of the cell alone, so overlapping tiles agree.

Codes:

| char | class | |
|---|---|---|
| `u` | urban | |
| `r` | residential | |
| `w` | woodland | revision 2 |
| `s` | greenspace | revision 2 |
| `.` | rural | the default |
| `m` | mountain | **RESERVED, not emitted.** The client vocabulary declares it; the classifier needs an elevation source (Copernicus GLO-30 relief) this bake does not have. Revision 2's named peaks with `ele` are its calibration set. |
| `g` | ~~green~~ | **RETIRED in revision 2.** Never re-spent. |

**`g` is retired, not reused, and that is a compatibility decision.** Revision 1's `g` meant
"wood or green" and revision 2 splits that in two (§10.4). Re-spending the character would
make a revision-1 tile and a revision-2 tile disagree about what `g` claims, and an old
client would silently read every `greenspace` cell as woodland — a wrong answer where the
whole grid's job is to be a right one.

What each side sees across the boundary:

- **An old client reading a revision-2 tile** decodes `w` and `p` as unknown characters.
  Ausculta's `HABITAT_CODE` maps an unknown character to nothing and the cell falls back to
  rural, so an old app reads every wooded or park cell as rural. That is quiet degradation
  and correct abstention — it under-claims rather than mis-claims.
- **A new client reading a revision-1 tile** does **not** map `g` to either successor. The
  client's `HABITAT_CODE` omits it deliberately, so it decodes to nothing and the cell falls
  back to rural: `g` might have meant either, and the whole reason for the split is that the
  two are not interchangeable, so picking one would be exactly the fabrication the split
  exists to end. Legacy cells go quiet rather than wrong. After this re-bake no tile on the
  CDN contains `g` at all (all five live v5 slices are re-baked), so the only `g` left is in
  on-device caches, for at most their 30-day TTL.

### 10.4 Habitat classifier — v2, normative

The vocabulary is Ausculta's `packages/content/src/habitat.ts` exactly:
`urban | residential | woodland | greenspace | rural` (plus `mountain`, which that module
declares and this bake does not yet produce — see §10.3). Ausculta's server re-derives spawns
from these classes, so the classification must be reproducible from this spec
+ the OSM extract. It is a pure function of two per-cell aggregates:

**Way length per group.** Each walkable-way segment (the same osmium-filtered
ways v4 ships) is cut into `ceil(len/20 m)` equal steps and each step's length
is credited to the spawn cell containing the step **midpoint** (`HAB_STEP_M`).
Groups: `res` = `residential|living_street`, `foot` =
`footway|path|pedestrian|steps|track`, `road` = `service|unclassified`.
(`living_street` counts as `res` here even though v4's `foot` flag includes
it — habitat cares that people live on it.)

**Cover.** Each cell has a 2×2 sample grid (at 0.25/0.75 of the cell in
each axis); a sample is covered when it falls inside a landcover polygon
(post-simplification, post-2000 m² threshold, even-odd over the polygon's rings). Revision
2 keeps **two** sample masks rather than one: `woodFrac` counts samples inside a `wood`
polygon, `greenFrac` samples inside a `green` one, each / 4. A sample inside both — a
wooded corner of a park — sets both. `coverFrac` is the count of samples inside **either**,
/ 4, which is bit-for-bit revision 1's single `greenFrac`.

Rules apply **in order**, first match wins (`all = foot + res + road`;
thresholds are the `HAB` constant in `tile.mjs`):

1. **green family** if `coverFrac ≥ 0.5` **and** `foot > 0` — trackless forest is
   rural; a wood with a path through it is walkable green. (Without the `foot`
   guard, ~40% of Massachusetts' green cells were unreachable forest.)
2. **urban** if `all ≥ 900 m` and `res/all ≤ 0.35`
3. **green family** if `foot ≥ 120 m` and `foot/all ≥ 0.7`
4. **residential** if `res ≥ 120 m` and `res/all ≥ 0.4`
5. **rural** otherwise — including cells with no data at all (the default).

**Which green.** Rules 1 and 3 select the *family*; this selects the member, and it is
deliberately a separate question:

> **`woodland`** if `woodFrac > 0` **and** `woodFrac ≥ greenFrac`; **`greenspace`**
> otherwise.

The split is a **partition of revision 1's `green`, not a redrawing of its boundary** — the
gate is unchanged, so no cell moves into or out of the green family, and every cell that
was `green` becomes exactly one of the two. (Verified against the pre-revision tiler on a
synthetic extract: same cell set, and every non-green class byte-identical.)

`woodland` takes the tie, which is the case that actually occurs — a wooded corner of a
large park. The reason that is not merely taste: §10.1's landcover precedence is already
`water > wood > green`, so a polygon carrying **both** `natural=wood` and `leisure=park`
resolves to `wood` at the polygon layer. Letting `greenspace` win here would leave the two
layers disagreeing about the same square metre. Secondarily, tree cover is the more
distinctive fact and the more specific claim, and it is the one somebody had to map
explicitly. *This is a structural argument, not a measured one — no revision-2 bake has run,
so the sample counts that would settle it empirically do not exist yet.*

With **no** cover evidence at all — rule 3, a trail-dominated cell with nothing mapped
around it — the answer is `greenspace`. `woodland` is a claim about tree cover and there is
none to support it; `greenspace` is the weaker claim, which is the one to make when the
evidence is absent.

**Sidecar:** `out/habitat-<slice>.jsonl` — `class` is the full word
(`"woodland"` / `"greenspace"`, not the grid character) — one line per **non-rural** cell
(rural-as-default keeps it small), `{"cx":…,"cy":…,"class":"woodland"}`, sorted
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
12.3 MB / 277k non-rural cells (116k green, 152k residential, 9k urban) — revision 1
numbers; revision 2 partitions that 116k into woodland + greenspace without changing the
total, so the sidecar size is unchanged.
Tiling cost: +85 s over the 60 s v4-only bake for the whole state. If a later
slice blows the ~3× p95 budget, tighten `SIMPLIFY_TOL_M` / `LC_MIN_AREA_M2`
before touching the format.

**Revision 2's delta is not yet measured** (the table above is revision 1, and the honest
statement is that no revision-2 bake has run). The arithmetic, to be replaced by
measurement after the first one:

- Three more landmark slots at ~70 B each is ~210 B on an 11.3 KB p50 tile, **+1.9%**.
- `lit`/`access` add ~12–24 B to a *tagged* way only. US `lit` coverage is thin and
  `access=private` is common on service roads; even at a generous 10% of ways in a
  2,000-way downtown tile that is ~4 KB pre-gzip against a 600 KB payload, and it gzips
  against a highly repetitive key set.
- **New landmark-only tiles are the item to watch.** Containment binning (§10.2) writes a
  v5 tile for every cell inside a national park or protected area, including cells with no
  ways, no landcover and nothing else. A synthetic 0.4° × 0.2° park produced 800 such
  tiles at ~150 B each. Utah is the stress case — roughly two-thirds federal land, much of
  it `boundary=protected_area` — where this could plausibly add ~10^5 tiles, ~15 MB and
  ~$0.45 of Class-A writes. That is the price of a national park being visible from
  anywhere inside it rather than only near its centroid.

### 10.6 Per-way attributes — `lit` and `access`

Two OPTIONAL keys on a v5 way object, alongside `points` and `foot`:

| key | type | from |
|---|---|---|
| `lit` | `true` / `false` | `lit=yes\|24/7\|sunset-sunrise\|dusk-dawn\|automatic` → `true`; `lit=no\|disused` → `false` |
| `access` | `"private"` / `"no"` / `"permissive"` | `access=` those three values, verbatim |

Both are **written only when the tag is present and unambiguous**. Anything else —
`lit=limited`, `lit=interval`, `access=destination`, `access=customers`, an unrecognised
value, or no tag at all — is **omitted**. Absent therefore means UNKNOWN and must never be
read as `false`: `lit` exists to stop street-safety routing a player down an unlit path
after dark, and a fabricated `false` is worse than a gap because the player can see a gap
and cannot see a fabrication. Absent `access` means no restriction is mapped, which is the
absence of a claim, not a claim of "public".

**These need no osmium filter line.** `tags-filter` selects OBJECTS and keeps every tag on
the ones it selects, so both tags already arrive on every way the `w/highway=` line matched.
They were never missing from the extract, only from the tiler's output.

**Why they ride on the way object rather than in a parallel array.** `names` is a parallel
array, and the obvious symmetry would be `lit`/`access` as two more. It is wrong here: the
client's seam-dedupe merge (a way at a tile boundary appears in both tiles) carries the way
OBJECT by reference and drops anything not attached to it, so a parallel array would force
a second, divergent dedupe app-side — which is exactly how a seam-duplicated way quietly
doubles a street's weight in the walk graph. Riding on the object also costs nothing for
the untagged majority, whereas a parallel array pays one slot per way either way.

**v4 is untouched.** v4's way objects are `{points, foot}`, spelled out field by field in
`tile.mjs`'s v4 write loop; neither key can reach them. Verified by re-tiling the same
input with the pre-revision tiler and diffing: `out/v4` and `hashes.json` are byte-identical.
