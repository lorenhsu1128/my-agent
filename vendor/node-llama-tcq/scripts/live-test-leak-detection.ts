// B3 / M-LOCAL-MODEL-ROBUSTNESS E2E — 故意設計會觸發 Qwen tool-format XML 漏出的
// prompt，跑 my-agent CLI → shim:8081 → qwen3.5-9b（thinking-coding preset），
// 再 client-side 偵測最終 result text 是否含 marker。
//
// 前置：
//   - GPU server 已起：bash scripts/llama/serve.sh
//   - ~/.my-agent/llamacpp.jsonc 設 defaultSamplingPreset=thinking-coding
//   - shim console 會印 [qwen-tool-leak] warn line（B3 接入），driver 不依賴
//     抓 stderr — 只看 client-side 收到的 result text；shim warn 用人眼對。
//
// 8 個 case 設計（依漏出機制分類）：
//   L1 解釋語法 — prompt 直接要求說明 `<tool_call>` 是什麼 → 模型 prose 引用
//   L2 截斷 — 多檔 read + 低 max-tokens → tool_call 截斷在中間
//   L3 多 tool 連串 — Glob → Grep → Read 鏈 → 中間某 block 退化
//   L4 fixture 含 marker — 讀一個含 `<tool_call>` 字面量的 fixture
//   L5 模糊 tool name — typo 容易誘發 hallucinate name
//   L6 矛盾指令 — 「禁止 tool」+「列檔案」→ 異常輸出
//   L7 巢狀 multi-step — Grep 結果 → 對每個 hit 再 Read
//   L8 user prompt 含 marker — 直接把 `</tool_call>` 字串放進問題

import {spawn} from "node:child_process";
import path from "node:path";
import * as fs from "node:fs";
import {killTree} from "./_lib/killTree";
import {dumpResult, makeRunId} from "./_lib/testCaseHelpers";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const RUN_ID = makeRunId("leak-detection");
const FIXTURE_DIR = path.join(REPO_ROOT, "stress-results", "leak-fixtures");

// === Client-side 漏出偵測（與 shim 端 detectToolCallLeak 同邏輯，刻意 inline 不依賴）===

type LeakMarker =
    | "tool_call_open"
    | "tool_call_close"
    | "function_open"
    | "function_close"
    | "parameter_open"
    | "parameter_close"
    | "tools_block"
    | "tool_response";

const LEAK_PATTERNS: ReadonlyArray<{kind: LeakMarker, re: RegExp}> = [
    {kind: "tool_call_open", re: /<tool_call\b[^>]*>/},
    {kind: "tool_call_close", re: /<\/tool_call>/},
    {kind: "function_open", re: /<function=[^>]+>/},
    {kind: "function_close", re: /<\/function>/},
    {kind: "parameter_open", re: /<parameter=[^>]+>/},
    {kind: "parameter_close", re: /<\/parameter>/},
    {kind: "tools_block", re: /<\/?tools>/},
    {kind: "tool_response", re: /<\/?tool_response>/}
];

