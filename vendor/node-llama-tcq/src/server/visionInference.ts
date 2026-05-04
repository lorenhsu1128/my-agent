// M-TCQ-SHIM-1-7：vision/audio mtmd inference path.
//
// 走 LlamaMtmdContext 的 tokenize → evalChunks → mtmdGenerate 三步。
//
// 限制（明確記錄）：
//   - 多輪 vision 歷史不保存（每 request 重置 sequence；image 重新 encode）。
//     對 my-agent 一輪一圖的 chat 流程已夠，連續多輪同圖會重複處理。
//   - 不支援同 turn 同時用 vision + tool_calls（mtmdGenerate 純文字輸出，
//     沒走 chat wrapper 的 tool format injection；後續若要支援需把
//     pythonic-XML system block 也手動拼進 prompt 並做 post-parse）。
//   - 串流走 mtmdGenerate 的 onTextChunk 回調；reasoning_content 切分仍
//     有效（用 StreamReasoningSplitter 處理 <think> 標籤）。

import type {ServerResponse, IncomingMessage} from "node:http";
import {nanoid} from "nanoid";
import {withLock} from "lifecycle-utils";
import {type ServerSession, resetSessionSequence} from "./session.js";
import type {OpenAIChatRequest, OpenAIChatCompletion, OpenAIChatChunk, OpenAIMessage} from "./types.js";
import {sendJson} from "./httpHelpers.js";
import {makeError} from "./errors.js";
import {extractMediaParts, flattenContent, type MediaInput} from "./visionPath.js";
import {resolveMedia, cleanupMedia, type ResolvedMedia} from "./mediaResolver.js";
import {SseWriter} from "./streaming.js";
import {splitReasoning, StreamReasoningSplitter} from "./reasoningSplit.js";
import {makeUsage} from "./usage.js";
import {recordChatTokens, incChatError, inflightStart, inflightEnd} from "./metrics.js";
import {isContextOverflowError, makeContextLengthExceededError} from "./errors.js";
import type {MtmdMediaInput} from "../evaluator/LlamaMtmdContext.js";

const SHIM_OBJECT_NON_STREAM = "chat.completion" as const;
const SHIM_OBJECT_STREAM = "chat.completion.chunk" as const;

