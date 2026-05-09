import process from "process";
import {CommandModule} from "yargs";
import chalk from "chalk";
import {BuildGpu, nodeLlamaCppGpuOptions, parseNodeLlamaCppGpuOption} from "../../bindings/types.js";
import {GgmlType} from "../../gguf/types/GgufTensorInfoTypes.js";
import {documentationPageUrls} from "../../config.js";
import {withCliCommandDescriptionDocsUrl} from "../utils/withCliCommandDescriptionDocsUrl.js";
import {startTcqShimServer} from "../../server/httpServer.js";

type ServerCommandArgs = {
    modelPath: string,
    mmproj?: string,
    host: string,
    port: number,
    apiKey?: string,
    cors: boolean,
    alias?: string,
    aliases?: string[],
    contextSize: number,
    gpuLayers: number,
    gpu?: BuildGpu | "auto",
    threads?: number,
    batchSize?: number,
    ubatchSize?: number,
    parallel: number,
    cacheTypeK: string,
    cacheTypeV: string,
    flashAttention: boolean,
    noMmap: boolean,
    jinja: boolean,
    enableCorsProxy: boolean,
    enableTools: boolean,
    webuiDir?: string,
    debug: boolean,
    reasoning: "on" | "off" | "auto",
    reasoningBudget: number,
    reasoningBudgetMessage?: string,
    reasoningFormat: "none" | "deepseek" | "deepseek-legacy",
    slotSavePath?: string,
    temp?: number,
    topP?: number,
    topK?: number,
    minP?: number,
    repeatPenalty?: number,
    presencePenalty?: number,
    frequencyPenalty?: number,
    repeatLastN?: number
};

// 讀 env (TCQ_*) — CLI 旗標 > env > 內建預設。值無法 parse 為 number 時 print warn 並回 undefined。
function readEnvNumber(name: string): number | undefined {
    const raw = process.env[name];
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        console.error(chalk.yellow(`[TCQ-shim] ${name}=${raw} is not a number — ignored`));
        return undefined;
    }
    return n;
}

