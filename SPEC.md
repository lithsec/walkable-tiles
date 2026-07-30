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

Revision 2 adds eight landmark kinds (§10.2), an optional `ele` and an optional `anchor` on
a landmark, two optional per-way attributes (§10.6), and **splits the `green` habitat class
into `woodland` and `greenspace`** (§10.3, §10.4). Nothing is removed and no key changes
meaning, so **the version is not bumped** — this is additive over revision 1 in exactly the
way v5 was additive over v4.

**Revision 3 (2026-07-30) is elevation, and it is additive in the same way.** The `m`
(mountain) grid character revision 2 reserved is now EMITTED, its atlas bit is now SET, and
the `peak` significance score is now computed from local relief rather than from height
above sea level (§10.4, §10.8, §10.9). No key changes meaning and nothing is removed; a
revision-2 client decodes `m` as an unknown character and the cell falls back to rural,
which is the same quiet degradation `w`/`s` already rely on. There is no revision-3-only
field to skip. The version stays `v: 5`. A revision-1 client skips landmark kinds it does not know (its
parser already whitelists), ignores way keys it does not read, and decodes an unknown
habitat character to nothing. Four behaviour changes such a client *will* see, all
degradation rather than breakage:

- `LANDMARKS_PER_TILE` rises 3 → 6. A revision-1 client that defensively clamps at 3 keeps
  the first three kinds it RECOGNISES, which are the same parks it lists today.
- A protected area also tagged `leisure=nature_reserve` now classifies as `national_park`
  or `protected_area` instead of `nature_reserve` (§10.2 — every US national park checked
  is tagged this way). A revision-1 client skips the unknown kind and falls through.
- **`national_park` now needs a footprint, not only a tag** (§10.2), so features a
  revision-1 tile calls a national park mostly become `park` or `nature_reserve`. Measured:
  the District's 37 promotions and Vermont's 3 all fall, to **zero** in both, which is the
  true count for a city of NPS administrative units and a state with a national *forest*.
  This is the one revision-2 change that MOVES features between kinds rather than adding
  one, and it moves them toward the weaker, truer claim.
- The habitat grid character `g` no longer appears; `w` and `p` replace it (§10.3). A
  revision-1 client reads both as unknown and the cell falls back to rural — it
  under-claims rather than mis-claims, which is why `g` is retired rather than re-spent.

Revision-1 tiles stay valid `v: 5` and parse unchanged, so the two revisions coexist on the
CDN for as long as any slice goes un-rebaked. **The reason to bake revision 2 into every
field at once is that a tile is baked whole:** a field discovered missing later costs the
entire bake again, and the bake gets an order more expensive with every slice added.

Layout mirrors v4 everywhere: tiles at `v5/<latIdx>/<lngIdx>.json.gz`, hash
manifests at `v5/hashes/<slice>.json`, plus three slice-level artifacts —
`v5/habitat/<slice>.jsonl` (locally `out/habitat-<slice>.jsonl`), the habitat
sidecar Ausculta's **server** ingests (§10.4); `v5/atlas/<slice>.json`
(locally `out/atlas-<slice>.json`), the ~1 KB habitat atlas its **client** holds
whole (§10.7); and `v5/landmarks/<slice>.jsonl` (locally
`out/landmarks-<slice>.jsonl`), the landmark **anchor** sidecar the server
ingests (§10.8). `serve-local.mjs` serves both tile prefixes. All constants below
live in one place at the top of `tile.mjs`.

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
parseable `ele` tag, plus `anchor: true` when this landmark is in the slice's anchor set
(§10.8). `anchor` is **written only when true**; absent means "not an anchor as far as
this tile knows", which is a weaker statement than it looks — see §10.8.

**Vocabulary and tier.** The `kind` whitelist, with its TIER — the second sort key inside a
tile. Matching is in this table's order, most specific tag first:

| kind | tier | OSM |
|---|---|---|
| `city`, `town` | 0 | `place=city\|town` (NODE) |
| `village`, `hamlet`, `suburb` | 1 | `place=village\|hamlet\|suburb` (NODE) |
| `peak` | 2 | `natural=peak` (NODE), with `ele` when tagged |
| `national_park` | 3 | (`boundary=national_park`, **or** `boundary=protected_area` with `protect_class=2` or `protected_area=national_park`) **and footprint ≥ `NP_MIN_AREA_M2` (5×10⁷ m²)** |
| `protected_area` | 3 | `boundary=protected_area` otherwise |
| `park` | 4 | `leisure=park` |
| `library` | 4 | `amenity=library` (area or NODE) |
| `cemetery` | 4 | `landuse=cemetery` |
| `nature_reserve` | 4 | `leisure=nature_reserve` |
| `common` | 4 | `leisure=common` |
| `protected_area` | 3 | `boundary=national_park` that failed the area test and matched nothing else |

The `boundary` rows sit ABOVE `leisure` deliberately. Everglades, Grand Canyon and Zion
are all tagged `boundary=protected_area` + `leisure=nature_reserve`, and **none** carries
`boundary=national_park` — a `leisure` test placed first quietly classes every US national
park as a local nature reserve. `protect_class=2` is IUCN category II ("National Park");
Grand Canyon has only `protected_area=national_park`, so both signals are needed.

