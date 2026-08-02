#!/usr/bin/env bash
# Bake one Geofabrik slice into v4 + v5 tiles and publish them as ARCHIVES (SPEC §11).
#   download .osm.pbf -> osmium tags-filter -> osmium export -> tile.mjs -> pack -> publish
# Every phase is timed and the elapsed seconds are logged and recorded in the build stamp;
# a full-globe plan needs measurements, and this log used to have none.
# One pass writes three formats: v4 (unchanged, Cologra), v5 (v4 + landcover/
# landmarks/habitat for Ausculta — SPEC.md §10), and v5c (the COARSE landcover layer,
# shape only, for the zoomed-out map — SPEC.md §10.10), plus the habitat sidecar jsonl.
#
# Usage: bake-slice.sh <geofabrik-pbf-url> <slice-name>
# Env:
#   R2_DRY_RUN=1                 build tiles locally, skip all network upload
#   R2_UPLOAD_ONLY=1             skip download/filter/tile; publish an existing OUT_DIR
#                                (needs OUT_DIR with hashes.json + hashes-v5.json).
#                                Resumes a bake whose tiling succeeded and whose upload
#                                did not — the failure mode this pipeline actually hit.
#   R2_CONCURRENCY=<n>           in-flight R2 requests per aws process (default 128)
#   R2_SKIP_V4=1                 publish v5 + v5c only, leaving already-live v4 untouched,
#                                and skip PACKING v4 as well. For a terrain backfill of a
#                                state that already has v4: does not disturb Cologra's
#                                format, and saves the pack. See the note at the publish.
#   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET   (required unless dry run)
#   DEM_CACHE_DIR=<dir>          where Copernicus GLO-30 blocks are cached between bakes
#                                (default ~/.cache/walkable-tiles/dem). It MUST NOT live
#                                under $WORK — that directory is deleted on exit, and a
#                                calibration loop would then re-download hundreds of MB per
#                                run. Cold-cache cost, measured: district-of-columbia
#                                11.7 MB, vermont 255.2 MB (SPEC §10.9).
#   DEM_DISABLE=1                bake with NO elevation source. No cell classifies
#                                `mountain` and no named peak can rank as an anchor. Both
#                                are absences and neither is visible in the output, so the
#                                tiler prints a banner; use it for a network-free run and
#                                never for a bake you intend to publish.
set -euo pipefail

URL="${1:?usage: bake-slice.sh <pbf-url> <slice-name>}"
NAME="${2:?usage: bake-slice.sh <pbf-url> <slice-name>}"
DRY="${R2_DRY_RUN:-0}"

# `pwd -P` resolves symlinked path components. On macOS `mktemp -d` hands back
# /var/folders/... and /var is a symlink to /private/var; BSD `cpio -p` refuses to
# write through a symlinked component ("Cannot extract through symlink") and the
# staging step below would then stage nothing while still exiting 0 — a silent
# no-op upload. Resolve once, here, so every path derived from WORK is physical.
WORK="$(cd "$(mktemp -d)" && pwd -P)"
PBF="$WORK/in.osm.pbf"
FILTERED="$WORK/filtered.osm.pbf"
# OUT_DIR (optional) persists the built tiles outside the temp dir — set it for
# local dev so you can `serve-local.mjs` the result. Default: throwaway temp.
OUT="${OUT_DIR:-$WORK/out}"
LOG="bake-$NAME.log"
exec > >(tee -a "$LOG") 2>&1
# `tee` is a background process reading a pipe, and when the script exits the kernel does
# not wait for it to drain. The last few lines are therefore lost — silently, and always the
# same ones: the timing summary and `=== bake done ===`, i.e. exactly the lines somebody
# greps a 30 MB log for. Close the fds so tee sees EOF, then wait for it.
# `$!` is only set for a process substitution on bash 4.4+, and macOS still ships 3.2, so
# the wait is best-effort with an unconditional short settle behind it. Half a second at the
# end of a six-hour bake is not a cost worth being clever about.
TEE_PID=$!
flush_log() { exec 1>&- 2>&-; wait "$TEE_PID" 2>/dev/null || true; sleep 0.5; }
trap 'rm -rf "$WORK"; flush_log' EXIT

