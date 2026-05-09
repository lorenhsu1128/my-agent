/**
 * TURBO4 KV cache 獨立 smoke test（4.25 bpv，無損品質）。
 * 用 Qwen3.5-9B-Q4_K_M.gguf。
 * 比 TURBO3_TCQ 簡單：純標量量化、不走 trellis、不需 codebook env。
 */
import path from "node:path";
import {
    getLlama, LlamaChatSession, GgmlType,
    isTCQAvailable, TCQPresets
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

console.log("[turbo4] loading llama, model=" + path.basename(modelPath));
const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({modelPath});

const preset = TCQPresets.TURBO4;
console.log("[turbo4] preset=" + preset.label + " bpv=" + preset.bpv +
    " keyType=" + GgmlType[preset.keyType] + "(" + preset.keyType + ")");

const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    experimentalKvCacheKeyType: preset.keyType,
    experimentalKvCacheValueType: preset.valueType
});

console.log("[turbo4] ctx ready, kvKeyType=" + ctx.kvCacheKeyType +
    " kvValueType=" + ctx.kvCacheValueType + " (expect 43)");

const session = new LlamaChatSession({contextSequence: ctx.getSequence()});

const prompt = "What is 2+2? Answer in one short sentence.";
console.log("[turbo4] prompt: " + JSON.stringify(prompt));

const reply = await session.prompt(prompt, {maxTokens: 256});
console.log("[turbo4] reply.length=" + reply.length);
console.log("[turbo4] reply: " + JSON.stringify(reply));

if (reply.trim().length === 0) {
    console.error("[turbo4] WARNING: empty reply");
    process.exit(3);
}

console.log("[turbo4] OK ✓ TURBO4 inference 通");

// 故意不 dispose 以避免 CUDA error during cleanup
process.exit(0);
