#!/bin/bash
# 4 preset × 12 fast case，每 preset ~5min。Log 即時可 tail。
set -u
source /c/Users/LOREN/miniconda3/etc/profile.d/conda.sh
conda activate aiagent
cd "$(dirname "$0")/.."
PRESETS=(thinking-general thinking-coding instruct-general instruct-reasoning)
OUT=stress-results/coding-fast
mkdir -p "$OUT"
total_start=$SECONDS
for preset in "${PRESETS[@]}"; do
  ts=$(date +%H:%M:%S)
  echo "[$ts] === preset: $preset ===" | tee -a "$OUT/_summary.log"
  sed -i "s/\"defaultSamplingPreset\": \"[^\"]*\"/\"defaultSamplingPreset\": \"$preset\"/" "$HOME/.my-agent/llamacpp.jsonc"
  start=$SECONDS
  bun vendor/node-llama-tcq/scripts/live-test-coding-fast.ts > "$OUT/$preset.log" 2>&1
  ec=$?
  elapsed=$((SECONDS - start))
  ts=$(date +%H:%M:%S)
  echo "[$ts]   $preset done (exit=$ec, ${elapsed}s)" | tee -a "$OUT/_summary.log"
done
total_elapsed=$((SECONDS - total_start))
echo "Done. Total ${total_elapsed}s ($(((total_elapsed)/60)) min)" | tee -a "$OUT/_summary.log"
