/**
 * In-process llama.cpp adapter，使用 vendor/node-llama-tcq。
 *
 * 平行於 llamacpp-fetch-adapter.ts，提供同一介面（fetch-shaped function）。
 * 既有 ADR-005 / ADR-010 規定不修改的檔案完全不動。
 *
 * Phase C/E + G4/G5/G6：純文字 + vision multimodal 兩條路徑共存
 *  - 提供 createLlamaCppEmbeddedFetch(config) 回傳 fetch-shaped function
 *  - lazy import node-llama-tcq 避免無 binding 時 my-agent 啟動失敗
 *  - 透過 tcqEnsureSession module-level singleton 重用 model / context / sequence
 *  - 純文字：tcqPackMessages + tcqRunCoreNonStreaming / tcqRunCoreStreaming
 *  - vision：tcqBuildVisionPrompt + tcqRunVisionCore（與 HTTP server 共用）
 *  - streaming：byte-pipe → translateOpenAIStreamToAnthropic（含 watchdog）
 *  - abort：fetch init.signal → runCtx.abort → tcqRunCore* 中止生成
 *  - 都吐 OpenAI ChatCompletion JSON / SSE，銜接 fetch adapter 的翻譯層
 *
 * 仍不在範圍：
 *  - 多 sequence 並行（TCQ-shim 單 slot 限制）
 *  - vision streaming（v1 vision 走 batch；v2 補 streaming sink）
 *  - tool call leak detection（mode='tcq' 跳過下游 leak parser，由 tcq core 自家 parse）
 */

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
    runChatCompletionCoreStreaming as tcqRunCoreStreaming,
    isQwenModel as tcqIsQwenModel,
    countFullPromptTokens as tcqCountFullPromptTokens,
    ensureSession as tcqEnsureSession,
    disposeSession as tcqDisposeSession,
    // G5: vision pipeline core — embedded vision branch 改走 tcq-shim 同一份邏輯
    runVisionChatCompletionCoreNonStreaming as tcqRunVisionCore,
    buildVisionPrompt as tcqBuildVisionPrompt,
    extractMediaParts as tcqExtractMediaParts,
    resolveMedia as tcqResolveMedia,
    cleanupMedia as tcqCleanupMedia,
    buildQwenToolChoicePrefix as tcqBuildQwenToolChoicePrefix,
    type RunCtx as TcqRunCtx,
    type StreamingSink as TcqStreamingSink,
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

/**
 * 從 Anthropic request body 推 watchdog callSite。
 *
 * Anthropic Messages API metadata 沒有標準 callSite 欄位，my-agent 的 fetch adapter
 * 也是 hardcoded 'turn'（caller 沒注入機制）。為了讓 tokenCap watchdog 在 embedded
 * 模式對 cron/memoryPrefetch 等 background 任務套用對應 cap，這裡支援兩種 caller
 * 注入方式（任一即可）：
 *   1. anthropicBody.metadata.callSite — 字串 'turn'|'memoryPrefetch'|...
 *   2. anthropicBody.metadata.user_id starts with 'callSite:<name>'
 * 都沒提供 → 預設 'turn'（與 fetch adapter 行為一致）。
 */
