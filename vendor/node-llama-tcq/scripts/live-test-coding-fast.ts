// v3-coding-fast — 12 case subset，每 case 上限 120s。
// 從 live-test-coding-deep.ts 摘核心，跳過已知 timeout 的 B2 / 重 tool 的 H1/H2
// / 大檔 G1。目標：每 preset ~5 min，4 preset 共 ~20-30 min。

import {spawn} from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

type CaseType = "algorithm" | "bug-fix" | "refactor" | "code-review" | "negative" | "retry";
type CaseResult = {
    case: string, type: CaseType,
    timeMs: number, ttftMs: number | null,
    inputTokens: number, outputTokens: number,
    thinkingChars: number, textChars: number,
    toolUses: string[], numTurns: number,
    note: string, ok: boolean
};
const results: CaseResult[] = [];

function record(r: CaseResult) {
    results.push(r);
    const flag = r.ok ? "✅" : "❌";
    const tt = r.ttftMs != null ? ` ttft=${String(r.ttftMs).padStart(5)}ms` : "";
    const tools = r.toolUses.length > 0 ? ` tools=[${r.toolUses.join(",")}]` : "";
    console.log(`  ${flag} ${r.case.padEnd(28)} ${String(r.timeMs).padStart(7)}ms${tt}  in=${String(r.inputTokens).padStart(6)}t  out=${String(r.outputTokens).padStart(4)}t  think=${r.thinkingChars}ch text=${r.textChars}ch turns=${r.numTurns}${tools} ${r.note}`);
}

type Expect = {textMatch?: RegExp, requiredTool?: string, forbidTool?: string, minToolUses?: number};

async function runCase(opts: {name: string, type: CaseType, prompt: string, expect: Expect, timeoutMs?: number}): Promise<void> {
    const t0 = Date.now();
    let ttftMs: number | null = null, inputTokens = 0, outputTokens = 0;
    let thinkingChars = 0, textChars = 0;
    const toolUses: string[] = [];
    let numTurns = 0, resultText = "", resultIsError = false, buf = "";
    const args = [...CLI_ARGS_PREFIX, "--print", "--output-format", "stream-json", "--include-partial-messages",
        "--verbose", "--allow-dangerously-skip-permissions",
        "--model", MODEL, "--no-session-persistence", "-p", opts.prompt];
    const child = spawn(CLI, args, {cwd: REPO_ROOT, env: {...process.env}, stdio: ["ignore", "pipe", "pipe"]});
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
                const ev = JSON.parse(line);
                if (ev.type === "stream_event") {
                    const inner = ev.event;
                    if (inner?.type === "content_block_delta") {
                        if (ttftMs == null) ttftMs = Date.now() - t0;
                        const d = inner.delta;
                        if (d?.type === "text_delta") textChars += d.text.length;
                        else if (d?.type === "thinking_delta") thinkingChars += d.thinking.length;
                    } else if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
                        if (ttftMs == null) ttftMs = Date.now() - t0;
                        toolUses.push(inner.content_block.name);
                    }
                } else if (ev.type === "result") {
                    numTurns = ev.num_turns ?? 0;
                    inputTokens = ev.usage?.input_tokens ?? 0;
                    outputTokens = ev.usage?.output_tokens ?? 0;
                    resultText = ev.result ?? "";
                    resultIsError = ev.is_error === true;
                }
            } catch {}
        }
    });
    child.stderr.on("data", () => {});
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);
    const dt = Date.now() - t0;
    let ok = !resultIsError && !timedOut;
    let okReason = timedOut ? "TIMEOUT" : "";
    const e = opts.expect;
    if (e.textMatch != null) { const m = e.textMatch.test(resultText); ok = ok && m; if (m) okReason += `text~/${e.textMatch.source.slice(0, 18)}/ `; }
    if (e.requiredTool != null) { const has = toolUses.includes(e.requiredTool); ok = ok && has; if (has) okReason += `tool=${e.requiredTool} `; }
    if (e.forbidTool != null) ok = ok && !toolUses.includes(e.forbidTool);
    if (e.minToolUses != null) { ok = ok && toolUses.length >= e.minToolUses; if (toolUses.length >= e.minToolUses) okReason += `tools>=${e.minToolUses} `; }
    record({case: opts.name, type: opts.type, timeMs: dt, ttftMs, inputTokens, outputTokens, thinkingChars, textChars, toolUses, numTurns, note: okReason.trim() || (resultIsError ? `ERROR` : ""), ok});
}

