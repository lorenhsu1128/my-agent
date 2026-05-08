// 失敗診斷：針對 thinking-coding 24-case 跑出來的 7 個 fail 重跑 + 完整記錄。
//
// 為每個 case dump 出：
//   - 完整 result text
//   - 完整 thinking text
//   - tool 呼叫順序（含 args 摘要）
//   - 多個寬鬆 regex 嘗試（分類正確性）
//
// 輸出：stress-results/diagnostic/<case-id>.txt 與 stress-results/diagnostic/_index.md

import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {killTree} from "./_lib/killTree";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const OUT_DIR = path.join(REPO_ROOT, "stress-results", "diagnostic");
try { fs.mkdirSync(OUT_DIR, {recursive: true}); } catch { /* exists */ }

// 寬鬆 regex 集合 — 每個 case 試多個 fallback，標記是否任一 match
type RegexCheck = {label: string, re: RegExp};

type Case = {
    id: string,
    prompt: string,
    timeoutMs: number,
    // 多個 regex 試一次，看哪個 match 哪個沒
    checks: RegexCheck[],
    // 期望的 tool 行為（觀察用，不影響 ok 判定）
    expectedToolHint: string,
};

const CASES: Case[] = [
    {
        id: "B1-off-by-one",
        prompt: "下面這段 sumRange(arr, start, end) 有 bug：```js\nfunction sumRange(arr, start, end) {\n  return arr.slice(start, end).reduce((a,b)=>a+b, 0);\n}\nsumRange([1,2,3,4,5], 1, 3); // 想算 idx 1 到 3 含端點 = 2+3+4 = 9，但回 5\n```\n指出 bug 並給修正版（要包含 idx end）。",
        timeoutMs: 120_000,
        checks: [
            {label: "原 regex (end+1 / inclusive / 含端點)", re: /(end\s*\+\s*1|inclusive|含端點|\+1|end\s*\+1)/i},
            {label: "更寬：mention slice end exclusive", re: /(end\s*\+|\+\s*1|exclusive|不含|\bbug\b|錯誤)/i},
            {label: "code 真的把 end 改成 end+1", re: /slice\s*\(\s*start\s*,\s*end\s*\+\s*1\s*\)/},
            {label: "或用 idx range 不同寫法", re: /(filter|for\s*\(.*<=\s*end|i\s*<=\s*end)/i},
        ],
        expectedToolHint: "純 code 修正不該呼工具",
    },
    {
        id: "B2-missing-await",
        prompt: "下面這個 readJsonAll 漏了 await：```js\nasync function readJsonAll(files) {\n  return files.map(f => require('fs').promises.readFile(f, 'utf8')).map(JSON.parse);\n}\n```\n修對它（每個 readFile 是 Promise）。給完整修正版。",
        timeoutMs: 360_000,  // 已知會 tool-loop
        checks: [
            {label: "原 regex (await / Promise.all)", re: /(await|Promise\.all)/i},
            {label: "更寬：mention promise resolve", re: /(promise|resolve|async|then)/i},
            {label: "code 含 Promise.all", re: /Promise\.all\s*\(/},
            {label: "code 含 await on map", re: /await.*map|map.*await/i},
        ],
        expectedToolHint: "純 code 修正不該呼工具（但實測會 tool-loop）",
    },
    {
        id: "B3-ts-narrowing",
        prompt: "下面 TypeScript 編譯失敗：```ts\nfunction len(x: string | null) {\n  return x.length;\n}\n```\n錯誤是 'x is possibly null'。給最簡短的修法（保留同一函式簽章）。",
        timeoutMs: 120_000,
        checks: [
            {label: "原 regex (?.length / ?? '' / if guard)", re: /(\?\.length|x\s*\?\?\s*''|if\s*\(x|\?\?|guard)/i},
            {label: "type assertion (x as string / x!)", re: /(x\s+as\s+string|x!|<string>x)/i},
            {label: "early return null", re: /(return\s+0|return\s+null|return\s+undefined)/i},
            {label: "?. operator 用法", re: /\?\./},
            {label: "說明 nullish", re: /(nullish|null check|\?\?|fallback)/i},
        ],
        expectedToolHint: "純 code 修正不該呼工具",
    },
    {
        id: "C3-if-else-switch",
        prompt: "把這段改成 switch：```js\nfunction handle(cmd) {\n  if (cmd === 'add') return 1;\n  else if (cmd === 'sub') return 2;\n  else if (cmd === 'mul') return 3;\n  else if (cmd === 'div') return 4;\n  else return 0;\n}\n```",
        timeoutMs: 120_000,
        checks: [
            {label: "原 regex (switch())", re: /switch\s*\(/},
            {label: "case 'add'", re: /case\s+['\"]add['\"]/i},
            {label: "包含 default", re: /default\s*:/i},
            {label: "整個 switch 結構", re: /switch[\s\S]*case[\s\S]*default/i},
        ],
        expectedToolHint: "純 code 重寫不該呼工具",
    },
    {
        id: "E1-find-callers",
        prompt: "用 Grep 找 src 內呼叫 'translateRequestToOpenAI' 的位置（不含 declaration 本身）。列出每個 caller 的檔名（一行一個）。",
        timeoutMs: 360_000,  // 已知會 tool-loop
        checks: [
            {label: "原 regex (檔案路徑)", re: /llamacpp-fetch-adapter|llamacppSideQuery|src\//},
            {label: "提到關鍵檔名", re: /llamacpp-fetch-adapter|llamacppSideQuery/},
            {label: "列出 .ts 檔", re: /\.ts/},
            {label: "至少呼 1 次 Grep", re: /(?:)/},  // 永遠 true，看 toolUses
        ],
        expectedToolHint: "Grep 1-2 次後直接報答案",
    },
    {
        id: "F2-refusal-flight",
        prompt: "幫我訂一張明天去東京的機票。",
        timeoutMs: 120_000,
        checks: [
            {label: "原 regex (無法/不能/抱歉等)", re: /(無法|不能|沒有|抱歉|做不到|cannot|unable|建議)/i},
            {label: "說明限制 (我只能/我是)", re: /(我是|我只能|coding|程式|software|engineering)/i},
            {label: "建議改用其他渠道", re: /(網站|app|google|搜尋|service|booking|官網)/i},
            {label: "誤呼工具去訂", re: /(WebFetch|booking)/i},
        ],
        expectedToolHint: "應拒絕，不該呼工具",
    },
    {
        id: "I1-retry-after-bash-fail",
        prompt: "用 Bash 跑 'cat nonexistent_file_xyz_does_not_exist.txt'。看到 'No such file' 錯誤後，改用 Bash 跑 'ls -1 src | head -5' 列出 src 下前 5 個項目。",
        timeoutMs: 180_000,
        checks: [
            {label: "原 regex (src 子目錄名)", re: /(commands|llamacppConfig|services|tools|utils|memdir|cli)/i},
            {label: "確認 Bash 至少呼 2 次", re: /(?:)/},  // 看 toolUses
            {label: "提到第一個錯誤", re: /(no such|找不到|nonexistent|錯誤)/i},
        ],
        expectedToolHint: "Bash×2（cat fail → ls）",
    },
];

type Result = {
    id: string,
    timeMs: number,
    timedOut: boolean,
    inputTokens: number,
    outputTokens: number,
    thinkingChars: number,
    textChars: number,
    toolUses: string[],
    toolCallSummaries: string[],
    numTurns: number,
    resultText: string,
    thinkingText: string,
    matches: {label: string, ok: boolean}[],
};

async function runDiagnostic(c: Case): Promise<Result> {
    const t0 = Date.now();
    let inputTokens = 0, outputTokens = 0, thinkingChars = 0, textChars = 0;
    const toolUses: string[] = [];
    const toolCallSummaries: string[] = [];
    let numTurns = 0;
    let resultText = "";
    let thinkingText = "";
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
        "-p", c.prompt,
    ];

    const child = spawn(CLI, args, {cwd: REPO_ROOT, env: {...process.env}, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32"});
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        void killTree(child.pid);
    }, c.timeoutMs);

    // 收集當前 tool_use 的 input args（以 content_block_start 開頭、_delta 累積、_stop 結束）
    let activeTool: {name: string, args: string} | null = null;

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
                        } else if (d?.type === "input_json_delta" && activeTool) {
                            activeTool.args += d.partial_json ?? "";
                        }
                    } else if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
                        toolUses.push(inner.content_block.name);
                        activeTool = {name: inner.content_block.name, args: ""};
                    } else if (inner?.type === "content_block_stop" && activeTool) {
                        const argSnip = activeTool.args.length > 120 ? activeTool.args.slice(0, 120) + "…" : activeTool.args;
                        toolCallSummaries.push(`${activeTool.name}(${argSnip})`);
                        activeTool = null;
                    }
                } else if (ev.type === "result") {
                    numTurns = ev.num_turns ?? 0;
                    inputTokens = ev.usage?.input_tokens ?? 0;
                    outputTokens = ev.usage?.output_tokens ?? 0;
                    resultText = ev.result ?? "";
                }
            } catch {}
        }
    });
    child.stderr.on("data", () => {});

    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);
    const dt = Date.now() - t0;

    const matches = c.checks.map((chk) => ({label: chk.label, ok: chk.re.test(resultText)}));

    return {
        id: c.id, timeMs: dt, timedOut,
        inputTokens, outputTokens, thinkingChars, textChars,
        toolUses, toolCallSummaries, numTurns,
        resultText, thinkingText,
        matches,
    };
}

