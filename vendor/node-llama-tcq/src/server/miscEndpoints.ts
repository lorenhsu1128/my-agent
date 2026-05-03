// Small endpoint handlers grouped together to avoid file proliferation.
// Each is a thin wrapper around node-llama-tcq primitives.

import type {ServerResponse} from "node:http";
import {ServerSession} from "./session.js";
import {sendJson, sendText} from "./httpHelpers.js";
import {makeError} from "./errors.js";

export function listModels(aliases: string[]): unknown {
    return {
        object: "list",
        data: aliases.map((id) => ({id, object: "model", created: 0, owned_by: "tcq-shim"}))
    };
}

export function listOllamaTags(aliases: string[]): unknown {
    return {
        models: aliases.map((name) => ({
            name,
            modified_at: new Date().toISOString(),
            size: 0,
            digest: "",
            details: {format: "gguf", family: "llama", families: ["llama"], parameter_size: "unknown", quantization_level: "unknown"}
        }))
    };
}

export function healthBody(): unknown {
    return {status: "ok"};
}

export function propsBody(session: ServerSession, primaryAlias: string): unknown {
    const o = session.options;
    return {
        n_ctx: o.contextSize,
        model_path: o.modelPath,
        model_alias: primaryAlias,
        chat_template: "",
        n_slots: 1,
        // TCQ-shim extras for observability
        cache_type_k: session.cacheTypeKLabel,
        cache_type_v: session.cacheTypeVLabel,
        flash_attention: o.flashAttention,
        gpu_layers: o.gpuLayers
    };
}

export function slotsBody(session: ServerSession): unknown {
    return [{
        id: 0,
        id_task: -1,
        n_ctx: session.options.contextSize,
        n_predict: -1,
        n_tokens: 0,
        is_processing: false,
        prompt: ""
    }];
}

export async function handleTokenize(res: ServerResponse, body: any, session: ServerSession): Promise<void> {
    const text = typeof body?.content === "string" ? body.content : (Array.isArray(body?.content) ? body.content.map((p: any) => p?.text ?? "").join("") : "");
    const tokens = session.model.tokenize(text);
    sendJson(res, 200, {tokens: Array.from(tokens)});
}

export async function handleDetokenize(res: ServerResponse, body: any, session: ServerSession): Promise<void> {
    if (!Array.isArray(body?.tokens)) {
        sendJson(res, 400, makeError("invalid_request", "tokens must be an array of integers"));
        return;
    }
    const content = session.model.detokenize(body.tokens);
    sendJson(res, 200, {content});
}

export async function handleApplyTemplate(res: ServerResponse, body: any, session: ServerSession): Promise<void> {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    // Phase 1 simplification: best-effort string concat using role labels.
    // The chat wrapper that LlamaChatSession picks dynamically is what's actually used
    // during inference; this endpoint is rarely consumed by my-agent.
    const result = messages
        .map((m: any) => `${m.role ?? "user"}: ${typeof m.content === "string" ? m.content : ""}`)
        .join("\n");
    sendJson(res, 200, {prompt: result});
}

export async function handleCountTokens(res: ServerResponse, body: any, session: ServerSession): Promise<void> {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const concat = messages.map((m: any) => typeof m.content === "string" ? m.content : "").join("\n");
    const tokens = session.model.tokenize(concat);
    sendJson(res, 200, {input_tokens: tokens.length});
}

export function metricsBody(counters: {requests: number, promptTokens: number, completionTokens: number}): string {
    return [
        `# HELP llamacpp_requests_total Total HTTP requests processed`,
        `# TYPE llamacpp_requests_total counter`,
        `llamacpp_requests_total ${counters.requests}`,
        `# HELP llamacpp_tokens_predicted_total Tokens predicted by the model`,
        `# TYPE llamacpp_tokens_predicted_total counter`,
        `llamacpp_tokens_predicted_total ${counters.completionTokens}`,
        `# HELP llamacpp_tokens_evaluated_total Tokens evaluated as input`,
        `# TYPE llamacpp_tokens_evaluated_total counter`,
        `llamacpp_tokens_evaluated_total ${counters.promptTokens}`,
        ""
    ].join("\n");
}

export function sendMetrics(res: ServerResponse, body: string): void {
    sendText(res, 200, body, "text/plain; version=0.0.4; charset=utf-8");
}
