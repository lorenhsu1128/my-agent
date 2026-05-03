/**
 * Phase D 純文字 benchmark：TURBO4 vs baseline。
 *
 * 為了量乾淨的 VRAM delta，每個變體跑一個 child process：
 *   parent 啟 child，child 跑單一變體 → JSON 一行到 stdout → exit
 *   parent 收集所有結果，產 BENCHMARKS.md
 */
import {execSync, spawnSync} from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {GgmlType} from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const childScript = path.resolve(path.dirname(__filename), "benchmark-turbo4-worker.ts");

const modelPath = process.env.TEST_MODEL_TEXT;
if (!modelPath) {
    console.error("TEST_MODEL_TEXT env not set");
    process.exit(1);
}

interface Run {
    label: string;
    kvType: string;
    kvNum: number;
    loadMs: number;
    createMs: number;
    promptMs: number;
    replyLen: number;
    replyPreview: string;
    vramMB: number;
    error?: string;
}

const variants: Array<[string, GgmlType]> = [
    ["F16 (baseline)", GgmlType.F16],
    ["Q8_0", GgmlType.Q8_0],
    ["TURBO4_0", GgmlType.TURBO4_0]
];

// child 會繼承 PATH 與 env；若 worker 不存在則先建立
if (!fs.existsSync(childScript)) {
    console.error("worker script missing: " + childScript);
    process.exit(1);
}

const results: Run[] = [];
for (const [label, kv] of variants) {
    console.log(`\n=== running child for ${label} (kv=${kv}) ===`);
    const viteNodeBin = path.resolve("node_modules/vite-node/dist/cli.mjs");
    const r = spawnSync(
        process.execPath,
        [viteNodeBin, childScript],
        {
            env: {...process.env, BENCH_KV_TYPE: String(kv), BENCH_LABEL: label},
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "inherit"]
        }
    );
    if (r.error) console.error("  spawn error:", r.error.message);
    if (r.status !== 0) {
        results.push({
            label, kvType: GgmlType[kv]!, kvNum: kv,
            loadMs: 0, createMs: 0, promptMs: 0, replyLen: 0, replyPreview: "",
            vramMB: 0, error: `exit code ${r.status}`
        });
        continue;
    }
    const lines = r.stdout.split(/\n/).filter(Boolean);
    const jsonLine = lines.find(l => l.startsWith("BENCH_RESULT="));
    if (!jsonLine) {
        results.push({
            label, kvType: GgmlType[kv]!, kvNum: kv,
            loadMs: 0, createMs: 0, promptMs: 0, replyLen: 0, replyPreview: "",
            vramMB: 0, error: "no BENCH_RESULT line"
        });
        continue;
    }
    const obj = JSON.parse(jsonLine.replace("BENCH_RESULT=", ""));
    results.push({...obj, label, kvType: GgmlType[kv]!, kvNum: kv});
}

// 寫 BENCHMARKS.md
const hwName = (() => {
    try {
        return execSync("nvidia-smi --query-gpu=name --format=csv,noheader").toString().trim();
    } catch {
        return "unknown";
    }
})();

const md = [
    `# Benchmark — ${path.basename(modelPath)}`,
    "",
    `Model: ${path.basename(modelPath)}, contextSize=4096`,
    `Hardware: ${hwName}`,
    `Runtime: node-llama-tcq + buun-llama-cpp (CUDA)`,
    "",
    "Each variant runs in a fresh child process for clean VRAM measurement.",
    "",
    "| Variant | KV Type | VRAM (MB) | createCtx (ms) | prompt (ms) | reply len |",
    "|---------|---------|-----------|----------------|-------------|-----------|",
    ...results.map(r => r.error
        ? `| ${r.label} | ${r.kvType} (${r.kvNum}) | — | — | — | error: ${r.error} |`
        : `| ${r.label} | ${r.kvType} (${r.kvNum}) | ${r.vramMB} | ${r.createMs} | ${r.promptMs} | ${r.replyLen} |`
    ),
    "",
    "## Reply previews",
    "",
    ...results.flatMap(r => [`### ${r.label}`, "", "```", r.error ?? r.replyPreview, "```", ""])
].join("\n");

const outPath = path.resolve("BENCHMARKS.md");
fs.writeFileSync(outPath, md, "utf-8");
console.log(`\n✓ wrote ${outPath}`);
console.log("\n=== summary ===");
for (const r of results) {
    if (r.error) console.log(`  ${r.label}: ${r.error}`);
    else console.log(`  ${r.label}: VRAM=${r.vramMB}MB ctx=${r.createMs}ms prompt=${r.promptMs}ms replyLen=${r.replyLen}`);
}
