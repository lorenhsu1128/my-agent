// M-TCQ-SHIM-2-4：Ollama /api/chat 與 Anthropic /v1/messages 相容層。
//
// 策略：把外部 schema 翻譯成內部 OpenAIChatRequest，呼叫
// handleChatCompletions（透過一個只 capture 的 fake ServerResponse），
// 再把 OpenAI response 翻譯回對應外部 schema。這樣所有 chat 邏輯（reasoning
// 分流、tool_calls、context overflow 處理等）都不必複製。
//
// 限制：streaming（NDJSON for Ollama / SSE for Anthropic）暫不支援，
// 若 client 要 stream → 501 標準錯誤；非 stream 路徑完整。

import type {IncomingMessage, ServerResponse} from "node:http";
import {handleChatCompletions} from "./chatCompletions.js";
import type {ServerSession} from "./session.js";
import type {OpenAIChatRequest, OpenAIChatCompletion, OpenAIMessage, StandardErrorBody} from "./types.js";
import {sendJson} from "./httpHelpers.js";
import {makeError} from "./errors.js";

/**
 * Minimal in-memory ServerResponse stand-in. Only implements the few methods
 * that sendJson uses (writeHead / end). Used to capture handleChatCompletions
 * output without actually writing to the network.
 */
class CapturingResponse {
    statusCode = 200;
    headers: Record<string, string | number | string[]> = {};
    bodyChunks: Buffer[] = [];
    finished = false;

    setHeader(name: string, value: string | number | string[]): void { this.headers[name.toLowerCase()] = value; }
    getHeader(name: string): unknown { return this.headers[name.toLowerCase()]; }
    writeHead(status: number, headers?: Record<string, string | number | string[]>): this {
        this.statusCode = status;
        if (headers) for (const k of Object.keys(headers)) this.setHeader(k, headers[k]!);
        return this;
    }
    write(chunk: string | Buffer): boolean {
        this.bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
        return true;
    }
    end(chunk?: string | Buffer): this {
        if (chunk != null) this.write(chunk);
        this.finished = true;
        return this;
    }
    body(): string { return Buffer.concat(this.bodyChunks).toString("utf8"); }
    json(): any { try { return JSON.parse(this.body()); } catch { return null; } }
}

async function runInternalChat(
    req: IncomingMessage,
    body: OpenAIChatRequest,
    session: ServerSession,
    primaryAlias: string
): Promise<{status: number, payload: any}> {
    const cap = new CapturingResponse();
    // Force non-stream — caller upstream decides whether to stream.
    body.stream = false;
    await handleChatCompletions(req, cap as unknown as ServerResponse, body, session, primaryAlias);
    return {status: cap.statusCode, payload: cap.json()};
}

/* -------------------------- Ollama /api/chat -------------------------- */

type OllamaChatRequest = {
    model?: string,
    messages?: Array<{role: string, content: string, images?: string[]}>,
    stream?: boolean,
    options?: {
        temperature?: number, top_p?: number, top_k?: number, seed?: number, num_predict?: number
    },
    tools?: OpenAIChatRequest["tools"]
};

export async function handleOllamaChat(
    req: IncomingMessage,
    res: ServerResponse,
    body: OllamaChatRequest,
    session: ServerSession,
    primaryAlias: string
): Promise<void> {
    if (body?.stream === true) {
        sendJson(res, 501, makeError(
            "ollama_stream_not_supported",
            "/api/chat streaming is not yet supported by TCQ-shim. Set stream=false or use /v1/chat/completions.",
            "not_implemented"
        ));
        return;
    }
    const messages = (body.messages ?? []).map((m) => ({
        role: m.role as OpenAIMessage["role"],
        content: m.content
    } as OpenAIMessage));

    const oai: OpenAIChatRequest = {
        model: body.model ?? primaryAlias,
        messages,
        ...(body.tools ? {tools: body.tools} : {}),
        ...(body.options?.temperature != null ? {temperature: body.options.temperature} : {}),
        ...(body.options?.top_p != null ? {top_p: body.options.top_p} : {}),
        ...(body.options?.top_k != null ? {top_k: body.options.top_k} : {}),
        ...(body.options?.seed != null ? {seed: body.options.seed} : {}),
        ...(body.options?.num_predict != null ? {max_tokens: body.options.num_predict} : {})
    };

    const {status, payload} = await runInternalChat(req, oai, session, primaryAlias);
    if (status >= 400 || payload?.error) {
        sendJson(res, status, payload ?? makeError("internal_error", "empty response", "server_error"));
        return;
    }
    const completion = payload as OpenAIChatCompletion;
    const choice = completion.choices?.[0];
    sendJson(res, 200, {
        model: completion.model,
        created_at: new Date(completion.created * 1000).toISOString(),
        message: {
            role: choice?.message?.role ?? "assistant",
            content: choice?.message?.content ?? "",
            ...(choice?.message?.tool_calls ? {tool_calls: choice.message.tool_calls} : {})
        },
        done: true,
        done_reason: choice?.finish_reason ?? "stop",
        total_duration: 0,
        prompt_eval_count: completion.usage?.prompt_tokens ?? 0,
        eval_count: completion.usage?.completion_tokens ?? 0
    });
}

