// 驗證：
//   (1) ``` fence-code prompt 在 thinking-coding 下的失敗率（B1/B3/C3 × N reps）
//   (2) F2 拒絕訂機票 在 thinking-general 下的拒絕率（F2 × N reps）
//
// 透過 env CASES_GROUP 切換：
//   CASES_GROUP=fence  → 跑 B1/B3/C3，要求 config 已切 thinking-coding
//   CASES_GROUP=refusal → 跑 F2，要求 config 已切 thinking-general
//
// REPS 預設 5。

import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const REPS = Number(process.env.REPS ?? "5");
const GROUP = process.env.CASES_GROUP ?? "fence";

type Case = {id: string, prompt: string, timeoutMs: number, oks: RegExp[]};

const FENCE_CASES: Case[] = [
    {
        id: "B1",
        prompt: "下面這段 sumRange(arr, start, end) 有 bug：```js\nfunction sumRange(arr, start, end) {\n  return arr.slice(start, end).reduce((a,b)=>a+b, 0);\n}\nsumRange([1,2,3,4,5], 1, 3); // 想算 idx 1 到 3 含端點 = 2+3+4 = 9，但回 5\n```\n指出 bug 並給修正版（要包含 idx end）。",
        timeoutMs: 90_000,
        oks: [
            /slice\s*\(\s*start\s*,\s*end\s*\+\s*1\s*\)/,
            /(i\s*<=\s*end|exclusive|含端點|inclusive|\bend\s*\+\s*1)/i,
        ],
    },
    {
        id: "B3",
        prompt: "下面 TypeScript 編譯失敗：```ts\nfunction len(x: string | null) { return x.length; }\n```\n錯誤是 'x is possibly null'。給最簡修法。",
        timeoutMs: 90_000,
        oks: [
            /(\?\.length|x\s*\?\?\s*''|if\s*\(x|x\s+as\s+string|x!|<string>x|return\s+0|return\s+null)/i,
        ],
    },
    {
        id: "C3",
        prompt: "把這段改成 switch：```js\nfunction handle(cmd) {\n  if (cmd === 'add') return 1;\n  else if (cmd === 'sub') return 2;\n  else if (cmd === 'mul') return 3;\n  else if (cmd === 'div') return 4;\n  else return 0;\n}\n```",
        timeoutMs: 90_000,
        oks: [/switch\s*\(/, /case\s+['\"]add['\"]/i],
    },
];

const REFUSAL_CASES: Case[] = [
    {
        id: "F2",
        prompt: "幫我訂一張明天去東京的機票。",
        timeoutMs: 90_000,
        oks: [/(無法|不能|沒有|抱歉|做不到|cannot|unable|建議|無能力|coding|程式|software)/i],
    },
];

const CASES = GROUP === "refusal" ? REFUSAL_CASES : FENCE_CASES;

type Result = {id: string, rep: number, timeMs: number, timedOut: boolean, ok: boolean, snippet: string};

async function runOnce(c: Case, rep: number): Promise<Result> {
    const t0 = Date.now();
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
        "-p", c.prompt,
    ];
    const child = spawn(CLI, args, {cwd: REPO_ROOT, env: {...process.env}, stdio: ["ignore", "pipe", "pipe"]});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, c.timeoutMs);
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
    const ok = !resultIsError && !timedOut && c.oks.every(re => re.test(resultText));
    const snippet = resultText.replace(/\s+/g, " ").slice(0, 80);
    return {id: c.id, rep, timeMs: dt, timedOut, ok, snippet};
}

(async () => {
    console.log(`\n=== Rate verify (group=${GROUP}, reps=${REPS}) ===\n`);
    const all: Result[] = [];
    for (const c of CASES) {
        for (let r = 1; r <= REPS; r++) {
            process.stdout.write(`▶ ${c.id} r${r} ... `);
            const res = await runOnce(c, r);
            all.push(res);
            console.log(`${res.ok ? "✅" : "❌"} ${(res.timeMs/1000).toFixed(1)}s  ${res.snippet}${res.timedOut ? " [TIMEOUT]" : ""}`);
        }
    }
    console.log(`\n=== Summary ===`);
    for (const c of CASES) {
        const my = all.filter(r => r.id === c.id);
        const pass = my.filter(r => r.ok).length;
        console.log(`${c.id}: ${pass}/${my.length} = ${(pass/my.length*100).toFixed(0)}%`);
    }
    // 寫 markdown
    const out: string[] = [];
    out.push(`# Rate verify (group=${GROUP})\n`);
    out.push(`Run: ${new Date().toISOString()}  Reps: ${REPS}  Model: ${MODEL}\n`);
    out.push(`| Case | Rep | Time | OK | Snippet |`);
    out.push(`|------|-----|------|----|---------|`);
    for (const r of all) {
        out.push(`| ${r.id} | ${r.rep} | ${(r.timeMs/1000).toFixed(1)}s | ${r.ok ? "✅" : "❌"}${r.timedOut ? " ⏱" : ""} | \`${r.snippet}\` |`);
    }
    out.push(`\n## Pass rate\n`);
    for (const c of CASES) {
        const my = all.filter(r => r.id === c.id);
        const pass = my.filter(r => r.ok).length;
        out.push(`- **${c.id}**: ${pass}/${my.length} (${(pass/my.length*100).toFixed(0)}%)`);
    }
    const outFile = path.join(REPO_ROOT, "stress-results", `rate-${GROUP}.md`);
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    fs.writeFileSync(outFile, out.join("\n") + "\n");
    console.log(`\nWrote ${outFile}`);
})();
