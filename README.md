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
LICENSE  NOTICE  DATA-LICENSE.md
SPEC.md                      # matrix / scheduling / boundary / diff design
```

## Running locally

```bash
# One slice, dry-run (no upload):
R2_DRY_RUN=1 ./scripts/bake-slice.sh \
  https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf massachusetts

# Real upload needs R2 creds in env:
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=walkable-tiles
./scripts/bake-slice.sh <pbf-url> <slice-name>
```

## App wiring

The app change is small: `walkableWaysRemote(pos)` fetches
`v4/<latIdx>/<lngIdx>.json.gz` and returns the **full v4 payload** (ways + names
+ crossings) instead of the ways-only PostGIS RPC — which also fixes the current
gap where remote tiles carry no crossings. Overpass stays as the R2-miss
fallback. See `SPEC.md §6`.