/* -------------------------- Anthropic /v1/messages -------------------------- */

type AnthropicMessageRequest = {
    model?: string,
    messages: Array<{
        role: "user" | "assistant",
        content: string | Array<{type: string, text?: string, source?: any, tool_use_id?: string, content?: any}>
    }>,
    system?: string | Array<{type: string, text: string}>,
    max_tokens: number,
    stream?: boolean,
    temperature?: number,
    top_p?: number,
    top_k?: number,
    stop_sequences?: string[],
    tools?: Array<{name: string, description?: string, input_schema: any}>
};

function flattenAnthropicContent(content: AnthropicMessageRequest["messages"][number]["content"]): string {
    if (typeof content === "string") return content;
    return content.map((p) => p.type === "text" ? (p.text ?? "") : "").join("");
}

function flattenSystem(system: AnthropicMessageRequest["system"]): string {
    if (system == null) return "";
    if (typeof system === "string") return system;
    return system.map((b) => b.text).join("\n");
}

export async function handleAnthropicMessages(
    req: IncomingMessage,
    res: ServerResponse,
    body: AnthropicMessageRequest,
    session: ServerSession,
    primaryAlias: string
): Promise<void> {
    if (body?.stream === true) {
        sendJson(res, 501, makeError(
            "anthropic_stream_not_supported",
            "/v1/messages streaming is not yet supported by TCQ-shim. Set stream=false or use /v1/chat/completions.",
            "not_implemented"
        ));
        return;
    }
    const sys = flattenSystem(body.system);
    const messages: OpenAIMessage[] = [];
    if (sys) messages.push({role: "system", content: sys});
    for (const m of body.messages ?? []) {
        messages.push({role: m.role, content: flattenAnthropicContent(m.content)} as OpenAIMessage);
    }
    const tools = (body.tools ?? []).map((t) => ({
        type: "function" as const,
        function: {name: t.name, description: t.description ?? "", parameters: t.input_schema}
    }));

    const oai: OpenAIChatRequest = {
        model: body.model ?? primaryAlias,
        messages,
        max_tokens: body.max_tokens,
        ...(body.temperature != null ? {temperature: body.temperature} : {}),
        ...(body.top_p != null ? {top_p: body.top_p} : {}),
        ...(body.top_k != null ? {top_k: body.top_k} : {}),
        ...(body.stop_sequences ? {stop: body.stop_sequences} : {}),
        ...(tools.length > 0 ? {tools} : {})
    };

    const {status, payload} = await runInternalChat(req, oai, session, primaryAlias);
    if (status >= 400 || payload?.error) {
        sendJson(res, status, payload ?? makeError("internal_error", "empty response", "server_error"));
        return;
    }
    const completion = payload as OpenAIChatCompletion;
    const choice = completion.choices?.[0];
    const text = choice?.message?.content ?? "";
    const toolCalls = choice?.message?.tool_calls ?? [];

    const contentBlocks: Array<{type: string, [k: string]: any}> = [];
    if (text) contentBlocks.push({type: "text", text});
    for (const tc of toolCalls) {
        let input: any = {};
        try { input = JSON.parse(tc.function.arguments); } catch { /* leave empty */ }
        contentBlocks.push({type: "tool_use", id: tc.id, name: tc.function.name, input});
    }
    const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use"
        : choice?.finish_reason === "length" ? "max_tokens"
        : "end_turn";

    sendJson(res, 200, {
        id: completion.id,
        type: "message",
        role: "assistant",
        model: completion.model,
        content: contentBlocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: completion.usage?.prompt_tokens ?? 0,
            output_tokens: completion.usage?.completion_tokens ?? 0
        }
    });
}

/* -------------------------- Anthropic count_tokens -------------------------- */

export function handleAnthropicCountTokens(
    res: ServerResponse,
    body: AnthropicMessageRequest,
    session: ServerSession
): void {
    const sys = flattenSystem(body.system);
    const parts: string[] = [];
    if (sys) parts.push(sys);
    for (const m of body.messages ?? []) parts.push(flattenAnthropicContent(m.content));
    const text = parts.join("\n");
    const tokens = session.model.tokenize(text);
    sendJson(res, 200, {input_tokens: tokens.length});
}
