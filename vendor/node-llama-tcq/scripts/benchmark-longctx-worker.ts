/**
 * Long-context benchmark child worker。
 * 對單一 (kvType, ctxSize) 組合：load model → create ctx → 量 VRAM →
 * 用一個簡短 prompt 觸發推論 → 吐 BENCH_RESULT JSON。
 *
 * 重點不是 reply 品質，而是「該 ctx 大小能否撐住 + VRAM 落差」。
 */
import {execSync} from "node:child_process";
import {getLlama, LlamaChatSession, GgmlType} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT!;
const kvType = parseInt(process.env.BENCH_KV_TYPE!, 10) as GgmlType;
const ctxSize = parseInt(process.env.BENCH_CTX_SIZE!, 10);
const prompt = "What is 2+2? Answer in one short sentence.";

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
const vramAfterLoad = vramUsedMB();

const t1 = Date.now();
const ctx = await model.createContext({
    contextSize: ctxSize,
    flashAttention: true,
    ignoreMemorySafetyChecks: true,
    experimentalKvCacheKeyType: kvType,
    experimentalKvCacheValueType: kvType
});
const createMs = Date.now() - t1;
const vramAfterCtx = vramUsedMB();

const session = new LlamaChatSession({contextSequence: ctx.getSequence()});
const t2 = Date.now();
const reply = await session.prompt(prompt, {maxTokens: 64});
const promptMs = Date.now() - t2;
const vramPeak = vramUsedMB();

const result = {
    loadMs,
    createMs,
    promptMs,
    replyLen: reply.length,
    replyPreview: reply.replace(/\n/g, " ").slice(0, 80),
    vramBefore,
    vramModel: vramAfterLoad - vramBefore,
    vramKv: vramAfterCtx - vramAfterLoad,
    vramTotal: vramPeak - vramBefore
};
console.log("BENCH_RESULT=" + JSON.stringify(result));
process.exit(0);
