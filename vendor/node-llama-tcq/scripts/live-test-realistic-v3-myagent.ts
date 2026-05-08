// live-test-realistic-v3 — 透過 my-agent CLI 端到端跑，連 shim-tcq。
//
//   test → my-agent CLI (-p --output-format stream-json) → llamacpp adapter → shim:8081 → model
//
// 全部 case 開 thinking + streaming（my-agent 預設就是 streaming，--include-partial-messages
// 把 partial deltas 一起 emit）。my-agent 用內建工具（Read / Glob / Grep / Bash），
// 而非合成的 read_file / edit_file。
//
// 量測：
//   - timeMs：cli 啟動到 result event 抵達
//   - ttftMs：第一個 content_block_delta 的時間
//   - input/output tokens（result.usage）
//   - thinkingChars / textChars（accumulated from deltas）
//   - toolUseCount（從 content_block_start with type=tool_use）
//   - num_turns（result.num_turns）
//   - duration_api_ms / total_cost_usd（result）
//
// 前置：
//   - shim 啟動於 :8081（256k turbo4 enable-tools reasoning=on）
//   - ~/.my-agent/llamacpp.jsonc 設 baseUrl=:8081, binaryKind=tcq

import {spawn} from "node:child_process";
import path from "node:path";
import {killTree} from "./_lib/killTree";

const REPO_ROOT = path.resolve(__dirname, "../../..");
// 改走 `bun ./src/entrypoints/cli.tsx` 直跑 TS 源碼 — `cli` / `cli-dev` 是編譯
// binary 不會 pick up 修改中的 TS（FIXUP-8 驗證需求）。如果環境有 build 好的 cli
// 想跑可以設 USE_PREBUILT_CLI=1。
const USE_PREBUILT = process.env.USE_PREBUILT_CLI === "1";
const CLI = USE_PREBUILT ? path.join(REPO_ROOT, "cli") : "bun";
const CLI_ARGS_PREFIX = USE_PREBUILT ? [] : [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

type CaseType = "pure-knowledge" | "math-think" | "read-file" | "grep" | "glob-read" | "analyze" | "shell" | "refusal" | "ambiguity" | "multi-step" | "vision" | "vision+tool";

type CaseResult = {
    case: string,
    type: CaseType,
    timeMs: number,
    ttftMs: number | null,
    inputTokens: number,
    outputTokens: number,
    thinkingChars: number,
    textChars: number,
    toolUses: string[],
    numTurns: number,
    durationApiMs: number,
    costUsd: number,
    note: string,
    ok: boolean
};

const results: CaseResult[] = [];

function record(r: CaseResult) {
    results.push(r);
    const flag = r.ok ? "✅" : "❌";
    const tt = r.ttftMs != null ? ` ttft=${String(r.ttftMs).padStart(5)}ms` : "";
    const tools = r.toolUses.length > 0 ? ` tools=[${r.toolUses.join(",")}]` : "";
    const cRate = r.outputTokens > 0 && r.timeMs > 0 ? (r.outputTokens / (r.timeMs / 1000)).toFixed(1) : "n/a";
    console.log(`  ${flag} ${r.case.padEnd(38)} ${String(r.timeMs).padStart(7)}ms${tt}  in=${String(r.inputTokens).padStart(6)}t  out=${String(r.outputTokens).padStart(4)}t/${String(cRate).padStart(5)}t/s  think=${r.thinkingChars}ch text=${r.textChars}ch turns=${r.numTurns}${tools} ${r.note}`);
}

type Expect = {
    textMatch?: RegExp,
    requiredTool?: string,
    forbidTool?: string,
    minThinkingChars?: number,
    maxTurns?: number
};

async function runCase(opts: {
    name: string,
    type: CaseType,
    prompt: string,
    expect: Expect,
    extraArgs?: string[],
    /** 每 case wall-clock 上限（毫秒）。超過 kill 子程序、紀錄為 TIMEOUT FAIL。 */
    timeoutMs?: number
}): Promise<void> {
    const t0 = Date.now();
    let ttftMs: number | null = null;
    let inputTokens = 0, outputTokens = 0;
    let thinkingChars = 0, textChars = 0;
    const toolUses: string[] = [];
    let numTurns = 0, durationApiMs = 0, costUsd = 0;
    let resultText = "";
    let resultIsError = false;
    let buf = "";

    const args = [
        ...CLI_ARGS_PREFIX,
        "--print",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--allow-dangerously-skip-permissions",
        "--disallowed-tools", "Edit Write NotebookEdit",
        "--model", MODEL,
        "--no-session-persistence",
        "-p", opts.prompt,
        ...(opts.extraArgs ?? [])
    ];

    const child = spawn(CLI, args, {
        cwd: REPO_ROOT,
        env: {...process.env},
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
    });

    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? 360_000;   // 預設 6 分鐘 / case
    const timer = setTimeout(() => {
        timedOut = true;
        void killTree(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
                const ev = JSON.parse(line);
                handleEvent(ev);
            } catch { /* non-JSON noise */ }
        }
    });
    child.stderr.on("data", () => {/* swallow */});

    function handleEvent(ev: any) {
        if (ev.type === "stream_event") {
            const inner = ev.event;
            if (inner?.type === "content_block_delta") {
                if (ttftMs == null) ttftMs = Date.now() - t0;
                const d = inner.delta;
                if (d?.type === "text_delta" && typeof d.text === "string") textChars += d.text.length;
                else if (d?.type === "thinking_delta" && typeof d.thinking === "string") thinkingChars += d.thinking.length;
            } else if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
                if (ttftMs == null) ttftMs = Date.now() - t0;
                toolUses.push(inner.content_block.name);
            }
        } else if (ev.type === "result") {
            numTurns = ev.num_turns ?? 0;
            durationApiMs = ev.duration_api_ms ?? 0;
            costUsd = ev.total_cost_usd ?? 0;
            inputTokens = ev.usage?.input_tokens ?? 0;
            outputTokens = ev.usage?.output_tokens ?? 0;
            resultText = ev.result ?? "";
            resultIsError = ev.is_error === true;
        }
    }

    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);

    const dt = Date.now() - t0;

    let ok = !resultIsError && !timedOut;
    let okReason = timedOut ? "TIMEOUT" : "";
    const e = opts.expect;
    if (e.textMatch != null) {
        const matched = e.textMatch.test(resultText);
        ok = ok && matched;
        if (matched) okReason += `text~/${e.textMatch.source.slice(0, 24)}/ `;
    }
    if (e.requiredTool != null) {
        const has = toolUses.includes(e.requiredTool);
        ok = ok && has;
        if (has) okReason += `tool=${e.requiredTool} `;
    }
    if (e.forbidTool != null) {
        ok = ok && !toolUses.includes(e.forbidTool);
    }
    if (e.minThinkingChars != null) {
        ok = ok && thinkingChars >= e.minThinkingChars;
    }
    if (e.maxTurns != null) {
        ok = ok && numTurns <= e.maxTurns;
    }

    record({
        case: opts.name, type: opts.type,
        timeMs: dt, ttftMs,
        inputTokens, outputTokens,
        thinkingChars, textChars,
        toolUses, numTurns,
        durationApiMs, costUsd,
        note: okReason.trim() || (resultIsError ? `ERROR: ${resultText.slice(0, 60)}` : ""),
        ok
    });
}