(async () => {
    console.log(`\n#### CODING-FAST — my-agent → shim:8081 (256k turbo4 reasoning=on) ####\n`);
    console.log("[A] algorithm");
    await runCase({name: "A1 fibonacci 兩寫法", type: "algorithm",
        prompt: "請寫一段 Node.js：定義 fibIter(n) 與 fibMemo(n)，各算 fib(10) 並 console.log 結果。包在 ```javascript ``` 區塊裡（不需執行）。",
        expect: {textMatch: /(55|fib(?:Iter|Memo)\s*\()/i}});
    await runCase({name: "A2 binsearch leftmost", type: "algorithm",
        prompt: "用 TypeScript 寫 leftmostBinarySearch(arr: number[], target: number): number — 找最左 idx，找不到回 -1。包在 ```typescript ```。",
        expect: {textMatch: /(leftmost|binarySearch|while|low|high|mid)/i}});
    await runCase({name: "A3 LRU cache", type: "algorithm",
        prompt: "用 TypeScript 寫 LRUCache class（capacity=3）：put(k,v) / get(k)。用 Map 即可。包在 ```typescript ```。",
        expect: {textMatch: /(class\s+LRU|Map|capacity)/i}});

    console.log("\n[B] bug-fix（跳過 B2 missing await — 已知會 tool-loop）");
    await runCase({name: "B1 修 off-by-one", type: "bug-fix",
        prompt: "下面 sumRange(arr, start, end) 有 bug：```js\nfunction sumRange(arr, start, end) { return arr.slice(start, end).reduce((a,b)=>a+b, 0); }\n// 想算 idx 1 到 3 含端點 = 2+3+4 = 9，但回 5\n```\n指出並修正。",
        expect: {textMatch: /(end\s*\+\s*1|inclusive|含端點|\+1|end\s*\+1)/i}});
    await runCase({name: "B3 修 TS narrowing", type: "bug-fix",
        prompt: "TS 編譯失敗：```ts\nfunction len(x: string | null) { return x.length; }\n```\n錯誤是 'x is possibly null'。給最簡修法。",
        expect: {textMatch: /(\?\.length|x\s*\?\?\s*''|if\s*\(x|\?\?|guard)/i}});

    console.log("\n[C] refactor");
    await runCase({name: "C1 抽 helper 建議", type: "refactor",
        prompt: "讀 vendor/node-llama-tcq/src/server/samplerCoalesce.ts 的 buildRepeatPenalty。指出 1 處可抽 helper（如有）；若無說明原因。1-2 句話。",
        expect: {requiredTool: "Read", textMatch: /(helper|重複|抽|無|沒有|簡潔)/i}});
    await runCase({name: "C3 if-else → switch", type: "refactor",
        prompt: "改 switch：```js\nfunction handle(cmd) { if (cmd === 'add') return 1; else if (cmd === 'sub') return 2; else if (cmd === 'mul') return 3; else if (cmd === 'div') return 4; else return 0; }\n```",
        expect: {textMatch: /switch\s*\(/}});

    console.log("\n[D] code-review");
    await runCase({name: "D1 找邊界 bug", type: "code-review",
        prompt: "讀 src/llamacppConfig/applySamplingPreset.ts。指出 1 個邊界問題（modelId 空 / appliesTo 空 / taskType 空字串）。1-2 句話。",
        expect: {requiredTool: "Read", textMatch: /(空|empty|undefined|null|return|跳過|早退)/i}});
    await runCase({name: "D2 解 ?? vs ||", type: "code-review",
        prompt: "為什麼 sampling 注入用 `??` 而非 `||`？解釋 0 / null / undefined 在這兩運算子下的差異。1-2 句話。",
        expect: {textMatch: /(nullish|coalescing|0|null|undefined|空字串|falsy)/i}});

    console.log("\n[F] negative");
    await runCase({name: "F2 拒絕訂機票", type: "negative",
        prompt: "幫我訂一張明天去東京的機票。",
        expect: {textMatch: /(無法|不能|沒有|抱歉|做不到|cannot|unable|建議)/i, forbidTool: "Bash"}});
    await runCase({name: "F3 含糊澄清", type: "negative",
        prompt: "幫我修一下。",
        expect: {textMatch: /(哪|什麼|具體|請問|清楚|描述|資訊|更多)/i}});

    console.log("\n[I] retry");
    await runCase({name: "I1 Bash 失敗→換策略", type: "retry",
        prompt: "用 Bash 跑 'cat nonexistent_xyz.txt'，看到錯誤後改用 Bash 跑 'ls -1 src | head -5' 列出 src 下前 5 個項目。",
        expect: {requiredTool: "Bash", minToolUses: 2, textMatch: /(commands|llamacppConfig|services|tools|utils|memdir|cli)/i},
        timeoutMs: 180_000});

    const passN = results.filter(r => r.ok).length;
    const rate = (passN / results.length * 100).toFixed(1);
    console.log(`\n${"=".repeat(120)}`);
    console.log(`Overall: ${passN}/${results.length} 通過率 ${rate}%`);
    if (passN < results.length) {
        console.log("Failed:");
        for (const f of results.filter(r => !r.ok)) console.log(`  - [${f.type}] ${f.case}  text=${f.textChars}ch tools=[${f.toolUses.join(",")}] note=${f.note}`);
    }
    process.exit(passN === results.length ? 0 : 1);
})();
