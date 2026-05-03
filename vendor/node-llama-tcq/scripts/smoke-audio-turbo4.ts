/**
 * Phase H3 — audio smoke：libmtmd audio 路徑 + TURBO4 KV cache。
 *
 * 測試步驟：
 *   1. loadModel（純文字模型 — Gemopus / Qwen3.5-9B 等）
 *   2. createContext({ kvType: TURBO4_0 })
 *   3. LlamaMtmdContext.loadMmproj(model, mmproj-Gemopus-4-E4B-it.gguf)
 *      若 supportsAudio=false 則 skip（需要 audio-capable mmproj）
 *   4. tokenize({media: [{type:"file", data:"test-2.mp3"}]})
 *      mtmd_helper_bitmap_init_from_file 自動偵測 mp3 並用 miniaudio 解碼成 PCM
 *   5. evalChunks → mtmdGenerate（streaming）→ 印 reply
 *
 * 跑法：
 *   $env:TEST_MODEL_TEXT='C:\Users\LOREN\Documents\_projects\my-agent\models\Gemopus-4-E4B-it-Preview-Q5_K_M.gguf'
 *   $env:TEST_MMPROJ='C:\Users\LOREN\Documents\_projects\my-agent\models\mmproj-Gemopus-4-E4B-it.gguf'
 *   node_modules/.bin/vite-node scripts/smoke-audio-turbo4.ts
 */
import path from "node:path";
import {getLlama, GgmlType, LlamaMtmdContext} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT;
const mmprojPath = process.env.TEST_MMPROJ;
const audioPath = process.env.TEST_AUDIO
    ?? path.resolve("llama/llama.cpp/tools/mtmd/test-2.mp3");

if (!modelPath || !mmprojPath) {
    console.error("TEST_MODEL_TEXT and TEST_MMPROJ env required");
    process.exit(1);
}

console.log("[audio] loading llama (cuda)");
const llama = await getLlama({gpu: "cuda"});

console.log("[audio] loading model: " + path.basename(modelPath));
const model = await llama.loadModel({modelPath});

console.log("[audio] creating context (TURBO4 KV, ctx=4096)");
const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    experimentalKvCacheKeyType: GgmlType.TURBO4_0,
    experimentalKvCacheValueType: GgmlType.TURBO4_0
});
console.log("[audio] ctx ready, kvKeyType=" + ctx.kvCacheKeyType);

console.log("[audio] loading mmproj: " + path.basename(mmprojPath));
const mtmdCtx = await LlamaMtmdContext.loadMmproj(model, {
    mmprojPath,
    useGpu: true,
    nThreads: 4
});

const sampleRate = mtmdCtx.audioSampleRate;
console.log("[audio] mtmd ready: vision=" + mtmdCtx.supportsVision +
    " audio=" + mtmdCtx.supportsAudio +
    " sampleRate=" + sampleRate +
    " marker=" + JSON.stringify(mtmdCtx.defaultMarker));

if (!mtmdCtx.supportsAudio) {
    console.error("[audio] ⚠ this mmproj does not support audio. Skipping.");
    console.error("[audio] supported audio mmproj: Whisper / Qwen2-Audio / Gemma 4a / Conformer / Kimi-Audio");
    mtmdCtx.dispose();
    process.exit(2);
}

console.log("[audio] tokenize prompt + audio file: " + path.basename(audioPath));
const promptText = `${mtmdCtx.defaultMarker}\nWhat is in this audio? Describe in 1-2 sentences.`;
const chunks = await mtmdCtx.tokenize({
    text: promptText,
    media: [{type: "file", data: audioPath}]
});
console.log("[audio] chunks.count=" + chunks.count + " totalTokens=" + chunks.totalTokens);

const seq = ctx.getSequence();
console.log("[audio] eval chunks (audio encoder + llama_decode)");
const newNPast = await mtmdCtx.evalChunks(ctx, chunks, 0, {
    seqId: seq.sequenceId ?? 0
});
console.log("[audio] eval done, newNPast=" + newNPast);

const bindings = (model as any)._llama._bindings;
const sampler = new bindings.AddonSampler((model as any)._model);
sampler.applyConfig({temperature: 0, topK: 40, topP: 0.95, minP: 0.05});

const t0 = Date.now();
let chunkCount = 0;
process.stdout.write("[audio] streaming reply: ");
const result = await mtmdCtx.generate(ctx, sampler, newNPast, 200, {
    seqId: seq.sequenceId ?? 0,
    onTextChunk: (c) => {
        chunkCount += 1;
        process.stdout.write(c);
    }
});
process.stdout.write("\n");
const dt = Date.now() - t0;

console.log(`[audio] generated ${result.tokens.length} tokens in ${dt}ms (${(result.tokens.length / (dt / 1000)).toFixed(1)} tok/s), chunks=${chunkCount}`);
console.log("[audio] reply text: " + JSON.stringify(result.text));

if (result.text.trim().length === 0) {
    console.error("[audio] ⚠ empty reply");
    process.exit(3);
}

console.log("[audio] OK ✓ — audio + TURBO4 + streaming 端到端通過");
chunks.dispose();
sampler.dispose();
mtmdCtx.dispose();
process.exit(0);
