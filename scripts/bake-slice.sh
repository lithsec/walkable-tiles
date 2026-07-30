#!/usr/bin/env bash
# Bake one Geofabrik slice into v4 + v5 tiles and push only the changed ones to R2.
#   download .osm.pbf -> osmium tags-filter -> osmium export -> tile.mjs -> diff -> upload
# One pass writes both formats: v4 (unchanged, Cologra) and v5 (v4 + landcover/
# landmarks/habitat for Ausculta — SPEC.md §10), plus the habitat sidecar jsonl.
#
# Usage: bake-slice.sh <geofabrik-pbf-url> <slice-name>
# Env:
#   R2_DRY_RUN=1                 build tiles locally, skip all network upload
#   R2_UPLOAD_ONLY=1             skip download/filter/tile; publish an existing OUT_DIR
#                                (needs OUT_DIR with hashes.json + hashes-v5.json).
#                                Resumes a bake whose tiling succeeded and whose upload
#                                did not — the failure mode this pipeline actually hit.
#   R2_CONCURRENCY=<n>           in-flight R2 requests per aws process (default 128)
#   R2_SKIP_V4=1                 publish v5 only, leaving already-live v4 untouched. For a
#                                terrain backfill of a state that already has v4: halves the
#                                writes, and does not disturb Cologra's format. See the note
#                                at the upload call.
#   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET   (required unless dry run)
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
trap 'rm -rf "$WORK"' EXIT
PBF="$WORK/in.osm.pbf"
FILTERED="$WORK/filtered.osm.pbf"
# OUT_DIR (optional) persists the built tiles outside the temp dir — set it for
# local dev so you can `serve-local.mjs` the result. Default: throwaway temp.
OUT="${OUT_DIR:-$WORK/out}"
LOG="bake-$NAME.log"
exec > >(tee -a "$LOG") 2>&1

echo "[$NAME] === bake start ==="

# Publish-only resume: the tiles and their hash manifests already exist in OUT_DIR,
# so skip straight to the diff + upload. Guarded on the manifests rather than on the
# tile dirs, because a half-written OUT_DIR has tiles but no manifest to diff against.
UPLOAD_ONLY="${R2_UPLOAD_ONLY:-0}"
if [ "$UPLOAD_ONLY" = "1" ]; then
  [ -f "$OUT/hashes.json" ] && [ -f "$OUT/hashes-v5.json" ] || {
    echo "[$NAME] R2_UPLOAD_ONLY=1 but $OUT/hashes{,-v5}.json missing" >&2; exit 1; }
  echo "[$NAME] R2_UPLOAD_ONLY=1 — reusing tiles in $OUT, skipping download/filter/tile"
fi

if [ "$UPLOAD_ONLY" != "1" ]; then
echo "[$NAME] download $URL"
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

echo "[$NAME] tags-filter"
# Line filters feed v4 (unchanged); the a/ (area) + library filters feed v5's
# landcover/landmarks/habitat. Superset filter -> the v4 objects and their export
# are untouched, so v4 tiles stay byte-identical.
osmium tags-filter --overwrite -o "$FILTERED" "$PBF" \
  w/highway=footway,path,pedestrian,steps,track,living_street,residential,service,unclassified \
  n/highway=crossing \
  w/footway=crossing \
  a/natural=wood,water \
  a/waterway=riverbank \
  a/landuse=forest,reservoir,basin,grass,meadow,recreation_ground,village_green,farmland,farmyard,orchard,cemetery \
  a/leisure=park,garden,common,nature_reserve \
  a/amenity=library \
  n/amenity=library

echo "[$NAME] export + tile"
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
echo "[$NAME] built $TILES v4 tiles ($BYTES bytes), $TILES5 v5 tiles ($BYTES5 bytes)"

if [ "$DRY" = "1" ]; then
  echo "[$NAME] R2_DRY_RUN=1 — skipping upload; tiles in $OUT/v4 + $OUT/v5"
  cp "$OUT/hashes.json" "./hashes-$NAME.json"
  cp "$OUT/hashes-v5.json" "./hashes-v5-$NAME.json"
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