function writeCaseDump(c: Case, r: Result) {
    const lines: string[] = [];
    lines.push(`# Diagnostic: ${c.id}`);
    lines.push("");
    lines.push(`**Time:** ${(r.timeMs / 1000).toFixed(1)}s${r.timedOut ? " (TIMEOUT)" : ""}`);
    lines.push(`**Tokens:** in=${r.inputTokens} out=${r.outputTokens}`);
    lines.push(`**Thinking chars:** ${r.thinkingChars}`);
    lines.push(`**Text chars:** ${r.textChars}`);
    lines.push(`**Turns:** ${r.numTurns}`);
    lines.push(`**Tool uses (${r.toolUses.length}):** ${r.toolUses.join(", ") || "(none)"}`);
    lines.push("");
    lines.push("## Tool call sequence");
    lines.push("");
    if (r.toolCallSummaries.length === 0) lines.push("(no tool calls)");
    else for (const t of r.toolCallSummaries) lines.push(`- \`${t}\``);
    lines.push("");
    lines.push("## Regex match table");
    lines.push("");
    lines.push("| ✓/✗ | Label |");
    lines.push("|-----|-------|");
    for (const m of r.matches) lines.push(`| ${m.ok ? "✅" : "❌"} | ${m.label} |`);
    lines.push("");
    lines.push("## Prompt");
    lines.push("");
    lines.push("```");
    lines.push(c.prompt);
    lines.push("```");
    lines.push("");
    lines.push("## Thinking text (full)");
    lines.push("");
    lines.push("```");
    lines.push(r.thinkingText.length > 0 ? r.thinkingText : "(empty)");
    lines.push("```");
    lines.push("");
    lines.push("## Result text (full)");
    lines.push("");
    lines.push("```");
    lines.push(r.resultText.length > 0 ? r.resultText : "(empty)");
    lines.push("```");
    lines.push("");
    fs.writeFileSync(path.join(OUT_DIR, `${c.id}.md`), lines.join("\n"), "utf8");
}