function detectLeak(content: string): {markers: LeakMarker[], snippet: string} | null {
    if (!content) return null;
    const hits: {kind: LeakMarker, idx: number}[] = [];
    for (const {kind, re} of LEAK_PATTERNS) {
        const m = re.exec(content);
        if (m) hits.push({kind, idx: m.index});
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.idx - b.idx);
    const a = hits[0]!;
    const start = Math.max(0, a.idx - 60);
    const end = Math.min(content.length, a.idx + 120);
    const snippet = (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
    return {
        markers: [...new Set(hits.map((h) => h.kind))],
        snippet
    };
}

// === fixture 準備 ===

function ensureFixtures() {
    try { fs.mkdirSync(FIXTURE_DIR, {recursive: true}); }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
    const f1 = path.join(FIXTURE_DIR, "with-marker.txt");
    if (!fs.existsSync(f1)) {
        fs.writeFileSync(f1, [
            "// Sample doc that legitimately mentions Qwen tool-call XML",
            "The Qwen format uses these markers:",
            "  <tool_call>",
            "    <function=name>",
            "      <parameter=arg>value</parameter>",
            "    </function>",
            "  </tool_call>",
            "",
            "When the parser sees these blocks it strips them from the visible output.",
            ""
        ].join("\n"), "utf8");
    }
    return {markerFile: f1};
}

// === case 定義 ===

type Case = {
    id: string,
    label: string,
    prompt: string,
    timeoutMs?: number
};

function buildCases(fix: {markerFile: string}): Case[] {
    return [
        {
            id: "L1",
            label: "解釋語法（直接要求引用 marker）",
            prompt: "請用一段話說明 Qwen3.5 的 native tool-calling XML 標記長什麼樣（包含開閉合 tag 與 parameter 寫法）。不要呼叫任何 tool，只用文字回答。"
        },
        {
            id: "L2",
            label: "截斷（低 max-tokens 強制中斷 tool_call）",
            prompt: `Read 這 4 個檔案並各自摘要前 3 行：${REPO_ROOT}/CLAUDE.md, ${REPO_ROOT}/TODO.md, ${REPO_ROOT}/LESSONS.md, ${REPO_ROOT}/README.md。`,
            timeoutMs: 240_000
        },
        {
            id: "L3",
            label: "多 tool 連串（Glob → Grep → Read）",
            prompt: `先用 Glob 找 ${REPO_ROOT}/src/utils/proc/*.ts，再 Grep 看哪個檔案 export "killTree"，最後 Read 那個檔案的前 30 行。`,
            timeoutMs: 240_000
        },
        {
            id: "L4",
            label: "fixture 含 marker（合法引用觸發 false-positive 防呆）",
            prompt: `Read 這個檔案並用 1 句話摘要它在說什麼：${fix.markerFile}`
        },
        {
            id: "L5",
            label: "模糊 tool name（誘發 hallucinated name）",
            prompt: "請用『讀檔工具』把當前目錄下名為 'NotExisting_xyz_999.md' 的檔案內容讀給我。沒有就告訴我沒有。"
        },
        {
            id: "L6",
            label: "矛盾指令（禁止 tool + 要求列檔案）",
            prompt: "請列出當前目錄的 5 個檔案。**規則：禁止使用任何 tool / 函式呼叫，只能用你已知的內容回答**。"
        },
        {
            id: "L7",
            label: "巢狀 multi-step（Grep 後對每個 hit 再 Read）",
            prompt: `Grep ${REPO_ROOT}/src/utils/proc/ 找含 "taskkill" 的檔案，找到後 Read 那個檔案的對應行附近 5 行。`,
            timeoutMs: 240_000
        },
        {
            id: "L8",
            label: "user prompt 字面含 </tool_call>",
            prompt: "我看到一段文字 `</tool_call>` 出現在我的程式輸出裡。請解釋這個 tag 是什麼用途、為什麼會出現。不要呼叫 tool。"
        }
    ];
}

// === 執行單個 case ===

type CaseResult = {
    id: string,
    label: string,
    timeMs: number,
    inputTokens: number,
    outputTokens: number,
    thinkingChars: number,
    textChars: number,
    toolUses: string[],
    numTurns: number,
    resultText: string,
    thinkingText: string,
    leakMarkers: LeakMarker[],
    leakSnippet: string,
    timedOut: boolean,
    isError: boolean
};

async function runCase(c: Case): Promise<CaseResult> {
    const t0 = Date.now();
    let inputTokens = 0, outputTokens = 0, thinkingChars = 0, textChars = 0;
    const toolUses: string[] = [];
    let numTurns = 0;
    let resultText = "";
    let thinkingText = "";
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
        "-p", c.prompt
    ];

    const child = spawn(CLI, args, {
        cwd: REPO_ROOT,
        env: {...process.env},
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
    });

    let timedOut = false;
    const timeoutMs = c.timeoutMs ?? 180_000;
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
                if (ev.type === "stream_event") {
                    const inner = ev.event;
                    if (inner?.type === "content_block_delta") {
                        const d = inner.delta;
                        if (d?.type === "text_delta" && typeof d.text === "string") textChars += d.text.length;
                        else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
                            thinkingChars += d.thinking.length;
                            thinkingText += d.thinking;
                        }
                    } else if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
                        toolUses.push(inner.content_block.name);
                    }
                } else if (ev.type === "result") {
                    numTurns = ev.num_turns ?? 0;
                    inputTokens = ev.usage?.input_tokens ?? 0;
                    outputTokens = ev.usage?.output_tokens ?? 0;
                    resultText = ev.result ?? "";
                    resultIsError = ev.is_error === true;
                }
            } catch { /* non-JSON */ }
        }
    });
    child.stderr.on("data", () => {/* swallow — shim warn 在 shim 端的 log，不混進這裡 */});

    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);

    const dt = Date.now() - t0;
    const leak = detectLeak(resultText);
    return {
        id: c.id,
        label: c.label,
        timeMs: dt,
        inputTokens, outputTokens,
        thinkingChars, textChars,
        toolUses, numTurns,
        resultText, thinkingText,
        leakMarkers: leak?.markers ?? [],
        leakSnippet: leak?.snippet ?? "",
        timedOut,
        isError: resultIsError
    };
}

