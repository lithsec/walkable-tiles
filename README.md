# walkable-tiles

Pre-bakes the whole world's **walkable ways + street names + pedestrian
crossings** from OpenStreetMap into small static tiles, uploaded to
**Cloudflare R2** and served through a CDN. The app fetches one tile per
location instead of hitting a live PostGIS/Overpass backend.

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

Baking to the **cell center** (not a runner's exact position) makes every tile
deterministic and cacheable. Because the 1200 m box overspills the 1.1 km cell,
a way near a boundary lands in ~4 neighboring tiles — accepted duplication
(~4–5×) that keeps the app's coverage behavior byte-for-byte identical and lets
`ensureCoverage`'s edge-refetch work unchanged.

---

## R2 layout

```
walkable-tiles/
  v4/build/<slice>.json      # per-slice last-baked timestamp, tile/changed counts, bytes
  v4/hashes/<slice>.json     # content hash per tile from the last build (diff input)
  v4/<latIdx>/<lngIdx>.json.gz   # one gzip-compressed v4 payload per data-bearing cell
```

- Served at `${TILES_HOST}/v4/<latIdx>/<lngIdx>.json.gz`, where `TILES_HOST` is the
  Cloudflare custom domain in front of R2 — supplied to the app as a build-time env
  var, never committed here. (The data is ODbL, so the host is operational config,
  not a true secret.)
- `Cache-Control: public, max-age=604800` (7 d). No purge needed — walkable infra
  barely moves, and the app's on-device cache is 60 d, so freshness is inherently
  loose (see below). Force freshness by bumping the path prefix (`v5/…`).
- **404 = no walkable data in that cell** → app treats as empty, optionally falls
  back to Overpass.
- Only **data-bearing** cells are written (oceans/empty land skipped), cutting
  ~2 B theoretical cells to ~5–10 M real ones.

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
4. **Assemble** each owned cell's v4 payload → gzip.
5. **Diff-gated upload:** hash each tile, compare to `v4/hashes/<slice>.json`;
   PUT only changed tiles (minimizes R2 Class-A writes), then refresh the hash
   manifest and the per-slice `build/<slice>.json` stamp.

The osmium steps stream (low memory); tiles flush per-cell, so any Geofabrik
country/state extract fits a free runner's disk.

---

## Repo layout

```
.github/workflows/bake.yml   # the daily matrix workflow (see SPEC.md)
slices.json                  # Geofabrik extracts × assigned day-of-month
scripts/bake-slice.sh        # download → filter → tile → diff → upload
scripts/tile.mjs             # OSM features → v4 tiles + gzip
scripts/serve-local.mjs      # serve baked tiles locally like the CDN (dev only)
LICENSE  NOTICE  DATA-LICENSE.md
SPEC.md                      # matrix / scheduling / boundary / diff design
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
node scripts/serve-local.mjs ./out            # http://localhost:8788, gzip headers, 404 = empty
# iOS simulator can use localhost; a real device on your LAN uses your Mac's IP.
# In the app build:  EXPO_PUBLIC_TILES_HOST=http://localhost:8788
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

## App wiring

The app change is small: `walkableWaysRemote(pos)` fetches
`v4/<latIdx>/<lngIdx>.json.gz` and returns the **full v4 payload** (ways + names
+ crossings) instead of the ways-only PostGIS RPC — which also fixes the current
gap where remote tiles carry no crossings. Overpass stays as the R2-miss
fallback. See `SPEC.md §6`.
