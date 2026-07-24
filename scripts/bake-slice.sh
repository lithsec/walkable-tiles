#!/usr/bin/env bash
# Bake one Geofabrik slice into v4 tiles and push only the changed ones to R2.
#   download .osm.pbf -> osmium tags-filter -> osmium export -> tile.mjs -> diff -> upload
#
# Usage: bake-slice.sh <geofabrik-pbf-url> <slice-name>
# Env:
#   R2_DRY_RUN=1                 build tiles locally, skip all network upload
#   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET   (required unless dry run)
set -euo pipefail

URL="${1:?usage: bake-slice.sh <pbf-url> <slice-name>}"
NAME="${2:?usage: bake-slice.sh <pbf-url> <slice-name>}"
DRY="${R2_DRY_RUN:-0}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PBF="$WORK/in.osm.pbf"
FILTERED="$WORK/filtered.osm.pbf"
# OUT_DIR (optional) persists the built tiles outside the temp dir — set it for
# local dev so you can `serve-local.mjs` the result. Default: throwaway temp.
OUT="${OUT_DIR:-$WORK/out}"
LOG="bake-$NAME.log"
exec > >(tee -a "$LOG") 2>&1

echo "[$NAME] === bake start ==="

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
osmium tags-filter --overwrite -o "$FILTERED" "$PBF" \
  w/highway=footway,path,pedestrian,steps,track,living_street,residential,service,unclassified \
  n/highway=crossing \
  w/footway=crossing

echo "[$NAME] export + tile"
mkdir -p "$OUT"
osmium export "$FILTERED" -f geojsonseq --add-unique-id=type_id -o - \
  | node --max-old-space-size=12288 "$(dirname "$0")/tile.mjs" --out "$OUT" "${POLY_ARG[@]}"

TILES=$(find "$OUT/v4" -name '*.json.gz' 2>/dev/null | wc -l | tr -d ' ')
BYTES=$(du -sb "$OUT/v4" 2>/dev/null | cut -f1 || echo 0)
echo "[$NAME] built $TILES tiles ($BYTES bytes)"

if [ "$DRY" = "1" ]; then
  echo "[$NAME] R2_DRY_RUN=1 — skipping upload; tiles in $OUT/v4"
  cp "$OUT/hashes.json" "./hashes-$NAME.json"
  echo "[$NAME] === bake done (dry) ==="
  exit 0
fi

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}"
EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
aws() { command aws --endpoint-url "$EP" "$@"; }

# Previous per-slice hash manifest (cellKey -> sha256). Absent on first bake.
PREV="$WORK/prev.json"
aws s3 cp "s3://$R2_BUCKET/v4/hashes/$NAME.json" "$PREV" 2>/dev/null || echo '{}' > "$PREV"

# Changed = new/differing hashes. Removed = keys gone from this build.
jq -r --slurpfile o "$PREV" '$o[0] as $old | to_entries[] | select($old[.key] != .value) | .key' \
  "$OUT/hashes.json" > "$WORK/changed.keys"
jq -r --slurpfile n "$OUT/hashes.json" '$n[0] as $new | to_entries[] | select($new[.key] == null) | .key' \
  "$PREV" > "$WORK/removed.keys"

CHANGED=$(wc -l < "$WORK/changed.keys" | tr -d ' ')
REMOVED=$(wc -l < "$WORK/removed.keys" | tr -d ' ')
echo "[$NAME] uploading $CHANGED changed, deleting $REMOVED removed (of $TILES total)"

key_to_path() { sed 's#:#/#; s#$#.json.gz#; s#^#v4/#'; }

# Upload changed tiles (bounded parallelism; -r => no run on empty input).
key_to_path < "$WORK/changed.keys" | xargs -r -P 16 -I{} \
  aws s3 cp "$OUT/{}" "s3://$R2_BUCKET/{}" \
    --content-type application/json \
    --content-encoding gzip \
    --cache-control "public, max-age=604800" \
    --only-show-errors

# Delete tiles that no longer have data.
key_to_path < "$WORK/removed.keys" | xargs -r -P 16 -I{} \
  aws s3 rm "s3://$R2_BUCKET/{}" --only-show-errors

# Refresh the slice's hash manifest + per-slice build stamp (per-slice avoids a
# multi-runner read-modify-write race on a single build.json).
aws s3 cp "$OUT/hashes.json" "s3://$R2_BUCKET/v4/hashes/$NAME.json" \
  --content-type application/json --only-show-errors

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg name "$NAME" --arg ts "$TS" \
  --argjson tiles "$TILES" --argjson changed "$CHANGED" --argjson removed "$REMOVED" --argjson bytes "${BYTES:-0}" \
  '{name:$name, bakedAt:$ts, tiles:$tiles, changed:$changed, removed:$removed, bytes:$bytes}' \
  > "$WORK/build.json"
aws s3 cp "$WORK/build.json" "s3://$R2_BUCKET/v4/build/$NAME.json" \
  --content-type application/json --only-show-errors

echo "[$NAME] === bake done ==="
