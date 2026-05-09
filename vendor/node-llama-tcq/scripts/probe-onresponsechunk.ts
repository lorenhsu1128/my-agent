// 直接 import shim 內部，bypass HTTP，驗 onResponseChunk 是否吐 thought segments。
import {LlamaChatSession} from "../src/evaluator/LlamaChatSession/LlamaChatSession.js";
import {getLlama} from "../src/bindings/getLlama.js";

const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({
    modelPath: process.env.MODEL_PATH ?? "../../models/Qwen3.5-9B-Q4_K_M.gguf",
    gpuLayers: 999
});
const ctx = await model.createContext({contextSize: 8192});
const seq = ctx.getSequence();
const session = new LlamaChatSession({contextSequence: seq});

let thoughtCh = 0, mainCh = 0, otherCh = 0;
let thoughtSample = "", mainSample = "";

const result = await session.promptWithMeta(
    "請逐步推理：三個質數的和是 30，找出所有可能組合。",
    {
        maxTokens: 800,
        responsePrefix: "<think>\n",   // ← 強制讓模型進 thought 區塊
        onResponseChunk(chunk: any) {
            if (chunk.type === "segment" && chunk.segmentType === "thought") {
                thoughtCh += chunk.text.length;
                if (thoughtSample.length < 120) thoughtSample += chunk.text;
            } else if (chunk.type === undefined) {
                mainCh += chunk.text.length;
                if (mainSample.length < 120) mainSample += chunk.text;
            } else {
                otherCh += (chunk.text?.length ?? 0);
            }
        }
    }
);

console.log("thought ch=", thoughtCh, "sample:", JSON.stringify(thoughtSample));
console.log("main    ch=", mainCh, "sample:", JSON.stringify(mainSample));
console.log("other   ch=", otherCh);
console.log("response.length=", (result as any).response?.length);
process.exit(0);
