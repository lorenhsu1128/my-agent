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
    /** KV cache type（"turbo3_tcq" 等字串或 GgmlType 數字） */
    kvCacheType?: string | number;
    /** 是否套用 TCQ codebook 環境變數 */
    applyTCQCodebooks?: boolean;
    /** 自訂 codebook 路徑（覆蓋 default） */
    codebooks?: {threeBit?: string; twoBit?: string; layerAdaptive?: boolean};
    /** Context size */
    contextSize?: number;
    /** GPU 後端：'cuda' | 'metal' | 'vulkan' | false */
    gpu?: "auto" | "cuda" | "metal" | "vulkan" | false;
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

        return {
            useEmbedded: true,
            reason: modelConfig.useEmbedded === true
                ? "modelConfig.useEmbedded=true"
                : "MY_AGENT_LLAMACPP_EMBEDDED=1",
            config: {
                enabled: true,
                modelPath: modelConfig.modelPath,
                gpu: modelConfig.embeddedConfig?.gpu ?? "cuda",
                contextSize: modelConfig.embeddedConfig?.contextSize ?? 4096,
                kvCacheType: modelConfig.embeddedConfig?.kvCacheType,
                applyTCQCodebooks: modelConfig.embeddedConfig?.applyTCQCodebooks ?? false,
                codebooks: modelConfig.embeddedConfig?.codebooks,
                mmprojPath: modelConfig.embeddedConfig?.mmprojPath
            }
        };
    }

    return {useEmbedded: false, reason: "default fetch path"};
}