# ── PHASE TIMING ──────────────────────────────────────────────────────────────────────
# The log used to print `download`, `tags-filter`, `export + tile` with no timestamps, so
# after a 6–10 hour run nobody could say which phase dominated. That is fine for one state
# and useless for planning a planet: the whole globe is ~200 slices, and the answer to "how
# long" is a different number depending on whether the cost is Geofabrik's bandwidth,
# osmium's CPU, the tiler's memory or the DEM's round trips — and a different FIX in each
# case. `date +%s` rather than `$SECONDS` or `%N`: portable to macOS, and one-second
# resolution is three orders of magnitude finer than the phases being measured.
BAKE_T0=$(date +%s)
PHASE_T0=$BAKE_T0
PHASE_NAME=""
PHASE_LOG=""
phase() {
  local now; now=$(date +%s)
  if [ -n "$PHASE_NAME" ]; then
    local d=$((now - PHASE_T0))
    echo "[$NAME] ⏱ $PHASE_NAME: ${d}s"
    PHASE_LOG="${PHASE_LOG}${PHASE_LOG:+,}\"$PHASE_NAME\":$d"
  fi
  PHASE_NAME="$1"
  PHASE_T0=$now
  # `if`, not `[ … ] && echo`: with an empty argument the test is false, the `&&` chain
  # returns 1, and that is the LAST command in the function — so `phase ""` (the call that
  # closes the final phase) would return non-zero and `set -e` would kill the script one
  # line before it printed the totals. Which it did, exactly once, silently.
  if [ -n "$1" ]; then echo "[$NAME] $1"; fi
}

echo "[$NAME] === bake start === $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Publish-only resume: the tiles and their hash manifests already exist in OUT_DIR,
# so skip straight to the diff + upload. Guarded on the manifests rather than on the
# tile dirs, because a half-written OUT_DIR has tiles but no manifest to diff against.
UPLOAD_ONLY="${R2_UPLOAD_ONLY:-0}"
if [ "$UPLOAD_ONLY" = "1" ]; then
  [ -f "$OUT/hashes.json" ] && [ -f "$OUT/hashes-v5.json" ] && [ -f "$OUT/hashes-v5c.json" ] || {
    echo "[$NAME] R2_UPLOAD_ONLY=1 but $OUT/hashes{,-v5,-v5c}.json missing" >&2; exit 1; }
  echo "[$NAME] R2_UPLOAD_ONLY=1 — reusing tiles in $OUT, skipping download/filter/tile"
fi

if [ "$UPLOAD_ONLY" != "1" ]; then
phase "download $URL"
curl -fsSL --retry 3 "$URL" -o "$PBF"

# Geofabrik ships <region>.poly beside the .pbf — precise ownership boundary.
POLY_ARG=()
POLY_URL="${URL%-latest.osm.pbf}.poly"
if curl -fsSL --retry 2 "$POLY_URL" -o "$WORK/slice.poly" 2>/dev/null; then
  POLY_ARG=(--poly "$WORK/slice.poly")
  echo "[$NAME] using poly ownership"
else
  echo "[$NAME] no .poly found — falling back to full-extent ownership (may double-write seams)"
fi

