/**
 * In-process llama.cpp adapter，使用 vendor/node-llama-tcq。
 *
 * 平行於 llamacpp-fetch-adapter.ts，提供同一介面（fetch-shaped function）。
 * 既有 ADR-005 / ADR-010 規定不修改的檔案完全不動。
 *
 * Phase C/E：純文字 + vision binding（mmproj）兩條路徑共存
 *  - 提供 createLlamaCppEmbeddedFetch(config) 回傳 fetch-shaped function
 *  - lazy import node-llama-tcq 避免無 binding 時 my-agent 啟動失敗
 *  - 單例 LlamaModel + LlamaContext 重用
 *  - vision：detect OpenAI image_url content → mtmd tokenize/eval/generate
 *  - 純文字：走 LlamaChatSession.prompt（Phase C 既有）
 *  - 都吐 OpenAI ChatCompletion JSON / SSE，銜接 translateOpenAIStreamToAnthropic
 *
 * 仍不在範圍：
 *  - 多 sequence 並行
 *  - tool call leak detection（fetch-adapter 處理，本 adapter 純文字）
 *  - 真正 token-by-token streaming（先一次吐單一 chunk）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {EmbeddedRoutingConfig} from "../../utils/model/embeddedRouting.js";
import {
    translateRequestToOpenAI,
    translateChatCompletionToAnthropic,
    translateOpenAIStreamToAnthropic,
    sseGeneratorToStream,
    mkMsgId,
} from "./llamacpp-fetch-adapter.js";
// node-llama-tcq TCQ-shim core utilities — Phase G4 暴露給 embedded 模式。
// 同一份 Qwen tool-format / 對話歷史處理邏輯，與 HTTP server 路徑完全等價。
import {
    packMessages as tcqPackMessages,
    runChatCompletionCoreNonStreaming as tcqRunCoreNonStreaming,
    isQwenModel as tcqIsQwenModel,
    countFullPromptTokens as tcqCountFullPromptTokens,
    ensureSession as tcqEnsureSession,
    type RunCtx as TcqRunCtx,
    type ServerSession as TcqServerSession,
    type SessionInitOptions as TcqSessionInitOptions,
} from "node-llama-tcq";

interface OpenAIImageUrl {
    type: "image_url";
    image_url: {url: string};
}

interface OpenAITextPart {
    type: "text";
    text: string;
}

/** OpenAI / Anthropic input_audio 格式 — base64 + format hint */
interface OpenAIInputAudio {
    type: "input_audio";
    input_audio: {data: string; format?: "mp3" | "wav" | "flac" | "ogg"};
}

/** 沿用 image_url 模式的 audio_url（社群常見） */
interface OpenAIAudioUrl {
    type: "audio_url";
    audio_url: {url: string};
}

type OpenAIContentPart =
    | OpenAITextPart
    | OpenAIImageUrl
    | OpenAIInputAudio
    | OpenAIAudioUrl
    | {type: string; text?: string};

interface OpenAIChatRequest {
    model?: string;
    messages: Array<{role: string; content: string | OpenAIContentPart[]}>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[] | string;
}

interface NodeLlamaTcqModule {
    LlamaChatSession: typeof import("node-llama-tcq").LlamaChatSession;
    LlamaMtmdContext: typeof import("node-llama-tcq").LlamaMtmdContext;
}

let _moduleCache: NodeLlamaTcqModule | null = null;

async function loadModule(): Promise<NodeLlamaTcqModule> {
    if (_moduleCache) return _moduleCache;
    // 動態 import 避免無 binding 環境啟動失敗
    _moduleCache = (await import("node-llama-tcq")) as unknown as NodeLlamaTcqModule;
    return _moduleCache;
}

/**
 * Embedded adapter state — 直接重用 TCQ-shim 的 ServerSession（單例 module-level
 * cache，與 HTTP server 路徑共用同一份）。第二次以後 ensureState 從 tcqEnsureSession
 * 取既有 _session（withLock guard），不會重複載 model / 重建 context。
 *
 * 等價於 TCQ-shim httpServer.ts 啟動時的 ensureSession 結果。
 */
