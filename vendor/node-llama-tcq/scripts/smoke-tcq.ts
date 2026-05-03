/**
 * Phase A6：TCQ KV cache 壓縮 smoke test。
 * 用 Qwen3.5-9B-Q4_K_M.gguf（head_dim=128，符合 TCQ 條件）+ TURBO3_TCQ。
 * 驗證 .node addon 接受 ggml_type=45 並能正常產 token。
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Qwen3.5-9B-Q4_K_M.gguf'
 *   node --import tsx scripts/smoke-tcq.ts
 */
import path from "node:path";
import {
    getLlama, LlamaChatSession, GgmlType,
    applyTCQCodebooks, isTCQAvailable, TCQPresets, defaultCodebooks
} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT;
if (!modelPath) {
    console.error("TEST_MODEL_TEXT env not set");
    process.exit(1);
}

const avail = isTCQAvailable();
if (!avail.ok) {
    console.error("TCQ unavailable: " + avail.reason);
    process.exit(2);
}

console.log("[tcq] codebooks: 3bit=" + path.basename(defaultCodebooks.threeBit) +
    " 2bit=" + path.basename(defaultCodebooks.twoBit));

// 必須在 loadModel 之前 setup env
applyTCQCodebooks();
console.log("[tcq] env: TURBO_TCQ_CB=" + (process.env.TURBO_TCQ_CB ? "set" : "missing") +
    ", TURBO_TCQ_CB2=" + (process.env.TURBO_TCQ_CB2 ? "set" : "missing"));

const llama = await getLlama();
const model = await llama.loadModel({modelPath});

const preset = TCQPresets.TURBO3_TCQ;
console.log("[tcq] preset=" + preset.label + " bpv=" + preset.bpv +
    " keyType=" + GgmlType[preset.keyType] + "(" + preset.keyType + ")");

const ctx = await model.createContext({
    contextSize: 8192,
    experimentalKvCacheKeyType: preset.keyType,
    experimentalKvCacheValueType: preset.valueType
});

console.log("[tcq] ctx ready, kvKeyType=" + ctx.kvCacheKeyType + " (expect 45)");

const session = new LlamaChatSession({contextSequence: ctx.getSequence()});
const reply = await session.prompt("用一句話介紹你自己", {maxTokens: 64});
console.log("[tcq] reply: " + reply);
console.log("[tcq] OK ✓ — TCQ KV cache 路徑可用");

await ctx.dispose();
await model.dispose();
process.exit(0);
