import {OpenAIUsage} from "./types.js";

export function makeUsage(prompt: number, completion: number): OpenAIUsage {
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        // node-llama-tcq has no prefix-cache; always 0 to keep adapter happy.
        prompt_tokens_details: {cached_tokens: 0}
    };
}
