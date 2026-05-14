#!/bin/bash
# 兩階段：fence 在 thinking-coding 跑、refusal 在 thinking-general 跑
set -u
source /c/Users/LOREN/miniconda3/etc/profile.d/conda.sh
conda activate aiagent
cd "$(dirname "$0")/.."

REPS=${REPS:-5}

echo "[$(date +%T)] === Phase 1: fence cases × $REPS on thinking-coding ==="
sed -i 's/"defaultSamplingPreset": "[^"]*"/"defaultSamplingPreset": "thinking-coding"/' "$HOME/.virtual-assistant-desktop/llamacpp.jsonc"
CASES_GROUP=fence REPS=$REPS bun vendor/node-llama-tcq/scripts/live-test-rate-verify.ts

echo ""
echo "[$(date +%T)] === Phase 2: F2 refusal × $REPS on thinking-general ==="
sed -i 's/"defaultSamplingPreset": "[^"]*"/"defaultSamplingPreset": "thinking-general"/' "$HOME/.virtual-assistant-desktop/llamacpp.jsonc"
CASES_GROUP=refusal REPS=$REPS bun vendor/node-llama-tcq/scripts/live-test-rate-verify.ts

echo ""
echo "[$(date +%T)] === Done ==="
