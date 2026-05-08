// V4 plain-text 縮排（不用 backticks）— B1/B3/C3 各 N=3 = 9 runs
// 用 thinking-coding 跑（與 V1/V2/V3 直接對照）

import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI = "bun";
const CLI_ARGS_PREFIX = [path.join(REPO_ROOT, "src", "entrypoints", "cli.tsx")];
const MODEL = "qwen3.5-9b";
const REPS = 3;

type CaseSpec = {id: string, prompt: string, oks: RegExp[]};

const CASES: CaseSpec[] = [
    {
        id: "B1-V4-plaintext",
        // 純文字，無 backticks，4 空格縮排示意 code
        prompt: `下面這段 sumRange 函式有 bug，請修正：

    function sumRange(arr, start, end) {
      return arr.slice(start, end).reduce((a,b)=>a+b, 0);
    }

呼叫 sumRange([1,2,3,4,5], 1, 3) 想算 idx 1 到 3 含端點 = 9，但回 5。指出 bug 並給修正版（要包含 idx end）。`,
        oks: [/(slice\s*\(\s*start\s*,\s*end\s*\+\s*1\s*\)|i\s*<=\s*end|含端點|inclusive|\bend\s*\+\s*1)/i],
    },
    {
        id: "B3-V4-plaintext",
        prompt: `下面 TypeScript 編譯失敗：

    function len(x: string | null) {
      return x.length;
    }

錯誤是 'x is possibly null'。給最簡修法。`,
        oks: [/(\?\.length|x\s*\?\?\s*''|if\s*\(x|x\s+as\s+string|x!|<string>x|return\s+0|return\s+null)/i],
    },
    {
        id: "C3-V4-plaintext",
        prompt: `把下面這段改成 switch：

    function handle(cmd) {
      if (cmd === 'add') return 1;
      else if (cmd === 'sub') return 2;
      else if (cmd === 'mul') return 3;
      else if (cmd === 'div') return 4;
      else return 0;
    }`,
        oks: [/switch\s*\(/, /case\s+['\"]add['\"]/i],
    },
];

type Result = {id: string, rep: number, timeMs: number, timedOut: boolean, ok: boolean, snippet: string};

async function runOnce(c: CaseSpec, rep: number): Promise<Result> {
    const t0 = Date.now();
    let resultText = "", resultIsError = false, buf = "";
    const args = [
        ...CLI_ARGS_PREFIX, "--print",
        "--output-format", "stream-json",
        "--include-partial-messages", "--verbose",
        "--allow-dangerously-skip-permissions",
        "--model", MODEL, "--no-session-persistence",
        "-p", c.prompt,
    ];
    const child = spawn(CLI, args, {cwd: REPO_ROOT, env: {...process.env}, stdio: ["ignore", "pipe", "pipe"]});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
                const ev = JSON.parse(line);
                if (ev.type === "result") { resultText = ev.result ?? ""; resultIsError = ev.is_error === true; }
            } catch {}
        }
    });
    child.stderr.on("data", () => {});
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);
    const ok = !resultIsError && !timedOut && c.oks.every(re => re.test(resultText));
    return {id: c.id, rep, timeMs: Date.now() - t0, timedOut, ok, snippet: resultText.replace(/\s+/g, " ").slice(0, 100)};
}

(async () => {
    console.log(`\n=== V4 plain-text test (preset=thinking-coding, reps=${REPS}) ===\n`);
    const all: Result[] = [];
    for (const c of CASES) {
        for (let r = 1; r <= REPS; r++) {
            process.stdout.write(`▶ ${c.id} r${r} ... `);
            const res = await runOnce(c, r);
            all.push(res);
            console.log(`${res.ok ? "✅" : "❌"} ${(res.timeMs/1000).toFixed(1)}s  ${res.snippet}`);
        }
    }
    console.log(`\n=== Summary ===`);
    for (const c of CASES) {
        const my = all.filter(r => r.id === c.id);
        const pass = my.filter(r => r.ok).length;
        console.log(`${c.id}: ${pass}/${my.length} = ${(pass/my.length*100).toFixed(0)}%`);
    }
    const out = [
        `# V4 plain-text result\nRun: ${new Date().toISOString()}\n`,
        `| Case-Rep | Time | OK | Snippet |`, `|----------|------|----|---------|`,
        ...all.map(r => `| ${r.id}-r${r.rep} | ${(r.timeMs/1000).toFixed(1)}s | ${r.ok ? "✅" : "❌"} | \`${r.snippet}\` |`),
        ``, `## Pass rate`, ``,
        ...CASES.map(c => {
            const my = all.filter(r => r.id === c.id);
            const pass = my.filter(r => r.ok).length;
            return `- **${c.id}**: ${pass}/${my.length} (${(pass/my.length*100).toFixed(0)}%)`;
        }),
    ];
    fs.writeFileSync(path.join(REPO_ROOT, "stress-results", "v4-plaintext.md"), out.join("\n") + "\n");
    console.log(`\nWrote stress-results/v4-plaintext.md`);
})();
