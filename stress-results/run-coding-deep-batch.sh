#!/bin/bash
# 4 preset × N=3 rep × 24 case 批次跑 v3-coding-deep.ts
# log: stress-results/coding-deep/<preset>-rep<N>.log
set -u
# 黃金規則 1：在 aiagent conda 環境下跑
source /c/Users/LOREN/miniconda3/etc/profile.d/conda.sh
conda activate aiagent
cd "$(dirname "$0")/.."
PRESETS=(thinking-general thinking-coding instruct-general instruct-reasoning)
REPS=${REPS:-1}
OUT=stress-results/coding-deep
mkdir -p "$OUT"
total_start=$SECONDS
for preset in "${PRESETS[@]}"; do
  ts=$(date +%H:%M:%S)
  echo "[$ts] === preset: $preset ==="
  sed -i "s/\"defaultSamplingPreset\": \"[^\"]*\"/\"defaultSamplingPreset\": \"$preset\"/" "$HOME/.virtual-assistant-desktop/llamacpp.jsonc"
  for rep in $(seq 1 "$REPS"); do
    rts=$(date +%H:%M:%S)
    echo "[$rts]   rep $rep/$REPS"
    start=$SECONDS
    REP_IDX="$rep" bun vendor/node-llama-tcq/scripts/live-test-coding-deep.ts \
      > "$OUT/$preset-rep$rep.log" 2>&1
    ec=$?
    elapsed=$((SECONDS - start))
    rts=$(date +%H:%M:%S)
    echo "[$rts]   rep $rep done (exit=$ec, ${elapsed}s)"
  done
done
total_elapsed=$((SECONDS - total_start))
echo "All 12 runs done. Total: ${total_elapsed}s ($(((total_elapsed)/60)) min)"
