// OpenAI-compatible request/response shapes consumed by TCQ-shim handlers.
// These mirror what my-agent's llamacpp-fetch-adapter sends and expects.

export type OpenAIContentPart =
    | {type: "text", text: string}
    | {type: "image_url", image_url: {url: string, detail?: string}}
    | {type: "input_audio", input_audio: {data: string, format?: string}}
    | {type: "audio_url", audio_url: {url: string}};

export type OpenAIToolCall = {
    id: string,
    type: "function",
    function: {name: string, arguments: string}
};

export type OpenAIMessage = {
    role: "system" | "user" | "assistant" | "tool",
    content: string | null | OpenAIContentPart[],
    name?: string,
    tool_call_id?: string,
    tool_calls?: OpenAIToolCall[]
};

export type OpenAIToolDef = {
    type: "function",
    function: {
        name: string,
        description?: string,
        parameters: Record<string, unknown>
    }
};

export type OpenAIToolChoice =
    | "auto" | "none" | "required"
    | {type: "function", function: {name: string}};

export type OpenAIChatRequest = {
    model: string,
    messages: OpenAIMessage[],
    max_tokens?: number,
    temperature?: number,
    top_p?: number,
    top_k?: number,
    seed?: number,
    stream?: boolean,
    stop?: string | string[],
    tools?: OpenAIToolDef[],
    tool_choice?: OpenAIToolChoice,
    response_format?: {type: "text" | "json_object"},
    reasoning_effort?: "low" | "medium" | "high"
};

export type OpenAIUsage = {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
    prompt_tokens_details?: {cached_tokens?: number}
};

export type OpenAIChatChoice = {
    index: number,
    message: {
        role: "assistant",
        content: string | null,
        reasoning_content?: string | null,
        tool_calls?: OpenAIToolCall[]
    },
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
};

export type OpenAIChatCompletion = {
    id: string,
    object: "chat.completion",
    created: number,
    model: string,
    choices: OpenAIChatChoice[],
    usage: OpenAIUsage
};

export type OpenAIChatChunk = {
    id: string,
    object: "chat.completion.chunk",
    created: number,
    model: string,
    choices: Array<{
        index: number,
        delta: {
            role?: "assistant",
            content?: string | null,
            reasoning_content?: string | null,
            tool_calls?: Array<{
                index: number,
                id?: string,
                type?: "function",
                function?: {name?: string, arguments?: string}
            }>
        },
        finish_reason: string | null
    }>,
    usage?: OpenAIUsage
};

export type StandardErrorBody = {
    error: {
        message: string,
        type: string,
        code: string,
        param?: string | null
    }
};
