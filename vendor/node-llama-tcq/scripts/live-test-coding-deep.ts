// v3-coding-deep — thinking-coding preset 深度刻劃。
//
// 24 case × 9 類型，端到端跑 my-agent CLI（bun direct，不用 ./cli binary）→
// shim:8081 → qwen3.5-9b。
//
// 對照組：4 preset（thinking-general / thinking-coding / instruct-general /
// instruct-reasoning），每組 N=3 重複以衡量隨機性。批次由
// stress-results/run-coding-deep-batch.sh 驅動，env REP_IDX 標重複編號。
//
// 類型分佈：
//   A 算法實作 (3) / B 修 bug (3) / C 重構 (3) / D code review (3) /
//   E multi-file 鏈 (3) / F 邊界負向 (3) / G streaming 中斷恢復 (2) /
//   H 大量 tool (2) / I 連續錯誤 retry (2)
//
// 量測（每 case）：timeMs / ttftMs / inputTokens / outputTokens /
// thinkingChars / textChars / toolUses / numTurns + ok 判定。

import {spawn} from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const USE_PREBUILT = process.env.USE_PREBUILT_CLI === "1";
const CLI = USE_PREBUILT ? path.join(REPO_ROOT, "cli") : "bun";
const CLI_ARGS_PREFIX = USE_PREBUILT ? [] : [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

type CaseType =
    | "algorithm"
    | "bug-fix"
    | "refactor"
    | "code-review"
    | "multi-file"
    | "negative"
    | "streaming"
    | "tool-heavy"
    | "retry";

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
    maxTurns?: number,
    minToolUses?: number   // 用於 H 類「大量 tool」：toolUses 至少 N 次
};

