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

    // ─── G1：buun-llama-cpp 額外 runtime 旋鈕（env-based）───
    // 這些都是 buun fork 在 ggml-cuda 各處 getenv 用的開關，設了就生效。
    // 文件 vendor/node-llama-tcq/llama/llama.cpp/CLAUDE.md 與 README 有提及。

    /** TURBO_TCQ_DECODE_ALPHA_K：decode 時 K 軸量化 alpha 縮放 */
    decodeAlphaK?: number;
    /** TURBO_TCQ_DECODE_ALPHA_V：decode 時 V 軸量化 alpha 縮放 */
    decodeAlphaV?: number;
    /** TURBO_TCQ_ENCODE_ALPHA：encode 路徑的 alpha 模式（"context"=context-adaptive, 數字=固定） */
    encodeAlpha?: string | number;
    /** TURBO_TCQ_ALPHA：encode 預設 alpha（K 軸） */
    alpha?: number;
    /** TURBO_TCQ_ALPHA_V：encode V 軸 alpha（不設則沿用 alpha） */
    alphaV?: number;

    /** TURBO_PREFILL_VEC：prefill 階段用 vector kernel（"1" 啟用） */
    prefillVec?: boolean;
    /** GGML_TURBO_MMA_FUSED：用 fused MMA kernel（"1" 啟用，Turing+） */
    mmaFused?: boolean;
    /** GGML_TURBO_DECODE_NATIVE：decode 不走 dequant、直接 native（"1" 啟用） */
    decodeNative?: boolean;

    /** TURBO_INNERQ：inner quantization 主開關（"1" 啟用） */
    innerq?: boolean;
    /** TURBO_INNERQ_MODE：inner quant 模式（如 "static"/"dynamic"） */
    innerqMode?: string;
    /** TURBO_INNERQ_STRENGTH：inner quant 強度（0.0–1.0） */
    innerqStrength?: number;

    /** TURBO_TCQ_SHARED_BT：shared-memory backtrace 啟用（"1"，預設啟用） */
    sharedBacktrace?: boolean;
    /** TURBO_TCQ_DUMP_ERRORS：debug 用，dump 量化誤差（"1") */
    dumpErrors?: boolean;
    /** TURBO_Q_CALIBRATE：debug 用，量化校準模式（"1") */
    qCalibrate?: boolean;
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
 * Set TURBO_TCQ_CB / TURBO_TCQ_CB2 + 各 runtime 旋鈕環境變數，必須在
 * createContext / loadModel 之前呼叫（buun 在 kernel 載入時 getenv 一次）。
 */
export function applyTCQCodebooks(cfg: TCQCodebookConfig = {}): void {
    process.env.TURBO_TCQ_CB = cfg.threeBit ?? defaultCodebooks.threeBit;
    process.env.TURBO_TCQ_CB2 = cfg.twoBit ?? defaultCodebooks.twoBit;
    if (cfg.layerAdaptive) process.env.TURBO_LAYER_ADAPTIVE = "1";

    if (cfg.decodeAlphaK != null) process.env.TURBO_TCQ_DECODE_ALPHA_K = String(cfg.decodeAlphaK);
    if (cfg.decodeAlphaV != null) process.env.TURBO_TCQ_DECODE_ALPHA_V = String(cfg.decodeAlphaV);
    if (cfg.encodeAlpha != null) process.env.TURBO_TCQ_ENCODE_ALPHA = String(cfg.encodeAlpha);
    if (cfg.alpha != null) process.env.TURBO_TCQ_ALPHA = String(cfg.alpha);
    if (cfg.alphaV != null) process.env.TURBO_TCQ_ALPHA_V = String(cfg.alphaV);

    if (cfg.prefillVec != null) process.env.TURBO_PREFILL_VEC = cfg.prefillVec ? "1" : "0";
    if (cfg.mmaFused != null) process.env.GGML_TURBO_MMA_FUSED = cfg.mmaFused ? "1" : "0";
    if (cfg.decodeNative != null) process.env.GGML_TURBO_DECODE_NATIVE = cfg.decodeNative ? "1" : "0";

    if (cfg.innerq != null) process.env.TURBO_INNERQ = cfg.innerq ? "1" : "0";
    if (cfg.innerqMode != null) process.env.TURBO_INNERQ_MODE = cfg.innerqMode;
    if (cfg.innerqStrength != null) process.env.TURBO_INNERQ_STRENGTH = String(cfg.innerqStrength);

    if (cfg.sharedBacktrace != null) process.env.TURBO_TCQ_SHARED_BT = cfg.sharedBacktrace ? "1" : "0";
    if (cfg.dumpErrors) process.env.TURBO_TCQ_DUMP_ERRORS = "1";
    if (cfg.qCalibrate) process.env.TURBO_Q_CALIBRATE = "1";
}

export function clearTCQCodebooks(): void {
    const allKeys = [
        "TURBO_TCQ_CB", "TURBO_TCQ_CB2", "TURBO_LAYER_ADAPTIVE",
        "TURBO_TCQ_DECODE_ALPHA_K", "TURBO_TCQ_DECODE_ALPHA_V",
        "TURBO_TCQ_ENCODE_ALPHA", "TURBO_TCQ_ALPHA", "TURBO_TCQ_ALPHA_V",
        "TURBO_PREFILL_VEC", "GGML_TURBO_MMA_FUSED", "GGML_TURBO_DECODE_NATIVE",
        "TURBO_INNERQ", "TURBO_INNERQ_MODE", "TURBO_INNERQ_STRENGTH",
        "TURBO_TCQ_SHARED_BT", "TURBO_TCQ_DUMP_ERRORS", "TURBO_Q_CALIBRATE"
    ];
    for (const k of allKeys) delete process.env[k];
}
