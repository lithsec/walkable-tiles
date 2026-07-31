#!/usr/bin/env bash
# One-time whole-world (or any slices file) seed: bake every slice locally and upload to R2.
# After this, the GitHub Actions schedule keeps tiles fresh incrementally — bake-slice.sh
# diffs each slice against the hash manifests this run seeds, so CI then uploads only changes.
#
# Resumable: each finished slice drops a marker in STATE_DIR; re-running skips it. Failures
# are logged and retried on the next run. Bounded concurrency (be polite to Geofabrik).
#
# Usage:  R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=… \
#           ./scripts/bake-all.sh [slices.world.json]
# Env:    JOBS (parallel slices, default 3)   STATE_DIR (default .bake-state)
#         R2_DRY_RUN=1 to build locally without uploading (smoke test the loop)
#         R2_CONCURRENCY is inherited by each bake-slice.sh, so in-flight R2 requests
#         are JOBS × R2_CONCURRENCY (default 3 × 128 = 384). Turn one down if R2
#         starts 429ing; the uploads are the only thing here that talks to R2.
set -euo pipefail

SLICES="${1:-slices.json}"
JOBS="${JOBS:-3}"
STATE="${STATE_DIR:-.bake-state}"
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$STATE"

command -v jq >/dev/null || { echo "need jq"; exit 1; }
command -v osmium >/dev/null || { echo "need osmium-tool"; exit 1; }
[ -f "$SLICES" ] || { echo "no slices file: $SLICES"; exit 1; }

TOTAL=$(jq length "$SLICES")
echo "baking $TOTAL slices from $SLICES — $JOBS parallel, state in $STATE"

# ── KEEP THE TILES. THE BAKE IS THE EXPENSIVE PART; PUBLISHING IS NOT ────────────────
#
# `bake-slice.sh` defaults OUT_DIR to a directory under `mktemp -d`, which is deleted when
# the slice finishes. That is right for a one-shot publish and wrong for everything else,
# because it throws away the ONLY expensive artifact: a full re-bake is 6-10 hours of
# download, osmium, tiling and DEM sampling, while the upload that follows is about two of
# those hours and is the only part that cares what format the tiles are published in.
#
# Retaining the output makes the publish step REPEATABLE at zero bake cost — `R2_UPLOAD_ONLY=1`
# already republishes an existing OUT_DIR without re-tiling. That is what lets the packaging
# decision (one object per cell, or a single archive per slice) be made or REVISITED after
# the bake rather than before it, and it is the difference between changing your mind costing
# a command and costing another overnight run.
#
# Set BAKE_OUT=/some/path to put them elsewhere. Budget roughly the published size: the five
# live slices are on the order of 5 GB across v4, v5 and v5c.
BAKE_OUT="${BAKE_OUT:-$PWD/out-bake}"
mkdir -p "$BAKE_OUT"
echo "keeping tiles in $BAKE_OUT (publish is repeatable from here; see R2_UPLOAD_ONLY)"

bake_one() {
  name="$1"; url="$2"
  if [ -f "$STATE/$name.done" ]; then echo "skip  $name (already done)"; return 0; fi
  echo ">>>   $name"
  if OUT_DIR="$BAKE_OUT/$name" "$DIR/bake-slice.sh" "$url" "$name" >"$STATE/$name.log" 2>&1; then
    touch "$STATE/$name.done"
    echo "ok    $name"
  else
    echo "$name" >>"$STATE/failures.txt"
    echo "FAIL  $name (see $STATE/$name.log; retried on re-run)" >&2
  fi
}

# bash 3.2-safe concurrency pool (macOS default bash lacks `wait -n`).
throttle() { while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$JOBS" ]; do sleep 2; done; }

: >"$STATE/failures.txt" 2>/dev/null || true
while IFS=$'\t' read -r name url; do
  throttle
  bake_one "$name" "$url" &
done < <(jq -r '.[] | [.name, .url] | @tsv' "$SLICES")
wait

DONE=$(find "$STATE" -name '*.done' | wc -l | tr -d ' ')
FAILS=$( [ -s "$STATE/failures.txt" ] && sort -u "$STATE/failures.txt" | wc -l | tr -d ' ' || echo 0 )
echo "=== bake-all done: $DONE/$TOTAL slices complete, $FAILS failed ==="
[ "$FAILS" = "0" ] || { echo "re-run to retry failures:"; sort -u "$STATE/failures.txt"; }