phase "tags-filter"
# Line filters feed v4 (unchanged); the a/ (area) + n/ filters feed v5's
# landcover/landmarks/habitat. Superset filter -> the v4 objects and their export
# are untouched, so v4 tiles stay byte-identical.
#
# ── WHAT IS *NOT* HERE, AND WHY ────────────────────────────────────────────────────────
# `lit` and `access` (SPEC §10.6) have NO filter line and need none. `tags-filter` SELECTS
# objects and keeps every tag on the ones it selects, so both tags already arrive on every
# way the `w/highway=` line matched. They were never missing from the extract — only from
# the tiler's output. Adding a `w/lit=*` line would only widen the selection to ways we do
# not walk.
#
# `boundary=administrative` is deliberately absent too: it is the only thing that would
# give a settlement's true EXTENT, and it is a relation-heavy geometry class an order
# larger than everything else here. Settlements are carried as their centre NODE with a
# documented proximity radius instead — SPEC §10.2 says so rather than implying membership.
osmium tags-filter --overwrite -o "$FILTERED" "$PBF" \
  w/highway=footway,path,pedestrian,steps,track,living_street,residential,service,unclassified \
  n/highway=crossing \
  w/footway=crossing \
  a/natural=wood,water \
  a/waterway=riverbank \
  a/landuse=forest,reservoir,basin,grass,meadow,recreation_ground,village_green,farmland,farmyard,orchard,cemetery \
  a/leisure=park,garden,common,nature_reserve \
  a/amenity=library \
  n/amenity=library \
  n/place=city,town,village,hamlet,suburb \
  n/natural=peak \
  a/boundary=national_park,protected_area

# ── THE TILER NOW REACHES THE NETWORK, and it is not the Geofabrik download ───────────
# `mountain` (SPEC §10.4) and the peak-prominence score (§10.8) both read Copernicus GLO-30
# elevation, fetched by HTTP range from AWS Open Data with no credentials (§10.9). It is
# cached under DEM_CACHE_DIR between bakes, so the cost above is paid once per region and
# not once per bake. A missing DEM tile is the sea and is an answer; any other HTTP failure
# aborts, because a half-read elevation source silently un-classifies a mountain range.
phase "export + tile"
mkdir -p "$OUT"
osmium export "$FILTERED" -f geojsonseq --add-unique-id=type_id -o - \
  | node --max-old-space-size=12288 "$(dirname "$0")/tile.mjs" --out "$OUT" --slice "$NAME" "${POLY_ARG[@]}"
fi

# NB these count the whole OUT tree, which for a local multi-slice seed accumulates
# earlier slices too. The diff and upload below are driven strictly by this slice's
# hash manifests, so an inflated count here is cosmetic — but do not read it as
# "tiles this slice produced" (tile.mjs prints that).
TILES=$(find "$OUT/v4" -name '*.json.gz' 2>/dev/null | wc -l | tr -d ' ')
# Portable byte sum (BSD `du` has no -b): concat all tiles and count bytes.
BYTES=$(find "$OUT/v4" -type f -name '*.json.gz' -print0 2>/dev/null | xargs -0 cat 2>/dev/null | wc -c | tr -d ' ')
BYTES=${BYTES:-0}
TILES5=$(find "$OUT/v5" -name '*.json.gz' 2>/dev/null | wc -l | tr -d ' ')
BYTES5=$(find "$OUT/v5" -type f -name '*.json.gz' -print0 2>/dev/null | xargs -0 cat 2>/dev/null | wc -c | tr -d ' ')
BYTES5=${BYTES5:-0}
TILESC=$(find "$OUT/v5c" -name '*.json.gz' 2>/dev/null | wc -l | tr -d ' ')
BYTESC=$(find "$OUT/v5c" -type f -name '*.json.gz' -print0 2>/dev/null | xargs -0 cat 2>/dev/null | wc -c | tr -d ' ')
BYTESC=${BYTESC:-0}
echo "[$NAME] built $TILES v4 tiles ($BYTES bytes), $TILES5 v5 tiles ($BYTES5 bytes), $TILESC v5c coarse tiles ($BYTESC bytes)"

