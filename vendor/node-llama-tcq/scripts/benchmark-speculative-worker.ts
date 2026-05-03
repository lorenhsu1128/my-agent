/**
 * Speculative benchmark child worker。
 * 一個變體 = 一個 child process，KV state 完全乾淨。
 *
 * env：
 *   TEST_MODEL_TEXT  必須
 *   BENCH_SPEC_TYPE  off / copyspec / ngram_simple / suffix / recycle ...
 *   BENCH_NMAX       max draft tokens (default 16)
 *   BENCH_GAMMA      copyspec gamma (default 6)
 *   BENCH_GEN_TOKENS 要產生 token 數（default 100）
 */
import {execSync} from "node:child_process";
import {getLlama, GgmlType} from "../dist/index.js";

const modelPath = process.env.TEST_MODEL_TEXT!;
const specType = (process.env.BENCH_SPEC_TYPE ?? "off") as
    "off" | "copyspec" | "ngram_simple" | "suffix" | "recycle";
const nMax = parseInt(process.env.BENCH_NMAX ?? "16", 10);
const gamma = parseInt(process.env.BENCH_GAMMA ?? "6", 10);
const genTokens = parseInt(process.env.BENCH_GEN_TOKENS ?? "100", 10);

// 重複內容明顯的 prompt — CopySpec / Suffix tree 受益最大的場景
const prompt = `Rewrite each sentence with the same structure but different verbs:

INPUT: The cat sits on the mat. The cat eats the food. The cat sleeps on the bed.
OUTPUT: The cat lounges on the mat. The cat devours the food. The cat naps on the bed.

INPUT: The dog runs in the park. The dog plays with the ball. The dog drinks water.
OUTPUT: The dog dashes in the park. The dog tosses the ball. The dog laps water.

INPUT: The bird flies over the tree. The bird sings on the branch. The bird builds a nest.
OUTPUT: The bird soars over the tree. The bird chirps on the branch. The bird crafts a nest.

INPUT: The fish swims in the river. The fish hunts for prey. The fish hides in the rocks.
OUTPUT: The fish glides in the river. The fish stalks for prey. The fish conceals in the rocks.

INPUT: The horse gallops in the field. The horse grazes on the grass. The horse rests under the tree.
OUTPUT:`;

function vramUsedMB(): number {
    try {
        return parseInt(execSync("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits").toString().split("\n")[0]!.trim(), 10);
    } catch {
        return -1;
    }
}

const vramBefore = vramUsedMB();

const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({modelPath});
const ctx = await model.createContext({
    contextSize: 4096,
    flashAttention: true,
    ignoreMemorySafetyChecks: true,
    experimentalKvCacheKeyType: GgmlType.TURBO4_0,
    experimentalKvCacheValueType: GgmlType.TURBO4_0
});

const seq = ctx.getSequence();
const seqId = seq.sequenceId ?? 0;
const promptTokens = (model as any).tokenize(prompt, true);

// Prefill
const tPrefill = Date.now();
const it = seq.evaluate(Array.from(promptTokens), {});
await it.next();
await it.return();
const prefillMs = Date.now() - tPrefill;
const nPastStart = (seq as any).nextTokenIndex;

// Sampler
const bindings = (model as any)._llama._bindings;
const sampler = new bindings.AddonSampler((model as any)._model);
sampler.applyConfig({temperature: 0, topK: 40, topP: 0.95, minP: 0.05});

const specOpts = specType === "off"
    ? {}
    : {type: specType, nMax, copyspecGamma: gamma};

const tGen = Date.now();
const result = await ctx.generateWithSpeculative({
    sampler,
    nPast: nPastStart,
    maxTokens: genTokens,
    seqId,
    spec: specOpts as any
});
const genMs = Date.now() - tGen;
const vramPeak = vramUsedMB();

const text = (model as any).detokenize(new Uint32Array(result.tokens as number[]), false);

const out = {
    specType,
    nMax,
    gamma,
    promptTokens: promptTokens.length,
    nPastStart,
    prefillMs,
    genMs,
    nGen: result.tokens.length,
    nDrafted: result.nDrafted,
    nAccepted: result.nAccepted,
    acceptRate: result.nDrafted > 0 ? result.nAccepted / result.nDrafted : 0,
    tokPerSec: result.tokens.length / (genMs / 1000),
    vramMB: vramPeak - vramBefore,
    replyPreview: text.replace(/\n/g, "\\n").slice(0, 100)
};
console.log("BENCH_RESULT=" + JSON.stringify(out));
process.exit(0);
