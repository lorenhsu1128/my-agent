/**
 * Vision benchmark child worker：跑單一 (kvType, nImages, ctxSize) 變體。
 */
import {execSync} from "node:child_process";
import path from "node:path";
import {getLlama, GgmlType, LlamaMtmdContext} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT!;
const mmprojPath = process.env.TEST_MMPROJ!;
const imagePath = process.env.TEST_IMAGE
    ?? path.resolve("llama/llama.cpp/tools/mtmd/test-1.jpeg");

const kvType = parseInt(process.env.BENCH_KV_TYPE!, 10) as GgmlType;
const nImages = parseInt(process.env.BENCH_N_IMAGES!, 10);
const ctxSize = parseInt(process.env.BENCH_CTX_SIZE!, 10);

function vramUsedMB(): number {
    try {
        return parseInt(execSync("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits").toString().split("\n")[0]!.trim(), 10);
    } catch {
        return -1;
    }
}

const vramBefore = vramUsedMB();

const llama = await getLlama({gpu: "cuda"});
const t0 = Date.now();
const model = await llama.loadModel({modelPath});
const loadMs = Date.now() - t0;
const vramAfterModel = vramUsedMB();

const t1 = Date.now();
const ctx = await model.createContext({
    contextSize: ctxSize,
    flashAttention: true,
    ignoreMemorySafetyChecks: true,
    experimentalKvCacheKeyType: kvType,
    experimentalKvCacheValueType: kvType
});
const createMs = Date.now() - t1;

const mtmdCtx = await LlamaMtmdContext.loadMmproj(model, {mmprojPath, useGpu: true, nThreads: 4});
const vramAfterMtmd = vramUsedMB();

const seq = ctx.getSequence();
const marker = mtmdCtx.defaultMarker;
let promptText = "";
const images: Array<{type: "file"; data: string}> = [];
for (let i = 0; i < nImages; i++) {
    promptText += `${marker}\n`;
    images.push({type: "file", data: imagePath});
}
promptText += "Compare the images and describe the main subject in 1 sentence.";

const tTok = Date.now();
const chunks = await mtmdCtx.tokenize({text: promptText, images});
const tokMs = Date.now() - tTok;
const totalTokens = chunks.totalTokens;

const tEval = Date.now();
const newNPast = await mtmdCtx.evalChunks(ctx, chunks, 0, {seqId: seq.sequenceId ?? 0});
const evalMs = Date.now() - tEval;
const vramAfterEval = vramUsedMB();

const bindings = (model as any)._llama._bindings;
const sampler = new bindings.AddonSampler((model as any)._model);
sampler.applyConfig({temperature: 0, topK: 40, topP: 0.95, minP: 0.05});

const tGen = Date.now();
const result = await mtmdCtx.generate(ctx, sampler, newNPast, 100, {seqId: seq.sequenceId ?? 0});
const genMs = Date.now() - tGen;
const vramPeak = vramUsedMB();

const out = {
    loadMs,
    createMs,
    tokMs,
    evalMs,
    genMs,
    totalTokens,
    nGen: result.tokens.length,
    tokPerSec: result.tokens.length / (genMs / 1000),
    replyPreview: result.text.replace(/\n/g, " ").slice(0, 100),
    vramModel: vramAfterModel - vramBefore,
    vramCtxMtmd: vramAfterMtmd - vramAfterModel,
    vramKvImg: vramAfterEval - vramAfterMtmd,
    vramTotal: vramPeak - vramBefore
};
console.log("BENCH_RESULT=" + JSON.stringify(out));

chunks.dispose();
sampler.dispose();
mtmdCtx.dispose();
process.exit(0);
