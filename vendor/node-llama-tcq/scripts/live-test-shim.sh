#!/usr/bin/env bash
# Live HTTP test runner for TCQ-shim.
# Assumes a TCQ-shim is listening on $BASE (default http://127.0.0.1:8081).
# Run after manually starting:  bun run dev -- serve --model ... --port 8081 ...

set -u
BASE="${BASE:-http://127.0.0.1:8081}"
MODEL="${MODEL:-qwen3.5-9b}"
LOG="$(dirname "$0")/../live-test-results.log"
: > "$LOG"

pass=0; fail=0
run() {
    local name="$1"; local payload="$2"; local extract_jq="${3:-.choices[0].message.content}"
    local t0 t1 dt body content reasoning fr
    echo "===== $name =====" | tee -a "$LOG"
    t0=$(date +%s%3N)
    body=$(curl -sS --max-time 600 -H 'content-type: application/json' \
        -X POST "$BASE/v1/chat/completions" -d "$payload")
    t1=$(date +%s%3N); dt=$((t1 - t0))
    if [ -z "$body" ]; then
        echo "FAIL: empty body (${dt}ms)" | tee -a "$LOG"; fail=$((fail+1)); return
    fi
    content=$(echo "$body" | jq -r "$extract_jq // \"\"" 2>/dev/null)
    reasoning=$(echo "$body" | jq -r '.choices[0].message.reasoning_content // ""' 2>/dev/null)
    fr=$(echo "$body" | jq -r '.choices[0].finish_reason // ""' 2>/dev/null)
    local clen=${#content}; local rlen=${#reasoning}
    echo "time=${dt}ms finish=${fr} content_len=${clen} reasoning_len=${rlen}" | tee -a "$LOG"
    echo "--- content (first 200) ---" | tee -a "$LOG"
    echo "${content:0:200}" | tee -a "$LOG"
    if [ -n "$reasoning" ]; then
        echo "--- reasoning (first 120) ---" | tee -a "$LOG"
        echo "${reasoning:0:120}" | tee -a "$LOG"
    fi
    if [ "$clen" -gt 0 ] || [ -n "$(echo "$body" | jq -r '.choices[0].message.tool_calls // empty')" ]; then
        pass=$((pass+1)); echo "PASS" | tee -a "$LOG"
    else
        fail=$((fail+1)); echo "FAIL: empty content + no tool_calls" | tee -a "$LOG"
    fi
    echo "" | tee -a "$LOG"
}

# T1: simple greeting (think off)
run "T1 hello (think off)" "$(cat <<EOF
{"model":"$MODEL","messages":[{"role":"user","content":"用一句話回答：你好嗎？"}],"max_tokens":256,"reasoning":"off"}
EOF
)"

# T2: simple greeting (think on)
run "T2 hello (think on)" "$(cat <<EOF
{"model":"$MODEL","messages":[{"role":"user","content":"用一句話回答：你好嗎？"}],"max_tokens":1024,"reasoning":"on"}
EOF
)"

# T3: logic CoT (think on, large budget) - the famously-hard case
run "T3 logic CoT (think on)" "$(cat <<EOF
{"model":"$MODEL","messages":[{"role":"user","content":"小明有3顆蘋果，給了小華一半再買了4顆，現在有幾顆？請逐步思考。"}],"max_tokens":8192,"reasoning":"on"}
EOF
)"

# T4: math (think auto)
run "T4 math 17*23" "$(cat <<EOF
{"model":"$MODEL","messages":[{"role":"user","content":"17 乘以 23 等於多少？"}],"max_tokens":1024}
EOF
)"

# T5: multi-turn
run "T5 multi-turn" "$(cat <<EOF
{"model":"$MODEL","messages":[
  {"role":"user","content":"我叫 Loren。"},
  {"role":"assistant","content":"好的 Loren，有什麼可以幫忙？"},
  {"role":"user","content":"剛剛我叫什麼名字？"}
],"max_tokens":256,"reasoning":"off"}
EOF
)"

# T6: tool_calls non-stream
run "T6 tool_calls (non-stream)" "$(cat <<EOF
{"model":"$MODEL","messages":[{"role":"user","content":"台北現在天氣如何？用 get_weather 查詢。"}],
"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
"tool_choice":"auto","max_tokens":1024,"reasoning":"off"}
EOF
)" '.choices[0].message.tool_calls'

# T7: streaming basic - count chunks
echo "===== T7 streaming basic =====" | tee -a "$LOG"
t0=$(date +%s%3N)
chunks=$(curl -sS --max-time 120 -N -H 'content-type: application/json' \
    -X POST "$BASE/v1/chat/completions" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"從 1 數到 5\"}],\"max_tokens\":128,\"stream\":true,\"reasoning\":\"off\"}" \
    | grep -c "^data: ")
t1=$(date +%s%3N); dt=$((t1 - t0))
echo "time=${dt}ms data_chunks=${chunks}" | tee -a "$LOG"
if [ "$chunks" -gt 2 ]; then pass=$((pass+1)); echo "PASS" | tee -a "$LOG"; else fail=$((fail+1)); echo "FAIL" | tee -a "$LOG"; fi
echo "" | tee -a "$LOG"

# T8: streaming with tool sniffer
echo "===== T8 streaming + tool =====" | tee -a "$LOG"
t0=$(date +%s%3N)
output=$(curl -sS --max-time 120 -N -H 'content-type: application/json' \
    -X POST "$BASE/v1/chat/completions" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"高雄天氣？用 get_weather 查詢。\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"description\":\"Weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}}],\"tool_choice\":\"auto\",\"max_tokens\":512,\"stream\":true,\"reasoning\":\"off\"}")
t1=$(date +%s%3N); dt=$((t1 - t0))
has_tool=$(echo "$output" | grep -c '"tool_calls"')
chunks=$(echo "$output" | grep -c "^data: ")
echo "time=${dt}ms data_chunks=${chunks} tool_call_chunks=${has_tool}" | tee -a "$LOG"
if [ "$has_tool" -gt 0 ]; then pass=$((pass+1)); echo "PASS" | tee -a "$LOG"; else fail=$((fail+1)); echo "FAIL: no tool_calls in stream" | tee -a "$LOG"; fi
echo "" | tee -a "$LOG"

# Health & models meta
echo "===== meta /health /v1/models =====" | tee -a "$LOG"
curl -sS "$BASE/health" | tee -a "$LOG"; echo "" | tee -a "$LOG"
curl -sS "$BASE/v1/models" | tee -a "$LOG"; echo "" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "================================" | tee -a "$LOG"
echo "Total: PASS=${pass} FAIL=${fail}" | tee -a "$LOG"
echo "Log: $LOG"
exit $fail
