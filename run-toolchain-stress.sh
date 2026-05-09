#!/usr/bin/env bash
# T-series：工具鏈開放度梯度測試。每 case 額外記 shim chat-completion turn 數。
# 期待釐清：Qwen3.5-9B Q4 在哪一級從 bounded → open-ended 開始不收斂。
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p toolchain-results
SUMMARY=toolchain-results/summary.tsv
echo -e "case\tcategory\texit\twall_ms\tstdout_chars\tshim_turns\tnote" > "$SUMMARY"

ENVS="MY_AGENT_NO_DAEMON_AUTOSTART=1"

shim_completions() {
    curl -s --max-time 3 http://127.0.0.1:8081/metrics 2>/dev/null \
      | awk '/^tcq_shim_chat_completions_total/ && $1!~/^#/{print $2}'
}

queue_now() {
    curl -s --max-time 3 http://127.0.0.1:8081/metrics 2>/dev/null \
      | awk '/^llamacpp_queue_size/ && $1!~/^#/{print $2}'
}

run_case() {
    local id="$1"; local category="$2"; local timeout_s="$3"; local prompt="$4"
    local out=toolchain-results/${id}.out
    local err=toolchain-results/${id}.err

    # 等 shim drain
    local waited=0
    while [[ $waited -lt 30 ]]; do
        local q=$(queue_now)
        [[ "$q" == "0" ]] && break
        sleep 2; waited=$((waited+2))
    done
    if [[ "$(queue_now)" != "0" ]]; then
        echo "[!] $id 跳過：shim queue 沒清"
        echo -e "${id}\t${category}\t-1\t0\t0\t0\tSKIP queue_stuck" >> "$SUMMARY"
        return
    fi

    local turns_before=$(shim_completions)
    local t0=$(python -c "import time;print(int(time.time()*1000))")
    timeout "${timeout_s}" env $ENVS ./cli-dev --model qwen3.5-9b --dangerously-skip-permissions -p "$prompt" >"$out" 2>"$err"
    local rc=$?
    local t1=$(python -c "import time;print(int(time.time()*1000))")
    local dt=$((t1-t0))
    local ch=$(wc -c < "$out" | tr -d ' ')

    # 等任何尾巴 request drain 再讀 turns
    sleep 3
    local turns_after=$(shim_completions)
    local turns=$((turns_after - turns_before))

    printf "%-4s [%-15s] exit=%-3d %6dms stdout=%-7s turns=%-3d\n" "$id" "$category" "$rc" "$dt" "${ch}ch" "$turns"
    echo -e "${id}\t${category}\t${rc}\t${dt}\t${ch}\t${turns}\t" >> "$SUMMARY"
}

echo "==== T-series toolchain gradient ===="

# Bounded 顯式（baseline，預期應穩定通過）
run_case T1  "bounded-1tool"  120  "Read README.md，用 30 字內總結內容。"
run_case T2  "bounded-2tool"  120  "先用 Read 工具讀 LESSONS.md，再用 Bash 算它的行數，回報兩個數字（總段數 + 總行數）。"
run_case T3  "bounded-3tool"  180  "用 Glob 列出 src/utils/model/ 下的 .ts 檔，Read 第一個，回報它的行數。"

# Open MAX=N 顯式上限
run_case T4  "open-max3"      300  "請最多用 3 個工具呼叫，找出 src/services/api/ 下檔案大小最大的那個。"
run_case T5  "open-max5"      450  "請最多用 5 個工具呼叫，找出 src/QueryEngine.ts 中被引用最多次的 import 名稱。"
run_case T6  "open-max10"     600  "請最多用 10 個工具呼叫，分析 tests/integration/llamacpp/ 下的測試檔，整理出 3 個最常見的 mock 模式（含範例檔名）。"

# 早停信號：明確終止條件
run_case T7  "open-earlystop" 240  "在 src/services/api/ 下用 Grep 找含 'TODO' 的 .ts 檔，找到第一個就停，回檔名跟那一行內容。"

# 控制組：開放式無上限（預期跟 M1/M5 一樣 timeout）
run_case T8  "open-unbounded" 600  "請徹底分析 src/services/api/llamacpp-fetch-adapter.ts 中的所有錯誤處理路徑（catch、throw、error response），列出每個路徑的觸發條件、回應格式、recovery 策略。"

# 用 maxN 提示重做 M1 / M5：看是否能解原本不收斂的 case
run_case T9  "M1+maxN"        450  "請最多用 8 個工具呼叫內回答：從 my-agent 的 ./cli 進入點開始，追使用者輸入 'hello' 之後到打 llama.cpp /v1/chat/completions 的完整呼叫鏈，列每一站關鍵函式 + 檔案行號（至少 5 個關鍵層）。"
run_case T10 "M5+maxN"        450  "請最多用 6 個工具呼叫內依序執行：(1) Bash 'git log --oneline -20' (2) 從 commit msg 中找出最常見的中文詞 (3) Grep 在 src/ 下找該詞的 5 個範例。每步根據前一步結果調整。"

echo
echo "==== Summary ===="
column -t -s $'\t' "$SUMMARY"
