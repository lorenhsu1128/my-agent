#!/bin/bash
# 批次跑 4 preset × v3-myagent 12 case，每輪換 ~/.virtual-assistant-desktop/llamacpp.jsonc 的 defaultSamplingPreset
set -u
cd "$(dirname "$0")/.."
PRESETS=(thinking-general thinking-coding instruct-general instruct-reasoning)
OUT=stress-results/preset-comparison
mkdir -p "$OUT"
for preset in "${PRESETS[@]}"; do
  ts=$(date +%H:%M:%S)
  echo "[$ts] === Running preset: $preset ==="
  # in-place 換 defaultSamplingPreset 值
  sed -i "s/\"defaultSamplingPreset\": \"[^\"]*\"/\"defaultSamplingPreset\": \"$preset\"/" "$HOME/.virtual-assistant-desktop/llamacpp.jsonc"
  start=$SECONDS
  bun vendor/node-llama-tcq/scripts/live-test-realistic-v3-myagent.ts \
    > "$OUT/$preset.log" 2>&1
  ec=$?
  elapsed=$((SECONDS - start))
  ts=$(date +%H:%M:%S)
  echo "[$ts] === Finished: $preset (exit=$ec, ${elapsed}s) ==="
done
echo "All 4 presets done."