export async function handleChatWithVision(
    req: IncomingMessage,
    res: ServerResponse,
    body: OpenAIChatRequest,
    session: ServerSession,
    primaryAlias: string
): Promise<void> {
    const mtmdCtx = session.mtmdCtx;
    if (mtmdCtx == null) {
        sendJson(res, 400, makeError(
            "vision_not_enabled",
            "Server was started without --mmproj; vision/audio requests cannot be served."
        ));
        return;
    }

    const mediaParts = extractMediaParts(body.messages);
    if (mediaParts.length === 0) {
        sendJson(res, 500, makeError("internal_error", "handleChatWithVision called with no media parts", "server_error"));
        return;
    }

    // Build prompt: system + history + last-user with <__media__> markers replacing image positions.
    const {systemPrompt, conversationText, mediaInOrder} = buildVisionPrompt(body.messages, mediaParts, mtmdCtx.defaultMarker);
    if (mediaInOrder.length === 0) {
        sendJson(res, 500, makeError("internal_error", "Vision prompt build dropped all media; no markers in prompt", "server_error"));
        return;
    }

    const fullText = systemPrompt
        ? `<|im_start|>system\n${systemPrompt}<|im_end|>\n${conversationText}`
        : conversationText;

    // Resolve media → local files (data: → tmp; http(s): → download; file://: → path)
    let resolved: ResolvedMedia[] = [];
    let cleanup = async () => {
        await Promise.all(resolved.map((r) => cleanupMedia(r)));
    };
    try {
        resolved = await Promise.all(mediaInOrder.map((m) => resolveMedia(m.url)));
    } catch (err) {
        await cleanup();
        sendJson(res, 400, makeError("media_fetch_failed", (err as Error).message));
        return;
    }

    const mediaInputs: MtmdMediaInput[] = resolved.map((r, i) => ({
        type: "file",
        data: r.filePath
    }));

    const id = `chatcmpl-${nanoid(16)}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;
    const maxTokens = body.max_tokens ?? 512;

    inflightStart();
    try {
        await withLock(session.inferenceLockScope, async () => {
            // Vision pipeline 在 libmtmd 內部對 sequence 的 KV slot 持有 native
            // 引用，clearHistory() 只清 JS 端 _contextTokens / _nextTokenIndex，
            // 對 vision tokens 不夠乾淨 → 第二次 evalChunks 會撞 rc=-1。
            // 解法：用 resetSessionSequence 拿全新 sequence（內含等 reclaim
            // drain，避免 race「No sequences left」）。
            await resetSessionSequence(session);
            const visionSeq = session.sequence;
            try {
            // Tokenize text + media → MtmdChunks
            let chunks;
            try {
                chunks = await mtmdCtx.tokenize({text: fullText, media: mediaInputs});
            } catch (err) {
                if (isContextOverflowError(err)) {
                    incChatError("overflow");
                    sendJson(res, 413, makeContextLengthExceededError({
                        promptTokens: 0,
                        maxTokens: body.max_tokens,
                        ctxSize: session.options.contextSize,
                        underlying: err
                    }));
                    return;
                }
                incChatError("other");
                sendJson(res, 400, makeError("vision_tokenize_failed", (err as Error).message));
                return;
            }

            const promptTokens = chunks.totalTokens;
            if (promptTokens + maxTokens > session.options.contextSize) {
                chunks.dispose();
                incChatError("overflow");
                sendJson(res, 413, makeContextLengthExceededError({
                    promptTokens, maxTokens: body.max_tokens, ctxSize: session.options.contextSize
                }));
                return;
            }

            // evalChunks (vision encoder + llama_decode for text/image tokens)
            let nPast: number;
            try {
                nPast = await mtmdCtx.evalChunks(session.context, chunks, 0, {
                    seqId: ((visionSeq as any)._sequenceId ?? (visionSeq as any).sequenceId ?? 0),
                    nBatch: 512,
                    logitsLast: true
                });
            } catch (err) {
                chunks.dispose();
                if (isContextOverflowError(err)) {
                    incChatError("overflow");
                    sendJson(res, 413, makeContextLengthExceededError({
                        promptTokens, maxTokens: body.max_tokens, ctxSize: session.options.contextSize, underlying: err
                    }));
                    return;
                }
                incChatError("other");
                sendJson(res, 500, makeError("vision_eval_failed", (err as Error).message, "server_error"));
                return;
            }

            // Build sampler from native bindings
            const bindings = (session.model as any)._llama._bindings;
            const sampler = new bindings.AddonSampler((session.model as any)._model);
            sampler.applyConfig({
                temperature: body.temperature ?? 0.7,
                topK: body.top_k ?? 40,
                topP: body.top_p ?? 0.95,
                minP: 0.05,
                ...(body.seed != null ? {seed: body.seed} : {})
            });

            try {
                if (stream) {
                    await runVisionStreaming({
                        req, res, session, visionSeq, sampler, nPast, maxTokens,
                        id, created, model: primaryAlias, promptTokens, body
                    });
                } else {
                    await runVisionNonStreaming({
                        res, session, visionSeq, sampler, nPast, maxTokens,
                        id, created, model: primaryAlias, promptTokens
                    });
                }
            } finally {
                try { sampler.dispose(); } catch { /* */ }
                chunks.dispose();
            }
            } finally {
                // Don't dispose visionSeq — it's now session.sequence; next request reuses or reset
            }
        });
    } finally {
        inflightEnd();
        await cleanup();
    }
}

type VisionRunCtx = {
    session: ServerSession,
    visionSeq: any, // LlamaContextSequence — typed loosely to avoid extra import
    sampler: any,
    nPast: number,
    maxTokens: number,
    id: string,
    created: number,
    model: string,
    promptTokens: number
};

async function runVisionNonStreaming(opts: VisionRunCtx & {res: ServerResponse}): Promise<void> {
    const result = await opts.session.mtmdCtx!.generate(
        opts.session.context, opts.sampler, opts.nPast, opts.maxTokens,
        {seqId: ((opts.visionSeq as any)._sequenceId ?? (opts.visionSeq as any).sequenceId ?? 0)}
    );
    const split = splitReasoning(result.text);
    const completionTokens = result.tokens.length;

    const completion: OpenAIChatCompletion = {
        id: opts.id,
        object: SHIM_OBJECT_NON_STREAM,
        created: opts.created,
        model: opts.model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: split.content,
                reasoning_content: split.reasoning ?? null
            },
            finish_reason: completionTokens >= opts.maxTokens ? "length" : "stop"
        }],
        usage: makeUsage(opts.promptTokens, completionTokens)
    };
    recordChatTokens(opts.promptTokens, completionTokens);
    sendJson(opts.res, 200, completion);
}

async function runVisionStreaming(opts: VisionRunCtx & {req: IncomingMessage, res: ServerResponse, body: OpenAIChatRequest}): Promise<void> {
    const sse = new SseWriter(opts.res);
    const splitter = new StreamReasoningSplitter();
    sse.send(makeChunk(opts.id, opts.created, opts.model, {role: "assistant"}, null));

    let totalRaw = "";
    let completionTokens = 0;
    try {
        const result = await opts.session.mtmdCtx!.generate(
            opts.session.context, opts.sampler, opts.nPast, opts.maxTokens,
            {
                seqId: ((opts.visionSeq as any)._sequenceId ?? (opts.visionSeq as any).sequenceId ?? 0),
                onTextChunk(text: string) {
                    totalRaw += text;
                    const part = splitter.feed(text);
                    if (part.content || part.reasoning) {
                        sse.send(makeChunk(opts.id, opts.created, opts.model, {
                            ...(part.content ? {content: part.content} : {}),
                            ...(part.reasoning ? {reasoning_content: part.reasoning} : {})
                        }, null));
                    }
                }
            }
        );
        completionTokens = result.tokens.length;

        const tail = splitter.flush();
        if (tail.content || tail.reasoning) {
            sse.send(makeChunk(opts.id, opts.created, opts.model, {
                ...(tail.content ? {content: tail.content} : {}),
                ...(tail.reasoning ? {reasoning_content: tail.reasoning} : {})
            }, null));
        }

        const finalChunk = makeChunk(
            opts.id, opts.created, opts.model, {},
            completionTokens >= opts.maxTokens ? "length" : "stop"
        );
        finalChunk.usage = makeUsage(opts.promptTokens, completionTokens);
        recordChatTokens(opts.promptTokens, completionTokens);
        sse.send(finalChunk);
        sse.done();
    } catch (err) {
        incChatError("other");
        sse.error(err);
    }
}

function makeChunk(id: string, created: number, model: string, delta: any, finishReason: string | null): OpenAIChatChunk {
    return {
        id, object: SHIM_OBJECT_STREAM, created, model,
        choices: [{index: 0, delta, finish_reason: finishReason}]
    };
}

/**
 * Build a single text prompt that includes the chat-template framing AND
 * embeds `<__media__>` markers in place of each image_url part. Order of
 * markers must match the order media is passed to mtmdCtx.tokenize.
 *
 * Simplified template: assumes Qwen-style ChatML wrappers. Other model
 * families may need a different framing — left as a TODO when we expand
 * to Llava/Gemma vision.
 */
function buildVisionPrompt(
    messages: OpenAIMessage[],
    mediaParts: MediaInput[],
    marker: string
): {systemPrompt: string, conversationText: string, mediaInOrder: MediaInput[]} {
    const sys: string[] = [];
    const segments: string[] = [];
    const mediaInOrder: MediaInput[] = [];

    for (const m of messages) {
        if (m.role === "system") {
            sys.push(typeof m.content === "string" ? m.content : flattenContent(m.content));
            continue;
        }
        const role = m.role;
        const text = renderMessageWithMarkers(m, marker, mediaInOrder);
        segments.push(`<|im_start|>${role}\n${text}<|im_end|>`);
    }
    // 推理時要在最後留 assistant\n 引導模型開始生成
    segments.push(`<|im_start|>assistant\n`);

    return {
        systemPrompt: sys.join("\n\n"),
        conversationText: segments.join("\n"),
        mediaInOrder
    };
}

function renderMessageWithMarkers(m: OpenAIMessage, marker: string, mediaOut: MediaInput[]): string {
    if (typeof m.content === "string" || m.content == null) return m.content ?? "";
    const parts: string[] = [];
    for (const p of m.content) {
        if (p.type === "text") parts.push(p.text);
        else if (p.type === "image_url") { parts.push(marker); mediaOut.push({type: "image", url: p.image_url.url}); }
        else if (p.type === "input_audio") {
            parts.push(marker);
            const mime = p.input_audio.format === "mp3" ? "audio/mpeg" : `audio/${p.input_audio.format ?? "wav"}`;
            mediaOut.push({type: "audio", url: `data:${mime};base64,${p.input_audio.data}`});
        }
        else if (p.type === "audio_url") { parts.push(marker); mediaOut.push({type: "audio", url: p.audio_url.url}); }
    }
    return parts.join("\n");
}
