import path from "node:path";
import {fileURLToPath} from "node:url";
import {GgmlType} from "../gguf/types/GgufTensorInfoTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packagedCodebooksDir = path.resolve(__dirname, "..", "..", "codebooks");

export interface TCQCodebookConfig {
    /** Override path for the 3-bit codebook (TURBO_TCQ_CB) */
    threeBit?: string;
    /** Override path for the 2-bit codebook (TURBO_TCQ_CB2) */
    twoBit?: string;
    /** Enable TURBO_LAYER_ADAPTIVE for per-layer adaptive precision */
    layerAdaptive?: boolean;
}

/** Default codebook recommendations from buun-llama-cpp/codebooks/README.md */
export const defaultCodebooks = {
    threeBit: path.join(packagedCodebooksDir, "3bit", "cb_50iter_finetuned.bin"),
    twoBit: path.join(packagedCodebooksDir, "2bit", "tcq_2bit_100iter_s99.bin")
} as const;

const TCQ_GGML_TYPES: ReadonlySet<GgmlType> = new Set<GgmlType>([
    GgmlType.TURBO3_0,
    GgmlType.TURBO4_0,
    GgmlType.TURBO2_0,
    GgmlType.TURBO3_TCQ,
    GgmlType.TURBO2_TCQ
]);

export function isTCQType(type: GgmlType | undefined): boolean {
    return type != null && TCQ_GGML_TYPES.has(type);
}

/**
 * Set TURBO_TCQ_CB / TURBO_TCQ_CB2 environment variables before model loading.
 * 必須在 createContext / loadModel 之前呼叫，buun 在初始化階段讀一次 env。
 */
export function applyTCQCodebooks(cfg: TCQCodebookConfig = {}): void {
    process.env.TURBO_TCQ_CB = cfg.threeBit ?? defaultCodebooks.threeBit;
    process.env.TURBO_TCQ_CB2 = cfg.twoBit ?? defaultCodebooks.twoBit;
    if (cfg.layerAdaptive) process.env.TURBO_LAYER_ADAPTIVE = "1";
}

export function clearTCQCodebooks(): void {
    delete process.env.TURBO_TCQ_CB;
    delete process.env.TURBO_TCQ_CB2;
    delete process.env.TURBO_LAYER_ADAPTIVE;
}