# ── PACK ──────────────────────────────────────────────────────────────────────────────
# One `.wta` per version (SPEC §11) instead of one object per cell. This is the step that
# turned the publish from ~1.2 million Class-A writes into about fifteen — see
# ausculta/docs/PMTILES-SCOPING.md for the costing that motivated it.
#
# It reads only OUT_DIR, so it is exactly as re-runnable as `R2_UPLOAD_ONLY=1`: the 6–10
# hour part of a bake is never repeated for a packaging change. The packer re-opens each
# archive it writes and compares every tile against its source object, so "the bytes are
# unchanged" is checked here rather than asserted in a commit message.
if [ "${R2_SKIP_V4:-0}" = 1 ]; then PACK_VERSIONS="v5,v5c"; else PACK_VERSIONS="v4,v5,v5c"; fi
phase "pack archives ($PACK_VERSIONS)"
node "$(dirname "$0")/pack-archives.mjs" --out "$OUT" --slice "$NAME" \
  --dest "$OUT/archive" --versions "$PACK_VERSIONS"

if [ "$DRY" = "1" ]; then
  echo "[$NAME] R2_DRY_RUN=1 — skipping upload; tiles in $OUT/v4 + $OUT/v5 + $OUT/v5c, archives in $OUT/archive"
  cp "$OUT/hashes.json" "./hashes-$NAME.json"
  cp "$OUT/hashes-v5.json" "./hashes-v5-$NAME.json"
  cp "$OUT/hashes-v5c.json" "./hashes-v5c-$NAME.json"
  phase ""
  echo "[$NAME] ⏱ TOTAL: $(( $(date +%s) - BAKE_T0 ))s"
  echo "[$NAME] === bake done (dry) ==="
  exit 0
fi

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}"
EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
# AWS_ENDPOINT_URL (env, exported) rather than only a shell-function wrapper: the tile
# uploads run under `xargs`, whose children exec the aws BINARY and never see a shell
# function. That exact hole once sent every tile cp to s3.auto.amazonaws.com while the
# manifest cp (main shell, function applied) succeeded — leaving a manifest that claimed
# tiles the bucket never received. The env var reaches every child.
export AWS_ENDPOINT_URL="$EP"
# In-flight requests inside ONE aws process. This is the knob that matters now that
# tiles go up via `aws s3 cp --recursive` (see upload_version) instead of one process
# per object.
export AWS_MAX_CONCURRENT_REQUESTS="${R2_CONCURRENCY:-128}"
aws() { command aws --endpoint-url "$EP" "$@"; }

