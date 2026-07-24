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
