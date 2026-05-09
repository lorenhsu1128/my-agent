/**
 * Benchmark child worker：跑單一變體，量 VRAM peak、時序，吐 BENCH_RESULT JSON 到 stdout。
 */
import {execSync} from "node:child_process";
import {getLlama, LlamaChatSession, GgmlType} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT!;
const kvType = parseInt(process.env.BENCH_KV_TYPE!, 10) as GgmlType;
const PROMPT = process.env.BENCH_PROMPT ?? "What is 2+2? Answer in one short sentence.";
const MAX_TOKENS = parseInt(process.env.BENCH_MAX_TOKENS ?? "256", 10);

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

const t1 = Date.now();
const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    experimentalKvCacheKeyType: kvType,
    experimentalKvCacheValueType: kvType
});
const createMs = Date.now() - t1;
const vramAfter = vramUsedMB();

const session = new LlamaChatSession({contextSequence: ctx.getSequence()});
const t2 = Date.now();
const reply = await session.prompt(PROMPT, {maxTokens: MAX_TOKENS});
const promptMs = Date.now() - t2;

const replyPreview = reply.replace(/\n/g, " ").slice(0, 200);

const result = {
    loadMs,
    createMs,
    promptMs,
    replyLen: reply.length,
    replyPreview,
    vramMB: vramAfter - vramBefore
};
console.log("BENCH_RESULT=" + JSON.stringify(result));
process.exit(0);
