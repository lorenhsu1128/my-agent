export interface TCQAvailability {
    ok: boolean;
    reason?: string;
}

/**
 * Check whether the current platform supports TCQ.
 * buun-llama-cpp implements TCQ on CUDA + ROCm only, no Metal / CPU.
 */
export function isTCQAvailable(): TCQAvailability {
    if (process.platform === "darwin")
        return {ok: false, reason: "TCQ requires CUDA or ROCm; macOS Metal is not supported"};

    return {ok: true};
}

/**
 * Verify a model's head_dim is compatible with TCQ.
 * buun-llama-cpp requires head_dim % 128 === 0 (rotation matrix is 128x128).
 */
export function assertTCQCompatibleHeadDim(headDim: number): void {
    if (!Number.isInteger(headDim) || headDim <= 0)
        throw new Error(`TCQ compatibility check: invalid head_dim ${headDim}`);

    if (headDim % 128 !== 0)
        throw new Error(
            `TCQ requires head_dim % 128 === 0 (got head_dim=${headDim}). ` +
            `Use a model with head_dim being a multiple of 128 (e.g., Qwen3.5, Gemma3, Phi).`
        );
}
