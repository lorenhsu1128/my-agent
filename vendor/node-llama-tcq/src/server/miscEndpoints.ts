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

import {getMetricsSnapshot, renderPrometheus} from "./metrics.js";

/** Returns the current Prometheus body — counters live in metrics.ts singleton. */
export function metricsBody(_unused?: unknown): string {
    return renderPrometheus(getMetricsSnapshot());
}

export function sendMetrics(res: ServerResponse, body: string): void {
    sendText(res, 200, body, "text/plain; version=0.0.4; charset=utf-8");
}

// M-TCQ-SHIM-2-3: POST /props 白名單 — buun llama-server 在這裡接受熱更新少量
// runtime 設定（chat_template / system_prompt / sampler defaults）。我們的
// shim 是 stateless 單 model，runtime 換 chat_template 風險高，採取「接受+
// 記錄+回 200 + 當前狀態」策略：白名單欄位通過驗證即視為 noop ack，未列欄位
// 一律 400 回 unknown_field 錯誤；client 拿到 200 表示「shim 看到了你的請求
// 但目前不會主動套用」。實際熱換 schema 等 SHIM-3 之後評估。
const PROPS_WHITELIST = new Set([
    "chat_template",
    "system_prompt",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "n_predict",
    "max_tokens"
]);

export function handlePropsPost(res: ServerResponse, body: any, session: ServerSession, primaryAlias: string): void {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, makeError("invalid_request", "POST /props body must be a JSON object"));
        return;
    }
    const accepted: string[] = [];
    const unknown: string[] = [];
    for (const key of Object.keys(body)) {
        if (PROPS_WHITELIST.has(key)) accepted.push(key);
        else unknown.push(key);
    }
    if (unknown.length > 0) {
        sendJson(res, 400, makeError(
            "unknown_field",
            `POST /props rejected: ${unknown.length} unknown field(s) [${unknown.join(", ")}]. ` +
            `Whitelist: [${[...PROPS_WHITELIST].join(", ")}].`
        ));
        return;
    }
    // Ack: log + return current props (no live mutation in M-TCQ-SHIM-2)
    if (session.options.debug) {
        console.error(`[TCQ-shim:/props POST] ack ${accepted.length} field(s): ${accepted.join(", ")} (no-op, shim is stateless)`);
    }
    sendJson(res, 200, {accepted, current: propsBody(session, primaryAlias)});
}
