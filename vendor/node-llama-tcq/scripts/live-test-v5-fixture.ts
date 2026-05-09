// V5 fixture + Read tool 驗證 — B1/B3/C3 各 N=3 = 9 runs

import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {killTree} from "./_lib/killTree";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = "qwen3.5-9b";
const REPS = 3;

type CaseSpec = {id: string, prompt: string, oks: RegExp[]};

const CASES: CaseSpec[] = [
    {
        id: "B1-V5-fixture",
        prompt: "請用 Read 工具讀 tests/fixtures/preset-verify/B1-buggy-sumRange.js，這個 sumRange 函式有 bug — 想算含端點 idx range 但用 slice 變成不含 end。指出 bug 並給修正版（要包含 idx end）。",
        oks: [/(slice\s*\(\s*start\s*,\s*end\s*\+\s*1\s*\)|i\s*<=\s*end|含端點|inclusive|\bend\s*\+\s*1)/i],
    },
    {
        id: "B3-V5-fixture",
        prompt: "請用 Read 工具讀 tests/fixtures/preset-verify/B3-buggy-len.ts，這個函式編譯失敗於 'x is possibly null'。給最簡修法。",
        oks: [/(\?\.length|x\s*\?\?\s*''|if\s*\(x|x\s+as\s+string|x!|<string>x|return\s+0|return\s+null)/i],
    },
    {
        id: "C3-V5-fixture",
        prompt: "請用 Read 工具讀 tests/fixtures/preset-verify/C3-handle.js，把這個 handle 函式從 if-else chain 改成 switch 結構。給轉換後的 code。",
        oks: [/switch\s*\(/, /case\s+['\"]add['\"]/i],
    },
];

type Result = {id: string, rep: number, timeMs: number, timedOut: boolean, ok: boolean, snippet: string, tools: number};

async function runOnce(c: CaseSpec, rep: number): Promise<Result> {
    const t0 = Date.now();
    let resultText = "", resultIsError = false, buf = "", toolCount = 0;
    const args = [
        ...CLI_ARGS_PREFIX, "--print",
        "--output-format", "stream-json",
        "--include-partial-messages", "--verbose",
        "--allow-dangerously-skip-permissions",
        "--model", MODEL, "--no-session-persistence",
        "-p", c.prompt,
    ];
    const child = spawn(CLI, args, {cwd: REPO_ROOT, env: {...process.env}, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32"});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, 180_000);
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
                    if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") toolCount++;
                } else if (ev.type === "result") {
                    resultText = ev.result ?? ""; resultIsError = ev.is_error === true;
                }
            } catch {}
        }
    });
    child.stderr.on("data", () => {});
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);
    const ok = !resultIsError && !timedOut && c.oks.every(re => re.test(resultText));
    return {id: c.id, rep, timeMs: Date.now() - t0, timedOut, ok, snippet: resultText.replace(/\s+/g, " ").slice(0, 100), tools: toolCount};
}

(async () => {
    console.log(`\n=== V5 fixture+Read test (preset=thinking-coding, reps=${REPS}) ===\n`);
    const all: Result[] = [];
    for (const c of CASES) {
        for (let r = 1; r <= REPS; r++) {
            process.stdout.write(`▶ ${c.id} r${r} ... `);
            const res = await runOnce(c, r);
            all.push(res);
            console.log(`${res.ok ? "✅" : "❌"} ${(res.timeMs/1000).toFixed(1)}s tools=${res.tools}  ${res.snippet}`);
        }
    }
    console.log(`\n=== Summary ===`);
    for (const c of CASES) {
        const my = all.filter(r => r.id === c.id);
        const pass = my.filter(r => r.ok).length;
        console.log(`${c.id}: ${pass}/${my.length} = ${(pass/my.length*100).toFixed(0)}%`);
    }
    const out = [
        `# V5 fixture+Read result\nRun: ${new Date().toISOString()}\n`,
        `| Case-Rep | Time | Tools | OK | Snippet |`, `|----------|------|-------|----|---------|`,
        ...all.map(r => `| ${r.id}-r${r.rep} | ${(r.timeMs/1000).toFixed(1)}s | ${r.tools} | ${r.ok ? "✅" : "❌"} | \`${r.snippet}\` |`),
        ``, `## Pass rate`, ``,
        ...CASES.map(c => {
            const my = all.filter(r => r.id === c.id);
            const pass = my.filter(r => r.ok).length;
            return `- **${c.id}**: ${pass}/${my.length} (${(pass/my.length*100).toFixed(0)}%)`;
        }),
    ];
    fs.writeFileSync(path.join(REPO_ROOT, "stress-results", "v5-fixture.md"), out.join("\n") + "\n");
    console.log(`\nWrote stress-results/v5-fixture.md`);
})();
