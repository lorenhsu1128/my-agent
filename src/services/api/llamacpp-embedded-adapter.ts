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
    getLlama: typeof import("node-llama-tcq").getLlama;
    LlamaChatSession: typeof import("node-llama-tcq").LlamaChatSession;
    LlamaMtmdContext: typeof import("node-llama-tcq").LlamaMtmdContext;
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
    /** 若 config.mmprojPath 有值，會載入。null 代表純文字模式 */
    mtmdCtx: any | null;
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

    let mtmdCtx: any = null;
    if (config.mmprojPath) {
        mtmdCtx = await m.LlamaMtmdContext.loadMmproj(model, {
            mmprojPath: config.mmprojPath,
            useGpu: true,
            nThreads: 4
        });
    }

    return {config, llama: _llamaCache, model, context, session, mtmdCtx};
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
        if (typeof m.content === "string") continue;
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

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!init || !init.body) return new Response("missing body", {status: 400});

        const body: OpenAIChatRequest = JSON.parse(
            typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer)
        );

        const state = await ensure(opts.config);
        const modelLabel = body.model ?? "embedded";

        const wantsMedia = hasMediaContent(body.messages);
        const mediaAvailable = state.mtmdCtx != null;

        // 非 streaming：等完整 reply 再回 JSON
        const generateReplyBlocking = async (): Promise<string> => {
            if (wantsMedia && mediaAvailable) return await runVisionPath(state, body);
            const userMsg = lastUserMessage(body.messages);
            return await state.session.prompt(userMsg, {
                maxTokens: body.max_tokens ?? 256,
                temperature: body.temperature
            });
        };

        // Streaming：逐 token push SSE chunk（onTextChunk callback）
        const generateReplyStreaming = async (
            onChunk: (text: string) => void
        ): Promise<string> => {
            if (wantsMedia && mediaAvailable) return await runVisionPath(state, body, onChunk);
            const userMsg = lastUserMessage(body.messages);
            return await state.session.prompt(userMsg, {
                maxTokens: body.max_tokens ?? 256,
                temperature: body.temperature,
                onTextChunk: onChunk
            });
        };

        if (!body.stream) {
            const reply = await generateReplyBlocking();
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

        const stream = new ReadableStream({
            async start(controller) {
                const enc = new TextEncoder();
                try {
                    await generateReplyStreaming((delta) => {
                        if (delta.length === 0) return;
                        controller.enqueue(enc.encode(makeSseChunk(delta, modelLabel)));
                    });
                    controller.enqueue(enc.encode(makeSseFinal(modelLabel)));
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
