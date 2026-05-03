/**
 * Phase G2 — speculative decoding (CopySpec) 純文字 smoke。
 *
 * CopySpec 從 prompt 後綴找重複序列做 model-free speculation。
 * 在 prompt 含重複內容時可加速 1.2-1.5x。
 *
 * 流程：
 *   1. loadModel + createContext（TURBO4 KV）
 *   2. tokenize prompt（含重複片段）
 *   3. 把 prompt 跑進 KV cache（用 evaluate 但不取 tokens；只 prefill）
 *   4. 用 generateWithSpeculative 跑 spec=copyspec vs spec=off 對比
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Qwen3.5-9B-Q4_K_M.gguf'
 *   node_modules/.bin/vite-node scripts/smoke-speculative-copyspec.ts
 */
import path from "node:path";
import {getLlama, GgmlType} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT;
if (!modelPath) {
    console.error("TEST_MODEL_TEXT env not set");
    process.exit(1);
}

console.log("[spec] loading llama (cuda) + model: " + path.basename(modelPath));
const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({modelPath});

const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    ignoreMemorySafetyChecks: true,
    experimentalKvCacheKeyType: GgmlType.TURBO4_0,
    experimentalKvCacheValueType: GgmlType.TURBO4_0
});
console.log("[spec] ctx ready, kvKeyType=" + ctx.kvCacheKeyType);

const seq = ctx.getSequence();
const seqId = seq.sequenceId ?? 0;

// 含重複內容的 prompt（CopySpec 受益場景）
const promptText =
    "List the steps:\n" +
    "Step 1: open the door\n" +
    "Step 2: turn on the light\n" +
    "Step 3: open the door\n" +
    "Step 4: turn off the light\n" +
    "Step 5:";

const promptTokens = (model as any).tokenize(promptText, true);
console.log("[spec] prompt tokens=" + promptTokens.length);

// Prefill：把 prompt 跑進 KV
console.log("[spec] prefill prompt...");
const tStart = Date.now();
const it = seq.evaluate(Array.from(promptTokens), {});
// 拉 generator 到產出第一個 token 為止才算 prefill 結束
const first = await it.next();
let initialToken: number | null = null;
if (!first.done) initialToken = first.value as number;
await it.return();
const prefillMs = Date.now() - tStart;
console.log("[spec] prefill done in " + prefillMs + "ms, first sampled token=" + initialToken);

// Sampler
const bindings = (model as any)._llama._bindings;
const sampler = new bindings.AddonSampler((model as any)._model);
sampler.applyConfig({temperature: 0, topK: 40, topP: 0.95, minP: 0.05});

// nPast 推斷：prompt 之後 sequence.nextTokenIndex
const nPast = (seq as any).nextTokenIndex;
console.log("[spec] starting nPast=" + nPast);

const t0 = Date.now();
const result = await ctx.generateWithSpeculative({
    sampler,
    nPast,
    maxTokens: 60,
    seqId,
    spec: {type: "copyspec", nMax: 16, copyspecGamma: 6}
});
const dt = Date.now() - t0;
const text = (model as any).detokenize(new Uint32Array(result.tokens as number[]), false);
const accept = result.nDrafted > 0 ? (result.nAccepted / result.nDrafted * 100).toFixed(1) : "0";
console.log(`[spec] copyspec: ${result.tokens.length} tokens in ${dt}ms (${(result.tokens.length / (dt / 1000)).toFixed(1)} tok/s)`);
console.log(`[spec]    drafted=${result.nDrafted}, accepted=${result.nAccepted} (${accept}%)`);
console.log(`[spec]    text: ${JSON.stringify(text.slice(0, 200))}`);

if (result.tokens.length === 0) {
    console.error("[spec] ⚠ no tokens generated");
    process.exit(3);
}

console.log("[spec] OK ✓ — generateWithSpec CopySpec 路徑通");
process.exit(0);
