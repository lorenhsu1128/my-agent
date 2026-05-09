import {StandardErrorBody} from "./types.js";

export function makeError(
    code: string,
    message: string,
    type: string = "invalid_request_error",
    param: string | null = null
): StandardErrorBody {
    return {error: {code, message, type, param}};
}

export const NOT_IMPLEMENTED_501 = (endpoint: string, code: string) =>
    makeError(
        code,
        `Endpoint ${endpoint} is not supported by TCQ-shim. ` +
        `Use buun-llama-cpp llama-server for this functionality.`,
        "not_implemented"
    );

/**
 * Detect node-llama-tcq context-shift / compression failure by message pattern.
 * The library's own message is sometimes truncated mid-sentence (we observed
 * "...without affecting the" with no continuation), so we match on the stem.
 */
export function isContextOverflowError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return /compress chat history|too long prompt|context shift|context size|too long system message/i.test(msg);
}

/**
 * OpenAI-standard payload-too-large error for context window exhaustion.
 * `code: "context_length_exceeded"` matches OpenAI's error code so client SDKs
 * (incl. `@openai/openai`) recognize it and surface a meaningful retry hint.
 */
export function makeContextLengthExceededError(opts: {
    promptTokens: number,
    maxTokens: number | undefined,
    ctxSize: number,
    underlying?: unknown
}) {
    const requested = opts.maxTokens != null
        ? `${opts.promptTokens} (prompt) + ${opts.maxTokens} (max_tokens) = ${opts.promptTokens + opts.maxTokens}`
        : `${opts.promptTokens} (prompt)`;
    const detail = opts.underlying instanceof Error ? ` (engine: ${opts.underlying.message})` : "";
    return makeError(
        "context_length_exceeded",
        `Requested ${requested} tokens exceeds the context window of ${opts.ctxSize} tokens. ` +
        `Reduce max_tokens, shorten the prompt, or restart the server with a larger --ctx-size.${detail}`,
        "invalid_request_error",
        "messages"
    );
}
