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
  "habitat":   { "cellDeg": 0.0015, "cx0": …, "cy0": …, "cols": 7, "rows": 8,
                 "feat": "H_AAZAAAH_APAAoA…" }        // 8 base64url chars of MEASUREMENT per
  //                                                     spawn cell; the CLASS is derived by
  //                                                     the reader, never baked (§10.3)
}
```

### 10.0 Revision 4 (2026-07-31) — the habitat grid stops carrying a CLASS

**The one change in this format's history that is not purely additive, and the reason is that
the thing being removed is a second source of truth.** Revisions 1–3 shipped `habitat.cells`,
one class CHARACTER per spawn cell: the bake ran the classifier and published its answer.
That made every threshold a property of the CDN. `mountain`'s radius and threshold each moved
twice during one afternoon of calibration, and each move meant re-baking every slice — hours
per state and real money — so in practice the rules were frozen by their deployment cost, and
a class added later could only be seen by tiles baked after it.

Revision 4 ships the MEASUREMENTS instead. `habitat.feat` carries **8 base64url characters per
spawn cell** — way length by group, three 2×2 cover masks, and the regional relief — and
§10.4's rules are applied by whoever reads it: the bake (for the sidecar and the atlas),
Ausculta's client (`packages/content/src/habitat.ts`), and Ausculta's server (plpgsql, to
re-derive a claim). **Adding a classifier no longer requires a re-bake.** Adding a
MEASUREMENT still does, because that is new data rather than a new opinion, and that is the
line the format holds.

Three consequences, all stated rather than discovered:

- **`cells` is gone, not kept alongside.** Keeping both would leave the bake's answer and the
  reader's answer able to disagree about the same cell, which is exactly what revision 4
  exists to end. A revision-3 client finds no `cells`, decodes nothing, and every cell falls
  back to rural — the same quiet degradation the retired `g` already relies on, in the
  direction that under-claims.
- **The classifier is MULTI-LABEL** (§10.4). First-match-wins was a live bug: when `mountain`
  landed it claimed first and Vermont's `woodland` fell from 3.8% of spawn cells to 1.4%,
  taking most of a shipped woodland creature's habitat with it. A cell is now every class its
  features earn, and the ordering argument disappears.
- **`water` is the seventh class** (§10.4), which overflows the atlas's 6-bit mask; the atlas
  goes to two characters per block and `v: 2` (§10.7).

**Revision-3 tiles stay valid `v: 5`** and parse unchanged apart from the habitat grid, so
the two revisions coexist on the CDN for as long as any slice goes un-rebaked.

### 10.0.1 Revision 2 (2026-07) — still `v: 5`, and why

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

### 10.3 `habitat` — per-spawn-cell FEATURE grid

The grid is Ausculta's spawn-cell grid exactly: `cellDeg = 0.0015`
(`cx = floor(lng/0.0015)`, `cy = floor(lat/0.0015)` — cx first, as in its
spawn module's `cellId`). `TILE_DEG / cellDeg = 20/3` exactly, so a tile's
spawn-cell coverage is pure integer math (**normative**, and verified to match
float arithmetic across ±90°/±180°):

```
cy0 = floor(20·latIdx / 3)      cy1 = ceil(20·(latIdx+1) / 3) − 1     rows = cy1−cy0+1  (7 or 8)
cx0 = floor(20·lngIdx / 3)      cx1 = ceil(20·(lngIdx+1) / 3) − 1     cols = cx1−cx0+1  (7 or 8)
```

`feat` is **8 base64url characters per spawn cell**, `rows × cols × 8` long, **row-major,
south→north** (cy ascending is the outer loop), **west→east** (cx ascending) within a row:
cell `(cx, cy)` starts at character `8 · ((cy−cy0)·cols + (cx−cx0))`. Because 20/3 is not an
integer, edge spawn cells straddle tile boundaries and appear in two (or four) tiles' grids —
the record is a function of the cell alone, so overlapping tiles agree byte for byte.

This is deliberately the atlas's encoding (§10.7) one zoom in: a fixed number of base64url
characters per slot of a dense raster, same alphabet, same row order, no separators. There is
no second convention to learn and no parser to write — index arithmetic and a table lookup,
in JS or in plpgsql.

#### The feature record — 48 bits, normative

Assembled as one 48-bit big-endian integer and written most-significant character first. It
fits exactly in a JS double (< 2^53) and in a plpgsql `bigint`, so neither side needs a bignum
or a byte buffer.

| bits | field | encoding |
|---|---|---|
| 47–45 | reserved | must be 0 |
| 44–36 | `relief` | 9 bits, 10 m units, 0–510 ⇒ 0–5,100 m. **511 = NO DEM COVERAGE** |
| 35–32 | `waterMask` | the cell's 2×2 cover samples inside a `water` landcover polygon |
| 31–28 | `greenMask` | … inside a `green` polygon |
| 27–24 | `woodMask` | … inside a `wood` polygon |
| 23–16 | `road` | 8 bits, 10 m units, saturating at 2,550 m |
| 15–8 | `foot` | 8 bits, 10 m units, saturating at 2,550 m |
| 7–0 | `res` | 8 bits, 10 m units, saturating at 2,550 m |

Sample bit order within a mask is the 2×2 grid of §10.4: bit 0 = (S, W), 1 = (S, E),
2 = (N, W), 3 = (N, E).

Four decisions in that table, each load-bearing:

- **511 is not 5,110 m.** An unmeasured cell is not a flat cell. A rule that reads relief must
  abstain on the sentinel, never treat it as flat ground — the same contract §10.6's absent
  `lit` has, and the same one that stopped `mountain` claiming ocean.
- **MASKS, not counts, for the three cover fields.** The green gate is
  `popcount(woodMask | greenMask)` — the UNION — which counts cannot reproduce: two wood
  samples and two green samples cover anywhere from 2 to 4 of the cell's 4 samples depending
  on WHICH ones. Masks cost the same 12 bits three 3-bit counts would and answer strictly more.
- **Linear 10 m units, not a log scale.** A log scale gives constant relative precision and
  costs fewer bits, and it is refused because the thresholds are absolute (120 m, 900 m, 500 m)
  and must be exactly representable in every port: 120/10 and 900/10 are integers, so a cell
  cannot straddle a threshold because JS and plpgsql rounded a logarithm differently in the
  last bit. **The saturation point is 2,550 m of ONE way group inside a 167 m cell** — measured
  on both trial slices, the largest anywhere is Vermont's 1,530 m of `foot` and the District's
  2,400 m, and no cell in either reaches the ceiling.
- **FLOOR, never round.** Every stored quantity is a LOWER BOUND on the truth. The absolute
  gates are all `>=`, so quantisation can only refuse a class there, never grant one on
  evidence the cell does not have. The SHARE gates are ratios of three independently floored
  numbers and can move either way by up to one quantum each — measured, that moves **216 of
  Vermont's 282,350** walkable cells and **126 of the District's 7,364** across any label at
  all, and **no cell in either changes `mountain`**. Rounding instead of flooring moved 8,789
  and 71, all of it upward, including 3,208 extra `mountain` cells.

**The rules are applied to the DECODED record**, never to the tiler's internal float. That is
what makes the bake, the client and the plpgsql port classify identically by construction
rather than by tolerance.

`node scripts/habitat.mjs` is a live self-check of this table and of §10.4's rules, asserting
on VALUES the way `dem.mjs` does — a record read one field short returns perfectly plausible
numbers from the wrong offset, and `typeof f === 'object'` is true of an empty decode.

**What revisions 1–3 carried instead.** `cells`, one character per spawn cell —
`u` urban, `r` residential, `w` woodland, `s` greenspace, `m` mountain, `.` rural, and
revision 1's retired `g`. A revision-4 reader that meets `cells` and no `feat` **must decode
nothing**: mapping the characters back would reintroduce exactly the frozen classification
this revision removes, and it cannot represent a multi-class cell at all. Those cells go
quiet, which is the direction that under-claims.

### 10.4 Habitat classifier — v4, normative, MULTI-LABEL

The vocabulary is Ausculta's `packages/content/src/habitat.ts` exactly:
`mountain | water | urban | residential | woodland | greenspace | rural`. Ausculta's server
re-derives spawns from these classes, so the classification must be reproducible from this
spec + the OSM extract **and one published elevation product** (§10.9).

**The rules are no longer in the bake alone.** Three implementations run them — the tiler's
`scripts/habitat.mjs`, Ausculta's `packages/content/src/habitat.ts`, and the server's plpgsql
— over the same 8 characters per cell (§10.3). This section is normative for all three.

The bake's job is the three per-cell aggregates below, and only those:

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

**Every rule is evaluated INDEPENDENTLY and the result is the UNION** (`all = foot + res +
road`, all lengths and `relief` read from the decoded record of §10.3):

- **nothing at all** if `all == 0` ⇒ `rural`, alone. Spawns snap to walkable ways, so a cell
  with no walkable way places nothing, and classifying it would put a creature where nobody
  can stand. One invariant stated once, where v3 stated it three times.
- **mountain** if `relief ≥ 500 m`. A missing relief never matches — abstention, not a guess
  that the ground is flat.
- **water** if `waterFrac ≥ 0.25` **and** `foot > 0`.
- **green family** if (`coverFrac ≥ 0.5` **and** `foot > 0`) **or** (`foot ≥ 120 m` **and**
  `foot/all ≥ 0.7`) — trackless forest is rural; a wood with a path through it is walkable
  green. (Without the `foot` guard, ~40% of Massachusetts' green cells were unreachable
  forest.) Which member it is stays a PARTITION — see "Which green" below.
- **urban** if `all ≥ 900 m` **and** `res/all ≤ 0.35`.
- **residential** if `res ≥ 120 m` **and** `res/all ≥ 0.4`.
- **rural** if and only if nothing above matched. `rural` is the ABSENCE of every other
  class, so it is never a co-label and the mask is never empty.

**FIRST-MATCH-WINS WAS A LIVE BUG.** Revision 3 ordered these and stopped at the first: when
`mountain` was inserted at the top, Vermont's `woodland` fell from 3.8% of spawn cells to
1.4%, and `skitter` — a shipped woodland creature — lost most of its Green Mountain habitat.
Not because the ground changed, but because a class was inserted above it in a list. Real
ground is a wooded mountainside. Once the data says so, the ordering argument disappears
entirely: there is no order.

Measured on the vermont trial bake, 2026-07-31 (`--trial`, nothing uploaded) — the LABEL
share, which is what a creature's weight sees:

| vermont, of 1,266,781 distinct spawn cells | rev 2 (no mountain) | rev 3 (first match) | **rev 4 (multi-label)** |
|---|---|---|---|
| rural | 90.4% | 86.2% | **86.2%** |
| mountain | — | 8.8% | **8.8%** |
| residential | 4.5% | 2.7% | **4.5%** |
| woodland | 3.8% | 1.4% | **3.8%** |
| greenspace | 1.3% | 0.8% | **1.3%** |
| urban | 0.04% | 0.04% | **0.04%** |
| water | — | — | **0.2%** |

Every class the mountain rollout took from is exactly back where it was, and `mountain` is
unchanged at 8.8%. 4.9% of Vermont's cells carry more than one class.

The District of Columbia still reports **0.0% mountain** — its 17 named "peaks" are 28–123 m
city hills and its highest regional relief anywhere is 144 m, a factor of 3.5 below the
threshold, which is what makes it the sharpest available test that the rule does not
over-claim. Its labels move where multi-label and `water` say they should: rural 38.4% →
37.3%, urban 30.9% → 32.3%, greenspace 12.4% → 18.2%, woodland 9.3% → 9.4%, residential 9.0%
→ 10.0%, water — → 3.8%.

#### Display precedence — one plate, not 2^7 of them

Multi-label is right for spawning and wrong for painting: the habitat album holds ONE plate
per class and the map draws ONE ground texture per cell. So a **display order** picks the
single class a multi-class cell shows, and it is display-only:

> `mountain` > `water` > `woodland` > `greenspace` > `urban` > `residential` > `rural`

Coarsest and most distinctive first. A wooded mountainside paints `mountain`, because that is
what the player is standing in; a wooded lakeshore paints `water`, because the water is why
anyone walks there. `rural` is last and is the floor. Seven classes stay seven plates.

**How a creature's weight combines across a cell's classes is the MAXIMUM**, and that belongs
here rather than only in the app because the server re-derives the same draw. The reason is
monotonicity: adding a class to a cell must never REDUCE a creature's weight, or a classifier
added years from now silently deletes an existing creature's habitat exactly as `mountain`
just did. Product and mean both reintroduce the bug — under product a wooded mountainside
multiplies a woodland creature's 2.0 by a mountain creature's 0.2 and the woodland creature is
rarer there than in a car park.

#### `water` means SHORELINE, never open water

You cannot stand in a lake, and this bake already enforced it without knowing anything about
water: spawns snap to walkable ways, so a cell that is all water has no ways and places
nothing. The class therefore means *walkable ground beside water*, and the creature it
justifies is found on the towpath, not in the canal.

`waterFrac` is the same 2×2 sample grid the green rule uses, against the `water` landcover
polygons of §10.1 — which have shipped since the first v5 bake; only the habitat layer never
looked at them. The threshold is **lower than green's 0.5** because a shoreline cell is mostly
land by definition: a cell that is half lake is a cell whose walkable part is a narrow strip,
which is exactly the case worth naming. The `foot > 0` guard is the green rule's lesson
repeated at the strength open water needs.

**KNOWN GAP, deliberately open.** Narrow rivers, streams and canals are LINES in OSM
(`waterway=river|stream|canal`) and this bake takes only mapped `riverbank` polygons, so a
canal towpath — the most water-ish walk in Britain — does not classify. Closing it is new
DATA rather than a new rule: it needs an osmium filter line, a buffer width to justify, and
four more bits in the record, so unlike a threshold it costs a re-bake in whichever revision
takes it. It should wait for a creature that actually needs a stream. The miss is a GAP —
the cell reads as whatever else it is — and never a fabrication.

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
`relief = null` (the 511 sentinel of §10.3) and the mountain rule cannot match, so the cell
is whatever the other rules make it and exactly what a revision-2 cell would have been; it is
never `mountain` and never any other class it would not otherwise have been. A window that merely CLIPS a missing tile — every coastal mountain —
still has land in it and still has a relief, computed over the samples that exist. The two
cases are different on purpose: an unmeasured cell is not a flat cell, but a partly
unmeasured window is still a measured window.

The same rule covers a bake run with no elevation source at all (`DEM_DISABLE=1`): every
relief is missing, no cell is `mountain`, and the bake prints a banner saying so, because
"no mountains anywhere" and "no mountains here" are the same output and only one is true.

**Which green.** The two green gates select the *family*; this selects the member. It stays
a PARTITION rather than becoming two more independent labels, and that is the one place
multi-label deliberately does not apply: the album paints one plate per class and "wooded AND
open green" is not a place.

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
explicitly. *This is a structural argument, not a measured one.* What the trials do show is
that neither half is starved: vermont runs 2.90 woodland to 1 greenspace and the District 0.52
to 1, which is the two states' actual ground rather than a threshold artefact.

With **no** cover evidence at all — the path gate, a trail-dominated cell with nothing mapped
around it — the answer is `greenspace`. `woodland` is a claim about tree cover and there is
none to support it; `greenspace` is the weaker claim, which is the one to make when the
evidence is absent.

**Sidecar:** `out/habitat-<slice>.jsonl` — one line per owned spawn cell **that has any
walkable way**, `{"cx":…,"cy":…,"f":"H_APAAoA","classes":["woodland"]}`, sorted by `cy` then
`cx`. The exactly-one-writer rule (§4) applies at spawn-cell granularity: a cell is emitted
iff its centre is inside the slice poly. (Tile habitat grids near slice borders may include
cells classified from the extract's buffer geometry; the sidecar is the authoritative
slice-owned set.)

Three revision-4 changes to it, each with a reason:

- **`f` is the row and `classes` is the convenience.** The server re-derives every spawn from
  the rules above, so what it must store is the MEASUREMENT; a sidecar of class names would
  need a re-bake the day a class is added, which is the cost this revision exists to remove.
  `classes` is written beside it so an operator can read a line and so `inspect-bake.mjs` can
  cross-check the atlas against something other than its own arithmetic.
- **`class` (singular) is gone rather than widened.** A list under a singular key would be a
  key changing meaning, which is the one thing §10.0 does not do.
- **The gate is `all > 0`, not "non-rural".** "Non-rural" is a fact about today's rules — a
  cell this bake calls rural is exactly the cell a new rule might want. `all > 0` is
  structural: a cell with no walkable way places nothing under any rule anybody can write,
  and it is the only thing that can be dropped without a guess. **The atlas obeys the same
  gate**, which it did not before: a block whose only owned cells were trackless forest used
  to set the atlas's `rural` bit, and the app would then point somebody at open country
  40 km away that nobody can walk on.

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

- **Revision 4 (the feature grid) is the first habitat change that costs BYTES, and gzip
  eats most of it.** Measured on both trial bakes, 2026-07-31, against a revision-3 bake of
  the same extract. Uncompressed, the habitat block goes **126 B → 500 B** per tile — 8
  base64url characters per spawn cell instead of 1, over the same 49–64 cells — so **+374 B**
  of JSON. On the wire:

  | slice | v5 tiles | total gz | p50 gz | habitat share of the payload |
  |---|---|---|---|---|
  | vermont, rev 3 | 28,445 | 146,156,824 B | 3,969 B | 0.58% |
  | vermont, **rev 4** | 28,445 | **148,683,040 B** (+1.73%) | **4,051 B** (+82 B, +2.07%) | 2.25% |
  | district-of-columbia, rev 3 | 188 | 15,231,598 B | 78,890 B | 0.02% |
  | district-of-columbia, **rev 4** | 188 | **15,281,258 B** (+0.33%) | **79,219 B** (+329 B, +0.42%) | 0.10% |

  **+82 B on a 4.0 KB rural tile and +329 B on a 79 KB city one**, against a pre-gzip cost of
  374 B in both — the raster is highly repetitive (a cell with no ways and no cover is eight
  identical characters) and deflate takes ~78% of it back in Vermont. Tile COUNTS are
  unchanged in both slices, and **v4 and v5c are byte-identical** across the change: v4 never
  saw the habitat grid and the coarse layer carries no habitat at all.

  What is NOT free is the sidecar, and it is deliberate: **vermont 7.8 MB / 174,379 lines →
  18.3 MB / 282,350 lines**, the District 228,848 B / 5,285 → 464,686 B / 7,364. Both changes
  push the same way — the gate widened from "non-rural" to "has a walkable way", and the row
  gained the record. It buys the property the whole revision is for: the server can classify a
  cell under a rule that did not exist when the slice was baked. The atlas is tens of bytes
  (§10.7).

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

**Encoding (normative).** One class-occurrence mask per block, **`blockChars` base64url
characters per mask** (2 as of atlas `v: 2`), over a **dense raster** of the slice's block
bounding box, most-significant character first:

| bit | value | class |
|---|---|---|
| 0 | 1 | `urban` |
| 1 | 2 | `residential` |
| 2 | 4 | `woodland` |
| 3 | 8 | `greenspace` |
| 4 | 16 | `mountain` — set as of revision 3 (§10.4) |
| 5 | 32 | `rural` |
| 6 | 64 | `water` — set as of revision 4 (§10.4) |

```jsonc
{
  "v": 2, "slice": "vermont",
  "cellDeg": 0.0015, "blockCells": 64, "blockChars": 2,
  "bx0": -765, "by0": 445, "cols": 21, "rows": 24,
  "classes": ["urban","residential","woodland","greenspace","mountain","rural","water"],  // index i is bit 1<<i
  "blocks": "…1008 base64url characters…"
}
```

`blocks` is `rows × cols × blockChars` characters, **row-major, south→north** (`by` ascending
is the outer loop), **west→east** within a row — the same order as §10.3's per-cell grid, one
zoom out, so there is no second convention to learn. Block `(bx, by)` starts at character
`blockChars · ((by−by0)·cols + (bx−bx0))`. Alphabet is `A–Z a–z 0–9 - _` at indices 0–63;
base64url rather than standard base64 because `-`/`_` need no escaping in a JSON string, a
URL path or a shell, whereas a `/` invites a `\/` from a defensive encoder and the raster
stops round-tripping byte-for-byte.

**TWO CHARACTERS, AND WHAT BROKE AT SEVEN CLASSES.** Six bits was exactly the class
vocabulary's width, and `water` is the seventh. The bit that looks spendable is `rural` — the
sidecar omits it — and it is not: **mask 0 means NO DATA**, so without an explicit rural bit
the atlas cannot tell "90% of Vermont" from "that is the next state", which is the whole
abstention contract below. So the slot widens to 12 bits. `blockChars` is written into the
artifact rather than implied, because an inspector that hard-codes the width reads a v2 raster
as twice as many blocks of nonsense and nothing looks wrong. Five bits are now spare, which
makes the NEXT class free — the point of the exercise being that a class should not force an
encoding change twice.

**Measured cost, 2026-07-31 (`--trial`):** vermont **693 B → 1,220 B**, the District
**209 B → 241 B**. It is one character per block plus a longer `classes` list; at ~1 KB for a
state the absolute number is still the argument.

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

**Derivation (normative).** From the **slice-owned spawn cells that have a walkable way** —
§4's exactly-one-writer rule at spawn-cell granularity, cell *centre* inside the slice poly,
`all > 0` — classified by §10.4, in the same pass and under the same gate as the habitat
sidecar. A block's bit is set for every class ANY owned cell in it carries, which under
multi-label means one wooded mountainside sets two. **Never from the per-tile habitat
grids:** those include cells classified from the buffer geometry a Geofabrik extract
carries from its neighbours, which reads Washington DC as 38% rural, a fact about Virginia
and Maryland rather than about DC. A block's bit is set iff **at least one** owned cell in
it has that class.

The atlas and the sidecar record `rural` the same way as of revision 4 — the sidecar's
`classes` list carries it, because its gate is now `all > 0` rather than "non-rural" (§10.4).
That closes the one bit the cross-check below could never verify. It is also why Vermont's
occupied-block count moved 346 → 345: one block's only owned cells were trackless forest, and
"rural" was the wrong thing to say about ground nobody can walk on.

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

**Measured, revision 4 (2026-07-31, `--trial`, nothing uploaded):** vermont's raster is
1,220 B over 345 occupied blocks. Multi-label raises every class's block count, because a
block no longer loses a class to whatever claimed its cells first: `residential` 292 → 339,
`greenspace` 263 → 330, `woodland` 226 → 285, `urban` 42 → 60, `mountain` 228 unchanged, and
`water` arrives in 258 (74.8%). `rural` falls 344 → 302, which is the `all > 0` gate refusing
to call trackless forest open country. The noise floor is worth reading before trusting the
new bit: **55 of the 258 water blocks (21.3%) rest on a single spawn cell**, second only to
`urban`'s 31.7% — a mapped `riverbank` polygon with one path crossing it is a real answer and
a thin one. The District claims `mountain` in **0** of its 6 blocks and `water` in all 6.

**Measured, revision 3 (2026-07-30):** vermont's raster was 693 B — a mountain bit cost
nothing, because the raster was dense and the bit was already allocated. 228 of vermont's 346
occupied blocks (65.9%) claimed `mountain`, against 226 for `woodland`.

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

**Verification.** `inspect-bake.mjs` cross-checks the atlas against the habitat sidecar **by
value**, block for block: every bit the sidecar's cells imply must be set in the atlas and no
bit may be set without a sidecar cell backing it. The classes it checks are **re-derived from
each sidecar row's `f`**, not read off its `classes` — so the check tests the rules rather
than the tiler's memory of them, and a disagreement between the two fields is itself reported.
`rural` is inside the check as of revision 4 (the sidecar now lists it) and `water` from its
first bake; the mountain rollout is the argument for the latter — a brand-new bit is exactly
the one whose verification must not be skipped "for now". An atlas built from the tile grids
instead would disagree exactly at a state line, and `typeof atlas === 'object'` would never
notice. Both trial slices report `AGREES — 0 missing bits, 0 unbacked bits, 0 sidecar blocks
off-raster`.

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

### 10.10 `v5c` — the COARSE landcover layer, for the 600 m → 10 km band

A fourth artifact, at its own prefix `v5c/<latIdx>/<lngIdx>.json.gz`, with its own hash
manifest `v5c/hashes/<slice>.json` (locally `out/hashes-v5c.json`). **Additive in the
strongest possible sense:** it is a separate object at a separate path, so a client that
predates it never asks for it and the v5 tiles do not change shape by one byte.

#### The measurement that forces it

A v5 tile is ~890 KB in a city — 891 KB downtown Salt Lake City, 911 KB Boston, measured on
the live CDN. Ausculta's tile cache is **128 MiB total**, and its request set is a symmetric
block around the caller's cell (never a box around their position — that is the anonymity
property, and it costs cells). So:

| map radius | cells requested | v5 bytes |
|---|---|---|
| 0.6 km (gameplay) | ~9 | ~8 MB |
| 2 km | ~35 | ~31 MB |
| 5 km | ~165 | ~145 MB |

A 5 km view is **more than the entire cache**, fetched in one pinch, evicting every street
the player has walked. Raising the live radius cannot deliver the zoomed-out map; it can
only break the near one. And the habitat atlas (§10.7) does not fill the gap either — 693 B
for all of Vermont, but its blocks are 8 × 11 km, which is one or two pixels at this zoom.
**Nothing served the band between 600 m and 10 km.**

#### What it carries, and what it refuses

```jsonc
{ "v": 1,
  "landcover": [ { "kind": "water", "rings": [ [ 44.51234, -72.81431, 44.51301, … ], … ] }, … ] }
