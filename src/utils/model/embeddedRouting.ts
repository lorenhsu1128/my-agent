/**
 * 內嵌（in-process）llama.cpp 路由判定。
 *
 * my-agent 的 llamacpp 路徑預設走 fetch adapter（HTTP 到 llama-server）。
 * 若 model config 標 `useEmbedded: true` 或設 `MY_AGENT_LLAMACPP_EMBEDDED=1`
 * env，改走 vendor/node-llama-tcq 的 in-process binding。
 *
 * 內嵌主要用途：
 * - 純文字長 context + TCQ KV 壓縮（VRAM 不足以撐起 server）
 * - 需要在 Node app 內直接控制 sampler / KV cache 類型的場景
 *
 * Vision 與大部分情境仍走 server 路徑，避免 VRAM 同時被佔。
 */

export interface EmbeddedRoutingConfig {
    /** 是否啟用內嵌 binding */
    enabled: boolean;
    /** GGUF 模型絕對路徑 */
    modelPath?: string;
    /** mmproj 檔案路徑（vision 用，目前 Phase C 不啟用） */
    mmprojPath?: string;
    /** KV cache key type — TCQ-shim resolveCacheType 接受字串（"turbo4" / "turbo3_tcq" / "f16" 等） */
    cacheTypeK?: string;
    /** KV cache value type */
    cacheTypeV?: string;
    /** @deprecated 改用 cacheTypeK + cacheTypeV；舊欄位保留向後相容 */
    kvCacheType?: string | number;
    /** 自訂 codebook 路徑（覆蓋 default）；isTcq 時 ensureSession 會自動 apply */
    codebooks?: {threeBit?: string; twoBit?: string; layerAdaptive?: boolean};
    /** Context size */
    contextSize?: number;
    /** GPU 後端：'cuda' | 'metal' | 'vulkan' | false */
    gpu?: "auto" | "cuda" | "metal" | "vulkan" | false;
    /** GPU offload layer 數 — number / "max" / "auto"；對齊 jsonc server.gpuLayers */
    gpuLayers?: number | "max" | "auto";
    /** 推論 batch size（對齊 llama-server `-b`） */
    batchSize?: number;
    /** ubatch size（對齊 llama-server `-ub`） */
    ubatchSize?: number;
    /** 推論 thread 數（對齊 llama-server `--threads`） */
    threads?: number;
    /** Flash attention（對齊 llama-server `--flash-attn on`） */
    flashAttention?: boolean;
    /** 不使用 mmap（對齊 llama-server `--no-mmap`） */
    noMmap?: boolean;
    /** stderr 詳細 log */
    debug?: boolean;
    /** server-level reasoning default：on/off/auto */
    reasoning?: "on" | "off" | "auto";
    /** Sampler defaults（從 jsonc samplingPresets 注入，per-request 仍可覆蓋） */
    samplerDefaults?: {
        temperature?: number;
        topP?: number;
        topK?: number;
        minP?: number;
        repeatPenalty?: number;
        presencePenalty?: number;
        frequencyPenalty?: number;
        repeatLastN?: number;
    };
}

export interface EmbeddedRoutingDecision {
    useEmbedded: boolean;
    reason: string;
    config?: EmbeddedRoutingConfig;
}

/**
 * 從 env / model config 決定是否走內嵌路徑。
 *
 * Priority：
 * 1. modelConfig.useEmbedded === true  → 走內嵌（最高）
 * 2. MY_AGENT_LLAMACPP_EMBEDDED=1      → 走內嵌
 * 3. otherwise                          → 走 fetch
 */
export function decideEmbeddedRouting(modelConfig: {
    useEmbedded?: boolean;
    modelPath?: string;
    embeddedConfig?: Partial<EmbeddedRoutingConfig>;
} = {}): EmbeddedRoutingDecision {
    const envFlag = process.env.MY_AGENT_LLAMACPP_EMBEDDED === "1";

    if (modelConfig.useEmbedded === false)
        return {useEmbedded: false, reason: "modelConfig.useEmbedded=false"};

    if (modelConfig.useEmbedded === true || envFlag) {
        if (!modelConfig.modelPath)
            return {useEmbedded: false, reason: "embedded requested but modelPath missing"};

        const ec = modelConfig.embeddedConfig ?? {};
        return {
            useEmbedded: true,
            reason: modelConfig.useEmbedded === true
                ? "modelConfig.useEmbedded=true"
                : "MY_AGENT_LLAMACPP_EMBEDDED=1",
            config: {
                enabled: true,
                modelPath: modelConfig.modelPath,
                gpu: ec.gpu ?? "cuda",
                contextSize: ec.contextSize ?? 4096,
                cacheTypeK: ec.cacheTypeK,
                cacheTypeV: ec.cacheTypeV,
                kvCacheType: ec.kvCacheType,
                codebooks: ec.codebooks,
                mmprojPath: ec.mmprojPath,
                gpuLayers: ec.gpuLayers,
                batchSize: ec.batchSize,
                ubatchSize: ec.ubatchSize,
                threads: ec.threads,
                flashAttention: ec.flashAttention,
                noMmap: ec.noMmap,
                debug: ec.debug,
                reasoning: ec.reasoning,
                samplerDefaults: ec.samplerDefaults,
            }
        };
    }

    return {useEmbedded: false, reason: "default fetch path"};
}