# Diff-gated upload of one tile version (v4 or v5) against its per-slice hash
# manifest (cellKey -> sha256). Manifest absent on first bake.
#   upload_version <version> <local-hashes-file>
upload_version() {
  local VER="$1" HASHFILE="$2"
  local PREV="$WORK/prev-$VER.json"
  aws s3 cp "s3://$R2_BUCKET/$VER/hashes/$NAME.json" "$PREV" 2>/dev/null || echo '{}' > "$PREV"

  # Changed = new/differing hashes. Removed = keys gone from this build.
  jq -r --slurpfile o "$PREV" '$o[0] as $old | to_entries[] | select($old[.key] != .value) | .key' \
    "$HASHFILE" > "$WORK/changed-$VER.keys"
  jq -r --slurpfile n "$HASHFILE" '$n[0] as $new | to_entries[] | select($new[.key] == null) | .key' \
    "$PREV" > "$WORK/removed-$VER.keys"

  CHANGED=$(wc -l < "$WORK/changed-$VER.keys" | tr -d ' ')
  REMOVED=$(wc -l < "$WORK/removed-$VER.keys" | tr -d ' ')
  echo "[$NAME] $VER: uploading $CHANGED changed, deleting $REMOVED removed"

  key_to_path() { sed "s#:#/#; s#\$#.json.gz#; s#^#$VER/#"; }

  # Upload changed tiles.
  #
  # One `aws s3 cp` per object is the obvious shape and it is ~10x too slow: measured
  # 15.6 objects/s at `xargs -P 16` on a 12-core box, because each child pays Python
  # interpreter startup and the box saturates on that, not on the network. A slice is
  # 100k–250k objects per version, so that is 3–5 hours of pure process spawning.
  # Instead: hardlink the changed tiles into a staging tree that mirrors the R2 layout
  # (instant on APFS, no bytes copied) and hand the tree to ONE `aws s3 cp --recursive`,
  # which reuses its own connection pool — measured 160 objects/s, same bytes, same
  # headers. Every tile in a bake gets identical metadata, which is what makes a single
  # recursive cp equivalent to N individual ones.
  local STAGE="$WORK/stage-$VER"
  rm -rf "$STAGE"
  if [ "$CHANGED" -gt 0 ]; then
    mkdir -p "$STAGE"
    # Staging is `cpio -p`, not a shell loop, for the same reason the upload is one
    # aws process: 170k iterations of `mkdir -p` + `ln` is 170k forks, measured at
    # ~100 files/s — half an hour to stage what then takes 18 minutes to send.
    # `cpio -pdl` does the whole list in one process (-d makes parent dirs,
    # -l hardlinks instead of copying bytes) at ~1,250 files/s. The fallback drops
    # -l for the one case it cannot serve: OUT and WORK on different filesystems.
    ( cd "$OUT" && key_to_path < "$WORK/changed-$VER.keys" | cpio -pdl --quiet "$STAGE" ) \
      || ( cd "$OUT" && key_to_path < "$WORK/changed-$VER.keys" | cpio -pd --quiet "$STAGE" )

    # Assert on the VALUE, not on the exit code. cpio reports per-file failures on
    # stderr and still exits 0, so "staging succeeded" is only ever provable by
    # counting what landed. Without this an empty stage feeds `cp --recursive` an
    # empty tree, which uploads nothing and reports success — a bake that publishes
    # a hash manifest claiming tiles the bucket never received.
    local STAGED
    STAGED=$(find "$STAGE" -name '*.json.gz' | wc -l | tr -d ' ')
    [ "$STAGED" -eq "$CHANGED" ] || {
      echo "[$NAME] $VER: staged $STAGED of $CHANGED changed tiles — refusing to upload a partial set" >&2
      exit 1; }

    aws s3 cp "$STAGE/$VER" "s3://$R2_BUCKET/$VER" --recursive \
      --content-type application/json \
      --content-encoding gzip \
      --cache-control "public, max-age=604800" \
      --only-show-errors
    rm -rf "$STAGE"
  fi

  # Delete tiles that no longer have data.
  key_to_path < "$WORK/removed-$VER.keys" | xargs -r -P 16 -I{} \
    aws s3 rm "s3://$R2_BUCKET/{}" --only-show-errors

  # Refresh the slice's hash manifest (per-slice avoids a multi-runner
  # read-modify-write race on a single shared file).
  aws s3 cp "$HASHFILE" "s3://$R2_BUCKET/$VER/hashes/$NAME.json" \
    --content-type application/json --only-show-errors
}

# ── PUBLISHING v4 IS OPTIONAL, AND SKIPPING IT IS THE CHEAP PATH FOR A TERRAIN BACKFILL ──
#
# v5 is v4 plus landcover/landmarks, and it DUPLICATES v4 wholesale to do it — measured on
# live tiles: downtown SLC v4 880,063 B vs v5 890,931 B, so the terrain is 1.2% of the
# payload and the other 98.8% is the same ways, names and crossings twice over.
#
# So when a state already HAS live v4 and the point of the run is to backfill v5 (arizona,
# florida, kansas — the Ausculta terrain gap), publishing v4 again is half the Class-A
# writes for no new capability: 560,723 objects across those three, about $2.50.
#
# It is also the SAFER default in that situation, which is the better argument. v4 is
# Cologra's format and Cologra is shipping; refreshing its tiles as a side effect of an
# Ausculta terrain bake changes a live app's data for reasons that have nothing to do with
# that app. `R2_SKIP_V4=1` keeps the running system still and touches only what was asked
# for. Leave it OFF for a genuine refresh, where re-baking v4 from a newer extract IS the
# point.
if [ "${R2_SKIP_V4:-0}" = 1 ]; then
  echo "[$NAME] R2_SKIP_V4=1 — leaving v4 as published, uploading v5 only"
  V4_CHANGED=0 V4_REMOVED=0
else
  upload_version v4 "$OUT/hashes.json"
  V4_CHANGED=$CHANGED V4_REMOVED=$REMOVED
fi
upload_version v5 "$OUT/hashes-v5.json"

# Habitat sidecar for the game server (small; re-upload every bake, no diff).
aws s3 cp "$OUT/habitat-$NAME.jsonl" "s3://$R2_BUCKET/v5/habitat/$NAME.jsonl" \
  --content-type application/x-ndjson --only-show-errors

# Per-slice build stamp. v4 fields keep their original names; v5 fields are additive.
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg name "$NAME" --arg ts "$TS" \
  --argjson tiles "$TILES" --argjson changed "$V4_CHANGED" --argjson removed "$V4_REMOVED" --argjson bytes "${BYTES:-0}" \
  --argjson tiles5 "$TILES5" --argjson changed5 "$CHANGED" --argjson removed5 "$REMOVED" --argjson bytes5 "${BYTES5:-0}" \
  '{name:$name, bakedAt:$ts, tiles:$tiles, changed:$changed, removed:$removed, bytes:$bytes,
    v5:{tiles:$tiles5, changed:$changed5, removed:$removed5, bytes:$bytes5}}' \
  > "$WORK/build.json"
aws s3 cp "$WORK/build.json" "s3://$R2_BUCKET/v4/build/$NAME.json" \
  --content-type application/json --only-show-errors

echo "[$NAME] === bake done ==="
