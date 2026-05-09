/**
 * Vision benchmark：F16 vs TURBO4 × 1/2/4 images × ctx 8K/16K。
 * 主要看多圖 + long-ctx 下 KV 壓縮比例。
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Qwen3.5-9B-Q4_K_M.gguf'
 *   $env:TEST_MMPROJ='C:\Users\LOREN\Documents\_projects\my-agent\models\mmproj-Qwen3.5-9B-F16.gguf'
 *   cd vendor/node-llama-tcq
 *   node_modules/.bin/vite-node scripts/benchmark-vision.ts
 */
import {execSync, spawnSync} from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {GgmlType} from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const childScript = path.resolve(path.dirname(__filename), "benchmark-vision-worker.ts");
const viteNodeBin = path.resolve("node_modules/vite-node/dist/cli.mjs");

const modelPath = process.env.TEST_MODEL_TEXT;
const mmprojPath = process.env.TEST_MMPROJ;
if (!modelPath || !mmprojPath) {
    console.error("TEST_MODEL_TEXT and TEST_MMPROJ env required");
    process.exit(1);
}

const variants: Array<[string, GgmlType]> = [
    ["F16", GgmlType.F16],
    ["TURBO4", GgmlType.TURBO4_0]
];
const imageCounts = [1, 2, 4];
const ctxSize = 16384;  // 固定 16K 比較易計算 KV 大小

interface Run {
    label: string;
    kvType: string;
    nImages: number;
    ctxSize: number;
    vramModel: number;
    vramCtxMtmd: number;
    vramKvImg: number;
    vramTotal: number;
    totalTokens: number;
    tokMs: number;
    evalMs: number;
    genMs: number;
    nGen: number;
    tokPerSec: number;
    replyPreview: string;
    error?: string;
}

const results: Run[] = [];
for (const [label, kv] of variants) {
    for (const n of imageCounts) {
        console.log(`\n=== ${label} × ${n} image(s) × ctx=${ctxSize} ===`);
        const r = spawnSync(
            process.execPath,
            [viteNodeBin, childScript],
            {
                env: {
                    ...process.env,
                    BENCH_KV_TYPE: String(kv),
                    BENCH_N_IMAGES: String(n),
                    BENCH_CTX_SIZE: String(ctxSize)
                },
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "inherit"]
            }
        );
        if (r.status !== 0) {
            results.push({
                label, kvType: GgmlType[kv]!, nImages: n, ctxSize,
                vramModel: 0, vramCtxMtmd: 0, vramKvImg: 0, vramTotal: 0,
                totalTokens: 0, tokMs: 0, evalMs: 0, genMs: 0, nGen: 0, tokPerSec: 0,
                replyPreview: "", error: `exit ${r.status}`
            });
            console.log(`  ✖ exit ${r.status}`);
            continue;
        }
        const jsonLine = r.stdout.split(/\n/).find(l => l.startsWith("BENCH_RESULT="));
        if (!jsonLine) {
            console.log(`  ✖ no result; stdout tail:`);
            console.log(r.stdout.split(/\n/).slice(-5).join("\n"));
            results.push({
                label, kvType: GgmlType[kv]!, nImages: n, ctxSize,
                vramModel: 0, vramCtxMtmd: 0, vramKvImg: 0, vramTotal: 0,
                totalTokens: 0, tokMs: 0, evalMs: 0, genMs: 0, nGen: 0, tokPerSec: 0,
                replyPreview: "", error: "no result line"
            });
            continue;
        }
        const obj = JSON.parse(jsonLine.replace("BENCH_RESULT=", ""));
        results.push({...obj, label, kvType: GgmlType[kv]!, nImages: n, ctxSize});
        console.log(`  totalTokens=${obj.totalTokens} eval=${obj.evalMs}ms gen=${obj.genMs}ms (${obj.tokPerSec.toFixed(1)} tok/s)`);
        console.log(`  VRAM model=${obj.vramModel} mtmd+ctx=${obj.vramCtxMtmd} kvImg=${obj.vramKvImg} total=${obj.vramTotal} MB`);
        console.log(`  reply: "${obj.replyPreview}"`);
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
    `# Vision benchmark — Qwen3.5-9B-Q4_K_M + mmproj F16`,
    "",
    `Model: ${path.basename(modelPath)}`,
    `mmproj: ${path.basename(mmprojPath)}`,
    `Hardware: ${hwName}`,
    `ctx=${ctxSize}, image: test-1.jpeg (newspaper, 20×15=300 image tokens each)`,
    "",
    "## VRAM total (MB)",
    "",
    `| Variant | 1 img | 2 imgs | 4 imgs |`,
    `|---------|-------|--------|--------|`,
];
for (const [label] of variants) {
    const row = imageCounts.map(n => {
        const r = results.find(x => x.label === label && x.nImages === n);
        return r?.error ? "—" : String(r!.vramTotal);
    });
    md.push(`| ${label} | ${row.join(" | ")} |`);
}
md.push("");
md.push("## Detail");
md.push("");
md.push("| Variant | imgs | totalTokens | eval ms | gen ms | tok/s | VRAM MB | reply preview |");
md.push("|---------|------|-------------|---------|--------|-------|---------|---------------|");
for (const r of results) {
    md.push(`| ${r.label} | ${r.nImages} | ${r.error ? "—" : r.totalTokens} | ${r.error ? "—" : r.evalMs} | ${r.error ? "—" : r.genMs} | ${r.error ? "—" : r.tokPerSec.toFixed(1)} | ${r.error ? r.error : r.vramTotal} | ${r.error ? "" : "`" + r.replyPreview + "`"} |`);
}

const outPath = path.resolve("BENCHMARKS-VISION.md");
fs.writeFileSync(outPath, md.join("\n"), "utf-8");
console.log(`\n✓ wrote ${outPath}`);