export interface EmbeddedAdapterState {
    config: EmbeddedRoutingConfig;
    serverSession: TcqServerSession;
    /** 別名：fetchFn 內部使用對應名稱 */
    llama: TcqServerSession["llama"];
    model: TcqServerSession["model"];
    context: TcqServerSession["context"];
    sequence: TcqServerSession["sequence"];
    mtmdCtx: TcqServerSession["mtmdCtx"];
}

/** 把 embedded routing config 轉成 TCQ-shim ensureSession 接受的 SessionInitOptions。
 *  缺欄位填合理 default（與 jsonc schema 預設一致）。 */
function toSessionInitOptions(config: EmbeddedRoutingConfig): TcqSessionInitOptions {
    if (!config.modelPath) throw new Error("Embedded adapter: modelPath required");

    // gpuLayers: jsonc 預設 99（全層 offload），"max" / "auto" 走 binding 解析
    const gpuLayers = typeof config.gpuLayers === "number"
        ? config.gpuLayers
        : config.gpuLayers === "max" ? 99
            : config.gpuLayers === "auto" ? -1  // -1 = auto 在 binding 內部處理
                : 99;  // default: 等同 llama-server `--n-gpu-layers 99`

    // KV cache：jsonc extraArgs `--cache-type-k turbo4 --cache-type-v turbo4` →
    // cacheTypeK/V 字串。若兩者都未設，fallback "f16"（與 llama-server default 對齊）。
    const cacheTypeK = config.cacheTypeK
        ?? (typeof config.kvCacheType === "string" ? config.kvCacheType : "f16");
    const cacheTypeV = config.cacheTypeV
        ?? (typeof config.kvCacheType === "string" ? config.kvCacheType : "f16");

    return {
        modelPath: config.modelPath,
        mmprojPath: config.mmprojPath,
        contextSize: config.contextSize ?? 4096,
        gpuLayers,
        gpu: config.gpu ?? "auto",
        threads: config.threads,
        batchSize: config.batchSize,
        ubatchSize: config.ubatchSize,
        cacheTypeK,
        cacheTypeV,
        flashAttention: config.flashAttention ?? true,
        noMmap: config.noMmap ?? false,
        debug: config.debug ?? process.env.LLAMA_DEBUG === "1",
        reasoning: config.reasoning ?? "auto",
        samplerDefaults: config.samplerDefaults,
    };
}

async function ensureState(config: EmbeddedRoutingConfig): Promise<EmbeddedAdapterState> {
    const opts = toSessionInitOptions(config);
    // tcqEnsureSession 是 module-level singleton（withLock guard）。第二次起直接拿
    // 既有 _session，model / context / sequence / mtmdCtx 都不重建。
    const serverSession = await tcqEnsureSession(opts);

    if (process.env.LLAMA_DEBUG === "1") {
        console.error(`[embedded] session ready: gpuLayers=${serverSession.model.gpuLayers}/${(serverSession.model as any).fileInfo?.totalLayers ?? "?"} vramUsed=${((serverSession.model as any).vramUsedBytes ?? 0) >> 20}MiB k=${serverSession.cacheTypeKLabel} v=${serverSession.cacheTypeVLabel} ctx=${opts.contextSize} batch=${opts.batchSize ?? "?"} threads=${opts.threads ?? "?"} flashAttn=${opts.flashAttention} noMmap=${opts.noMmap}`);
    }

    return {
        config,
        serverSession,
        llama: serverSession.llama,
        model: serverSession.model,
        context: serverSession.context,
        sequence: serverSession.sequence,
        mtmdCtx: serverSession.mtmdCtx,
    };
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
            return m.content.map(p => ("text" in p ? p.text ?? "" : "")).join("");
        }
    }
    return "";
}

/**
 * 從 last user message 萃取 image inputs（OpenAI vision 格式：
 *   {type: "image_url", image_url: {url: "data:image/png;base64,..." | "file:..." | "http..."}}
 * data URL 解 base64 後寫到 temp file，回傳檔案路徑陣列；
 * file URL 直接回傳路徑；http URL 暫不支援（拋錯）。
 *
 * 同時組出 prompt 文字 — 每張圖前插一個 mtmd marker。
 */