(async () => {
    console.log(`\n#### FAILURE DIAGNOSTIC — ${CASES.length} cases ####\n`);
    const summary: Result[] = [];
    for (const c of CASES) {
        process.stdout.write(`▶ ${c.id} ... `);
        const r = await runDiagnostic(c);
        summary.push(r);
        writeCaseDump(c, r);
        const passN = r.matches.filter(m => m.ok).length;
        console.log(`${(r.timeMs / 1000).toFixed(1)}s tools=${r.toolUses.length} match=${passN}/${r.matches.length}${r.timedOut ? " TIMEOUT" : ""}`);
    }
    // 寫 index
    const idx: string[] = [];
    idx.push("# Failure Diagnostic Index\n");
    idx.push(`Model: qwen3.5-9b (Q4_K_M)  Preset: thinking-coding  Run: ${new Date().toISOString()}\n`);
    idx.push("| Case | Time | Tokens | Tools | Match | Status |");
    idx.push("|------|------|--------|-------|-------|--------|");
    for (const r of summary) {
        const passN = r.matches.filter(m => m.ok).length;
        const status = r.timedOut ? "❌ TIMEOUT" : passN > 0 ? "🟡 some match" : "❌ no match";
        idx.push(`| [${r.id}](${r.id}.md) | ${(r.timeMs/1000).toFixed(1)}s | in=${r.inputTokens} out=${r.outputTokens} | ${r.toolUses.length} | ${passN}/${r.matches.length} | ${status} |`);
    }
    fs.writeFileSync(path.join(OUT_DIR, "_index.md"), idx.join("\n") + "\n", "utf8");
    console.log(`\nDumped to ${OUT_DIR}`);
    console.log(`Index: stress-results/diagnostic/_index.md`);
})();
