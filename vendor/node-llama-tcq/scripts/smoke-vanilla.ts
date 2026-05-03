/**
 * Phase A5：標準（非 TCQ）量化路徑 smoke test。
 * 確認替換 buun-llama-cpp 後，原本的 q8_0 / f16 KV cache 路徑仍可用。
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Qwen3.5-9B-Q4_K_M.gguf'
 *   node --import tsx scripts/smoke-vanilla.ts
 */
import path from "node:path";
import {getLlama, LlamaChatSession, GgmlType} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT;
if (!modelPath) {
    console.error("TEST_MODEL_TEXT env not set");
    process.exit(1);
}

console.log("[vanilla] loading llama, model=" + path.basename(modelPath));

const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({modelPath});
const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    experimentalKvCacheKeyType: GgmlType.Q8_0,
    experimentalKvCacheValueType: GgmlType.Q8_0
});

console.log("[vanilla] ctx ready, kvKeyType=" + ctx.kvCacheKeyType);

const session = new LlamaChatSession({contextSequence: ctx.getSequence()});
const reply = await session.prompt("用一句話介紹你自己", {maxTokens: 64});
console.log("[vanilla] reply: " + reply);
console.log("[vanilla] OK ✓");

await ctx.dispose();
await model.dispose();
process.exit(0);
