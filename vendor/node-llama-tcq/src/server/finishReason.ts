// Map node-llama-tcq's stop reason metadata onto OpenAI finish_reason values.

export type ShimStopReason = "eosToken" | "stopGenerationTrigger" | "maxTokens" | "abort" | "toolCalls" | undefined;

export function toOpenAIFinishReason(reason: ShimStopReason, hasToolCalls: boolean): "stop" | "length" | "tool_calls" | "content_filter" {
    if (hasToolCalls) return "tool_calls";
    switch (reason) {
        case "maxTokens":
            return "length";
        case "abort":
        case "eosToken":
        case "stopGenerationTrigger":
        case undefined:
        default:
            return "stop";
    }
}
