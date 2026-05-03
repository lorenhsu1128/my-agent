/**
 * Phase E6 — vision smoke test：libmtmd binding 端到端 + TURBO4 KV cache。
 *
 * 流程：
 *   1. loadModel(Qwen3.5-9B-Q4_K_M.gguf)
 *   2. createContext({ kvType: TURBO4_0, ctx=4096, flashAttention })
 *   3. LlamaMtmdContext.loadMmproj(model, mmproj-Qwen3.5-9B-F16.gguf)
 *   4. mtmdCtx.tokenize({ text: "<media> describe", images: [{type:"file", data: test-1.jpeg}] })
 *   5. mtmdCtx.evalChunks(llamaCtx, chunks, nPast=0)
 *   6. session.completePrompt 從 newNPast 繼續推理 3-5 句描述
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Qwen3.5-9B-Q4_K_M.gguf'
 *   $env:TEST_MMPROJ='C:\Users\LOREN\Documents\_projects\my-agent\models\mmproj-Qwen3.5-9B-F16.gguf'
 *   node_modules/.bin/vite-node scripts/smoke-vision-turbo4.ts
 */
import path from "node:path";
import {
    getLlama, GgmlType,
    LlamaMtmdContext
} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT;
const mmprojPath = process.env.TEST_MMPROJ;
const imagePath = process.env.TEST_IMAGE
    ?? path.resolve("llama/llama.cpp/tools/mtmd/test-1.jpeg");

if (!modelPath || !mmprojPath) {
    console.error("TEST_MODEL_TEXT and TEST_MMPROJ env required");
    process.exit(1);
}

console.log("[vision] loading llama (cuda)");
const llama = await getLlama({gpu: "cuda"});

console.log("[vision] loading model: " + path.basename(modelPath));
const model = await llama.loadModel({modelPath});

console.log("[vision] creating context (TURBO4 KV, ctx=4096)");
const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    experimentalKvCacheKeyType: GgmlType.TURBO4_0,
    experimentalKvCacheValueType: GgmlType.TURBO4_0
});
console.log("[vision] ctx ready, kvKeyType=" + ctx.kvCacheKeyType);

console.log("[vision] loading mmproj: " + path.basename(mmprojPath));
const mtmdCtx = await LlamaMtmdContext.loadMmproj(model, {
    mmprojPath,
    useGpu: true,
    nThreads: 4
});
console.log("[vision] mtmd ready, vision=" + mtmdCtx.supportsVision +
    " audio=" + mtmdCtx.supportsAudio +
    " marker=" + JSON.stringify(mtmdCtx.defaultMarker));

console.log("[vision] tokenize prompt + image");
const promptText = `${mtmdCtx.defaultMarker}\nDescribe this image in 2-3 short sentences.`;
const chunks = await mtmdCtx.tokenize({
    text: promptText,
    images: [{type: "file", data: imagePath}]
});
console.log("[vision] chunks.count=" + chunks.count + " totalTokens=" + chunks.totalTokens);

console.log("[vision] eval chunks (vision encoder + llama_decode)");
const seq = ctx.getSequence();
const newNPast = await mtmdCtx.evalChunks(ctx, chunks, 0, {
    seqId: seq.sequenceId ?? 0,
    nBatch: 512,
    logitsLast: true
});
console.log("[vision] eval done, newNPast=" + newNPast);

console.log("[vision] continuing inference via mtmdGenerate from nPast=" + newNPast);
const bindings = (model as any)._llama._bindings;
const sampler = new bindings.AddonSampler((model as any)._model);
sampler.applyConfig({
    temperature: 0,
    topK: 40,
    topP: 0.95,
    minP: 0.05
});

const t0 = Date.now();
const result = await mtmdCtx.generate(ctx, sampler, newNPast, 200, {seqId: seq.sequenceId ?? 0});
const dt = Date.now() - t0;

console.log(`[vision] generated ${result.tokens.length} tokens in ${dt}ms (${(result.tokens.length / (dt / 1000)).toFixed(1)} tok/s)`);
console.log("[vision] reply text: " + JSON.stringify(result.text));

if (result.text.trim().length === 0) {
    console.error("[vision] ⚠ reply is empty");
    process.exit(3);
}

console.log("[vision] OK ✓ — vision + TURBO4 + 完整生成端到端通過");

chunks.dispose();
sampler.dispose();
mtmdCtx.dispose();
process.exit(0);
