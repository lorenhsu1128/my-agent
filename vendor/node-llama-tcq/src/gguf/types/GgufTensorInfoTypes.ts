export type GgufTensorInfo = {
    readonly name: string,
    readonly dimensions: readonly (number | bigint)[],
    readonly ggmlType: GgmlType,
    readonly offset: number | bigint,

    /**
     * Adjusted offset relative to the file.
     *
     * Added by the GGUF parser - not part of the file's metadata.
     */
    readonly fileOffset: number | bigint,

    /**
     * For spliced metadata of multiple file parts, this will be the file part number.
     * Starts from `1`.
     *
     * Added by the GGUF parser - not part of the file's metadata.
     */
    readonly filePart: number
};

export enum GgmlType {
    F32 = 0,
    F16 = 1,
    Q4_0 = 2,
    Q4_1 = 3,
    Q4_2 = 4,
    Q4_3 = 5,
    Q5_0 = 6,
    Q5_1 = 7,
    Q8_0 = 8,
    Q8_1 = 9,
    Q2_K = 10,
    Q3_K = 11,
    Q4_K = 12,
    Q5_K = 13,
    Q6_K = 14,
    Q8_K = 15,
    IQ2_XXS = 16,
    IQ2_XS = 17,
    IQ3_XXS = 18,
    IQ1_S = 19,
    IQ4_NL = 20,
    IQ3_S = 21,
    IQ2_S = 22,
    IQ4_XS = 23,
    I8 = 24,
    I16 = 25,
    I32 = 26,
    I64 = 27,
    F64 = 28,
    IQ1_M = 29,
    BF16 = 30,
    Q4_0_4_4 = 31,
    Q4_0_4_8 = 32,
    Q4_0_8_8 = 33,
    TQ1_0 = 34,
    TQ2_0 = 35,
    IQ4_NL_4_4 = 36,
    IQ4_NL_4_8 = 37,
    IQ4_NL_8_8 = 38,
    MXFP4 = 39, // MXFP4 (1 block)
    NVFP4 = 40, // NVFP4 (4 blocks, E4M3 scale)

    // node-llama-tcq: buun-llama-cpp TCQ KV cache 壓縮新增的 ggml type
    // 對應 buun 的 GGML_TYPE_TURBO* 常數，僅供 KV cache 使用、不存於 GGUF 權重
    Q1_0       = 41,
    TURBO3_0   = 42, // 純標量量化（無 TCQ）
    TURBO4_0   = 43, // 4.25 bpv，無損品質
    TURBO2_0   = 44,
    TURBO3_TCQ = 45, // 3.25 bpv，超越 FP16（推薦預設）
    TURBO2_TCQ = 46  // 2.25 bpv，最大壓縮
}

export function resolveGgmlTypeOption(option?: keyof typeof GgmlType | GgmlType) {
    if (option == null)
        return undefined;

    if (typeof option === "number" && Object.hasOwn(GgmlType, option))
        return option as GgmlType;
    else if (typeof option === "string" && Object.hasOwn(GgmlType, option))
        return GgmlType[option as keyof typeof GgmlType];

    return undefined;
}