```

`kind` is §10.1's vocabulary unchanged (`water`, `wood`, `green`, `field`). `rings[0]` is
the outer ring and the rest are holes; rings are **open** and rendered even-odd, exactly as
in §10.1. Entries are ordered by clipped area descending, so big washes paint first at
either fidelity.

**Rings are FLAT `[lat, lng, lat, lng, …]` number arrays**, not §10.1's `{lat,lng}` objects.
v5 uses objects because its ways inherited them from v4 and the client passes them through
by reference on a hot path; this artifact has no such lineage, and a payload that is almost
entirely coordinates is ~2× smaller flat before gzip. The client converts once, at parse.

Nothing else is in it, and each refusal has its own reason:

- **No ways, names or crossings.** This is where the entire saving comes from. Measured on
  live tiles, downtown SLC is 880,063 B at v4 and 890,931 B at v5 — the terrain is 1.2% of
  the payload and ways are essentially all of the rest. At a 5 km view a residential street
  is a hair thinner than a stroke, and 165 tiles of them is 145 MB of hair.
- **No habitat grid.** It is already published twice: per spawn cell in the tiles (§10.3)
  and per 8 × 11 km block in the atlas (§10.7). A third copy at a third resolution is a
  third thing to keep in step.
- **No landmarks.** A label needs a name, and a name at 5 km needs a *significance* ranking
  over a region, which is §10.8's question and §10.8's artifact. Shipping the tile's
  six-per-cell list at this zoom would put every municipal park on a state-sized page.

`v: 1` is this artifact's own version and deliberately **not 5**. Giving it the tile version
would promise that a v5 parser can read it. It cannot, and should never try.

#### Granularity: one artifact per v5 tile, and why not per block

The obvious economy is a block of 4 × 4 or 16 × 16 tiles, which would cut a 5 km view from
~165 round trips to ~25 or ~9. **It is rejected on §4.**

Ownership is per cell CENTRE, so a coarser block is written by whichever slice holds its
centre — and that slice bakes it from a Geofabrik extract that carries its neighbour's
geometry only as far as the extract's own buffer reaches (a feature is complete if any node
is inside the `.poly`; a forest wholly 3 km over the line is simply absent). A 0.16° block
whose centre lands just inside Vermont therefore has to supply up to 17 km of New Hampshire
it does not have, and the result is a blank ribbon up to one block wide along **every** slice
boundary — at exactly the zoom this artifact exists for. On the 0.01° grid that ribbon is the
1.1 km the v5 tiles already accept and which no zoom in this app can see.

The trade is worth naming precisely: **the stated problem is BYTES, not round trips.** A
128 MiB cache against a 145 MB fetch is a wall; ~165 small requests is a second of latency on
a foreground gesture, and the client already asks for that many cells at that radius today.
Staying on the tile grid also means the coarse layer inherits `tileCellsAroundCell`, the
sorted-neighbour-ring request discipline, `tileCellKey`, the 30-day/5-minute TTL split and
the eviction policy **verbatim** — no second grid, and no second privacy argument. A new
grid would need one: the request-ordering side channel `apps/mobile/src/tiles/cache.ts`'s
header documents is not a property of the tile size, it is a property of the request set.

#### Clipped to the CELL RECT, not to the ±1200 m box

v5 clips landcover to the ±`BOX_HALF_M` box around the cell centre and the client dedupes the
seam copies. At this fidelity that would be ~9× the bytes for the same ground, since ~165
overlapping 2.4 km boxes cover each square metre nine times.

So a coarse tile is clipped to its cell's **exact 0.01° rectangle**, padded by
`COARSE_CLIP_PAD_M` = **40 m**. The coarse tiles are then a PARTITION: every polygon appears
in exactly the cells it covers, adjacent pieces abut, the union is seamless, **and the client
needs no seam dedupe at all**. The 40 m pad exists because two exactly-abutting fills leave
an antialiasing hairline; the renderer composites each class's polygons under one group
opacity, so a slight overlap unions away invisibly — the same property that already lets v5's
seam duplicates paint without double-darkening.

#### Simplification (values normative)

| constant | value | |
|---|---|---|
| `COARSE_SIMPLIFY_TOL_M` | **50 m** | Douglas-Peucker, applied to §10.1's already-10 m-simplified rings |
| `COARSE_MIN_AREA_M2` | **50,000 m²** | drop before clipping — on the *simplified* ring |
| `COARSE_MIN_CLIPPED_M2` | **25,000 m²** | post-clip sliver floor, the same 2:1 ratio §10.1 uses |
| `COARSE_CLIP_PAD_M` | **40 m** | |
| coordinate rounding | **1e-5°** (~1.1 m) | |

The thresholds are read off the DRAWN SIZE, not off the data. At the ~5 km span this layer is
for, a full-width phone panel is ~390 SVG units, so one unit is ~12.8 m. A 50,000 m² blob is
a 224 m square — **17.5 units**, the smallest thing that reads as a shape rather than a speck;
below it the page is dots, and a page of dots is noise. 50 m of simplification is ~4 units,
about the width of a watercolor edge.

**Re-simplifying an already-simplified ring is not the same as simplifying the original at
50 m** — the deviations compose, so a coarse ring is within 60 m of the OSM geometry rather
than 50. At under five drawn units that is accepted; paying a second full pass over the raw
rings to recover 10 m would double the tiler's landcover cost for something nobody can see.

1e-5° is 45× finer than the simplification tolerance and well inside the clip pad, so it
cannot open a seam, and it is one character per coordinate cheaper than §10.1's 1e-6. A tenth
of a metre on a shape that is honestly ±60 m is a precision this artifact does not have.

**What was deliberately NOT done: polygon union.** Two adjacent woods stay two polygons; a
lake clipped across four cells stays four pieces. Unioning them is a real geometry-library
problem, it would break the partition property that makes the dedupe unnecessary, and under
group-opacity compositing the drawn result is identical.

#### Measured, `--trial`, nothing uploaded (2026-07-30)

| slice | v5c tiles | v5c bytes (gz) | B / tile | B / km² | vs v5 total |
|---|---|---|---|---|---|
| district-of-columbia | 135 | **28,785** | 213 | 221 | **0.19%** of 14.5 MB |
| vermont | 18,486 | **3,179,256** | 172 | 193 | **2.18%** of 139.4 MB |

The whole District's coarse layer is **28.8 KB** — less than one third of one v5 tile.

The number that justifies the artifact is not the total, though: it is what ONE VIEW costs.
That is a WINDOW sum over the byte raster and is far more skewed than the per-tile
distribution, because cities sit next to cities and forest next to forest.
`inspect-bake.mjs` reports it — it reproduces `tileCellsAroundCell` including its
cos(lat)-at-the-cell-centre rule, prefix-sums both byte rasters, and slides the window over
every cell that has a v5 tile. At the app's own `COARSE_RADIUS_M` (5,200 m, the
half-diagonal of the widest page it can draw):

| slice | cells | v5 p50 / p95 / max | v5c p50 / p95 / max | cheaper by |
|---|---|---|---|---|
| district-of-columbia | 143 | 7.9 / 11.5 / **11.9 MB** | 13.0 / 18.4 / **19.8 KB** | 615–640× |
| vermont | 165 | 0.7 / 1.5 / **5.0 MB** | 17.9 / 34.1 / **55.9 KB** | 38–92× |

**Neither trial slice contains a ~890 KB tile** — the District's are ~81 KB and Vermont's
~5 KB, because a Geofabrik state extract of a small or rural region is nothing like downtown
Salt Lake City. Against the live-CDN measurement that opened this section, the same 165-cell
window of city tiles is **~145 MB**, and the worst coarse window measured anywhere across
both slices is **55.9 KB**. The 128 MiB cache holds 10.7 such views at v5 and 2,346–6,606 at
v5c.

**What the area gate costs, in ground rather than in polygons.** The 50,000 m² threshold
discards most polygons and almost no landcover, which is the shape a size gate is supposed
to have — and it is reported as area for exactly that reason, because the count reads like a
massacre and says nothing:

| slice | polygons kept | landcover AREA kept |
|---|---|---|
| vermont | 4,967 of 18,604 (26.7%) | **98.5%** |
| district-of-columbia | 186 of 1,664 (11.2%) | **78.8%** |

The District is the honest cost of the threshold and it is a city's cost: its park p90 is
64,602 m², so most of what it loses is squares and traffic circles, each a speck at this
zoom. What survives is the Mall, Rock Creek, the Anacostia and the Potomac — which is what a
5 km page of Washington should say.

#### Ownership, hashing, upload

Identical to v5 and unchanged: a slice writes cell `(i, j)` iff the cell centre is inside its
poly (§4); the hash is sha256 of the uncompressed JSON; `bake-slice.sh` diffs against the
published `v5c/hashes/<slice>.json` and uploads only what moved. **A slice that re-bakes v5
must re-bake this beside it** — a coarse tile whose v5 tile moved is a map whose zoomed-out
view disagrees with its zoomed-in one — and it costs ~0.2% of v5's bytes to do so.

---

## 11. `.wta` — the walkable tile archive, normative

**Status: this replaces the object layout.** As of 2026-07-31 the CDN publishes ONE archive
per slice per version instead of one object per cell, and the client reads tiles as HTTP
byte ranges. The object layout (`<ver>/<i>/<j>.json.gz`) is no longer published or read.
Nobody was using the app yet, so there is no compatibility layer and there should not be one.

The tile BYTES are unchanged. §10 is untouched; this section is about packaging only.

### 11.0 Why, and why not PMTiles

The motivation is the bake, not the runtime. Counted on the live bucket and the two trial
bakes, a full v5 + v5c re-bake is roughly **1.2–1.3 million Class-A writes**, which at R2's
per-million write price is essentially the whole **$6–9** cost of a bake. The bytes are
cheap; the object count is the bill. Under archives that becomes **about fifteen objects**.
ausculta's `docs/PMTILES-SCOPING.md` has the full costing and is the document this section
implements.

Nothing is saved at runtime, and it is worth saying out loud: a range request is the same
Class-B read an object GET was, the client issues the same number of tile requests it did
before, and storage and egress are unchanged. Anyone selling this as a runtime optimisation
has the wrong model.

Two structural wins, and they are the reason this is worth doing at all:

1. **"Empty" and "not baked yet" stop being the same answer.** §11.5.
2. **A republish is atomic.** An archive is one immutable object and an index entry; a
   partial upload can no longer leave the bucket in a mixed state.

**The format is NOT PMTiles v3, and that is deliberate.** The packaging idea is taken
wholesale — one archive, a directory, ranges, static hosting, no backend — and the byte
format is not. A PMTiles v3 directory is keyed by a `tileId` every reader in that ecosystem
derives from `(z, x, y)` by Hilbert order. This grid is not z/x/y; a tile id has to be
invented (§11.2). Writing invented ids into a spec-conformant v3 file produces a file every
PMTiles tool will happily open, report as valid, and then read the **wrong tile** from —
strictly worse than being unreadable, and the same class of failure this project already
paid for once (a module that resolved, type-checked and bundled while returning placeholder
values; the lesson recorded from it is *assert on a value, never on a shape*). Two lesser
reasons: v3 has no tile type for "gzipped JSON" and mandates min/max zoom this grid has no
honest value for, and its 16 KiB root-directory cap forces leaf directories and a second
round trip.

What IS taken from v3, verbatim in spirit, is the **directory encoding** (§11.3). That is
where the size lives and it is a solved problem.

The magic is `WTA1`, which no PMTiles reader accepts. That is the point.

### 11.1 File layout

| offset | bytes | field |
|---|---|---|
| 0 | 4 | magic, ASCII `WTA1` |
| 4 | 1 | format version = 1 |
| 5 | 1 | directory compression (1 = gzip) |
| 6 | 1 | tile compression (1 = gzip) |
| 7 | 1 | reserved, 0 |
| 8 | 4 | u32LE `gridDenom` = 100 (cells per degree; `TILE_DEG` = 1/100) |
| 12 | 4 | u32LE `tileCount` |
| 16 | 16 | i32LE `minI`, `maxI`, `minJ`, `maxJ` |
| 32 | 16 | u64LE `metaOffset`, `metaLength` |
| 48 | 16 | u64LE `dirOffset`, `dirLength` (gzipped size on disk) |
| 64 | 16 | u64LE `tileDataOffset`, `tileDataLength` |
| 80 | 48 | reserved, 0 |

Header is exactly **128 bytes**, then:

```
128                metadata   gzip(JSON) — self-description for a file on a disk
dirOffset          directory  gzip(§11.3)
tileDataOffset     tile data  bodies concatenated, ascending tile id, NO padding
```

Each tile body is the **exact `.json.gz` byte string** the object layout published. Nothing
is recompressed or re-serialised. `pack-archives.mjs` re-opens every archive it writes,
decodes the directory *from the file*, pulls every tile back by offset and compares it with
the source object; an archive that fails is deleted rather than published.

**Determinism is required.** Nothing in the archive carries a timestamp — `bakedAt` lives
in the index sidecar (§11.4), not in the file — and Node's gzip writes MTIME 0. So the same
tiles pack to the same bytes and `sha256(file)` is a content identity rather than a build
id. That is what makes "did this slice change" one comparison instead of a quarter of a
million (§11.6).

The header is fixed-size and first so a reader with no index can bootstrap from a single
`Range: bytes=0-127`. The client never does — `index.json` carries the directory's byte
range — so the header exists for tooling and for files on disk.

### 11.2 Tile id

```
tileId(i, j) = (i + 9000) × 36001 + (j + 18000)
```

`i ∈ [−9000, 8999]`, `j ∈ [−18000, 17999]`, so the id is injective over the whole grid and
its maximum is ≈ 6.5 × 10⁸ — inside `uint32`, which matters because the client decodes a
directory into typed arrays rather than into a `Map` an order of magnitude larger.

### 11.3 Directory

Uncompressed body, then gzipped:

```
varint   n                      entry count
n × varint   idDelta            entry 0 is the absolute id; entry k is id[k] − id[k−1], > 0
n × varint   length             tile body length in bytes
```

Varints are unsigned LEB128. **Offsets are implicit**: `offset[0] = 0`,
`offset[k] = offset[k−1] + length[k−1]`, relative to `tileDataOffset`. There is no way to
express a gap, and none is needed — the packer writes bodies contiguously in id order.

Dropping v3's explicit offset column costs the ability to dedupe identical tiles and to
carry leaf directories. Neither is worth a third of the directory here: tile bodies are
per-cell geometry and are essentially never equal, and the measurements below say a flat
directory is small enough to fetch whole.

**MEASURED** on the two trial bakes (2026-07-31), directory gzipped as stored:

| slice | ver | tiles | tile bytes | archive bytes | directory | B/entry | overhead |
|---|---|---|---|---|---|---|---|
| district-of-columbia | v4 | 188 | 14,399,444 | 14,400,356 | 607 | 3.23 | 0.006% |
| district-of-columbia | v5 | 188 | 15,231,413 | 15,232,326 | 608 | 3.23 | 0.006% |
| district-of-columbia | v5c | 135 | 28,785 | 29,396 | 306 | 2.27 | 2.123% |
| vermont | v4 | 27,737 | 117,052,777 | 117,107,382 | 54,309 | 1.96 | 0.047% |
| vermont | v5 | 28,445 | 146,156,824 | 146,213,365 | 56,245 | 1.98 | 0.039% |
| vermont | v5c | 18,486 | 3,179,256 | 3,203,229 | 23,676 | 1.28 | 0.754% |

Two bytes an entry, so a 100k-tile state carries a ~200 KB directory: one range request,
once, cached on the device for as long as the archive it describes exists. (The prototype
that argued for this format used a naive fixed-width directory and measured 3,760 B for
district-of-columbia's 188 tiles. The columnar form is 608.)

A directory lookup is a binary search. `−1` is a **HOLE** and is an ANSWER, not a failure.

### 11.4 Publishing layout and `index.json`

```
<ver>/archive/<slice>-<sha12>.wta    the archive; immutable, cache-control 1 year
<ver>/archive/<slice>.idx.json       this slice's index entry;  cache-control 60 s
<ver>/archive/index.json             every slice's entry, derived; cache-control 60 s
```

The archive is **content-addressed** — named by the first 12 hex of its own sha256 — and
that is the cache-control decision rather than a flourish. An archive at a fixed key is a
mutable object at a stable URL, which forces a short TTL on a gigabyte file so a republish
is seen, and therefore revalidation on a file that never changes in place. Naming it by its
digest inverts that: the archive is immutable and cacheable for a year, and `index.json` —
one kilobyte — is the only thing with a short TTL. A republish is a new object plus a new
index, and no client can ever see a directory that disagrees with its tiles because the two
can no longer come from different generations of the same key.

The publisher keeps **two generations** live. A client's index is at most
`ARCHIVE_INDEX_TTL_MS` (1 hour) old and is still asking for the previous archive; the
generation before that is deleted.

`index.json` is **rebuilt from the sidecars**, never read-modify-written:

```json
{ "v": 1, "version": "v5", "slices": [ { …sidecar… } ] }
```

Two slices publishing at once therefore cannot corrupt it. The worst a lost race does is
omit a slice until the next rebuild, and a missing slice reads to the client as "not baked
yet" — the honest answer, and self-healing. A read-modify-write on a shared blob would
instead delete a slice permanently, which is the race the per-slice hash manifests were
shaped to avoid in §5. The publisher asserts by VALUE that the rebuilt index contains the
slice it just uploaded, and refuses to publish the index otherwise.

Sidecar / index entry:

| field | meaning |
|---|---|
| `slice`, `version` | who and which prefix |
| `path` | key under the CDN root, e.g. `v5/archive/vermont-ed71947eba99.wta` |
| `bytes`, `sha256` | archive size and content identity |
| `tileCount`, `tileBytes` | what is inside |
| `grid` | cells per degree, 100 |
| `bbox` | `[minI, maxI, minJ, maxJ]` |
| `dir` | `[offset, length]` of the gzipped directory. The client fetches exactly this range and never reads the header. |
| `tileData` | `[offset, length]`; `offset` also equals `dir[0] + dir[1]` |
| `coverBlock`, `cover` | §11.5 |

### 11.5 Coverage bitmap — the reason "empty" and "not baked" are different answers

CLAUDE.md records the trap this removes:

> **Tile 404s cache for 5 minutes, not 30 days.** A 404 means "empty cell" — permanent for
> ocean, transient for a region not baked yet.

That hedge was forced by one-object-per-cell: from inside a single fetch nothing can tell
the two apart, so the TTL had to assume the worse one and a coastline was re-requested every
five minutes forever. The archive splits them:

* **HOLE** — some published slice's bitmap CLAIMS this cell's block, and its directory does
  not list the cell. The bake looked here and wrote nothing. **Permanent.** The client
  stores it as an empty payload on the 30-day payload TTL.
* **UNBAKED** — no published slice claims the block at all. **Transient.** The client stores
  it as `notFound` on the 5-minute TTL, which is now the only thing that flag means.

A slice's **bbox cannot do this job**. Vermont's bounding rectangle contains a large piece of
New York, so "inside the bbox and absent from the directory" would brand unbaked New York a
permanent hole and hide it for thirty days — exactly the bug the 5-minute TTL exists to
prevent. So the entry carries a bitmap of the 0.1° blocks (`coverBlock` = 10 cells ≈ 11 km)
the slice actually wrote tiles into. It follows the state's shape and it costs nothing:
**Vermont is 24 × 21 blocks, 63 bytes, 84 characters of base64.**

Encoding: row-major over `[originI .. originI + rows − 1] × [originJ .. originJ + cols − 1]`
in BLOCK indices, one bit per block, LSB first within each byte, base64.

```json
"coverBlock": 10,
"cover": { "origin": [427, -735], "dims": [24, 21], "bits": "…" }
```

**Bounded interior fill.** A block with no tile in it is usually water or emptiness the bake
DID look at; leaving it unclaimed makes the client call it "not baked" and retry it forever,
which is the behaviour this whole section removes. So a gap between two claimed blocks *on
the same row* is filled — the slice demonstrably owns ground on both sides of it at that
latitude — up to `COVER_FILL_MAX` = **8 blocks ≈ 88 km**. Cape Cod Bay (~40 km) fills;
Lake Michigan (~150 km) does not, so a slice with two lobes cannot quietly claim what sits
between them. Over the limit the answer reverts to "not baked", which is the conservative
direction: a client that retries too often is a bill, a client that caches a wrong "empty"
for thirty days is a region with no ground in it.

**The residue, stated:** a 0.1° block that straddles a slice border is claimed by whichever
slice wrote into it, so cells belonging to an unbaked neighbour inside that block read as
holes. That is a ~11 km ribbon along a state line, bounded and known, against the old
behaviour's "every unbaked cell in the world, re-requested every five minutes".

### 11.6 What "changed" means now

The per-tile hash manifest is **gone from the upload path**. It was an incremental-upload
gate and there is nothing left to gate: a slice is one object per version, and one object
either goes up or it does not. The manifests are still *written* (`tile.mjs` writes them,
`inspect-bake.mjs` reads them, and they remain the only per-cell record of what a bake
produced) and still published; they no longer decide anything.

> **Changed** now means: *this slice's archive is not byte-identical to the published one.*
> One `sha256` comparison replaces a quarter of a million, and it is exact because §11.1
> makes the archive deterministic.

The cost is granularity: it went from per-cell to **per-slice-per-version**. A one-street
edit in Vermont re-uploads 146 MB; the same edit in Utah re-uploads about a gigabyte.
PMTILES-SCOPING priced that and accepted it, on the grounds that the bakes actually run are
habitat-grid and classifier changes, which touch nearly every tile anyway — incremental
upload was already paying for almost nothing.

### 11.7 How a client resolves a tile

1. `GET <ver>/archive/index.json` — once per version per hour.
2. Candidate slices = those whose bitmap claims the cell's block, **in slice-name order**.
   None ⇒ UNBAKED.
3. For each candidate, `Range` the directory (`dir[0]`, `dir[1]`) — once per slice, cached
   under the archive's `sha256`, so a republish invalidates it with no clock involved.
4. Binary-search the directory. Present ⇒ `Range` the tile at
   `tileData[0] + offset[k]`, length `length[k]`. Absent in every candidate ⇒ HOLE.

**Request cost, measured against a local pack of district-of-columbia through real HTTP:**

| | requests |
|---|---|
| first 600 m block of a session, cold | **11** = 9 tiles + index + directory |
| any later cold block, same slice | 1 per cell (9) — identical to the object layout |
| warm block | **0** |
| a cell in an uncovered region | **0** (the index already answered) |

**A ranged read MUST require 206.** A 200 means the origin ignored `Range` and is handing
back the entire archive — about a gigabyte for a big slice, per tile, onto a phone. Both the
client and `verify-coverage.mjs` reject it by status rather than discover it by byte count.

**The tile bodies are still gzip and the platform no longer inflates them.** An object GET
carried `content-encoding: gzip` and the networking stack decompressed transparently; a
range of an archive is opaque bytes. The client inflates (`fflate`), sniffing the gzip magic
first so that if the CDN is ever configured to decode ranges the fast path costs nothing.

**Privacy is unchanged and the leak surface moved.** The cell index used to be in the URL
path and is now in the `Range` header; both are derived from the cell index alone, via the
same request set, in the same sorted order. The archive NAME is new information and is
strictly coarser than what was already disclosed — `vermont.wta` says "somewhere in
Vermont", which a 1.1 km cell index already said far more precisely. See
`apps/mobile/src/tiles/archive.ts` and `evals/tiles.test.ts` §8.

### 11.8 What was deliberately not built

**Range coalescing.** Tiles sit in the archive in tile-id order, which on this grid means
row by row, west to east — so a 3 × 3 block is three runs of three consecutive directory
entries, and nine requests could be three. It is not done, because this is a packaging
change and keeping the request count identical is what makes a regression attributable; and
because every assertion in `evals/tiles.test.ts` about dispatch order, the live-wins gate,
per-cell TTLs and the prefetch ring is written per cell, so coalescing rewrites all of them
at the same time as the transport. Round trips were never the expensive part — the coarse
layer exists because BYTES were. If it is built later it needs its own eval section proving
the privacy property survives it, and it should land alone.

**Tile dedupe and leaf directories** (§11.3). Both are v3 features this format drops and
would need a version bump to add.

**A Worker that re-serves a range with `content-encoding: gzip`** so the platform inflates
for us. It would remove the `fflate` dependency and it reintroduces a backend and a
per-request compute cost, which is the thing static archives exist to avoid.
