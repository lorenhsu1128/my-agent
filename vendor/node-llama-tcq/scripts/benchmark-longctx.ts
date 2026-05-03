/**
 * Long-context benchmark：F16 vs TURBO4 在 ctx=4K / 16K / 32K / 65K 對比。
 * 主要看 KV cache VRAM 隨 ctx 線性成長下，TURBO4 vs F16 的差距。
 *
 * 每組 (kvType, ctxSize) 跑獨立 child process（VRAM 量乾淨）。
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Qwen3.5-9B-Q4_K_M.gguf'
 *   cd vendor/node-llama-tcq
 *   node_modules/.bin/vite-node scripts/benchmark-longctx.ts
 */
import {execSync, spawnSync} from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {GgmlType} from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const childScript = path.resolve(path.dirname(__filename), "benchmark-longctx-worker.ts");

const modelPath = process.env.TEST_MODEL_TEXT;
if (!modelPath) {
    console.error("TEST_MODEL_TEXT env not set");
    process.exit(1);
}

const variants: Array<[string, GgmlType]> = [
    ["F16", GgmlType.F16],
    ["TURBO4", GgmlType.TURBO4_0]
];
const ctxSizes = [4096, 16384, 32768, 65536];

interface Run {
    label: string;
    kvType: string;
    ctxSize: number;
    vramModel: number;
    vramKv: number;
    vramTotal: number;
    loadMs: number;
    createMs: number;
    promptMs: number;
    replyLen: number;
    replyPreview: string;
    error?: string;
}

const viteNodeBin = path.resolve("node_modules/vite-node/dist/cli.mjs");
const results: Run[] = [];

for (const [label, kv] of variants) {
    for (const ctxSize of ctxSizes) {
        console.log(`\n=== ${label} (kv=${kv}) ctx=${ctxSize} ===`);
        const r = spawnSync(
            process.execPath,
            [viteNodeBin, childScript],
            {
                env: {
                    ...process.env,
                    BENCH_KV_TYPE: String(kv),
                    BENCH_CTX_SIZE: String(ctxSize)
                },
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "inherit"]
            }
        );
        if (r.status !== 0) {
            results.push({
                label, kvType: GgmlType[kv]!, ctxSize,
                vramModel: 0, vramKv: 0, vramTotal: 0,
                loadMs: 0, createMs: 0, promptMs: 0, replyLen: 0, replyPreview: "",
                error: `exit code ${r.status}`
            });
            console.log(`  ✖ exit ${r.status}`);
            continue;
        }
        const jsonLine = r.stdout.split(/\n/).find(l => l.startsWith("BENCH_RESULT="));
        if (!jsonLine) {
            results.push({
                label, kvType: GgmlType[kv]!, ctxSize,
                vramModel: 0, vramKv: 0, vramTotal: 0,
                loadMs: 0, createMs: 0, promptMs: 0, replyLen: 0, replyPreview: "",
                error: "no result line"
            });
            console.log(`  ✖ no result`);
            continue;
        }
        const obj = JSON.parse(jsonLine.replace("BENCH_RESULT=", ""));
        results.push({...obj, label, kvType: GgmlType[kv]!, ctxSize});
        console.log(`  VRAM model=${obj.vramModel}MB kv=${obj.vramKv}MB total=${obj.vramTotal}MB`);
        console.log(`  load=${obj.loadMs}ms ctx=${obj.createMs}ms prompt=${obj.promptMs}ms reply.len=${obj.replyLen}`);
    }
}

const hwName = (() => {
    try {
        return execSync("nvidia-smi --query-gpu=name --format=csv,noheader").toString().trim();
    } catch {
        return "unknown";
    }
})();

const md: string[] = [
    `# Long-context benchmark — ${path.basename(modelPath)}`,
    "",
    `Model: ${path.basename(modelPath)}`,
    `Hardware: ${hwName}`,
    `Runtime: node-llama-tcq + buun-llama-cpp (CUDA, flash_attn, ignoreMemorySafetyChecks=true)`,
    "",
    "Each (variant, ctxSize) cell runs in a fresh child process.",
    "",
    "## VRAM (MB) by context size",
    "",
    `| Variant | ${ctxSizes.map(c => `ctx=${c}`).join(" | ")} |`,
    `|---------|${ctxSizes.map(() => "-----").join("|")}|`,
];

for (const [label] of variants) {
    const row = ctxSizes.map(c => {
        const r = results.find(x => x.label === label && x.ctxSize === c);
        if (!r || r.error) return r?.error ?? "—";
        return `${r.vramTotal} (kv=${r.vramKv})`;
    });
    md.push(`| ${label} | ${row.join(" | ")} |`);
}

md.push("");
md.push("## Detailed table");
md.push("");
md.push("| Variant | ctx | VRAM model | VRAM KV | VRAM total | createCtx (ms) | prompt (ms) | reply.len |");
md.push("|---------|-----|-----------|---------|-----------|----------------|-------------|-----------|");
for (const r of results) {
    md.push(`| ${r.label} | ${r.ctxSize} | ${r.error ? "—" : r.vramModel} | ${r.error ? "—" : r.vramKv} | ${r.error ? r.error : r.vramTotal} | ${r.error ? "—" : r.createMs} | ${r.error ? "—" : r.promptMs} | ${r.error ? "—" : r.replyLen} |`);
}

const outPath = path.resolve("BENCHMARKS-LONGCTX.md");
fs.writeFileSync(outPath, md.join("\n"), "utf-8");
console.log(`\n✓ wrote ${outPath}`);
