import {GgmlType} from "../gguf/types/GgufTensorInfoTypes.js";

export interface TCQPreset {
    keyType: GgmlType;
    valueType: GgmlType;
    /** human-readable label for logs / benchmarks */
    label: string;
    /** approximate bits-per-value */
    bpv: number;
}

/** Predefined KV cache type combinations from buun-llama-cpp documentation. */
export const TCQPresets = {
    /** 4.25 bpv，無損品質，~3.8x compression */
    TURBO4: {
        keyType: GgmlType.TURBO4_0,
        valueType: GgmlType.TURBO4_0,
        label: "turbo4",
        bpv: 4.25
    },
    /** 3.25 bpv，超越 FP16，~5x compression（推薦預設） */
    TURBO3_TCQ: {
        keyType: GgmlType.TURBO3_TCQ,
        valueType: GgmlType.TURBO3_TCQ,
        label: "turbo3_tcq",
        bpv: 3.25
    },
    /** 2.25 bpv，最大壓縮，~7x */
    TURBO2_TCQ: {
        keyType: GgmlType.TURBO2_TCQ,
        valueType: GgmlType.TURBO2_TCQ,
        label: "turbo2_tcq",
        bpv: 2.25
    },
    /** 非對稱 2.75 bpv：3-bit key + 2-bit value */
    ASYMMETRIC_275: {
        keyType: GgmlType.TURBO3_TCQ,
        valueType: GgmlType.TURBO2_TCQ,
        label: "asym_3k_2v",
        bpv: 2.75
    }
} as const satisfies Record<string, TCQPreset>;

export type TCQPresetName = keyof typeof TCQPresets;