function inferCallSite(
    anthropicBody: Record<string, unknown>,
): "turn" | "memoryPrefetch" | "sideQuery" | "background" | "vision" {
    const meta = anthropicBody.metadata as Record<string, unknown> | undefined;
    if (!meta) return "turn";
    const direct = meta.callSite;
    if (typeof direct === "string"
        && (direct === "turn" || direct === "memoryPrefetch"
            || direct === "sideQuery" || direct === "background"
            || direct === "vision")) {
        return direct;
    }
    const userId = meta.user_id;
    if (typeof userId === "string" && userId.startsWith("callSite:")) {
        const name = userId.slice("callSite:".length);
        if (name === "turn" || name === "memoryPrefetch"
            || name === "sideQuery" || name === "background"
            || name === "vision") return name;
    }
    return "turn";
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
        const useQwenFormatGlobal = tcqIsQwenModel(modelLabel);

        // Vision / audio path（A 階段）— 改走 tcq-shim 同一份 vision core：
        //   buildVisionPrompt（含 system + tools system block + history + markers）
        //   resolveMedia（data:/file://下載/解析為 local path）
        //   runVisionChatCompletionCoreNonStreaming（tokenize / evalChunks / sampler /
        //   generate / splitReasoning / parseQwenToolCalls） → OpenAIChatCompletion
        // 與 HTTP server handleChatWithVision 完全一致行為（含 tools 解析）。
        // v1 vision 不做 streaming（沿用 batch 路徑）— 完成後給 translator 翻成 Anthropic。
        if (wantsMedia && mediaAvailable) {
            const mtmdCtx = state.mtmdCtx;
            const mediaParts = tcqExtractMediaParts(body.messages as Parameters<typeof tcqExtractMediaParts>[0]);
            if (mediaParts.length === 0) {
                // 不應該到這（hasMediaContent 已偵測），保險起見走純文字路徑
                if (process.env.LLAMA_DEBUG === "1")
                    console.error(`[embedded] vision detected but no extractable media parts; falling through to text path`);
            } else {
                const declaredTools = (body.tools ?? []) as Parameters<typeof tcqRunVisionCore>[0]["declaredTools"];
                const toolChoicePrefix = (useQwenFormatGlobal && declaredTools.length > 0)
                    ? tcqBuildQwenToolChoicePrefix((body as any).tool_choice)
                    : undefined;
                const {systemPrompt, conversationText, mediaInOrder} = tcqBuildVisionPrompt(
                    body.messages as Parameters<typeof tcqBuildVisionPrompt>[0],
                    mediaParts,
                    mtmdCtx.defaultMarker,
                    {useQwenFormat: useQwenFormatGlobal, tools: declaredTools as any, toolChoicePrefix},
                );
                const fullText = systemPrompt
                    ? `<|im_start|>system\n${systemPrompt}<|im_end|>\n${conversationText}`
                    : conversationText;

                // resolveMedia：data: / file:// / http(s) / 絕對路徑 → 本地檔
                let resolved: Awaited<ReturnType<typeof tcqResolveMedia>>[] = [];
                const cleanup = async () => {
                    await Promise.all(resolved.map((r) => tcqCleanupMedia(r)));
                };
                try {
                    resolved = await Promise.all(
                        mediaInOrder.map((m) => tcqResolveMedia(m.url)),
                    );
                    const mediaInputs = resolved.map((r) => ({type: "file" as const, data: r.filePath}));

                    if (process.env.LLAMA_DEBUG === "1") {
                        console.error(`[embedded] vision #${callN} tools=${declaredTools.length} qwen=${useQwenFormatGlobal} mediaCount=${mediaInputs.length} sysLen=${systemPrompt.length} convLen=${conversationText.length}`);
                    }

                    const result = await tcqRunVisionCore({
                        session: state.serverSession,
                        fullText,
                        mediaInputs,
                        body,
                        declaredTools,
                        useQwenFormat: useQwenFormatGlobal,
                        toolChoicePrefix,
                        id: "chatcmpl-embedded-vision-" + Date.now(),
                        created: Math.floor(Date.now() / 1000),
                        model: modelLabel,
                        maxTokens: body.max_tokens ?? 512,
                    });

                    if (result.type === "aborted") {
                        return new Response("aborted", {status: 499});
                    }
                    if (result.type === "contextOverflow") {
                        return new Response(JSON.stringify({
                            error: {message: "context length exceeded", type: "invalid_request_error"},
                        }), {status: 413, headers: {"content-type": "application/json"}});
                    }
                    if (result.type === "tokenizeFailed" || result.type === "evalFailed") {
                        return new Response(JSON.stringify({
                            error: {message: `vision_${result.type}: ${result.message}`, type: "server_error"},
                        }), {status: 500, headers: {"content-type": "application/json"}});
                    }

                    const anthropicJson = translateChatCompletionToAnthropic(
                        result.completion as unknown as Parameters<typeof translateChatCompletionToAnthropic>[0],
                        modelLabel,
                        "tcq",
                    );
                    return new Response(JSON.stringify(anthropicJson), {
                        status: 200,
                        headers: {"content-type": "application/json"},
                    });
                } finally {
                    await cleanup();
                }
            }
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

        // Preflight context-overflow（與 HTTP handleChatCompletions 對齊）—
        // 在開始推論前先檢查，避免 mid-stream sink.onError 讓 SDK 拿到含糊錯訊。
        const ctxSize = serverSession.options.contextSize;
        const effectiveMax = body.max_tokens ?? 0;
        if (promptTokens + effectiveMax > ctxSize) {
            return new Response(JSON.stringify({
                error: {
                    message: `context length exceeded (prompt=${promptTokens} + max=${effectiveMax} > ctx=${ctxSize})`,
                    type: "invalid_request_error",
                },
            }), {status: 413, headers: {"content-type": "application/json"}});
        }

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

        // Non-streaming：跑 core function 拿完整 OpenAI Completion，翻成 Anthropic JSON。
        if (!isStream) {
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
            const anthropicJson = translateChatCompletionToAnthropic(
                result.completion as unknown as Parameters<typeof translateChatCompletionToAnthropic>[0],
                modelLabel,
                "tcq",
            );
            return new Response(JSON.stringify(anthropicJson), {
                status: 200,
                headers: {"content-type": "application/json"},
            });
        }

        // Streaming v2：用 byte-pipe 把 tcqRunCoreStreaming sink 串到既有
        // translateOpenAIStreamToAnthropic — 100% 重用 fetch adapter 的 OpenAI SSE
        // → Anthropic SSE 翻譯 + watchdog（watchSseStream 在 translator 內部自帶），
        // 零行為 drift。core 在 background 跑，token 一出來立刻寫進 upstream
        // ReadableStream，translator 即時翻譯吐出 Anthropic events。
        const enc = new TextEncoder();
        let upstreamCtrl!: ReadableStreamDefaultController<Uint8Array>;
        const upstreamReadable = new ReadableStream<Uint8Array>({
            start(c) { upstreamCtrl = c; },
        });

        const _tSinkStart = Date.now();
        let _sinkChunkCount = 0;
        const sink: TcqStreamingSink = {
            onChunk(chunk) {
                upstreamCtrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                _sinkChunkCount++;
                if (process.env.LLAMA_STREAM_DEBUG === "1" && _sinkChunkCount <= 8) {
                    const delta: any = (chunk.choices?.[0] as any)?.delta ?? {};
                    const preview = (delta.content ?? delta.reasoning_content ?? "").toString().slice(0, 25);
                    console.error(`[embedded:sink] +${Date.now() - _tSinkStart}ms #${_sinkChunkCount} "${preview.replace(/\n/g, "\\n")}"`);
                }
            },
            onError(err) {
                try { upstreamCtrl.error(err); } catch { /* already errored/closed */ }
            },
            onDone() {
                upstreamCtrl.enqueue(enc.encode(`data: [DONE]\n\n`));
                try { upstreamCtrl.close(); } catch { /* already closed */ }
            },
        };

        // background 跑 tcq core — token 即時推進 upstream，main path 同步
        // 把 upstream 經 translator 翻成 Anthropic SSE 回傳給 SDK
        void (async () => {
            try {
                const result = await tcqRunCoreStreaming(runCtx, sink);
                if (result.type === "contextOverflow") {
                    sink.onError(new Error("context length exceeded"));
                    return;
                }
                // 'aborted' 與 'completion' 都已由 sink 處理（aborted: stream 半開 →
                // SDK abort 時 cancel upstream；completion: onDone 已 close）
                if (result.type === "aborted") {
                    try { upstreamCtrl.close(); } catch { /* */ }
                }
            } catch (err) {
                sink.onError(err instanceof Error ? err : new Error(String(err)));
            }
        })();

        // 用 fetch adapter 既有翻譯（mode='tcq' 跳過 leak parser）。
        // translator 內含 watchSseStream（M-LLAMACPP-WATCHDOG）— interChunk / reasoning /
        // tokenCap 三層 watchdog 在 byte-pipe 上自動生效，watchdog 觸發時 translator
        // catch WatchdogAbortError 後 yield message_delta + message_stop graceful 結束。
        // callSite 從 anthropicBody.metadata 推（caller 若提供）— 對應 jsonc tokenCap
        // per-callSite 設定（turn/memoryPrefetch/sideQuery/background/vision）
        const callSite = inferCallSite(anthropicBody);
        const msgId = mkMsgId();
        const upstreamWrapper = async function* () {
            try {
                yield* translateOpenAIStreamToAnthropic(
                    upstreamReadable, modelLabel, msgId, callSite, "tcq",
                );
            } finally {
                // Translator 結束（不論 watchdog graceful close 或自然 done）→
                // 反向 abort 背景 tcqRunCoreStreaming，避免 watchdog 後 GPU 還在
                // 跑沒人讀的 tokens。abort.abort() 對自然 done 是 noop（generation
                // 已停），對 watchdog 是必要的 GPU 釋放訊號。
                abort.abort();
            }
        };
        const anthropicReadable = sseGeneratorToStream(upstreamWrapper());

        return new Response(anthropicReadable, {
            status: 200,
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            },
        });
    };

    return fetchFn as typeof globalThis.fetch;
}

/** 測試用：清空模組 cache + 釋放 TCQ-shim session，下次 fetchFn 呼叫會重新初始化。 */
export function _resetEmbeddedAdapterCache(): void {
    _moduleCache = null;
    // 釋放 TCQ-shim module-level _session（model + context + sequence + mtmdCtx）。
    // 若尚未 init 過則 no-op（disposeSession 內部 idempotent）。
    try {
        tcqDisposeSession();
    } catch {
        // 無 session 可釋放；安全忽略
    }
}