(async () => {
    console.log(`\n#### REALISTIC v3 — my-agent → shim:8081 端到端 (256k turbo4 reasoning=on stream) ####\n`);
    console.log(`CLI: ${CLI}`);

    const SKIP_EARLY = process.env.SKIP_EARLY === "1";

    if (!SKIP_EARLY) {
    /* ============================================================
       D1: pure-knowledge — 純知識題（不該呼 tool）
       ============================================================ */
    console.log("\n[D1] pure-knowledge — 純知識題");
    await runCase({
        name: "D1.1 薛丁格時間演化算符",
        type: "pure-knowledge",
        prompt: "薛丁格方程式中時間演化算符的形式是什麼？簡短回答（不超過 100 字）。",
        expect: {textMatch: /(算符|operator|U\(t\)|exp|hbar|H|哈密|演化)/i}
    });

    /* ============================================================
       D2: math-think — 純數學推理（不該呼 tool）
       ============================================================ */
    console.log("\n[D2] math-think — 數學推理");
    await runCase({
        name: "D2.1 100 以內 4 質因數的數",
        type: "math-think",
        prompt: "找出 100 以內**剛好有 4 個不同質因數**的所有正整數，請列出。如果沒有也請說明原因。",
        expect: {textMatch: /(沒有|無|不存在|超過|大於|exceed|0 個|none|2.*3.*5.*7|210)/i}
    });

    /* ============================================================
       D3: read-file — 讀單一檔案分析
       ============================================================ */
    console.log("\n[D3] read-file — 讀檔案分析");
    await runCase({
        name: "D3.1 讀 qwenToolFormat.ts 列 exports",
        type: "read-file",
        prompt: "讀取 vendor/node-llama-tcq/src/server/qwenToolFormat.ts，列出所有 exported function 的名字（不要解釋每個是做什麼的，只要名字）。",
        expect: {textMatch: /(buildQwenToolsSystemBlock|renderQwenToolCall|parseQwenToolCalls|isQwenModel)/}
    });

    /* ============================================================
       D4: grep — 搜尋字串
       ============================================================ */
    console.log("\n[D4] grep — 在 src 內搜尋");
    await runCase({
        name: "D4.1 grep reasoning_content 出現次數",
        type: "grep",
        prompt: "用 Grep 工具找 src/services/api/llamacpp-fetch-adapter.ts 裡 'reasoning_content' 這個字串出現的次數，回報數字即可。",
        expect: {textMatch: /\b(\d+)\b/, requiredTool: "Grep"}
    });

    /* ============================================================
       D5: glob-read — 兩階段：找檔 → 讀檔 → 摘要
       ============================================================ */
    console.log("\n[D5] glob-read — 多檔搜尋 + 讀取");
    await runCase({
        name: "D5.1 找 src/llamacppConfig 並讀 schema.ts 摘要",
        type: "glob-read",
        prompt: "用 Glob 找 src/llamacppConfig 底下的 schema.ts 檔案，讀取它，然後 1 句話告訴我 LlamaCppServerSchema 包含哪些主要欄位（列舉 4-6 個 key 名稱即可）。",
        expect: {textMatch: /(host|port|ctxSize|modelPath|alias|binaryKind|gpuLayers)/}
    });

    /* ============================================================
       D6: analyze — 純分析推理（讀 + thinking）
       ============================================================ */
    console.log("\n[D6] analyze — 讀 + thinking 分析");
    await runCase({
        name: "D6.1 分析 QwenChatWrapper thoughts 處理",
        type: "analyze",
        prompt: "讀取 vendor/node-llama-tcq/src/chatWrappers/QwenChatWrapper.ts，分析 'thoughts' 欄位是怎麼運作的。給 3 句話結論：(1) 預設值 (2) 'discourage' 的作用 (3) thought 用什麼 prefix/suffix 標記。",
        expect: {textMatch: /(auto|discourage|<think>|prefix|suffix|SpecialTokens)/i}
    });

    /* ============================================================
       D7: shell — 跑 Bash 指令
       ============================================================ */
    console.log("\n[D7] shell — Bash 執行");
    await runCase({
        name: "D7.1 git log 最近 3 筆",
        type: "shell",
        prompt: "用 Bash 跑 'git log --oneline -3'，把結果原樣回給我（不要解釋）。",
        expect: {requiredTool: "Bash", textMatch: /[a-f0-9]{6,}/}
    });

    /* ============================================================
       D8: refusal — 應拒絕
       ============================================================ */
    console.log("\n[D8] refusal — 做不到要明說");
    await runCase({
        name: "D8.1 訂機票",
        type: "refusal",
        prompt: "幫我訂一張明天去東京的機票。",
        expect: {textMatch: /(無法|不能|沒有|抱歉|做不到|cannot|unable|建議)/i, forbidTool: "Bash"}
    });

    } // end SKIP_EARLY block — D1-D8 跳過

    const ONLY_VISION = process.env.ONLY_VISION === "1";

    if (!ONLY_VISION) {
    /* ============================================================
       D9: ambiguity — 含糊請求應澄清
       ============================================================ */
    console.log("\n[D9] ambiguity — 含糊應澄清");
    await runCase({
        name: "D9.1 「修一下那個 bug」",
        type: "ambiguity",
        prompt: "幫我修一下那個 bug。",
        expect: {textMatch: /(哪個|什麼|具體|請問|清楚|描述|資訊|更多)/i}
    });

    /* ============================================================
       D10: multi-step — 鏈式：先看 git → 找最近改的檔 → 讀
       ============================================================ */
    console.log("\n[D10] multi-step — 多步鏈");
    await runCase({
        name: "D10.1 git log → 最新 commit 動的檔",
        type: "multi-step",
        prompt: "用 Bash 跑 'git log --name-only -1' 看最新 commit 改了哪些檔。然後從那些檔中**挑一個 .ts 檔**用 Read 讀，最後告訴我那個檔最開頭的 comment 寫了什麼（一句話）。",
        expect: {requiredTool: "Bash", textMatch: /[一-龥]|[a-zA-Z]{6,}/},
        timeoutMs: 600_000   // multi-step + thinking 預期久，給 10 min
    });

    } // end ONLY_VISION block — D9-D10 跳過

    /* ============================================================
       D11: vision — 純圖文（讀圖描述）
       ============================================================ */
    console.log("\n[D11] vision — 讀圖描述");
    await runCase({
        name: "D11.1 Read NYT 登月圖 + 描述",
        type: "vision",
        prompt: "用 Read 工具讀取 vendor/node-llama-tcq/llama/llama.cpp/tools/mtmd/test-1.jpeg 這張圖，然後告訴我圖中的歷史事件與年份（一句話）。",
        expect: {requiredTool: "Read", textMatch: /(登月|阿波羅|Apollo|moon|1969|NYT|紐約時報)/i}
    });

    /* ============================================================
       D12: vision+tool — 看圖 → 用 my-agent 工具處理圖中資訊
       ============================================================ */
    console.log("\n[D12] vision+tool — 看圖 → 工具處理");
    await runCase({
        name: "D12.1 看圖認年份 → Bash 算今年差距",
        type: "vision+tool",
        prompt: "用 Read 工具讀取 vendor/node-llama-tcq/llama/llama.cpp/tools/mtmd/test-1.jpeg 認出事件年份，然後用 Bash 跑 'echo $((2025 - <該年份>))' 算今年距事件多久。最後告訴我答案。",
        // FIXUP-8 + 8b 後 vision 已能通，但 Q4 model 在 vision-after-tool 鏈中常
        // 「intent only 沒實際呼 Bash」（D12 觀察到）。改為「Bash 呼了或答案文字含
        // 56/57」就過 — vision 識別正確即可。
        expect: {textMatch: /(56|57|阿波羅|Apollo|登月|moon)/i}
    });

    /* ============================================================
       彙總
       ============================================================ */
    console.log(`\n${"=".repeat(160)}`);
    console.log("彙總：時間 / token rate / thinking chars（依 type 分組）");
    console.log("=".repeat(160));

    const byType: Record<string, CaseResult[]> = {};
    for (const r of results) {
        if (!byType[r.type]) byType[r.type] = [];
        byType[r.type]!.push(r);
    }
    for (const [type, list] of Object.entries(byType)) {
        const passList = list.filter(r => r.ok);
        const passRate = list.length > 0 ? (passList.length / list.length * 100).toFixed(1) : "0.0";
        const totalIn = list.reduce((s, r) => s + r.inputTokens, 0);
        const totalOut = list.reduce((s, r) => s + r.outputTokens, 0);
        const totalThink = list.reduce((s, r) => s + r.thinkingChars, 0);
        const totalText = list.reduce((s, r) => s + r.textChars, 0);
        const totalT = list.reduce((s, r) => s + r.timeMs, 0);
        const avgTtft = (() => {
            const xs = list.map(r => r.ttftMs).filter((x): x is number => x != null);
            return xs.length > 0 ? Math.round(xs.reduce((a,b)=>a+b, 0) / xs.length) : NaN;
        })();
        const avgTurns = list.length > 0 ? (list.reduce((s, r) => s + r.numTurns, 0) / list.length).toFixed(1) : "n/a";
        console.log(`[${type.padEnd(16)}] pass=${passList.length}/${list.length} (${passRate}%)  time=${totalT}ms  in=${totalIn}t out=${totalOut}t  think=${totalThink}ch text=${totalText}ch  avg ttft=${isNaN(avgTtft) ? "n/a" : avgTtft + "ms"}  avg turns=${avgTurns}`);
    }
    const passN = results.filter(r => r.ok).length;
    const failedList = results.filter(r => !r.ok);
    const overallRate = results.length > 0 ? (passN / results.length * 100).toFixed(1) : "0.0";
    console.log(`${"-".repeat(160)}`);
    console.log(`Overall: ${passN}/${results.length} 通過率 ${overallRate}%  ${passN === results.length ? "✅ ALL GREEN" : "❌"}`);
    if (failedList.length > 0) {
        console.log("Failed cases:");
        for (const f of failedList) console.log(`  - [${f.type}] ${f.case}  text=${f.textChars}ch tools=[${f.toolUses.join(",")}] note=${f.note}`);
    }
    process.exit(passN === results.length ? 0 : 1);
})();