// === main ===

(async () => {
    console.log(`\n#### B3 LEAK-DETECTION E2E — preset=thinking-coding model=${MODEL} ####\n`);
    console.log(`runId: ${RUN_ID}`);
    console.log(`fixtures: ${FIXTURE_DIR}\n`);

    const fix = ensureFixtures();
    const cases = buildCases(fix);
    const results: CaseResult[] = [];

    for (const c of cases) {
        process.stdout.write(`[${c.id}] ${c.label.padEnd(48)} … `);
        const r = await runCase(c);
        results.push(r);
        const flagLeak = r.leakMarkers.length > 0 ? `🚨 LEAK[${r.leakMarkers.join(",")}]` : "✅ clean";
        const flagErr = r.isError ? " ❌ERROR" : "";
        const flagTo = r.timedOut ? " ⏱TIMEOUT" : "";
        console.log(`${String(r.timeMs).padStart(7)}ms in=${r.inputTokens} out=${r.outputTokens} tools=[${r.toolUses.join(",")}] ${flagLeak}${flagErr}${flagTo}`);

        // 用 B7 dumpResult helper 寫完整證據到 stress-results/dumps/<runId>/<id>.md
        dumpResult({
            name: `${r.id}-${r.label}`,
            type: "leak-detection",
            prompt: c.prompt,
            resultText: r.resultText,
            thinkingText: r.thinkingText,
            toolUses: r.toolUses,
            ok: r.leakMarkers.length === 0 && !r.isError && !r.timedOut,
            note: r.leakMarkers.length > 0 ? `leak markers: ${r.leakMarkers.join(",")} | ${r.leakSnippet}` : (r.timedOut ? "TIMEOUT" : (r.isError ? "ERROR" : "")),
            runId: RUN_ID,
            metrics: {
                timeMs: r.timeMs,
                inputTokens: r.inputTokens,
                outputTokens: r.outputTokens,
                thinkingChars: r.thinkingChars,
                textChars: r.textChars,
                numTurns: r.numTurns,
                timedOut: r.timedOut ? "yes" : "no",
                isError: r.isError ? "yes" : "no"
            }
        });
    }

    // === summary ===
    console.log("\n=== Summary ===");
    const leakHits = results.filter((r) => r.leakMarkers.length > 0);
    const errors = results.filter((r) => r.isError);
    const timeouts = results.filter((r) => r.timedOut);
    console.log(`total=${results.length}  leak_hits=${leakHits.length}  errors=${errors.length}  timeouts=${timeouts.length}`);
    console.log(`\ndumps: stress-results/dumps/${RUN_ID}/`);
    console.log(`shim warn 對照：請看 shim console 的 [qwen-tool-leak] markers=… stats=… 行（B3 server-side 統計）`);

    // 寫 summary.md
    const summaryPath = path.join(REPO_ROOT, "stress-results", "dumps", RUN_ID, "_summary.md");
    const lines: string[] = [
        `# B3 leak-detection E2E summary`,
        ``,
        `- runId: \`${RUN_ID}\``,
        `- preset: thinking-coding`,
        `- model: ${MODEL}`,
        `- total cases: ${results.length}`,
        `- leak hits: ${leakHits.length}`,
        `- errors: ${errors.length}`,
        `- timeouts: ${timeouts.length}`,
        ``,
        `| id | label | leak | tools | time | out tok |`,
        `|----|-------|------|-------|------|---------|`
    ];
    for (const r of results) {
        const leak = r.leakMarkers.length > 0 ? r.leakMarkers.join(",") : "—";
        lines.push(`| ${r.id} | ${r.label} | ${leak} | ${r.toolUses.join(",") || "—"} | ${r.timeMs}ms | ${r.outputTokens} |`);
    }
    try {
        fs.writeFileSync(summaryPath, lines.join("\n"), "utf8");
        console.log(`summary: ${summaryPath}`);
    } catch (e) {
        console.warn(`summary write failed: ${(e as Error)?.message ?? e}`);
    }
})().catch((e) => {
    console.error("driver crashed:", e);
    process.exit(1);
});
