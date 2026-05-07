// Coalesce sampler params from request body and shim CLI defaults.
// Priority: request body > session.options.samplerDefaults > engine internal default.
// my-agent preset 注入會體現在 body 欄位，不會經過這層 — 這層只負責 server-side default。

import type {SessionInitOptions} from "./session.js";
import type {OpenAIChatRequest} from "./types.js";

export type SamplerDefaults = NonNullable<SessionInitOptions["samplerDefaults"]>;

export type ResolvedRepeatPenalty = {
    penalty?: number,
    presencePenalty?: number,
    frequencyPenalty?: number,
    lastTokens: number
};

const DEFAULT_REPEAT_LAST_N = 64;

/**
 * Build the `repeatPenalty` arg for promptWithMeta.
 * Returns undefined when no penalty is configured anywhere — caller must spread conditionally.
 *
 * Body-level keys checked (Qwen-style and OpenAI-style aliases both accepted):
 *   - body.repeat_penalty / body.repetition_penalty → penalty
 *   - body.presence_penalty                          → presencePenalty
 *   - body.frequency_penalty                         → frequencyPenalty
 *   - body.repeat_last_n                             → lastTokens
 */
export function buildRepeatPenalty(
    body: OpenAIChatRequest,
    sd: SamplerDefaults | undefined
): ResolvedRepeatPenalty | undefined {
    const sdSafe = sd ?? {};
    const penalty = body.repeat_penalty ?? body.repetition_penalty ?? sdSafe.repeatPenalty;
    const presencePenalty = body.presence_penalty ?? sdSafe.presencePenalty;
    const frequencyPenalty = body.frequency_penalty ?? sdSafe.frequencyPenalty;
    const lastTokens = body.repeat_last_n ?? sdSafe.repeatLastN ?? DEFAULT_REPEAT_LAST_N;

    const anySet = penalty != null || presencePenalty != null || frequencyPenalty != null;
    if (!anySet) return undefined;

    return {
        ...(penalty != null ? {penalty} : {}),
        ...(presencePenalty != null ? {presencePenalty} : {}),
        ...(frequencyPenalty != null ? {frequencyPenalty} : {}),
        lastTokens
    };
}

