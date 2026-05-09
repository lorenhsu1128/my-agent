// 測 prompt engineering 對 thinking-coding 「修 buggy fenced code」的影響。
// 三個 case (B1/B3/C3) × 三個變體 (V1 原版 / V2 強調 / V3 移除 fence)。
// 每組 N=3，共 27 runs。

import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {killTree} from "./_lib/killTree";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const REPS = Number(process.env.REPS ?? "3");

type Variant = {id: string, prompt: string};
type CaseSpec = {id: string, oks: RegExp[], variants: Variant[]};

const CASES: CaseSpec[] = [
    {
        id: "B1",
        oks: [/(slice\s*\(\s*start\s*,\s*end\s*\+\s*1\s*\)|i\s*<=\s*end|含端點|inclusive|\bend\s*\+\s*1)/i],
        variants: [
            {
                id: "V1-fence",
                prompt: "下面這段 sumRange(arr, start, end) 有 bug：```js\nfunction sumRange(arr, start, end) {\n  return arr.slice(start, end).reduce((a,b)=>a+b, 0);\n}\nsumRange([1,2,3,4,5], 1, 3); // 想算 idx 1 到 3 含端點 = 2+3+4 = 9，但回 5\n```\n指出 bug 並給修正版（要包含 idx end）。",
            },
            {
                id: "V2-fence-emphasized",
                prompt: "**重要：以下訊息中已附完整代碼，請直接分析不要請求補充。**\n\n下面這段 sumRange(arr, start, end) 有 bug：\n```js\nfunction sumRange(arr, start, end) {\n  return arr.slice(start, end).reduce((a,b)=>a+b, 0);\n}\nsumRange([1,2,3,4,5], 1, 3); // 想算 idx 1 到 3 含端點 = 2+3+4 = 9，但回 5\n```\n指出 bug 並給修正版（要包含 idx end）。",
            },
            {
                id: "V3-inline",
                prompt: "修正 sumRange 函式：`function sumRange(arr, start, end) { return arr.slice(start, end).reduce((a,b)=>a+b, 0); }` — 呼叫 sumRange([1,2,3,4,5], 1, 3) 預期得 9 (含端點 idx 1-3) 但回 5。指出 bug 並給修正版。",
            },
        ],
    },
    {
        id: "B3",
        oks: [/(\?\.length|x\s*\?\?\s*''|if\s*\(x|x\s+as\s+string|x!|<string>x|return\s+0|return\s+null)/i],
        variants: [
            {
                id: "V1-fence",
                prompt: "下面 TypeScript 編譯失敗：```ts\nfunction len(x: string | null) { return x.length; }\n```\n錯誤是 'x is possibly null'。給最簡修法。",
            },
            {
                id: "V2-fence-emphasized",
                prompt: "**重要：以下訊息中已附完整代碼，請直接分析不要請求補充。**\n\n下面 TypeScript 編譯失敗：\n```ts\nfunction len(x: string | null) { return x.length; }\n```\n錯誤是 'x is possibly null'。給最簡修法。",
            },
            {
                id: "V3-inline",
                prompt: "修正 TypeScript 編譯錯誤：`function len(x: string | null) { return x.length; }` — 錯誤是 'x is possibly null'。給最簡修法。",
            },
        ],
    },
    {
        id: "C3",
        oks: [/switch\s*\(/, /case\s+['\"]add['\"]/i],
        variants: [
            {
                id: "V1-fence",
                prompt: "把這段改成 switch：```js\nfunction handle(cmd) {\n  if (cmd === 'add') return 1;\n  else if (cmd === 'sub') return 2;\n  else if (cmd === 'mul') return 3;\n  else if (cmd === 'div') return 4;\n  else return 0;\n}\n```",
            },
            {
                id: "V2-fence-emphasized",
                prompt: "**重要：以下訊息中已附完整代碼，請直接轉換不要請求補充。**\n\n把這段改成 switch：\n```js\nfunction handle(cmd) {\n  if (cmd === 'add') return 1;\n  else if (cmd === 'sub') return 2;\n  else if (cmd === 'mul') return 3;\n  else if (cmd === 'div') return 4;\n  else return 0;\n}\n```",
            },
            {
                id: "V3-inline",
                prompt: "把這段改成 switch：function handle(cmd) { if (cmd === 'add') return 1; else if (cmd === 'sub') return 2; else if (cmd === 'mul') return 3; else if (cmd === 'div') return 4; else return 0; }",
            },
        ],
    },
];

type Result = {caseId: string, variantId: string, rep: number, timeMs: number, timedOut: boolean, ok: boolean, snippet: string};

async function runOnce(caseId: string, v: Variant, rep: number, oks: RegExp[]): Promise<Result> {
    const t0 = Date.now();
    let resultText = "";
    let resultIsError = false;
    let buf = "";
    const args = [
        ...CLI_ARGS_PREFIX, "--print",
        "--output-format", "stream-json",
        "--include-partial-messages", "--verbose",
        "--allow-dangerously-skip-permissions",
        "--model", MODEL, "--no-session-persistence",
        "-p", v.prompt,
    ];
    const child = spawn(CLI, args, {cwd: REPO_ROOT, env: {...process.env}, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32"});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
                const ev = JSON.parse(line);
                if (ev.type === "result") {
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
    const ok = !resultIsError && !timedOut && oks.every(re => re.test(resultText));
    const snippet = resultText.replace(/\s+/g, " ").slice(0, 80);
    return {caseId, variantId: v.id, rep, timeMs: dt, timedOut, ok, snippet};
}

(async () => {
    console.log(`\n=== Prompt-variant test (reps=${REPS}) — preset should be thinking-coding ===\n`);
    const all: Result[] = [];
    for (const c of CASES) {
        for (const v of c.variants) {
            for (let r = 1; r <= REPS; r++) {
                process.stdout.write(`▶ ${c.id} ${v.id} r${r} ... `);
                const res = await runOnce(c.id, v, r, c.oks);
                all.push(res);
                console.log(`${res.ok ? "✅" : "❌"} ${(res.timeMs/1000).toFixed(1)}s  ${res.snippet}`);
            }
        }
    }

    console.log(`\n=== Summary ===`);
    for (const c of CASES) {
        for (const v of c.variants) {
            const my = all.filter(r => r.caseId === c.id && r.variantId === v.id);
            const pass = my.filter(r => r.ok).length;
            console.log(`${c.id}-${v.id}: ${pass}/${my.length} = ${(pass/my.length*100).toFixed(0)}%`);
        }
    }
    // 寫 markdown
    const out: string[] = [];
    out.push(`# Prompt variant test (preset=thinking-coding, reps=${REPS})\n`);
    out.push(`Run: ${new Date().toISOString()}\n`);
    out.push(`| Case | Variant | Pass rate | Snippet (rep1) |`);
    out.push(`|------|---------|-----------|----------------|`);
    for (const c of CASES) {
        for (const v of c.variants) {
            const my = all.filter(r => r.caseId === c.id && r.variantId === v.id);
            const pass = my.filter(r => r.ok).length;
            const r1snip = my[0]?.snippet ?? "";
            out.push(`| ${c.id} | ${v.id} | ${pass}/${my.length} (${(pass/my.length*100).toFixed(0)}%) | \`${r1snip}\` |`);
        }
    }
    out.push(`\n## Detail\n`);
    out.push(`| Case-Variant-Rep | Time | OK | Snippet |`);
    out.push(`|-------------------|------|----|---------|`);
    for (const r of all) {
        out.push(`| ${r.caseId}-${r.variantId}-r${r.rep} | ${(r.timeMs/1000).toFixed(1)}s | ${r.ok ? "✅" : "❌"} | \`${r.snippet}\` |`);
    }
    const outFile = path.join(REPO_ROOT, "stress-results", "prompt-variants.md");
    fs.writeFileSync(outFile, out.join("\n") + "\n");
    console.log(`\nWrote ${outFile}`);
})();