export const ServerCommand: CommandModule<object, ServerCommandArgs> = {
    command: "serve [modelPath]",
    describe: withCliCommandDescriptionDocsUrl(
        "Start an OpenAI-compatible HTTP server (TCQ-shim) — drop-in replacement for llama-server",
        documentationPageUrls.CLI.index
    ),
    builder(yargs) {
        return yargs
            .option("modelPath", {
                alias: ["m", "model"],
                type: "string",
                demandOption: true,
                description: "Path to the GGUF model file to serve"
            })
            .option("mmproj", {
                type: "string",
                description: "Path to the multimodal projector (mmproj) GGUF file. Enables vision/audio support."
            })
            .option("host", {
                type: "string",
                default: "127.0.0.1",
                description: "HTTP host to bind"
            })
            .option("port", {
                type: "number",
                default: 8080,
                description: "HTTP port to bind"
            })
            .option("apiKey", {
                alias: ["api-key"],
                type: "string",
                description: "If set, requests must include `Authorization: Bearer <key>` (public endpoints exempted)"
            })
            .option("cors", {
                type: "boolean",
                default: false,
                description: "Send `Access-Control-Allow-Origin: *` headers"
            })
            .option("alias", {
                type: "string",
                description: "Primary model alias (returned by `/v1/models` and in `response.model`)"
            })
            .option("aliases", {
                type: "string",
                array: true,
                description: "Additional model aliases (multi-value). Requests using any alias route to the same model."
            })
            .option("contextSize", {
                alias: ["c", "ctx-size"],
                type: "number",
                default: 4096,
                description: "Context size to use for the model context"
            })
            .option("gpuLayers", {
                alias: ["ngl", "n-gpu-layers", "gpu-layers"],
                type: "number",
                default: 0,
                description: "Number of layers to offload to GPU"
            })
            .option("gpu", {
                type: "string",
                choices: nodeLlamaCppGpuOptions as any as Exclude<typeof nodeLlamaCppGpuOptions[number], false>[],
                coerce: (value) => {
                    if (value == null || value === "")
                        return undefined;
                    return parseNodeLlamaCppGpuOption(value);
                },
                description: "GPU backend (auto/cuda/vulkan/metal/false). Defaults to auto-detect."
            })
            .option("threads", {
                type: "number",
                description: "Number of threads to use for token evaluation"
            })
            .option("batchSize", {
                alias: ["b", "batch"],
                type: "number",
                description: "Batch size for prompt processing"
            })
            .option("ubatchSize", {
                alias: ["ub", "ubatch"],
                type: "number",
                description: "Micro-batch size"
            })
            .option("parallel", {
                alias: ["np"],
                type: "number",
                default: 1,
                description: "Number of parallel sequences (slots). Currently must be 1."
            })
            .option("cacheTypeK", {
                alias: ["cache-type-k"],
                type: "string",
                default: "f16",
                description: "KV cache key quantization. Supports llama.cpp types (f16/q8_0/q4_0/...) plus TCQ types (turbo2/turbo3/turbo4 — fork-only)."
            })
            .option("cacheTypeV", {
                alias: ["cache-type-v"],
                type: "string",
                default: "f16",
                description: "KV cache value quantization. Same options as --cache-type-k."
            })
            .option("flashAttention", {
                alias: ["fa", "flash-attn"],
                type: "boolean",
                default: false,
                description: "Enable flash attention"
            })
            .option("noMmap", {
                alias: ["no-mmap"],
                type: "boolean",
                default: false,
                description: "Disable memory-mapping for the model file"
            })
            .option("jinja", {
                type: "boolean",
                default: false,
                description: "Use the model's Jinja chat template (no-op for shim — chat wrapper handled by node-llama-tcq)"
            })
            .option("enableCorsProxy", {
                alias: ["enable-cors-proxy"],
                type: "boolean",
                default: false,
                description: "Enable experimental /cors-proxy endpoint"
            })
            .option("enableTools", {
                alias: ["enable-tools", "tools"],
                type: "boolean",
                default: false,
                description: "Enable experimental /tools endpoint"
            })
            .option("webuiDir", {
                alias: ["webui"],
                type: "string",
                description: "Directory to serve as static files at `/`"
            })
            .option("debug", {
                type: "boolean",
                default: false,
                description: "Enable verbose debug logging to stderr"
            })
            .option("reasoning", {
                alias: ["rea"],
                type: "string",
                choices: ["on", "off", "auto"] as const,
                default: "auto" as const,
                description: "Use reasoning/thinking ('on', 'off', 'auto'). Mirrors llama-server --reasoning. 'off' uses </think> responsePrefix to skip CoT."
            })
            .option("reasoningBudget", {
                alias: ["reasoning-budget"],
                type: "number",
                default: -1,
                description: "Token budget for thinking: -1 unlimited, 0 immediate end, N>0 cap. Mirrors llama-server --reasoning-budget."
            })
            .option("reasoningBudgetMessage", {
                alias: ["reasoning-budget-message"],
                type: "string",
                description: "Message appended to assistant content when reasoning budget is exhausted (think loop ran out without producing visible answer). Mirrors llama-server --reasoning-budget-message."
            })
            .option("reasoningFormat", {
                alias: ["reasoning-format"],
                type: "string",
                choices: ["none", "deepseek", "deepseek-legacy"] as const,
                default: "deepseek" as const,
                description: "How reasoning is exposed in response: none = leave <think> in content, deepseek = split into reasoning_content (default), deepseek-legacy = split + keep <think> tags in content. Mirrors llama-server --reasoning-format."
            })
            .option("slotSavePath", {
                alias: ["slot-save-path"],
                type: "string",
                description: "Directory where /slots/{id}?action=save state files are written (and read for restore). Required to enable POST /slots/{id} endpoints. Mirrors llama-server --slot-save-path."
            })
            .option("temp", {
                alias: ["temperature"],
                type: "number",
                description: "Server-side default sampling temperature. Mirrors llama-server --temp. Body `temperature` overrides per request. Env: TCQ_TEMP."
            })
            .option("topP", {
                alias: ["top-p"],
                type: "number",
                description: "Server-side default top-p. Mirrors llama-server --top-p. Env: TCQ_TOP_P."
            })
            .option("topK", {
                alias: ["top-k"],
                type: "number",
                description: "Server-side default top-k. Mirrors llama-server --top-k. Env: TCQ_TOP_K."
            })
            .option("minP", {
                alias: ["min-p"],
                type: "number",
                description: "Server-side default min-p (0 disables). Mirrors llama-server --min-p. Env: TCQ_MIN_P."
            })
            .option("repeatPenalty", {
                alias: ["repeat-penalty"],
                type: "number",
                description: "Server-side default multiplicative repeat penalty (1.0 = disabled). Mirrors llama-server --repeat-penalty. Env: TCQ_REPEAT_PENALTY."
            })
            .option("presencePenalty", {
                alias: ["presence-penalty"],
                type: "number",
                description: "Server-side default presence penalty (llama.cpp/Qwen-style; 0 = disabled). Mirrors llama-server --presence-penalty. Env: TCQ_PRESENCE_PENALTY."
            })
            .option("frequencyPenalty", {
                alias: ["frequency-penalty"],
                type: "number",
                description: "Server-side default frequency penalty (0 = disabled). Mirrors llama-server --frequency-penalty. Env: TCQ_FREQUENCY_PENALTY."
            })
            .option("repeatLastN", {
                alias: ["repeat-last-n"],
                type: "number",
                description: "Lookback window for repeat/presence/frequency penalties. Default 64. Mirrors llama-server --repeat-last-n. Env: TCQ_REPEAT_LAST_N."
            });
    },
    async handler(args) {
        const cacheTypeK = args.cacheTypeK?.toLowerCase() ?? "f16";
        const cacheTypeV = args.cacheTypeV?.toLowerCase() ?? "f16";

        if (args.parallel !== 1) {
            console.error(chalk.yellow(`[TCQ-shim] --parallel ${args.parallel} not yet supported; forcing 1`));
        }

        // CLI > env > undefined（undefined 即不設 server-side default → engine 內建）
        const samplerDefaults = (() => {
            const temperature = args.temp ?? readEnvNumber("TCQ_TEMP");
            const topP = args.topP ?? readEnvNumber("TCQ_TOP_P");
            const topK = args.topK ?? readEnvNumber("TCQ_TOP_K");
            const minP = args.minP ?? readEnvNumber("TCQ_MIN_P");
            const repeatPenalty = args.repeatPenalty ?? readEnvNumber("TCQ_REPEAT_PENALTY");
            const presencePenalty = args.presencePenalty ?? readEnvNumber("TCQ_PRESENCE_PENALTY");
            const frequencyPenalty = args.frequencyPenalty ?? readEnvNumber("TCQ_FREQUENCY_PENALTY");
            const repeatLastN = args.repeatLastN ?? readEnvNumber("TCQ_REPEAT_LAST_N");
            const anySet = [temperature, topP, topK, minP, repeatPenalty, presencePenalty, frequencyPenalty, repeatLastN]
                .some(v => v != null);
            if (!anySet) return undefined;
            return {
                ...(temperature != null ? {temperature} : {}),
                ...(topP != null ? {topP} : {}),
                ...(topK != null ? {topK} : {}),
                ...(minP != null ? {minP} : {}),
                ...(repeatPenalty != null ? {repeatPenalty} : {}),
                ...(presencePenalty != null ? {presencePenalty} : {}),
                ...(frequencyPenalty != null ? {frequencyPenalty} : {}),
                ...(repeatLastN != null ? {repeatLastN} : {})
            };
        })();

        const aliases = [args.alias, ...(args.aliases ?? [])].filter((a): a is string => typeof a === "string" && a.length > 0);
        if (aliases.length === 0) {
            // Fall back to file-name-based alias
            const baseName = args.modelPath.split(/[\\/]/).pop() ?? "model";
            aliases.push(baseName.replace(/\.gguf$/i, ""));
        }

        await startTcqShimServer({
            host: args.host,
            port: args.port,
            apiKey: args.apiKey,
            cors: args.cors,
            modelPath: args.modelPath,
            mmprojPath: args.mmproj,
            aliases,
            contextSize: args.contextSize,
            gpuLayers: args.gpuLayers,
            gpu: args.gpu,
            threads: args.threads,
            batchSize: args.batchSize,
            ubatchSize: args.ubatchSize,
            parallel: 1,
            cacheTypeK,
            cacheTypeV,
            flashAttention: args.flashAttention,
            noMmap: args.noMmap,
            enableCorsProxy: args.enableCorsProxy,
            enableTools: args.enableTools,
            webuiDir: args.webuiDir,
            debug: args.debug,
            reasoning: args.reasoning,
            reasoningBudget: args.reasoningBudget,
            reasoningBudgetMessage: args.reasoningBudgetMessage,
            reasoningFormat: args.reasoningFormat,
            slotSavePath: args.slotSavePath,
            samplerDefaults
        });

        // Keep process alive until SIGINT/SIGTERM
        await new Promise<void>((resolve) => {
            const shutdown = () => {
                console.error(chalk.gray("[TCQ-shim] shutting down…"));
                resolve();
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        });
    }
};

// Re-export so package consumers can detect TCQ types statically
export {GgmlType};