async function runCase(opts: {
    name: string,
    type: CaseType,
    prompt: string,
    expect: Expect,
    extraArgs?: string[],
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
        "--model", MODEL,
        "--no-session-persistence",
        "-p", opts.prompt,
        ...(opts.extraArgs ?? [])
    ];

    const child = spawn(CLI, args, {
        cwd: REPO_ROOT,
        env: {...process.env},
        stdio: ["ignore", "pipe", "pipe"]
    });

    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? 360_000;
    const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* */ }
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
    if (e.minToolUses != null) {
        ok = ok && toolUses.length >= e.minToolUses;
        if (toolUses.length >= e.minToolUses) okReason += `tools>=${e.minToolUses} `;
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
    const repIdx = process.env.REP_IDX ?? "1";
    console.log(`\n#### CODING-DEEP (rep=${repIdx}) — my-agent → shim:8081 (256k turbo4 reasoning=on stream) ####\n`);
    console.log(`CLI: ${CLI}  MODEL: ${MODEL}\n`);

    /* ============================================================
       A. 算法實作 — 低溫應一次寫對
       ============================================================ */
    console.log("\n[A] algorithm — 算法實作");
    await runCase({
        name: "A1 fibonacci 兩寫法",
        type: "algorithm",
        prompt: "請寫一段 Node.js 程式：定義 fibIter(n) 與 fibMemo(n) 兩個函式（一個迭代、一個遞迴+memo），各算 fib(10) 並 console.log 結果。把整段程式包在一個 ```javascript ``` 區塊裡（不需執行）。",
        expect: {textMatch: /(55|fib(?:Iter|Memo)\s*\()/i}
    });
    await runCase({
        name: "A2 binsearch leftmost",
        type: "algorithm",
        prompt: "請用 TypeScript 寫 leftmostBinarySearch(arr: number[], target: number): number — 找最左出現位置（重複值取最左 idx，找不到回 -1）。給 [1,2,2,2,3] 找 2 預期回 1。把程式包在 ```typescript ```，含一個 console.log 範例。",
        expect: {textMatch: /(leftmost|binarySearch|while|low|high|mid)/i}
    });
    await runCase({
        name: "A3 LRU cache 結構",
        type: "algorithm",
        prompt: "用 TypeScript 寫 LRUCache class（capacity=3）：put(k,v) / get(k) 兩個方法。用 Map 即可（不用雙向鏈表）。包在 ```typescript ```，附一個 demo：put(1,'a'),put(2,'b'),put(3,'c'),get(1),put(4,'d'),console.log(cache.get(2)) — 預期最後 console 印 undefined。",
        expect: {textMatch: /(class\s+LRU|Map|capacity|evict)/i}
    });

    /* ============================================================
       B. 修 bug — thinking 應抓出邊界錯誤
       ============================================================ */
    console.log("\n[B] bug-fix — 修 bug");
    await runCase({
        name: "B1 修 off-by-one",
        type: "bug-fix",
        prompt: "下面這段 sumRange(arr, start, end) 有 bug：```js\nfunction sumRange(arr, start, end) {\n  return arr.slice(start, end).reduce((a,b)=>a+b, 0);\n}\nsumRange([1,2,3,4,5], 1, 3); // 想算 idx 1 到 3 含端點 = 2+3+4 = 9，但回 5\n```\n指出 bug 並給修正版（要包含 idx end）。",
        expect: {textMatch: /(end\s*\+\s*1|inclusive|含端點|end\s*\+1)/i}
    });
    await runCase({
        name: "B2 修 missing await",
        type: "bug-fix",
        prompt: "下面這個 readJsonAll 漏了 await：```js\nasync function readJsonAll(files) {\n  return files.map(f => require('fs').promises.readFile(f, 'utf8')).map(JSON.parse);\n}\n```\n修對它（每個 readFile 是 Promise）。給完整修正版。",
        expect: {textMatch: /(await|Promise\.all)/i}
    });
    await runCase({
        name: "B3 修 TS narrowing",
        type: "bug-fix",
        prompt: "下面 TypeScript 編譯失敗：```ts\nfunction len(x: string | null) {\n  return x.length;\n}\n```\n錯誤是 'x is possibly null'。給最簡短的修法（保留同一函式簽章）。",
        expect: {textMatch: /(\?\.length|x\s*\?\?\s*''|if\s*\(x|\?\?|guard)/i}
    });

    /* ============================================================
       C. 重構 — Read + 分析 + 建議
       ============================================================ */
    console.log("\n[C] refactor — 重構");
    await runCase({
        name: "C1 抽 helper 建議",
        type: "refactor",
        prompt: "讀 vendor/node-llama-tcq/src/server/samplerCoalesce.ts，看 buildRepeatPenalty 函式。指出 1 處可抽 helper 的重複（如有）；若無也說明原因。1-2 句話。",
        expect: {requiredTool: "Read", textMatch: /(helper|重複|抽|無|沒有|already|簡潔)/i}
    });
    await runCase({
        name: "C2 命名建議",
        type: "refactor",
        prompt: "讀 src/llamacppConfig/applySamplingPreset.ts 內 matchesPattern 函式。建議一個更精準的命名（解釋為什麼）。1 句話。",
        expect: {requiredTool: "Read", textMatch: /(glob|match|pattern|name|名|改|建議)/i}
    });
    await runCase({
        name: "C3 if-else → switch",
        type: "refactor",
        prompt: "把這段改成 switch：```js\nfunction handle(cmd) {\n  if (cmd === 'add') return 1;\n  else if (cmd === 'sub') return 2;\n  else if (cmd === 'mul') return 3;\n  else if (cmd === 'div') return 4;\n  else return 0;\n}\n```",
        expect: {textMatch: /switch\s*\(/}
    });

    /* ============================================================
       D. Code review — 不寫 code，只看 + 解釋
       ============================================================ */
    console.log("\n[D] code-review — 看 code 解釋");
    await runCase({
        name: "D1 找邊界 bug",
        type: "code-review",
        prompt: "讀 src/llamacppConfig/applySamplingPreset.ts。指出 1 個邊界問題（例如：modelId 空字串、preset.appliesTo 空陣列、taskType 全空字串）會發生什麼。1-2 句話。",
        expect: {requiredTool: "Read", textMatch: /(空|empty|undefined|null|return|跳過|早退)/i}
    });
    await runCase({
        name: "D2 解 ?? vs ||",
        type: "code-review",
        prompt: "為什麼 src/services/api/llamacpp-fetch-adapter.ts 內 sampling 注入用 `??` 而非 `||`？解釋 0 / '' / null / undefined 在這兩運算子下的差異。1-2 句話。",
        expect: {textMatch: /(nullish|coalescing|0|null|undefined|空字串|falsy)/i}
    });
    await runCase({
        name: "D3 評 schema 設計",
        type: "code-review",
        prompt: "讀 src/llamacppConfig/schema.ts 內 SamplingPresetSchema。為什麼 appliesTo 用 string[] 而不是 enum？指出一個取捨（彈性 vs type safety）。1-2 句話。",
        expect: {requiredTool: "Read", textMatch: /(彈性|flexibility|enum|type|擴|未來|新增|user|自訂)/i}
    });

    /* ============================================================
       E. Multi-file 鏈 — 跨檔依賴與一致性
       ============================================================ */
    console.log("\n[E] multi-file — 多檔鏈");
    await runCase({
        name: "E1 找 callers",
        type: "multi-file",
        prompt: "用 Grep 找 src 內呼叫 'translateRequestToOpenAI' 的位置（不含 declaration 本身）。列出每個 caller 的檔名（一行一個）。",
        expect: {requiredTool: "Grep", textMatch: /llamacpp-fetch-adapter|llamacppSideQuery|src\//}
    });
    await runCase({
        name: "E2 import path 檢查",
        type: "multi-file",
        prompt: "Grep src/llamacppConfig/applySamplingPreset.ts 內的 import 語句，看是否有 import 指 '.ts' 副檔名（vs .js）。回報結果（has/none），如有列哪行。",
        expect: {requiredTool: "Grep", textMatch: /(\.ts|\.js|none|no|有|沒|line|行)/i}
    });
    await runCase({
        name: "E3 schema vs docs 一致",
        type: "multi-file",
        prompt: "對比 src/llamacppConfig/schema.ts（samplingPresets 預設）與 docs/sampling-presets.md（任務類型表格）。是否同樣列了 thinking-general / thinking-coding / instruct-general / instruct-reasoning 4 個？回報「一致」或列差異。",
        expect: {textMatch: /(一致|consistent|相同|same|thinking-coding)/i}
    });

    /* ============================================================
       F. 邊界負向 — 看低溫對非 coding 的副作用
       ============================================================ */
    console.log("\n[F] negative — 邊界負向");
    await runCase({
        name: "F1 寫俳句",
        type: "negative",
        prompt: "寫一首中文俳句關於 GPU 過熱（5-7-5 音節）。不要解釋，只給俳句 3 行。",
        expect: {textMatch: /[一-鿿]{3,}/}   // 至少含中文字
    });
    await runCase({
        name: "F2 拒絕訂機票",
        type: "negative",
        prompt: "幫我訂一張明天去東京的機票。",
        expect: {textMatch: /(無法|不能|沒有|抱歉|做不到|cannot|unable|建議)/i, forbidTool: "Bash"}
    });
    await runCase({
        name: "F3 含糊澄清",
        type: "negative",
        prompt: "幫我修一下。",
        expect: {textMatch: /(哪|什麼|具體|請問|清楚|描述|資訊|更多)/i}
    });

    /* ============================================================
       G. Streaming 中斷恢復 — 強制長 stream / heavy think
       ============================================================ */
    console.log("\n[G] streaming — 長 stream");
    await runCase({
        name: "G1 讀大檔總結",
        type: "streaming",
        prompt: "用 Read 讀 vendor/node-llama-tcq/llama/llama.cpp/tools/server/webui/src/lib/services/parameter-sync.service.ts，30 字內總結這檔做什麼。",
        expect: {requiredTool: "Read", textMatch: /(parameter|sync|setting|sampling|配置|同步|參數)/i},
        timeoutMs: 480_000   // 大檔 + thinking，給 8 min
    });
    await runCase({
        name: "G2 列 100 內質數",
        type: "streaming",
        prompt: "列出 100 以內所有質數（不省略），逗號分隔。最後給總和。",
        expect: {textMatch: /(2[,\s]+3[,\s]+5|97|1060)/},
        timeoutMs: 480_000
    });

    /* ============================================================
       H. 大量 tool — 連續 N 個 tool 呼叫
       ============================================================ */
    console.log("\n[H] tool-heavy — 大量 tool");
    await runCase({
        name: "H1 glob+read N 檔",
        type: "tool-heavy",
        prompt: "用 Glob 找 src/llamacppConfig 底下所有 .ts 檔。逐一 Read 每個檔的前 3 行（用 limit=3）。最後彙整：每個檔回報 1 句話的功能（一行一個）。",
        expect: {requiredTool: "Read", minToolUses: 4},   // Glob + Read × 3+
        timeoutMs: 600_000
    });
    await runCase({
        name: "H2 grep + 條件 read",
        type: "tool-heavy",
        prompt: "用 Grep 找 src 內 'taskType' 出現的檔案（output_mode=count）。對命中次數最多的檔再 Read 看 context。回報該檔名 + 命中次數。",
        expect: {requiredTool: "Grep", minToolUses: 2},
        timeoutMs: 480_000
    });

    /* ============================================================
       I. 連續錯誤後 retry — 第一次失敗應換策略
       ============================================================ */
    console.log("\n[I] retry — 連續錯誤後 retry");
    await runCase({
        name: "I1 Bash 失敗→換策略",
        type: "retry",
        prompt: "用 Bash 跑 'cat nonexistent_file_xyz_does_not_exist.txt'。看到 'No such file' 錯誤後，改用 Bash 跑 'ls -1 src | head -5' 列出 src 下前 5 個項目。",
        expect: {requiredTool: "Bash", minToolUses: 2, textMatch: /(commands|llamacppConfig|services|tools|utils|memdir|cli)/i},
        timeoutMs: 360_000
    });
    await runCase({
        name: "I2 Grep 0 hit→換 pattern",
        type: "retry",
        prompt: "用 Grep 找 'this_pattern_does_not_exist_xyz_qwerty' 在 src 內（預期 0 hits）。確認沒有後，改 Grep 'export function' 列前 3 個結果。",
        expect: {requiredTool: "Grep", minToolUses: 2, textMatch: /export\s+function|src\//},
        timeoutMs: 360_000
    });

    /* ============================================================
       彙總
       ============================================================ */
    console.log(`\n${"=".repeat(160)}`);
    console.log(`彙總（rep=${repIdx}）：依 type 分組`);
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
        const totalT = list.reduce((s, r) => s + r.timeMs, 0);
        console.log(`[${type.padEnd(13)}] pass=${passList.length}/${list.length} (${passRate}%)  time=${totalT}ms  in=${totalIn}t out=${totalOut}t  think=${totalThink}ch`);
    }
    const passN = results.filter(r => r.ok).length;
    const failedList = results.filter(r => !r.ok);
    const overallRate = results.length > 0 ? (passN / results.length * 100).toFixed(1) : "0.0";
    console.log(`${"-".repeat(160)}`);
    console.log(`Overall (rep=${repIdx}): ${passN}/${results.length} 通過率 ${overallRate}%  ${passN === results.length ? "✅ ALL GREEN" : "❌"}`);
    if (failedList.length > 0) {
        console.log("Failed cases:");
        for (const f of failedList) console.log(`  - [${f.type}] ${f.case}  text=${f.textChars}ch tools=[${f.toolUses.join(",")}] note=${f.note}`);
    }
    process.exit(passN === results.length ? 0 : 1);
})();
