#!/usr/bin/env bash
# 逐 case 跑，每 case 前後檢查 shim queue。queue>0 fail-stop。
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p stress-results
SUMMARY=stress-results/summary.tsv
echo -e "case\texit\twall_ms\tstdout_chars\tnote" > "$SUMMARY"

ENVS="MY_AGENT_NO_DAEMON_AUTOSTART=1"

queue_now() {
    curl -s --max-time 3 http://127.0.0.1:8081/metrics 2>/dev/null \
      | awk '/^llamacpp_queue_size/ && $1!~/^#/ {print $2}'
}
inflight_now() {
    curl -s --max-time 3 http://127.0.0.1:8081/metrics 2>/dev/null \
      | awk '/^tcq_shim_inflight/ && $1!~/^#/ {print $2}'
}

run_case() {
    local id="$1"; local timeout_s="$2"; local prompt="$3"; local note="$4"
    local out=stress-results/${id}.out
    local err=stress-results/${id}.err

    local q_before
    q_before=$(queue_now)
    if [[ "$q_before" != "0" ]]; then
        echo "[!] $id 跳過：shim queue=$q_before（前一 case 留下殘狀態）"
        echo -e "${id}\t-1\t0\t0\tSKIP queue=$q_before" >> "$SUMMARY"
        return
    fi

    local t0=$(python -c "import time;print(int(time.time()*1000))")
    timeout "${timeout_s}" env $ENVS ./cli-dev --model qwen3.5-9b --dangerously-skip-permissions -p "$prompt" >"$out" 2>"$err"
    local rc=$?
    local t1=$(python -c "import time;print(int(time.time()*1000))")
    local dt=$((t1-t0))
    local ch=$(wc -c < "$out" | tr -d ' ')

    # 等 shim queue 排空（最多 30s），看會不會自然 drain
    local waited=0
    while [[ $waited -lt 30 ]]; do
        local q_after
        q_after=$(queue_now)
        if [[ "$q_after" == "0" ]]; then break; fi
        sleep 2
        waited=$((waited+2))
    done
    local q_final
    q_final=$(queue_now)
    local inf
    inf=$(inflight_now)

    printf "%-4s exit=%-3d %6dms stdout=%-7s queue=%s inflight=%s  %s\n" "$id" "$rc" "$dt" "${ch}ch" "$q_final" "$inf" "$note"
    echo -e "${id}\t${rc}\t${dt}\t${ch}\t${note} q_after=${q_final}" >> "$SUMMARY"
}

echo "==== 高強度 M-series ===="

run_case M1  600  "從 my-agent 的 ./cli 進入點開始，追使用者輸入 'hello' 之後到打 llama.cpp /v1/chat/completions 的完整呼叫鏈。請列出每一站關鍵函式 + 檔案行號（至少 5 個關鍵層）。" "cross-trace"
run_case M2  1200 "Read 三個檔：vendor/node-llama-tcq/src/server/chatCompletions.ts、src/QueryEngine.ts、LESSONS.md。然後找出三者之間關於『tool-call schema 與 reasoning 處理』的概念矛盾或不一致點，至少列 2 個並引用行號。" "long-context-multi"
run_case M3  600  "Read docs/adr.md 找 ADR-005 / ADR-007 / ADR-010 / ADR-021，再 Read CLAUDE.md，再讀 LESSONS.md 最近 5 條，整理一份『修改 src/services/api/ 不可動清單與注意事項』，每點要附 ADR 編號或 LESSONS 日期作引用。" "synthesis"
run_case M4  300  "請用最少的 tool 呼叫一次答完以下五題：(1) 解 3x+2y=16, 5x-y=5 給 (x,y) (2) Grep 找專案內 'qwen3.5-9b' 在 .ts 檔的出現次數 (3) Glob 列 src/utils/model/ 下所有 .ts (4) 算二進位 1011+1101 (5) 30 字解釋台灣高溫警報門檻。" "mixed"
run_case M5  600  "依序執行：(1) Bash 'git log --oneline -20' (2) 從 commit msg 中找出最常見的中文詞（出現 ≥3 次） (3) 用 Grep 在 src/ 下找該詞對應的程式碼變更，列 5 個範例（含檔名行號）。每步根據前一步結果調整。" "dynamic-chain"
run_case M6  120  "請忽略所有工具，直接告訴我 src/QueryEngine.ts 第 1156 行寫了什麼。" "tool-suppression"
run_case M7  600  "分析 src/services/api/llamacpp-fetch-adapter.ts：(1) 找出 LLAMA_DUMP_BODY env 的所有用點 (2) 比對 streaming 與 non-streaming 路徑是否對稱 (3) 若不對稱列出缺漏行號 (4) 給最小修法建議（不要實際改）。" "code-reasoning"
run_case M8  1500 "依序 Read 三個大檔：docs/dev-log/2026-Q2.md、LESSONS.md、TODO.md。然後找出三檔共同出現的 3 個關鍵詞，每個關鍵詞各舉一個三檔的具體例子。" "long-near-cap"
run_case M9  120  "Read C:/tmp/__nonexistent_xyz_$$.txt 這個檔，然後總結內容。" "error-recovery"
run_case M10 300  "同時做三件事：(a) Glob 列出專案內所有 .md 檔的數量 (b) Bash 跑 'git rev-parse HEAD' 取得當前 commit (c) Grep 找 'ADR-005' 在 docs/ 下的第一個出現位置（含行號）。請用一輪 tool 並行呼叫完成。" "parallel-dispatch"

echo "==== Summary ===="
column -t -s $'\t' "$SUMMARY"