**`national_park` needs a size as well as a tag, and the tags alone are worthless.**
Measured on the district-of-columbia trial bake, 2026-07-30: the tag rule promoted **37**
features, **all** of them `boundary=national_park`, and they are Dupont Circle (9,000 m²),
Folger Park (7,000 m²), the Vietnam Veterans Memorial (9,000 m²) and "Anacostia Park
Section D" (204,000 m²). `boundary=national_park` is an *administrative* tag: in the US the
National Park Service puts it on everything it operates, down to a traffic circle.
`protect_class=2` fails in the other direction — on the vermont trial it promoted three
**state** parks (Niquette Bay, Mount Philo, Smuggler's Notch), and West Potomac Park
carries it too.

So a tag is necessary and nowhere near sufficient, and **area is the only lever that
generalises past one country's tagging habits**. 5×10⁷ m² is roughly a 7 km square — the
smallest thing that reads as somewhere you travel to and spend a day in — and it is 7× the
largest NPS unit in the District (Rock Creek Park, 7.2 km²), so it is not tuned to squeak
past one measurement. After the gate, `national_park` counts **0 in the District and 0 in
Vermont**, which is the true answer for both: the District has NPS units and Vermont has a
national *forest*.

**What a refused feature becomes depends on which tag made the claim**, and the two are
genuinely different:

- `boundary=protected_area` says "protected area" *independently* of any national-park
  claim, so a refused promotion leaves it exactly where it was. Vermont's three state parks
  land on `protected_area`, where they belong. This row is unchanged.
- `boundary=national_park` **is** the claim and says nothing else, so refusing it means the
  tag carries no weight and whatever else the feature is tagged describes it better. Every
  NPS unit in the District also carries `leisure=park`, so "Anacostia Park Section D"
  becomes a `park` — which is what it is. Rock Creek Park, tagged `leisure=nature_reserve`,
  becomes a `nature_reserve`. The final table row catches the handful with no other tag
  (memorials) so that nothing **named** is silently dropped.

**What the threshold costs, named.** Hot Springs NP (22 km²) and Gateway Arch NP (0.75 km²)
will read as `park`/`protected_area`. And area cannot separate a National Park from a
National Recreation Area of the same size — Golden Gate NRA (330 km²) will read as one.
Both are accepted: the kind's promise is about **scale**, not about a US federal
designation, and neither is a lie about the ground the way "Dupont Circle, National Park"
is. Neither is measured here; both are from published acreage.

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
sorted by **anchor first, tier ascending, footprint area descending, distance to the tile
centre ascending, name ascending**, and truncated to **6** (`LANDMARKS_PER_TILE`). At most
**2** (`SETTLEMENTS_PER_TILE`) of those may be tier 0/1.

Anchors sort ahead of tier because the tile is where a client *learns an anchor exists*, so
an anchor truncated out of its own tile is an anchor nobody can ever spawn at. It costs
almost nothing: there is at most one anchor per 0.5° cell (§10.8), so a 1.2 km tile
carrying two is one sitting on a cell corner, and five slots remain either way.

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
| `m` | mountain | revision 3 — regional relief from Copernicus GLO-30 (§10.4, §10.9) |
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

### 10.4 Habitat classifier — v3, normative

The vocabulary is Ausculta's `packages/content/src/habitat.ts` exactly:
`mountain | urban | residential | woodland | greenspace | rural`. Ausculta's server
re-derives spawns from these classes, so the classification must be reproducible from this
spec + the OSM extract **and, since revision 3, one published elevation product** (§10.9).
It is a pure function of three per-cell aggregates:

**Way length per group.** Each walkable-way segment (the same osmium-filtered
ways v4 ships) is cut into `ceil(len/20 m)` equal steps and each step's length
is credited to the spawn cell containing the step **midpoint** (`HAB_STEP_M`).
Groups: `res` = `residential|living_street`, `foot` =
`footway|path|pedestrian|steps|track`, `road` = `service|unclassified`.
(`living_street` counts as `res` here even though v4's `foot` flag includes
it — habitat cares that people live on it.)

**Regional relief.** Revision 3's addition, and the only input that is not in the OSM
extract. Fully specified in the block below, because the whole `mountain` class rests on it
and a plpgsql port has to reproduce it post for post.

**Cover.** Each cell has a 2×2 sample grid (at 0.25/0.75 of the cell in
each axis); a sample is covered when it falls inside a landcover polygon
(post-simplification, post-2000 m² threshold, even-odd over the polygon's rings). Revision
2 keeps **two** sample masks rather than one: `woodFrac` counts samples inside a `wood`
polygon, `greenFrac` samples inside a `green` one, each / 4. A sample inside both — a
wooded corner of a park — sets both. `coverFrac` is the count of samples inside **either**,
/ 4, which is bit-for-bit revision 1's single `greenFrac`.

Rules apply **in order**, first match wins (`all = foot + res + road`;
thresholds are the `HAB` and `MOUNTAIN_*` constants in `tile.mjs`):

1. **mountain** if `all > 0` **and** `relief ≥ 500 m` — revision 3. `relief` is the
   regional relief defined below; a missing relief never matches (abstention).
2. **green family** if `coverFrac ≥ 0.5` **and** `foot > 0` — trackless forest is
   rural; a wood with a path through it is walkable green. (Without the `foot`
   guard, ~40% of Massachusetts' green cells were unreachable forest.)
3. **urban** if `all ≥ 900 m` and `res/all ≤ 0.35`
4. **green family** if `foot ≥ 120 m` and `foot/all ≥ 0.7`
5. **residential** if `res ≥ 120 m` and `res/all ≥ 0.4`
6. **rural** otherwise — including cells with no data at all (the default).

**Mountain claims first**, because regional relief is the coarsest and most stable fact
about a cell: a wooded mountainside is a mountain and a lake in a corrie is a mountain. The
finer classes describe what is ON the ground; this one describes the ground. The cost is
stated rather than hidden — measured on the vermont trial bake, 2026-07-30, mountain takes
cells from every other class and roughly halves the green family in a mountainous state:

| vermont, of 1,266,781 distinct spawn cells | before (revision 2) | after (revision 3) |
|---|---|---|
| rural | 90.4% | 86.2% |
| **mountain** | — | **8.8%** |
| residential | 4.5% | 2.7% |
| woodland | 3.8% | 1.4% |
| greenspace | 1.3% | 0.8% |
| urban | 0.04% | 0.04% |

The District of Columbia is a **strict no-op**: 38.4% rural / 30.9% urban / 12.4%
greenspace / 9.3% woodland / 9.0% residential before and after, `mountain` 0.0%, and its
v5 hash manifest is byte-identical across the change. Its 17 named "peaks" are 28–123 m
city hills and its highest regional relief anywhere is 144 m, a factor of 3.5 below the
threshold — which is what makes it the sharpest available test that the rule does not
over-claim.

`all > 0` is the same guard as the green rule's `foot > 0`, at the strength this class
needs. Spawns snap to walkable ways, so a cell with no walkable way of any kind places
nothing, and classifying it would put a creature where nobody can stand. It is `all` and
not `foot` because a mountain town has streets and a creature that lives there is welcome
to them — that IS the "a city in the mountains counts" case.

#### Regional relief — normative, and the whole of the `mountain` rule

`relief(cx, cy)` is the elevation range over a **disc of radius 5,000 m** centred on the
spawn cell, sampled at one DEM post per spawn cell.

**The sample.** One elevation per spawn cell: the Copernicus GLO-30 post nearest the cell
centre (§10.9). The post index is exact integer arithmetic, never a rounded float:

```
kx = floor(((2·cx + 1)·3·W + 2000) / 4000)      W = the DEM tile's COLUMNS per degree
ky = floor(((2·cy + 1)·3·3600 + 2000) / 4000)       (3600, 2400, 1800 or 1200 — §10.9)
```

Both are `round((c + 0.5)·0.0015·posts_per_degree)` evaluated on the exact rational. The tie
is real and frequent, not hypothetical: at `W = 3600` the cell centre lands exactly halfway
between two posts for one cell in five (`cx ≡ 2 mod 5`), and which one a float lands on is
decided by whether `0.0015·3600`'s binary representation sits above or below `5.4`. The
integer form is round-half-up and is identical in JS, in plpgsql and by hand.

**The window.** For a slice, let `cellNS = 0.0015 · 111320 = 166.98 m` and
`cellEW = cellNS · cos(latMid)`, where `latMid` is the latitude of the middle row of the
grid being classified. Then

```
ry     = ceil(5000 / cellNS)                                     = 30
rx[dy] = floor(sqrt(5000² − (dy·cellNS)²) / cellEW)   for 0 ≤ dy ≤ ry, and −1 when dy·cellNS > 5000
```

and the window is every cell `(cx + dx, cy + dy)` with `|dy| ≤ ry` and `|dx| ≤ rx[|dy|]`.
`relief = max − min` of the sampled elevations over that window, ignoring cells whose own
sample is missing.

Three choices in that, each load-bearing:

- **A disc, not a square.** A square of half-width R reaches R·√2 into its corners. Measured
  on Vermont at R = 5 km and a 450 m threshold, the square calls 59.2% of spawn cells
  mountain and the disc calls 50.3% — the corner is a 41% longer reach in the direction of
  whatever the nearest mountain happens to be, not a rounding error.
- **Columns are latitude-corrected, rows are not.** A 0.0015° cell is 167 m north-south
  everywhere and 167·cos(lat) m east-west. A window counted in cells rather than metres
  would shrink to 2.3 km east-west in Swedish Lapland, which is the exact case ("a city IN
  the mountains counts") the threshold was calibrated on.
- **`latMid` is evaluated ONCE per grid, not per row.** A slice spans a few degrees and cos
  changes the column count by a few percent across it. Per-row evaluation would put a float
  comparison at every row boundary; per-grid makes the window a stated property of the
  slice, printed in the bake log (`[tile] relief: … 30 rows x 41 cols at the widest`).

**The threshold is 500 m,** and it is a calibration, not a measurement. The definition was
settled by three cases — a city IN the mountains counts, a big hill inside a city does not,
the Rockies count — which between them rule out absolute elevation (a Swedish fjäll town
sits lower than flat Denver at 1,600 m) and slope (a city hill is the steepest thing for
miles; a Rockies valley floor is flat). What separates them is the RADIUS at which relief is
measured. 5 km is where the separation is widest on real terrain: measured on Vermont, at
4 km the mountain village of Stowe scores 466 m and the rolling Northeast Kingdom hills at
Island Pond score 403 — no gap — and at 6 km Montpelier climbs to 345 m and erodes it from
the other side. At 5 km the valley towns run 111–458 m and the mountain towns run 568–1074,
and nothing lands in between. 500 m is the top of the 400–500 m band originally proposed,
because 450 admits Island Pond.

Checked worldwide against the same disc, 2026-07-30 (metres of relief):

```
Denver 88   Stockholm 90   Boston Common 70   Phoenix 57   Amsterdam 50   Miami 26
Colorado Springs 223   Sheffield 246 (England's steepest city)   Flagstaff 270   Kiruna 338
──────────────────────────────── threshold 500 ────────────────────────────────
Salt Lake City downtown 528   Leadville 726   Estes Park 780 (a Rockies VALLEY FLOOR)
Keswick 787   Boulder 868   Björkliden 956   Åre 1044 (the fjäll town)   Alta 1234
Provo 1371   Zermatt 2132   Chamonix 2603
```

Flagstaff (270 m) and Kathmandu (455 m) fall below, and that is the honest cost: both sit on
a plateau or a valley floor whose mountains are 10–15 km away, which is further than a walk.

**Where the DEM has no coverage, ABSTAIN — never guess.** The archive publishes no tile for
open ocean and none above its northern limit. A cell whose OWN sample is missing has
`relief = undefined` and rule 1 cannot match, so it falls through to rules 2–6 exactly as a
revision-2 cell would; it is never `mountain` and never any other class it would not
otherwise have been. A window that merely CLIPS a missing tile — every coastal mountain —
still has land in it and still has a relief, computed over the samples that exist. The two
cases are different on purpose: an unmeasured cell is not a flat cell, but a partly
unmeasured window is still a measured window.

The same rule covers a bake run with no elevation source at all (`DEM_DISABLE=1`): every
relief is missing, no cell is `mountain`, and the bake prints a banner saying so, because
"no mountains anywhere" and "no mountains here" are the same output and only one is true.

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
- **Revision 3 (elevation) adds NO bytes and rewrites a third of a mountain state.**
  Measured on the trial bakes, 2026-07-30: tile *counts* are unchanged (188 and 28,445), the
  atlas is unchanged at 209 B and 693 B, and the habitat sidecar grows only because
  `mountain` is non-rural and therefore listed — vermont 5.6 MB → **7.8 MB**, 122,108 →
  174,379 lines. What changes is the RE-UPLOAD SET: **0 of the District's 188 v5 tiles** (it
  has no mountain and its anchor is unchanged, so the bake is byte-identical) and **10,442 of
  vermont's 28,445 (36.7%)**, of which 10,423 carry at least one `m`. A slice with no relief
  costs nothing to re-bake; a mountainous one costs a third of its tiles.

- **The anchor flag and sidecar (§10.8) are free.** Measured on the trial bakes,
  2026-07-30: `anchor: true` costs **+83 B** across the District's 188 v5 tiles and
  **+17,756 B** across Vermont's 28,445 — 0.0005% and 0.012% of v5 bytes — because there
  are 1 and 12 anchors respectively. The sidecars are 1 and 12 lines. Tile *counts* are
  unchanged in both slices (188 and 28,445 before and after); what does change is the
  re-upload set, since `national_park` reclassification and the anchor-first ordering
  rewrite **70 of 188** District tiles and **1,891 of 28,445** Vermont tiles.

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

### 10.7 `atlas` — where a habitat class OCCURS, coarsely (Ausculta)

Habitat affinity is authored on every Ausculta creature and today it is **invisible**: a
player in a city may never meet a woodland creature and is never told why. The sentence
this artifact exists to make possible is *"Mount Mansfield is not too far away — you might
find mountainous creatures there."* Answering it needs to know **which habitat classes
occur roughly where**, and nothing like per-cell resolution: Vermont's per-cell habitat
sidecar is 5.3 MB and the same question answered at ~10 km is **693 bytes**.

**It is a shipped static file, and that is a privacy decision, not a size one.** Ausculta's
tile prefetch (`apps/mobile/src/tiles/cache.ts`) derives its request set from the CELL
INDEX and never the raw position, and fires the whole neighbour ring on cell entry in
sorted `(i, j)` order rather than nearest-boundary-first — so that everyone standing
anywhere in a ~1.1 km cell emits byte-identical URLs, and request ORDER cannot reveal which
way somebody is walking. *"What habitat is near me"* asked as a **query** throws all of
that away in a single call, and worse: the request's very existence discloses a position
and an intent, and no amount of care on the server side unsends it. An atlas every player
already holds sidesteps the problem completely — the answer is computed on-device from data
nobody had to ask for, and there is no request to observe. A whole state is under a
kilobyte, so the entire United States is ~50 KB, small enough to ship inside the app binary
if even the one CDN fetch is ever unwanted.

Layout: `v5/atlas/<slice>.json` (locally `out/atlas-<slice>.json`), one object, no gzip —
at this size the HTTP round-trip dominates and gzip would only cost a decode.

**Blocks (normative).** A block is `blockCells = 64` × 64 spawn cells:

```
bx = floor(cx / 64)      by = floor(cy / 64)          floor toward −inf, NOT truncation
```

64 × 0.0015° = **0.096°**, ≈ 10.7 km north–south and 0.096°·cos(lat) east–west (7.7 km at
Vermont's 43.9°, 8.3 km at DC's 38.9°). Block `(bx, by)` spans
`lng ∈ [bx·0.096, (bx+1)·0.096)`, `lat ∈ [by·0.096, (by+1)·0.096)`.

**Why 64 spawn cells and not 0.1°.** `0.1 / 0.0015 = 66.67`: a 0.1° block edge cuts
*through* spawn cells, so which block a cell belongs to would depend on float rounding of
the cell's centre — and Ausculta's server re-derives from this spec in plpgsql, where a
disagreement of one block is a creature offered in the wrong place. 64 is exact, is a power
of two, keeps the whole index in integers, and makes the atlas a strict coarsening of the
*same* grid as §10.3 and §10.4 rather than a third coordinate system. The size is a trade
against precision: bigger blocks are a smaller file and a vaguer "about 40 km north".

**Encoding (normative).** One 6-bit class-occurrence mask per block, one **base64url**
character per mask, over a **dense raster** of the slice's block bounding box:

| bit | value | class |
|---|---|---|
| 0 | 1 | `urban` |
| 1 | 2 | `residential` |
| 2 | 4 | `woodland` |
| 3 | 8 | `greenspace` |
| 4 | 16 | `mountain` — set as of revision 3 (§10.4) |
| 5 | 32 | `rural` |

```jsonc
{
  "v": 1, "slice": "vermont",
  "cellDeg": 0.0015, "blockCells": 64,
  "bx0": -765, "by0": 445, "cols": 21, "rows": 24,
  "classes": ["urban","residential","woodland","greenspace","mountain","rural"],  // index i is bit 1<<i
  "blocks": "…504 base64url characters…"
}
```

`blocks` is `rows × cols` characters, **row-major, south→north** (`by` ascending is the
outer loop), **west→east** within a row — the same order as §10.3's per-cell grid, one zoom
out, so there is no second convention to learn. Index `= (by−by0)·cols + (bx−bx0)`.
Alphabet is `A–Z a–z 0–9 - _` at indices 0–63; base64url rather than standard base64
because `-`/`_` need no escaping in a JSON string, a URL path or a shell, whereas a `/`
invites a `\/` from a defensive encoder and the raster stops round-tripping byte-for-byte.
Six bits is exactly the class vocabulary's width, so a mask never needs a second character.

Dense rather than a sparse `{blockKey: mask}` map: a JSON object entry costs ~20 B against
1 B for a raster slot and a state's bbox is far more than 5% occupied (Vermont, a diagonal
wedge, is 346/504 = 69%), so sparse loses by an order — and the query this exists to serve
is *"walk outward from my block until one has bit X"*, which over a raster is index
arithmetic with no hashing and no allocation.

**Mask 0 means NO DATA — not "empty land".** It says this slice owns no classified spawn
cell in that block. The block may be ocean, or it may be the next state and densely urban.
A consumer that reads 0 as `rural` fabricates a wilderness out of a state line, which is
the same abstention failure §10.6's absent `lit` exists to prevent. Off-raster is the same
answer as mask 0.

**Derivation (normative).** From the **slice-owned spawn cells** — §4's exactly-one-writer
rule at spawn-cell granularity, cell *centre* inside the slice poly — classified by §10.4,
in the same pass that writes the habitat sidecar. **Never from the per-tile habitat
grids:** those include cells classified from the buffer geometry a Geofabrik extract
carries from its neighbours, which reads Washington DC as 38% rural, a fact about Virginia
and Maryland rather than about DC. A block's bit is set iff **at least one** owned cell in
it has that class.

The atlas records `rural`; the sidecar (§10.4) omits it. Not an inconsistency — the two pay
for it differently. The sidecar is one *line* per cell and rural is the default, so listing
it would multiply a 5 MB file by ten to say "nothing here". The atlas is a fixed-size
raster where rural costs one *bit* that is already allocated, and without it the atlas could
not answer "where is rural" at all — which in Vermont is 90% of the state and the single
most likely habitat a player is standing in.

**Occurrence, not dominance, and the noise floor that comes with it.** A bit means "at
least one 167 m spawn cell", so one lone crossroads can make an 8 × 11 km block claim
`urban`. Measured on Vermont: of the 54 blocks claiming urban, **16 (29.6%) rest on a
single spawn cell**; woodland and greenspace are far steadier at 2.8% and 3.6%.
`inspect-bake.mjs` prints this ratio per class precisely because it is the number that
decides whether a minimum-cell threshold is wanted, and that decision has deliberately
**not** been taken here — occurrence is the semantics the feature asks for ("could a
woodland creature be there at all"), and a threshold would silently delete real small
woods. A consumer that needs confidence should prefer a class with a low thin-block ratio,
or wait for a threshold to be specified.

**Measured, revision 3 (2026-07-30, `--trial`, nothing uploaded):** vermont's raster is
unchanged at 693 B — a mountain bit costs nothing, because the raster is dense and the bit
was already allocated. 228 of vermont's 346 occupied blocks (65.9%) now claim `mountain`,
against 226 for `woodland`; 3 of those rest on a single spawn cell (1.3%, the steadiest of
any class — a 5 km relief window does not produce isolated cells the way one crossroads
produces an isolated `urban`). The District claims `mountain` in **0** of its 6 blocks.

**Measured, first bake (2026-07, `--trial`, nothing uploaded):**

| slice | file | occupied blocks | raster | B / occupied block |
|---|---|---|---|---|
| vermont | **693 B** | 346 | 21 × 24 = 504 | 2.0 |
| district-of-columbia | **209 B** | 6 | 3 × 3 = 9 | 34.8 |

Both are dominated by the ~180 B header at DC's size, which is the honest shape of the
trade: the atlas is cheap per block and the fixed cost only matters for a slice smaller
than a few blocks. **DC is smaller than 3 blocks across, and all 6 of its occupied blocks
carry all 5 classes** — the atlas's truthful answer inside DC is "everything is here", and
the feature's answer there is "you are already in it". Vermont is where it says something:
54 blocks with urban against 346 with rural, urban present in the blocks containing
Burlington, Montpelier, Rutland and Brattleboro and absent from the blocks containing
Mount Mansfield and Killington Peak, which both carry `woodland`.

**Verification.** `inspect-bake.mjs` cross-checks the atlas against the habitat sidecar
**by value**, block for block: every non-rural bit the sidecar's cells imply must be set in
the atlas and no non-rural bit may be set without a sidecar cell backing it. `mountain` is
inside that check as of revision 3 — it was skipped while the bit could only ever be 0, and
leaving it skipped would have made the one new bit the only unverified one. An atlas built
from the tile grids instead would disagree exactly at a state line, and `typeof atlas ===
'object'` would never notice. Both trial slices report `AGREES — 0 missing bits, 0 unbacked
bits, 0 sidecar blocks off-raster`.

**How a client answers "where is the nearest woodland".** Read `blocks`, find your own
block from your `(cx, cy)`, and walk outward in rings of increasing Chebyshev radius until
a block has the bit. Distance is `ring · 0.096°` in the relevant axis, which at ~10 km
granularity supports "about 30 km north-east" and nothing finer — say it that loosely.
Nothing is fetched, so nothing is disclosed.

### 10.8 `landmarks` sidecar — the slice's ANCHOR set (Ausculta)

`v5/landmarks/<slice>.jsonl` (locally `out/landmarks-<slice>.jsonl`). One line per
**distinct anchor**, sorted by `key` ascending:

```jsonc
{"key":"peak@44543947,-72814310","kind":"peak","lat":44.543947,"lng":-72.81431,"ele":1340,"name":"Mount Mansfield"}
```

`ele` is present only when the anchor is a `peak` carrying one. `name` is here and is
deliberately **not** in the server's table sketch (`docs/LANDMARK-SPAWNS.md` Option A): the
sidecar is the only artifact outside the tiles holding the key→name mapping, and an
operator reading `peak@44543947,-72814310` in a log needs to be able to tell it is Mount
Mansfield without re-baking a state.

This is the artifact that makes a landmark creature **bankable**. Ausculta's `record_claim`
is the only write path to `claims` and it re-derives every spawn; with no anchor row it
cannot verify a landmark seed, and an unverifiable claim is a creature the player finds,
records and then loses at sync. The full argument, and the two alternatives that were
rejected, are in `docs/LANDMARK-SPAWNS.md`.

**Three requirements, all normative.**

1. **One line per DISTINCT anchor, never one per tile listing.** Proximity and containment
   binning list the same feature from every tile it touches: measured on the
   district-of-columbia trial, 983 tile listings were 246 distinct places, and the raw
   pre-truncation set was 1,183 listings over 242. The dedupe happens in the bake, where
   the whole slice is in scope — never client-side, where the set is already truncated to
   six per tile.
2. **Slice-owned, exactly-one-writer (§4), at ANCHOR granularity.** An anchor is emitted
   iff its own point is inside the slice poly. Ownership is applied **before** the ranking,
   not after: ranking first would make the result depend on how much of the neighbouring
   state a Geofabrik extract's buffer happened to include, and the same anchor could then
   be ranked in from one slice and out from another.
3. **The `key` is emitted by the bake and must never be recomputed by the ingester.** It is
   `<kind>@<latE6>,<lngE6>` in integer micro-degrees, built from the same rounded lat/lng
   the tile carries. Keyed on the POINT, not the name: `Math.round(lat * 1e6)` and
   plpgsql's `round(lat * 1e6)` are the same integer with nothing in between, whereas a
   name hash diverges between JS UTF-16 code units and Postgres code points above U+FFFF —
   it would ship green and fire in whichever country first maps a landmark with an
   astral-plane character in its name.

#### Significance, and why there is a second cap at all

`LANDMARKS_PER_TILE` (§10.2) answers "what fits on the drawn page". This answers a
different question — *which named things are significant enough to hold a creature* — and
it has to be answered over a **region**, because significance is comparative. Measured:
vermont produced **1,291 distinct named summits**, the District **341 park listings over
121 distinct parks**. Neither is a collection; both are a spreadsheet.

The target is **~15 anchors per ~100 km of walking radius**, area-normalised:
`ANCHOR_DENSITY_PER_KM2 = 15 / (π · 100²) = 4.775×10⁻⁴`. Per slice would be wrong twice
over — it would hand Vermont and California the same number, and it would make the count an
artefact of where a bake was cut rather than a fact about the ground.

**Significance score.** `sig = log2(magnitude / reference)` — a number of *doublings* above
the magnitude at which a feature of that kind starts being worth naming. Ratios, not units,
is what makes a cemetery comparable to a national park with no hand-set per-kind prior.

| kind | reference magnitude (`LANDMARK_SIG_REF_M2`) |
|---|---|
| `national_park` | 5×10⁷ m² — the promotion threshold itself, so the smallest surviving national park scores exactly 0 |
| `protected_area` | 5×10⁶ m² |
| `nature_reserve` | 5×10⁵ m² |
| `park`, `common` | 1×10⁵ m² |
| `cemetery` | 5×10⁴ m² |
| `library` | 1×10⁴ m² |
| `peak` | local relief, see below |
| `city`, `town`, `village`, `hamlet`, `suburb` | **`null` — abstain** |

The area references are read off the measured trial distributions: park p90 is 64,602 m²
(DC) and 160,686 m² (VT); cemetery p50 24,343 and 6,575; nature_reserve p50 121,513 and
234,103; protected_area p50 1,025,794 (VT). `library` is 1 ha because a library is a
*building* and most are nodes with no footprint at all — at the 1,000 m² a branch library
occupies, the District's Madison Building scored 4.23 and won the entire District, which is
how that number got measured rather than guessed.

**Settlements abstain**, and §10.2 already says why in its own words: a settlement is
carried as its centre NODE with a proximity radius and that "is not a claim of membership".
A point that does not locate the thing at walking scale cannot anchor a creature to it, so
spending a cell's one anchor on `city@Washington` spends it on an arbitrary downtown
intersection.

**A summit is scored from its LOCAL DROP, and the bridge to an area is dimensional.** At a
fixed hillside slope a summit standing *h* metres above its own ground has a footprint
∝ *h*², so `log2` of that footprint is `2·log2(h)` — the slope cancels out of the ranking
entirely and only a reference height survives:

> `drop(peak)` = elevation of the GLO-30 post nearest the node, minus the LOWEST post
> within `PEAK_RELIEF_R_M` = **2,000 m** of it, over the disc of §10.4's window rule at
> post spacing (§10.9). `sig(peak) = 2 · log2(drop / PEAK_RELIEF_REF_M)`,
> `PEAK_RELIEF_REF_M = 60`. A peak whose own post has no DEM coverage has no `drop` and
> scores `−Infinity`, which is below `ANCHOR_SIG_MIN` — abstention, not a guess.

**Revision 3 changed this line, and revision 2 predicted it would.** It used to read `ele`,
which is height above **sea level**, so a 1,700 m bump on the Colorado plateau out-scored
every city park in the country and the spec could only warn about it. `drop` is a fact about
the ground the summit stands on and is comparable across a continent.

**DROP, not the window's RANGE**, and that distinction is the whole filter. `max − min` over
a window counts summits *higher* than the peak, so a knob beside a mountain scores as if it
were the mountain. Measured on the vermont trial, 2026-07-30: ranking by range gave the
state's twelve anchors to Table Rock, The Cobble (265 m) and Bear Mount and left out Mount
Mansfield, Killington Peak and Camels Hump. Range detects cliffs; drop measures the summit.

**R = 2,000 m, and it is the massif's shoulder that sets it.** The window has to be wider
than the ridge a summit sits on, or it ranks the ridge. Measured, drop in metres:

| | R = 1,000 | R = 1,500 | R = 2,000 |
|---|---|---|---|
| Mount Mansfield | 546 | 729 | **837** |
| Adams Apple (a knob 1 km along the same ridge) | 597 | 734 | 766 |
| Bear Head (2 km along the same ridge) | 597 | 663 | 691 |
| Killington Peak | 381 | 471 | **538** |
| Little Killington | 344 | 430 | 485 |

At 1 km Mansfield loses its own anchor cell twice over; at 1.5 km it loses to Adams Apple by
five metres; at 2 km it leads Vermont outright and every named sub-summit of Mansfield,
Killington and Equinox falls behind its parent. Wider is not free — at 3 km Mt Ascutney
falls behind Ascutney North, because the window stops being local at all.

**REF = 60 m**, the same construction the retired 105 m did, on a quantity that means
something. The District's 17 named summits run **38–103 m** of drop over a 2 km disc with a
**median of 60**, so its own hills score around zero. Below that is the surface model's own
noise (§10.9): Vermont's flattest named "hills" — Stanhope Hill, The Hurricane, Upper
Diggings — measure **24–36 m**, which is a name attached to a road bend. Point Reno, which
is genuinely the District's high point, measures **84 m** and scores **+0.97** where `ele`
gave it +0.46. Only Vermont's Stanhope Hill and a handful like it fall below zero, and that
is the filter working as specified: it is a floor under a *ranking*, and the ranking is
where the change shows.

The scale is preserved on purpose — Mansfield scores 7.6 against `ele`'s 7.4 and Vermont's
median summit 4.2 against ~4.5 — so the AREA references above, which were read off the same
trial distributions and balanced against the old peak scores, still hold unchanged.

#### The cap — three terms, each doing a job the other two cannot

1. **RANK** by `sig` descending, ties broken by `key` ascending, so a re-bake of unchanged
   data produces the identical set.
2. **SPREAD** — at most one anchor per `ANCHOR_CELL_DEG` = **0.5°** cell
   (`floor(lat/0.5)`, `floor(lng/0.5)`). Without it the count cap alone picks the five
   highest points on one mountain: Vermont's top summits by `ele` are Mansfield 1340, Adams
   Apple 1256, Lower Lip 1256, The Nose 1225, Upper Lip 1208 — four of which are named
   sub-summits *of* Mansfield, all within 2 km of it. 0.5° is ~46 km north-south and
   `sqrt(1 / ANCHOR_DENSITY_PER_KM2)` is 45.8 km, so the cell **is** the density expressed
   as a distance; the two terms agree by construction rather than by tuning, and the cell
   nests exactly in whole degrees.
3. **COUNT** — `max(1, round(ANCHOR_DENSITY_PER_KM2 × sliceAreaKm2))`. The area is
   integrated by the same scanline and the same even-odd rule as `pointInRings`, so
   "inside" means here exactly what it means to `owns()`; a spherical-shoelace formula
   would instead have to agree with the winding of every Geofabrik `.poly`, and one `!hole`
   ring taken the wrong way round would be a silent factor of two in the count. Vermont
   integrates to 24,991 km² against a published 24,923 (+0.3%).

Plus `ANCHOR_SIG_MIN = 0`: an anchor must also *be* significant, not merely the least
insignificant thing nearby. The floor of 1 in term 3 and this minimum pull in opposite
directions on purpose — the floor says every slice gets its best thing, the minimum says
only if that thing is significant at all. A slice with nothing above its kinds' references
emits an **empty** sidecar, and that is an answer rather than a failure. It does not bind on
either trial slice; the count cap binds first in both.

**Measured, 2026-07-30.** Vermont: 2,687 owned candidates, 1,398 above the floor, area
24,991 km² ⇒ cap 12, and the 12 are — Green Mountain National Forest, Mount Mansfield
(1340 m), Killington Peak (1293), Camels Hump (1243), Equinox Mountain (1169), Glastenbury
Mountain (1139), Mount Snow (1092), East Mountain (1045), Signal Mountain (1013), Mt
Ascutney (954), Gilpin Mountain (919), Herrick Mountain (828). District of Columbia: 328
candidates, 37 above the floor, area 186 km² ⇒ cap 1 — the U.S. National Arboretum.

**A city gets very few anchors, and that is the stated density doing its job**, not a bug:
at 15 per 31,416 km² the District's 186 km² earns 0.09, and it gets 1 only because of the
floor. If a dense city should feel like it has landmarks, the knob is
`ANCHORS_PER_100KM_RADIUS` and it moves globally.

#### Border behaviour, and what the tile flag is worth

Ownership is per slice, so a 0.5° cell straddling a state line is ranked twice — once by
each slice, over its own half — and can therefore hold **two** anchors rather than one. The
excess is bounded at one per (slice, cell) and it is the price of every slice being
reproducible from its own extract alone, which §4 already pays elsewhere for the same
reason. It also means a tile near a border can list a landmark this slice never ranked, so
the `anchor: true` flag of §10.2 will be **absent** on an entry the neighbouring slice does
anchor. That degrades to a **gap** — the client derives no spawn — and never to a
fabrication, which is the direction every other truncation in this format fails in. The
sidecar, not the tile flag, is the authority.

**Size.** Vermont 12 lines, the District 1. Extrapolating the density: ~4,700 rows for the
continental US and ~7×10⁴ globally, against the habitat sidecar's 277k *non-rural cells per
state*. It is a small table, and the per-tile payload cost is `+83 B` over the District's
188 tiles and `+17,756 B` over Vermont's 28,445 — 0.0005% and 0.012% of v5 bytes.

### 10.9 Elevation source — Copernicus GLO-30, normative

The only input to this bake that is not the OSM extract. `mountain` (§10.4) and the `peak`
significance score (§10.8) both read it, and both must be reproducible, so the product and
the way it is addressed are specified here rather than left to the implementation.

**Product.** Copernicus DEM GLO-30 (2021 release, ~30 m), on AWS Open Data. **Anonymous
HTTPS, no credentials, no requester-pays**, and `Accept-Ranges: bytes`:

```
https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<TILE>_DEM/Copernicus_DSM_COG_10_<TILE>_DEM.tif
<TILE> = N44_00_W073_00     the SW corner, zero-padded to 2 and 3 digits
```

One file per 1° cell. Cloud-optimised GeoTIFF: float32, tiled 1024 × 1024, Compression 8
(Adobe Deflate), Predictor 3 (floating point), **`GTRasterTypeGeoKey = 2`, pixel-is-point**.
Three overview IFDs exist and are **deliberately not used** — they are GDAL's average of
8 × 8 posts, and averaging a summit destroys the quantity being measured; worse, it would
make a re-derivation depend on reproducing one C library's resampling.

**The lattice.** Pixel-is-point puts post (0,0) exactly on the tile's NW degree corner, so
there is no half-pixel offset anywhere. Tile `N44_00_W073_00` holds `ky ∈ (44·3600,
45·3600]` and `kx ∈ [−73·W, −72·W)`, and
`row = 3600·(tileLat+1) − ky`, `col = kx − tileLng·W`. Note the latitude asymmetry: the post
exactly on lat 44 belongs to **N43**, so `tileLat = floor((ky − 1) / 3600)`.

**LONGITUDE IS DECIMATED ABOVE 50°N, and a port that assumes otherwise fails silently.**
Rows are 1 arc-second everywhere — height is always 3600. Columns are not. Measured by
fetching headers, 2026-07-30:

| band | N44 | N52 | N59 | N63 | N68 | N71 | N76 |
|---|---|---|---|---|---|---|---|
| columns per degree (`W`) | 3600 | 2400 | 2400 | 1800 | 1800 | 1200 | 1200 |

`W` **must be read from each tile's own `ImageWidth`**, not from a latitude table: the
published handbook says 5 arc-seconds above 75°N and the archive ships 3. This bake got it
wrong once and the failure was total and invisible — reading a 2400-wide tile as if it were
3600 wide indexes past the end of a raster row into the *next* row's block, which is a
perfectly valid float32 array from somewhere else in the tile. Keswick, ringed by 900 m
fells, reported **0 m** of relief; Amsterdam reported 0 m too, so nothing looked wrong.
`typeof elev === 'number'` was true throughout. Assert on a value.

**It is a surface model, not a terrain model.** GLO-30 includes canopy and buildings. Over a
5 km disc that is noise against a 500 m threshold and is ignored; over the 2 km disc §10.8
uses it is roughly 20–30 m of apparent drop with no landform under it, and that is exactly
what the 60 m reference is set above.

**Missing tiles are an ANSWER.** The archive publishes no tile for open ocean, and a 404 or
403 means "no land here" — the caller abstains (§10.4). **Any other status is an error and
must abort the bake**: an elevation source that half-works would silently un-classify a
mountain range, and a bake that quietly loses a class is the failure mode this whole format
is written to prevent.

**Cost, measured on a cold cache, 2026-07-30.** Only the 1024 × 1024 blocks the slice
actually needs are fetched, by HTTP range, not whole tiles:

| slice | 1° tiles touched | blocks | fetched | whole tiles would have been |
|---|---|---|---|---|
| district-of-columbia | 4 | 6 | **11.7 MB** | ~180 MB |
| vermont | 12 | 120 | **255.2 MB** | ~539 MB |

Sampling and the relief pass together take **4.9 s** for the District (182 × 138 cells) and
**84 s** for Vermont (1,345 × 1,803 cells), against a ~2 minute tiling pass — the disc is
O(N·ry) rather than separable, and that is the price of the shape (§10.4).

Blocks are cached on disk between bakes (`DEM_CACHE_DIR`, default
`~/.cache/walkable-tiles/dem`) and the cache is **deliberately outside the slice's temp
directory**, which `bake-slice.sh` deletes on exit — a calibration loop re-bakes the same
slice repeatedly and would otherwise re-download hundreds of megabytes each time. On a
GitHub runner the cache is cold every run; the download is inside the existing 120-minute
timeout and costs nothing, and a state's DEM is a fraction of the ~1.1 GB Geofabrik extract
it is baking beside.
