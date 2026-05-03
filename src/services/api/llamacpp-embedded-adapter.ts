/**
 * In-process llama.cpp adapter，使用 vendor/node-llama-tcq。
 *
 * 平行於 llamacpp-fetch-adapter.ts，提供同一介面（fetch-shaped function）。
 * 既有 ADR-005 / ADR-010 規定不修改的檔案完全不動。
 *
 * Phase C MVP 範圍：
 *  - 提供 createLlamaCppEmbeddedFetch(config) 回傳 fetch-shaped function
 *  - lazy import node-llama-tcq 避免無 binding 時 my-agent 啟動失敗
 *  - 單例 LlamaModel + LlamaContext 重用
 *  - 把 OpenAI Chat Completion request 跑進 node-llama-tcq，emit OpenAI SSE 格式回應
 *  - 既有 translateOpenAIStreamToAnthropic 可繼續使用
 *
 * 不在 Phase C 範圍：
 *  - vision / mmproj（Phase E）
 *  - 多 sequence 並行
 *  - tool call leak detection（已在 fetch-adapter 處理，本 adapter 直接吐 raw text）
 */

import type {EmbeddedRoutingConfig} from "../../utils/model/embeddedRouting.js";

interface OpenAIChatRequest {
    model?: string;
    messages: Array<{role: string; content: string | Array<{type: string; text?: string}>}>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[] | string;
}

interface NodeLlamaTcqModule {
    getLlama: typeof import("node-llama-tcq").getLlama;
    LlamaChatSession: typeof import("node-llama-tcq").LlamaChatSession;
    applyTCQCodebooks: typeof import("node-llama-tcq").applyTCQCodebooks;
    isTCQAvailable: typeof import("node-llama-tcq").isTCQAvailable;
    GgmlType: typeof import("node-llama-tcq").GgmlType;
}

let _moduleCache: NodeLlamaTcqModule | null = null;
let _llamaCache: any = null;
let _modelCache: Map<string, any> = new Map();

async function loadModule(): Promise<NodeLlamaTcqModule> {
    if (_moduleCache) return _moduleCache;
    // 動態 import 避免無 binding 環境啟動失敗
    _moduleCache = (await import("node-llama-tcq")) as unknown as NodeLlamaTcqModule;
    return _moduleCache;
}

export interface EmbeddedAdapterState {
    config: EmbeddedRoutingConfig;
    llama: any;
    model: any;
    context: any;
    session: any;
}

async function ensureState(config: EmbeddedRoutingConfig): Promise<EmbeddedAdapterState> {
    const m = await loadModule();

    const avail = m.isTCQAvailable();
    if (config.applyTCQCodebooks && !avail.ok)
        throw new Error(`Embedded adapter: TCQ unavailable on this platform: ${avail.reason}`);

    if (config.applyTCQCodebooks)
        m.applyTCQCodebooks(config.codebooks);

    if (!_llamaCache) {
        _llamaCache = await m.getLlama({gpu: config.gpu ?? "cuda"});
    }

    if (!config.modelPath) throw new Error("Embedded adapter: modelPath required");

    let model = _modelCache.get(config.modelPath);
    if (!model) {
        model = await _llamaCache.loadModel({modelPath: config.modelPath});
        _modelCache.set(config.modelPath, model);
    }

    const kvType = resolveKvCacheType(config.kvCacheType, m.GgmlType);

    const context = await model.createContext({
        contextSize: config.contextSize ?? 4096,
        flashAttention: true,
        ...(kvType != null
            ? {experimentalKvCacheKeyType: kvType, experimentalKvCacheValueType: kvType}
            : {})
    });

    const session = new m.LlamaChatSession({contextSequence: context.getSequence()});

    return {config, llama: _llamaCache, model, context, session};
}

function resolveKvCacheType(
    val: string | number | undefined,
    GgmlType: NodeLlamaTcqModule["GgmlType"]
): number | undefined {
    if (val == null) return undefined;
    if (typeof val === "number") return val;
    // 字串：先試 GgmlType key（如 "TURBO3_TCQ"）
    const key = val.toUpperCase() as keyof typeof GgmlType;
    if (Object.hasOwn(GgmlType, key)) return GgmlType[key] as number;
    return undefined;
}

/**
 * 把 OpenAI ChatCompletion messages 轉成單一 prompt（簡化版）。
 * 直接給 node-llama-tcq 的 LlamaChatSession.prompt() 用 — chat wrapper 由它處理。
 */
function lastUserMessage(messages: OpenAIChatRequest["messages"]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user") {
            if (typeof m.content === "string") return m.content;
            return m.content.map(p => p.text ?? "").join("");
        }
    }
    return "";
}

/**
 * 產生符合 OpenAI streaming 格式的 SSE chunk。
 * translateOpenAIStreamToAnthropic 會吃這格式。
 */
function makeSseChunk(deltaText: string, model: string): string {
    const obj = {
        id: "embedded-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{index: 0, delta: {content: deltaText}, finish_reason: null}]
    };
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeSseFinal(model: string): string {
    const obj = {
        id: "embedded-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{index: 0, delta: {}, finish_reason: "stop"}]
    };
    return `data: ${JSON.stringify(obj)}\n\ndata: [DONE]\n\n`;
}

export interface EmbeddedFetchOptions {
    config: EmbeddedRoutingConfig;
    /** 注入測試用替身，避免真的載 node-llama-tcq */
    overrideEnsureState?: (cfg: EmbeddedRoutingConfig) => Promise<EmbeddedAdapterState>;
}

export function createLlamaCppEmbeddedFetch(opts: EmbeddedFetchOptions): typeof globalThis.fetch {
    const ensure = opts.overrideEnsureState ?? ensureState;

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!init || !init.body) return new Response("missing body", {status: 400});

        const body: OpenAIChatRequest = JSON.parse(
            typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer)
        );

        const state = await ensure(opts.config);
        const userMsg = lastUserMessage(body.messages);
        const modelLabel = body.model ?? "embedded";

        if (!body.stream) {
            const reply = await state.session.prompt(userMsg, {
                maxTokens: body.max_tokens ?? 256,
                temperature: body.temperature
            });
            return new Response(JSON.stringify({
                id: "embedded-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: modelLabel,
                choices: [{
                    index: 0,
                    message: {role: "assistant", content: reply},
                    finish_reason: "stop"
                }]
            }), {status: 200, headers: {"content-type": "application/json"}});
        }

        // Streaming: 收集所有 token 後一次吐
        // Phase C MVP：先不做 token-by-token streaming，吐單一 chunk + done
        // Phase D 再升級為真正 streaming
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const reply: string = await state.session.prompt(userMsg, {
                        maxTokens: body.max_tokens ?? 256,
                        temperature: body.temperature
                    });
                    controller.enqueue(new TextEncoder().encode(makeSseChunk(reply, modelLabel)));
                    controller.enqueue(new TextEncoder().encode(makeSseFinal(modelLabel)));
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            }
        });

        return new Response(stream, {
            status: 200,
            headers: {"content-type": "text/event-stream", "cache-control": "no-cache"}
        });
    };

    return fetchFn as typeof globalThis.fetch;
}

/** 測試用：清空所有 cache，下次呼叫會重新初始化 */
export function _resetEmbeddedAdapterCache(): void {
    _moduleCache = null;
    _llamaCache = null;
    _modelCache = new Map();
}