# ══════════════════════════════════════════════════════════════════════════════════════
# PUBLISHING AN ARCHIVE, AND WHAT "CHANGED" MEANS NOW
# ══════════════════════════════════════════════════════════════════════════════════════
#
# The per-tile hash manifest is GONE from the upload path. It was an incremental-upload gate
# — hash every cell, diff against the published manifest, send only the differing objects —
# and there is nothing left for it to gate: a slice is one object per version, and one
# object either goes up or it does not.
#
# The manifests are still WRITTEN (tile.mjs writes them, `inspect-bake.mjs` reads them, and
# they are the only per-cell record of what a bake produced), and they are still published
# so a future bake can answer "which cells moved" without re-tiling. They just no longer
# decide anything.
#
# "CHANGED" now means: THIS SLICE'S ARCHIVE IS NOT BYTE-IDENTICAL TO THE PUBLISHED ONE.
# One sha256 comparison replaces a quarter of a million. That works because the archive is
# deterministic by construction — tiles in tile-id order, no timestamps anywhere in the file
# (`bakedAt` lives in the sidecar), gzip MTIME 0 — so the digest is a content identity and
# not a build id.
#
# The GRANULARITY of "changed" is what this costs, and it is worth saying plainly: it went
# from per-cell to per-slice-per-version. A one-street edit in Vermont now re-uploads
# 146 MB; the same edit in Utah re-uploads about a gigabyte. PMTILES-SCOPING priced that and
# accepted it, on the grounds that the bakes actually run are habitat-grid and classifier
# changes, which touch nearly every tile anyway — incremental upload was already paying for
# almost nothing.
#
# ── ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER ─────────────────────────────────────
#
# 1. the archive        `<ver>/archive/<slice>-<sha12>.wta`, immutable, cached for a year.
# 2. the sidecar        `<ver>/archive/<slice>.idx.json` — this slice's index entry.
# 3. index.json         rebuilt from EVERY sidecar in the bucket.
# 4. the old archive    the generation before last is deleted; the immediately previous one
#                       is kept, because a client can be holding an index up to an hour old
#                       and is still asking for it.
#
# Nothing between steps 1 and 3 can produce a client that sees a directory disagreeing with
# its tiles: a directory is only ever reachable through an index entry that names a specific
# immutable archive. That is the atomicity the old layout could not have — a partial upload
# there left a bucket in a genuinely mixed state, which is why the exactly-one-writer rule
# and the hash manifest existed in the first place.
#
# index.json is REBUILT FROM SIDECARS rather than read-modify-written. Two slices publishing
# at once cannot then corrupt it: the worst a lost race does is omit a slice from the index
# until the next rebuild, and a missing slice reads to the client as "not baked yet" — the
# honest answer, and self-healing. A read-modify-write on a shared blob would instead delete
# a slice permanently, which is exactly the race the per-slice hash manifests were shaped to
# avoid.
#   publish_archive <version>
publish_archive() {
  local VER="$1"
  # Set BEFORE the early return, not after: under `set -u` an unset flag is a hard exit at
  # the build stamp, and the one path that takes that return is the one nobody tests.
  ARCHIVE_CHANGED=0
  local IDX="$OUT/archive/$VER/$NAME.idx.json"
  [ -f "$IDX" ] || { echo "[$NAME] $VER: no archive packed — skipping"; return 0; }
  local ARCPATH SHA ARC
  ARCPATH=$(jq -r .path "$IDX")               # e.g. v5/archive/vermont-ab12cd34ef56.wta
  SHA=$(jq -r .sha256 "$IDX")
  ARC="$OUT/archive/$VER/$(basename "$ARCPATH")"
  [ -f "$ARC" ] || { echo "[$NAME] $VER: sidecar names $ARCPATH but the file is missing" >&2; exit 1; }

  local PREVIDX="$WORK/prev-$VER.idx.json" PREVSHA="" PREVPATH=""
  if aws s3 cp "s3://$R2_BUCKET/$VER/archive/$NAME.idx.json" "$PREVIDX" --only-show-errors 2>/dev/null; then
    PREVSHA=$(jq -r '.sha256 // ""' "$PREVIDX")
    PREVPATH=$(jq -r '.path // ""' "$PREVIDX")
  fi

  if [ "$SHA" = "$PREVSHA" ]; then
    echo "[$NAME] $VER: archive unchanged (${SHA:0:16}…) — 0 objects uploaded"
    ARCHIVE_CHANGED=0
    return 0
  fi
  ARCHIVE_CHANGED=1

  local ARCBYTES; ARCBYTES=$(jq -r .bytes "$IDX")
  local ARCTILES; ARCTILES=$(jq -r .tileCount "$IDX")
  echo "[$NAME] $VER: publishing $ARCTILES tiles as one $ARCBYTES B archive -> $ARCPATH"

  # 1. The archive. `immutable` is honest here and nowhere else in this script: the key
  #    contains the digest of the bytes, so this object can never change.
  aws s3 cp "$ARC" "s3://$R2_BUCKET/$ARCPATH" \
    --content-type application/octet-stream \
    --cache-control "public, max-age=31536000, immutable" \
    --only-show-errors

  # 2. The sidecar, SHORT-lived at the edge: it is how a republish becomes visible.
  aws s3 cp "$IDX" "s3://$R2_BUCKET/$VER/archive/$NAME.idx.json" \
    --content-type application/json --cache-control "public, max-age=60" --only-show-errors

  # 3. index.json, rebuilt from every sidecar in the bucket. ~1 KB per slice, so this is a
  #    handful of tiny GETs and one small PUT even at full-globe scale.
  local IDXDIR="$WORK/idx-$VER"
  rm -rf "$IDXDIR"; mkdir -p "$IDXDIR"
  aws s3 cp "s3://$R2_BUCKET/$VER/archive/" "$IDXDIR" --recursive \
    --exclude '*' --include '*.idx.json' --only-show-errors
  # Assert on the VALUE: the rebuild MUST contain the slice just published, or the archive
  # is in the bucket and unreachable — an upload that reports success and publishes nothing,
  # which is the failure mode this script has already been bitten by once (see the
  # AWS_ENDPOINT_URL note above).
  jq -s --arg ver "$VER" '{v:1, version:$ver, slices: sort_by(.slice)}' "$IDXDIR"/*.idx.json \
    > "$WORK/index-$VER.json"
  jq -e --arg s "$NAME" --arg sha "$SHA" \
    'any(.slices[]; .slice == $s and .sha256 == $sha)' "$WORK/index-$VER.json" > /dev/null || {
      echo "[$NAME] $VER: rebuilt index does not contain this slice at $SHA — refusing to publish it" >&2
      exit 1; }
  aws s3 cp "$WORK/index-$VER.json" "s3://$R2_BUCKET/$VER/archive/index.json" \
    --content-type application/json --cache-control "public, max-age=60" --only-show-errors

  # 4. Retire the generation BEFORE the previous one. Two live generations is the retention
  #    rule, and it is derived rather than guessed: a client's index is at most
  #    ARCHIVE_INDEX_TTL_MS (1 hour) old, so the previous archive must survive at least that
  #    long after a republish.
  local OLDER="$WORK/older-$VER.txt"
  aws s3 ls "s3://$R2_BUCKET/$VER/archive/" | awk '{print $4}' \
    | grep -E "^${NAME}-[0-9a-f]{12}\.wta$" > "$OLDER" || true
  while read -r f; do
    [ -z "$f" ] && continue
    [ "$VER/archive/$f" = "$ARCPATH" ] && continue
    [ -n "$PREVPATH" ] && [ "$VER/archive/$f" = "$PREVPATH" ] && continue
    echo "[$NAME] $VER: retiring $f"
    aws s3 rm "s3://$R2_BUCKET/$VER/archive/$f" --only-show-errors
  done < "$OLDER"

  # The per-cell hash manifest, still published — no longer a gate, still the record.
  # See the header above.
  local HASHFILE="$OUT/hashes.json"
  [ "$VER" = v5 ] && HASHFILE="$OUT/hashes-v5.json"
  [ "$VER" = v5c ] && HASHFILE="$OUT/hashes-v5c.json"
  aws s3 cp "$HASHFILE" "s3://$R2_BUCKET/$VER/hashes/$NAME.json" \
    --content-type application/json --only-show-errors
}

# ── PUBLISHING v4 IS OPTIONAL, AND SKIPPING IT IS THE CHEAP PATH FOR A TERRAIN BACKFILL ──
#
# v5 is v4 plus landcover/landmarks, and it DUPLICATES v4 wholesale to do it — measured on
# live tiles: downtown SLC v4 880,063 B vs v5 890,931 B, so the terrain is 1.2% of the
# payload and the other 98.8% is the same ways, names and crossings twice over.
#
# Under the object layout the argument for `R2_SKIP_V4=1` was mostly COST: republishing v4
# was a quarter of a million more Class-A writes. That argument is gone — v4 is now one
# object — and the remaining one is the better one anyway: v4 is Cologra's format, Cologra
# is shipping, and refreshing its tiles as a side effect of an Ausculta terrain bake changes
# a live app's data for reasons that have nothing to do with that app. The flag keeps the
# running system still. It also skips PACKING v4, which is the real saving now (minutes of
# I/O and a second copy of the slice on disk).
phase "publish"
if [ "${R2_SKIP_V4:-0}" = 1 ]; then
  echo "[$NAME] R2_SKIP_V4=1 — leaving v4 as published, uploading v5 + v5c only"
  V4_CHANGED=0
else
  publish_archive v4
  V4_CHANGED=$ARCHIVE_CHANGED
fi
publish_archive v5
V5_CHANGED=$ARCHIVE_CHANGED
# The COARSE layer (SPEC §10.10) — same machinery, nothing new. A slice that re-bakes v5
# should always re-bake this beside it: a coarse tile whose v5 tile moved is a map whose
# zoomed-out view disagrees with its zoomed-in one.
publish_archive v5c
V5C_CHANGED=$ARCHIVE_CHANGED

# Habitat sidecar for the game server (small; re-upload every bake, no diff).
aws s3 cp "$OUT/habitat-$NAME.jsonl" "s3://$R2_BUCKET/v5/habitat/$NAME.jsonl" \
  --content-type application/x-ndjson --cache-control "public, max-age=300" --only-show-errors

# Landmark ANCHOR sidecar for the game server (SPEC §10.8) — one line per distinct anchor
# the regional cap kept, which is tens per state and not the tens of thousands of tile
# listings behind them. This is the artifact that makes a landmark creature bankable at
# all: with no row here `record_claim` cannot verify the seed, and an unverifiable claim is
# a creature the player finds, records and then loses at sync (docs/LANDMARK-SPAWNS.md
# Option B, explicitly rejected).
aws s3 cp "$OUT/landmarks-$NAME.jsonl" "s3://$R2_BUCKET/v5/landmarks/$NAME.jsonl" \
  --content-type application/x-ndjson --cache-control "public, max-age=300" --only-show-errors

# Habitat atlas for the CLIENT (SPEC §10.7) — under a kilobyte per slice, one object.
# Unlike every other v5 artifact this one is fetched WHOLE and unconditionally, and that
# is the point: "which way is the nearest woodland" asked as a query is a request whose
# very existence leaks a direction, which is the same leak the sorted-neighbour-ring tile
# prefetch was designed to close. A file every player already holds cannot leak it.
aws s3 cp "$OUT/atlas-$NAME.json" "s3://$R2_BUCKET/v5/atlas/$NAME.json" \
  --content-type application/json --cache-control "public, max-age=300" --only-show-errors

# Per-slice build stamp. v4 fields keep their original names so anything reading them still
# works; `changed`/`removed` are now 1/0 ARCHIVE flags rather than object counts, because
# per-object change stopped being what the publish decides on — see publish_archive's
# header. `phases` is the new field and it is the reason the timing instrumentation exists:
# a per-phase record that survives the log, so a planet-scale plan can be built from
# measurements of the slices actually baked rather than from a guess.
phase ""
BAKE_SECONDS=$(( $(date +%s) - BAKE_T0 ))
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg name "$NAME" --arg ts "$TS" \
  --argjson tiles "$TILES" --argjson changed "$V4_CHANGED" --argjson removed 0 --argjson bytes "${BYTES:-0}" \
  --argjson tiles5 "$TILES5" --argjson changed5 "$V5_CHANGED" --argjson bytes5 "${BYTES5:-0}" \
  --argjson tilesc "$TILESC" --argjson changedc "$V5C_CHANGED" --argjson bytesc "${BYTESC:-0}" \
  --argjson seconds "$BAKE_SECONDS" --argjson phases "{$PHASE_LOG}" \
  '{name:$name, bakedAt:$ts, tiles:$tiles, changed:$changed, removed:$removed, bytes:$bytes,
    v5:{tiles:$tiles5, changed:$changed5, removed:0, bytes:$bytes5},
    v5c:{tiles:$tilesc, changed:$changedc, bytes:$bytesc},
    seconds:$seconds, phases:$phases}' \
  > "$WORK/build.json"
aws s3 cp "$WORK/build.json" "s3://$R2_BUCKET/v4/build/$NAME.json" \
  --content-type application/json --only-show-errors

echo "[$NAME] ⏱ TOTAL: ${BAKE_SECONDS}s"
echo "[$NAME] === bake done === $(date -u +%Y-%m-%dT%H:%M:%SZ)"