/**
 * 從 last user message 萃取 image / audio inputs。
 * 支援格式：
 *   image_url: data: / file: / 絕對路徑
 *   input_audio: {data: <base64>, format: "mp3"|"wav"|...}
 *   audio_url: data: / file: / 絕對路徑（同 image 模式）
 *
 * 對每個 marker 在 prompt 中插一個 mtmd marker。
 * 順序對應 mtmd_tokenize 期望（marker 順序 = bitmaps 陣列順序）。
 */
function extractMediaInput(
    messages: OpenAIChatRequest["messages"],
    marker: string
): {prompt: string; mediaPaths: string[]; tempFiles: string[]} {
    const mediaPaths: string[] = [];
    const tempFiles: string[] = [];

    let lastUser: OpenAIChatRequest["messages"][number] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const mm = messages[i];
        if (mm && mm.role === "user") {
            lastUser = mm;
            break;
        }
    }
    if (!lastUser) return {prompt: "", mediaPaths: [], tempFiles: []};

    if (typeof lastUser.content === "string") {
        return {prompt: lastUser.content, mediaPaths: [], tempFiles: []};
    }

    const writeBase64ToTemp = (b64: string, ext: string): string => {
        const buf = Buffer.from(b64, "base64");
        const tmpPath = path.join(
            os.tmpdir(),
            `nltcq-media-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
        );
        fs.writeFileSync(tmpPath, buf);
        tempFiles.push(tmpPath);
        return tmpPath;
    };

    const resolveUrlToPath = (url: string, defaultExt: string): string => {
        if (url.startsWith("data:")) {
            const m = /^data:([^;]+);base64,(.+)$/.exec(url);
            if (!m) throw new Error("invalid data: URL");
            const mime = m[1]!.toLowerCase();
            const ext = mime.includes("png") ? ".png"
                : mime.includes("jpeg") || mime.includes("jpg") ? ".jpg"
                    : mime.includes("mp3") || mime.includes("mpeg") ? ".mp3"
                        : mime.includes("wav") ? ".wav"
                            : mime.includes("flac") ? ".flac"
                                : mime.includes("ogg") ? ".ogg"
                                    : defaultExt;
            return writeBase64ToTemp(m[2]!, ext);
        }
        if (url.startsWith("file://")) return url.slice(7);
        if (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url)) return url;
        throw new Error(`unsupported media URL scheme: ${url.slice(0, 30)}...`);
    };

    const textParts: string[] = [];
    for (const part of lastUser.content) {
        if (part.type === "image_url" && "image_url" in part && part.image_url?.url) {
            mediaPaths.push(resolveUrlToPath(part.image_url.url, ".bin"));
            textParts.push(marker);
        } else if (part.type === "audio_url" && "audio_url" in part && part.audio_url?.url) {
            mediaPaths.push(resolveUrlToPath(part.audio_url.url, ".mp3"));
            textParts.push(marker);
        } else if (part.type === "input_audio" && "input_audio" in part && part.input_audio?.data) {
            const fmt = part.input_audio.format ?? "mp3";
            mediaPaths.push(writeBase64ToTemp(part.input_audio.data, "." + fmt));
            textParts.push(marker);
        } else if (part.type === "text" && "text" in part) {
            textParts.push(part.text ?? "");
        }
    }

    return {prompt: textParts.join("\n"), mediaPaths, tempFiles};
}

/** @deprecated 改用 extractMediaInput */
function extractVisionInput(
    messages: OpenAIChatRequest["messages"],
    marker: string
): {prompt: string; imagePaths: string[]; tempFiles: string[]} {
    const {prompt, mediaPaths, tempFiles} = extractMediaInput(messages, marker);
    return {prompt, imagePaths: mediaPaths, tempFiles};
}

function hasMediaContent(messages: OpenAIChatRequest["messages"]): boolean {
    for (const m of messages) {
        // assistant 訊息含 tool_calls 時 content 是 null；其餘訊息可能是 string
        if (m.content == null || typeof m.content === "string") continue;
        if (!Array.isArray(m.content)) continue;
        if (m.content.some(p =>
            p.type === "image_url" || p.type === "audio_url" || p.type === "input_audio"
        )) return true;
    }
    return false;
}

/** @deprecated 改用 hasMediaContent — 保留向後相容 */
function hasVisionContent(messages: OpenAIChatRequest["messages"]): boolean {
    return hasMediaContent(messages);
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

    let _fetchCallCount = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        _fetchCallCount++;
        const callN = _fetchCallCount;
        try {
            return await fetchFnInner(input, init, callN);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[embedded] fetchFn #${callN} threw: ${msg}`);
            if (process.env.LLAMA_DEBUG === "1" && err instanceof Error && err.stack) {
                console.error(err.stack.split("\n").slice(0, 6).join("\n"));
            }
            throw err;
        }
    };

    const fetchFnInner = async (
        _input: RequestInfo | URL,
        init: RequestInit | undefined,
        callN: number
    ): Promise<Response> => {
        if (!init || !init.body) return new Response("missing body", {status: 400});

        // 桌寵 / my-agent 透過 Anthropic SDK 注入 fetch，body 是 Anthropic 格式
        // （/v1/messages）。沿用 fetch-adapter 的翻譯：Anthropic→OpenAI 入、
        // OpenAI→Anthropic 出，讓 SDK 拿到符合預期的 Anthropic SSE / JSON。
        // 修正 v0.4：原先直接把 body 當 OpenAI 解析造成 SDK 收到 OpenAI shape →
        // 內部 read response.usage.input_tokens crash → assistant text 顯示
        // 「Cannot read properties of undefined (reading 'input_tokens')」。
        const rawBodyText: string = typeof init.body === "string"
            ? init.body
            : new TextDecoder().decode(init.body as ArrayBuffer);
        const anthropicBody = JSON.parse(rawBodyText) as Record<string, unknown>;

        const state = await ensure(opts.config);
        const reportedModel = (typeof anthropicBody.model === "string" && anthropicBody.model) || "embedded";

        // Anthropic → OpenAI 翻譯（含 messages / tools / system）
        const openaiBody = translateRequestToOpenAI(
            anthropicBody as Parameters<typeof translateRequestToOpenAI>[0],
            reportedModel,
            {vision: state.mtmdCtx != null},
        );

        const body: OpenAIChatRequest = openaiBody as unknown as OpenAIChatRequest;
        const modelLabel = reportedModel;
        const isStream = anthropicBody.stream === true;

        const wantsMedia = hasMediaContent(body.messages);
        const mediaAvailable = state.mtmdCtx != null;

        // Vision path（含 image / audio）目前還沒接 TCQ-shim 核心 — 走自家 batch
        // 流程。tools 在 vision 模式下也不會被解析。v2 再整合。
        if (wantsMedia && mediaAvailable) {
            const reply = await runVisionPath(state, body);
            const openaiJson = {
                id: "embedded-" + Date.now(),
                object: "chat.completion" as const,
                created: Math.floor(Date.now() / 1000),
                model: modelLabel,
                choices: [{
                    index: 0,
                    message: {role: "assistant" as const, content: reply},
                    finish_reason: "stop" as const,
                }],
                usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
            };
            const anthropicJson = translateChatCompletionToAnthropic(
                openaiJson as Parameters<typeof translateChatCompletionToAnthropic>[0],
                modelLabel,
                "tcq",
            );
            return new Response(JSON.stringify(anthropicJson), {
                status: 200,
                headers: {"content-type": "application/json"},
            });
        }

        // 純文字路徑 — reuse TCQ-shim 核心：packMessages 把 OpenAI messages + tools
        // 組成 systemPrompt（含 <tools> 區塊）+ history（含過去 tool_call XML）+
        // lastUserPrompt（可能含 buildQwenToolsReminder）；再丟給
        // runChatCompletionCoreNonStreaming 跑 promptWithMeta + parseQwenToolCalls。
        const useQwenFormat = tcqIsQwenModel(modelLabel);
        const {systemPrompt, history, lastUserPrompt} = tcqPackMessages(
            body.messages as Parameters<typeof tcqPackMessages>[0],
            (body.tools ?? []) as Parameters<typeof tcqPackMessages>[1],
            useQwenFormat,
        );
        if (process.env.LLAMA_DEBUG === "1") {
            console.error(`[embedded] #${callN} tools=${(body.tools ?? []).length} qwen=${useQwenFormat} sysLen=${systemPrompt.length} histLen=${history.length} userLen=${lastUserPrompt.length} stream=${isStream}`);
        }

        // 為 embedded 模式建 per-request LlamaChatSession，與 TCQ-shim
        // runNonStreaming 同模式（new LlamaChatSession({contextSequence, systemPrompt})
        // + setChatHistory(history)）。Sequence 從 cached context 取既有 slot，
        // LlamaChatSession 內部會依 setChatHistory 重填 KV cache（與舊狀態不匹配
        // 就 evict），不需手動 dispose+recreate sequence。
        const m = await loadModule();
        // 用 cached sequence（單 slot context 只有一個），每次 request 新建
        // LlamaChatSession 包它。setChatHistory + promptWithMeta 會處理 KV cache
        // 與舊狀態的差異（增量 prefill / evict 舊 tokens）。
        const sequence = state.sequence;
        const chatSession = new m.LlamaChatSession({
            contextSequence: sequence,
            ...(systemPrompt ? {systemPrompt} : {}),
            autoDisposeSequence: false,
        });
        if (history.length > 0) chatSession.setChatHistory(history);

        // 直接用 tcqEnsureSession 已建立的 ServerSession（含正確 options /
        // cacheTypeKLabel / inferenceLockScope）— 不再自製空殼。
        const serverSession = state.serverSession;

        const promptTokens = tcqCountFullPromptTokens(
            serverSession,
            systemPrompt,
            history,
            lastUserPrompt,
        );

        const abort = new AbortController();
        // 若 SDK 透過 init.signal 傳取消訊號，串接到 promptWithMeta
        if (init.signal) {
            if (init.signal.aborted) abort.abort();
            else init.signal.addEventListener("abort", () => abort.abort(), {once: true});
        }

        const runCtx: TcqRunCtx = {
            body: body as unknown as TcqRunCtx["body"],
            chatSession,
            lastUserPrompt,
            systemPrompt,
            history,
            session: serverSession as TcqRunCtx["session"],
            useQwenFormat,
            id: "chatcmpl-embedded-" + Date.now(),
            created: Math.floor(Date.now() / 1000),
            model: modelLabel,
            declaredTools: (body.tools ?? []) as TcqRunCtx["declaredTools"],
            promptTokens,
            abort,
        };

        const result = await tcqRunCoreNonStreaming(runCtx);
        if (result.type === "aborted") {
            return new Response("aborted", {status: 499});
        }
        if (result.type === "contextOverflow") {
            return new Response(JSON.stringify({
                error: {message: "context length exceeded", type: "invalid_request_error"},
            }), {status: 413, headers: {"content-type": "application/json"}});
        }

        // Server-side parse 已等價於 TCQ-shim — adapterMode 設 'tcq' 跳過下游 leak parser。
        const adapterMode: "vanilla" | "tcq" = "tcq";
        const anthropicJson = translateChatCompletionToAnthropic(
            result.completion as unknown as Parameters<typeof translateChatCompletionToAnthropic>[0],
            modelLabel,
            adapterMode,
        );

        if (!isStream) {
            return new Response(JSON.stringify(anthropicJson), {
                status: 200,
                headers: {"content-type": "application/json"},
            });
        }

        // Stream 模式 v1：把已產出的 Anthropic Message 序列化為 Anthropic SSE
        // events。v2 整合 runChatCompletionCoreStreaming 後可逐 token push。
        const anthropicSseStream = new ReadableStream<Uint8Array>({
            async start(controller) {
                const enc = new TextEncoder();
                const msg = anthropicJson as any;
                const msgId = msg.id ?? mkMsgId();
                const writeEvent = (event: string, data: any) => {
                    controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                };

                writeEvent("message_start", {
                    type: "message_start",
                    message: {
                        id: msgId,
                        type: "message",
                        role: "assistant",
                        model: msg.model ?? modelLabel,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: msg.usage ?? {input_tokens: 0, output_tokens: 0},
                    },
                });

                const blocks: any[] = msg.content ?? [];
                for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i];
                    if (block.type === "text") {
                        writeEvent("content_block_start", {
                            type: "content_block_start", index: i,
                            content_block: {type: "text", text: ""},
                        });
                        if (block.text) {
                            writeEvent("content_block_delta", {
                                type: "content_block_delta", index: i,
                                delta: {type: "text_delta", text: block.text},
                            });
                        }
                        writeEvent("content_block_stop", {type: "content_block_stop", index: i});
                    } else if (block.type === "tool_use") {
                        writeEvent("content_block_start", {
                            type: "content_block_start", index: i,
                            content_block: {
                                type: "tool_use",
                                id: block.id,
                                name: block.name,
                                input: {},
                            },
                        });
                        writeEvent("content_block_delta", {
                            type: "content_block_delta", index: i,
                            delta: {
                                type: "input_json_delta",
                                partial_json: JSON.stringify(block.input ?? {}),
                            },
                        });
                        writeEvent("content_block_stop", {type: "content_block_stop", index: i});
                    } else if (block.type === "thinking") {
                        writeEvent("content_block_start", {
                            type: "content_block_start", index: i,
                            content_block: {type: "thinking", thinking: ""},
                        });
                        if (block.thinking) {
                            writeEvent("content_block_delta", {
                                type: "content_block_delta", index: i,
                                delta: {type: "thinking_delta", thinking: block.thinking},
                            });
                        }
                        writeEvent("content_block_stop", {type: "content_block_stop", index: i});
                    }
                }

                writeEvent("message_delta", {
                    type: "message_delta",
                    delta: {
                        stop_reason: msg.stop_reason ?? "end_turn",
                        stop_sequence: msg.stop_sequence ?? null,
                    },
                    usage: msg.usage ?? {input_tokens: 0, output_tokens: 0},
                });

                writeEvent("message_stop", {type: "message_stop"});
                controller.close();
            },
        });

        return new Response(anthropicSseStream, {
            status: 200,
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            },
        });
    };

    async function runVisionPath(
        state: EmbeddedAdapterState,
        body: OpenAIChatRequest,
        onChunk?: (text: string) => void
    ): Promise<string> {
        // F1 階段 vision 仍是 batch — 整段 reply 算完一次餵 onChunk。
        // F2 改 mtmdCtx.generate 接 onTextChunk 後可逐 token push。
        const m = await loadModule();
        const marker = state.mtmdCtx.defaultMarker;
        const {prompt, mediaPaths, tempFiles} = extractMediaInput(body.messages, marker);
        try {
            const chunks = await state.mtmdCtx.tokenize({
                text: prompt,
                media: mediaPaths.map(p => ({type: "file", data: p}))
            });
            const seq = state.context.getSequence();
            const newNPast = await state.mtmdCtx.evalChunks(state.context, chunks, 0, {
                seqId: seq.sequenceId ?? 0
            });

            const bindings = (state.model as any)._llama._bindings;
            const sampler = new bindings.AddonSampler((state.model as any)._model);
            sampler.applyConfig({
                temperature: body.temperature ?? 0,
                topK: 40,
                topP: body.top_p ?? 0.95,
                minP: 0.05
            });
            try {
                const result = await state.mtmdCtx.generate(
                    state.context, sampler, newNPast, body.max_tokens ?? 256,
                    {seqId: seq.sequenceId ?? 0, onTextChunk: onChunk}
                );
                // onChunk 已逐 piece 推；若沒人 emit 過（mtmdGenerateStep 路徑）保險 fallback
                return result.text;
            } finally {
                sampler.dispose();
                chunks.dispose();
            }
        } finally {
            for (const f of tempFiles) {
                try { fs.unlinkSync(f); } catch { /* ignore */ }
            }
        }

        // unreachable; satisfies linter
        // eslint-disable-next-line no-unreachable
        return _unreachable(m);
    }

    // 防 lint
    function _unreachable(_m: NodeLlamaTcqModule): string { return ""; }

    return fetchFn as typeof globalThis.fetch;
}

/** 測試用：清空所有 cache，下次呼叫會重新初始化 */
export function _resetEmbeddedAdapterCache(): void {
    _moduleCache = null;
    _llamaCache = null;
    _modelCache = new Map();
}
