import {nanoid} from "nanoid";
import {withLock} from "lifecycle-utils";
import type {IncomingMessage, ServerResponse} from "node:http";
import {LlamaChatSession} from "../evaluator/LlamaChatSession/LlamaChatSession.js";
import type {ChatHistoryItem} from "../types.js";
import {type ServerSession, resetSessionSequence} from "./session.js";
import {SseWriter} from "./streaming.js";
import {OpenAIChatChunk, OpenAIChatRequest, OpenAIChatCompletion, OpenAIMessage} from "./types.js";
import {makeError, isContextOverflowError, makeContextLengthExceededError} from "./errors.js";
import {recordChatTokens, incChatError, inflightStart, inflightEnd} from "./metrics.js";
import {makeUsage} from "./usage.js";
import {toOpenAIFinishReason, ShimStopReason} from "./finishReason.js";
import {splitReasoning, StreamReasoningSplitter} from "./reasoningSplit.js";
import {extractToolCalls, buildToolPromptSuffix} from "./toolCallExtract.js";
import {StreamToolSniffer} from "./streamToolSniffer.js";
import {bundleResponse} from "./segmentExtract.js";
import {
    isQwenModel,
    buildQwenToolsReminder,
    buildQwenToolsSystemBlock,
    renderQwenToolCall,
    renderQwenToolResponse,
    parseQwenToolCalls
} from "./qwenToolFormat.js";
import {flattenContent, extractMediaParts} from "./visionPath.js";
import {handleChatWithVision} from "./visionInference.js";
import {sendJson} from "./httpHelpers.js";

const SHIM_OBJECT_NON_STREAM = "chat.completion" as const;
const SHIM_OBJECT_STREAM = "chat.completion.chunk" as const;

/**
 * Handle POST /v1/chat/completions (and /chat/completions native variant).
 * `nativeWrapper` toggles the response shape — true wraps in llama.cpp's native
 * `{content, stop_reason}` format; false uses OpenAI ChatCompletion.
 */
export async function handleChatCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    body: OpenAIChatRequest,
    session: ServerSession,
    primaryAlias: string
): Promise<void> {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendJson(res, 400, makeError("invalid_request", "messages must be a non-empty array"));
        return;
    }

    const mediaParts = extractMediaParts(body.messages);
    if (mediaParts.length > 0 && session.mtmdCtx == null) {
        sendJson(res, 400, makeError(
            "vision_not_enabled",
            "Request contains image_url/audio parts but the server was started without --mmproj"
        ));
        return;
    }
    if (mediaParts.length > 0) {
        // M-TCQ-SHIM-1-7：路由到 vision inference path（mtmd tokenize/eval/generate）
        return handleChatWithVision(req, res, body, session, primaryAlias);
    }

    const useQwenFormat = isQwenModel(primaryAlias);
    const {systemPrompt, history, lastUserPrompt} = packMessages(body.messages, body.tools ?? [], useQwenFormat);
    if (session.options.debug) {
        console.error(`[TCQ-shim:chat] tool-format=${useQwenFormat ? "qwen-native" : "json-fallback"} alias=${primaryAlias}`);
    }

    // M-TCQ-SHIM-2-6/2-7：先算完整 prompt token 數，做 context-overflow 預檢
    // 並在 usage.prompt_tokens 用到（非 stream 走參數傳入，stream 走 closure）
    const promptTokens = countFullPromptTokens(session, systemPrompt, history, lastUserPrompt);
    const ctxSize = session.options.contextSize;
    const effectiveMax = body.max_tokens ?? 0;
    if (promptTokens + effectiveMax > ctxSize) {
        incChatError("overflow");
        sendJson(res, 413, makeContextLengthExceededError({
            promptTokens, maxTokens: body.max_tokens, ctxSize
        }));
        return;
    }

    const id = `chatcmpl-${nanoid(16)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = primaryAlias;
    const stream = body.stream === true;

    inflightStart();
    try { await withLock(session.inferenceLockScope, async () => {
        // Hard reset：dispose 舊 sequence + 拿新的。純 clearHistory 在 vision
        // 後會留下 libmtmd 的 KV 殘留，導致下個 chat 收到 "Eval has failed"。
        // 一律 dispose+recreate 是最穩的；resetSessionSequence 內含 await
        // reclaim 以避免「No sequences left」race（單 slot context）。
        await resetSessionSequence(session);

        const chatSession = new LlamaChatSession({
            contextSequence: session.sequence,
            ...(systemPrompt ? {systemPrompt} : {}),
            autoDisposeSequence: false
        });
        if (session.options.debug) {
            console.error(`[TCQ-shim:chat] systemPrompt=${systemPrompt.length} hist=${history.length} prompt=${JSON.stringify(lastUserPrompt).slice(0, 100)}`);
        }

        if (history.length > 0) {
            chatSession.setChatHistory(history);
        }

        if (stream) {
            await runStreaming({
                req, res, body, chatSession, lastUserPrompt,
                systemPrompt, history, session, useQwenFormat,
                id, created, model, declaredTools: body.tools ?? [],
                promptTokens
            });
        } else {
            await runNonStreaming({
                res, body, chatSession, lastUserPrompt,
                systemPrompt, history, session, useQwenFormat,
                id, created, model, declaredTools: body.tools ?? [],
                promptTokens
            });
        }
    }); } finally { inflightEnd(); }
}

type RunCtx = {
    body: OpenAIChatRequest,
    chatSession: LlamaChatSession,
    lastUserPrompt: string,
    systemPrompt: string,
    history: ChatHistoryItem[],
    session: ServerSession,
    useQwenFormat: boolean,
    id: string,
    created: number,
    model: string,
    declaredTools: NonNullable<OpenAIChatRequest["tools"]>,
    /** Pre-computed full prompt token count (system + history + last + tools) */
    promptTokens: number
};

function extractToolCallsForFormat(
    text: string,
    declaredTools: OpenAIChatRequest["tools"],
    useQwenFormat: boolean
): {content: string, toolCalls: ReturnType<typeof extractToolCalls>["toolCalls"]} {
    if (useQwenFormat) {
        return parseQwenToolCalls(text, declaredTools ?? []);
    }
    return extractToolCalls(text, declaredTools ?? []);
}

function countTokens(session: ServerSession, text: string | undefined): number {
    if (text == null || text.length === 0) return 0;
    try { return session.model.tokenize(text).length; }
    catch { return 0; }
}

/**
 * Sum tokens across every prompt component the model will see:
 * system + each history turn (rendered) + last user/tool turn.
 * Chat-template overhead (special tokens, role markers) is approximated by a
 * small per-turn fudge factor — enough for usage.prompt_tokens to align with
 * OpenAI semantics ("everything sent in"), not just the last user message.
 *
 * (M-TCQ-SHIM-2-7) — pre-fix this only counted lastUserPrompt, which under-
 * reported by 2–10× on multi-turn / tool-heavy requests.
 */
function countFullPromptTokens(
    session: ServerSession,
    systemPrompt: string,
    history: ChatHistoryItem[],
    lastUserPrompt: string
): number {
    let total = 0;
    if (systemPrompt) total += countTokens(session, systemPrompt) + 4;
    for (const item of history) {
        if (item.type === "user") total += countTokens(session, item.text) + 4;
        else if (item.type === "model") {
            for (const piece of item.response) {
                if (typeof piece === "string") total += countTokens(session, piece) + 4;
            }
        }
    }
    total += countTokens(session, lastUserPrompt) + 4;
    return total;
}

/** Strip the responsePrefix we injected (e.g. "</think>\n\n") from start of model output, if present. */
function stripResponsePrefix(text: string, prefix: string | undefined): string {
    if (prefix == null || prefix === "" || text == null) return text;
    if (text.startsWith(prefix)) return text.slice(prefix.length);
    // Sometimes the model echoes a slightly different leading whitespace pattern.
    const trimmedPrefix = prefix.trimEnd();
    if (text.startsWith(trimmedPrefix)) return text.slice(trimmedPrefix.length).replace(/^\s+/, "");
    return text;
}

/**
 * Resolved reasoning behavior for one request.
 *
 * - off: skip CoT entirely (responsePrefix `</think>\n\n` inserted)
 * - thoughtTokens: engine-level hard cap on think tokens
 * - reasoningFormat: how `<think>` appears in the response payload
 * - budgetMessage: text to append when post-gen we detect budget exhausted
 *                  with no visible answer (T3 behavior remediation)
 * - explicitBudget: true if caller (or server) gave a non-default budget;
 *                   used to decide whether to apply auto-cap heuristic
 */
type ResolvedReasoning = {
    responsePrefix?: string,
    thoughtTokens?: number,
    reasoningFormat: "none" | "deepseek" | "deepseek-legacy",
    budgetMessage?: string,
    explicitBudget: boolean
};

/**
 * Precedence (per-request > server > sensible defaults):
 * - body.chat_template_kwargs.enable_thinking: false → off
 * - body.reasoning_effort: low|medium|high → thoughtTokens 256/1024/4096
 * - body.reasoning_budget (number) → explicit thoughtTokens cap
 * - body.reasoning_budget_message (string) → budgetMessage override
 * - body.reasoning_format → "none"|"deepseek"|"deepseek-legacy"
 * - server --reasoning off → forces responsePrefix
 * - server --reasoning-budget N (>=0) → server default cap
 * - server --reasoning-budget-message → server default budget message
 * - server --reasoning-format → server default format (deepseek if unset)
 *
 * **Auto-cap heuristic** (M-TCQ-SHIM-2 reasoning 控制深化):
 *   If reasoning is on/auto AND no explicit budget given AND request max_tokens
 *   is small (<= 16384), cap thoughtTokens at floor(max_tokens × 0.6) so the
 *   model leaves room for a visible answer. Reproduces T3 fix without changing
 *   default behavior for callers who set max_tokens generously.
 */
function resolveReasoning(session: ServerSession, body: OpenAIChatRequest): ResolvedReasoning {
    const serverMode = session.options.reasoning ?? "auto";
    const serverBudget = session.options.reasoningBudget;
    const serverBudgetMessage = session.options.reasoningBudgetMessage;
    const serverFormat = session.options.reasoningFormat ?? "deepseek";

    const ctk = (body as any).chat_template_kwargs;
    const perReqOff = ctk != null && typeof ctk === "object" && ctk.enable_thinking === false;

    const effort = body.reasoning_effort;
    let perReqBudget: number | undefined;
    if (effort === "low") perReqBudget = 256;
    else if (effort === "medium") perReqBudget = 1024;
    else if (effort === "high") perReqBudget = 4096;

    const explicitPerReqBudget = (body as any).reasoning_budget;
    if (typeof explicitPerReqBudget === "number" && explicitPerReqBudget >= 0) {
        perReqBudget = explicitPerReqBudget;
    }

    const reasoningFormat = ((body as any).reasoning_format ?? serverFormat) as ResolvedReasoning["reasoningFormat"];
    const budgetMessage = (body as any).reasoning_budget_message ?? serverBudgetMessage;

    if (perReqOff || serverMode === "off") {
        return {
            responsePrefix: "</think>\n\n",
            thoughtTokens: 0,
            reasoningFormat,
            budgetMessage,
            explicitBudget: true
        };
    }

    let thoughtTokens: number | undefined;
    let explicitBudget = false;
    if (perReqBudget != null) {
        thoughtTokens = perReqBudget;
        explicitBudget = true;
    } else if (typeof serverBudget === "number" && serverBudget >= 0) {
        thoughtTokens = serverBudget;
        explicitBudget = true;
    }

    // Auto-cap when no explicit budget AND max_tokens is small
    if (!explicitBudget && typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens <= 16384) {
        thoughtTokens = Math.floor(body.max_tokens * 0.6);
    }

    return {responsePrefix: undefined, thoughtTokens, reasoningFormat, budgetMessage, explicitBudget};
}

/**
 * Apply the configured `reasoning_format` to a raw response text (used when the
 * chat wrapper didn't expose thought segments — fallback to inline <think> regex).
 */
function formatReasoning(
    rawText: string,
    format: ResolvedReasoning["reasoningFormat"]
): {content: string, reasoning: string | null} {
    if (format === "none") {
        return {content: rawText, reasoning: null};
    }
    const split = splitReasoning(rawText);
    if (format === "deepseek-legacy") {
        const legacyContent = split.reasoning != null
            ? `<think>${split.reasoning}</think>${split.content ? "\n\n" + split.content : ""}`
            : split.content;
        return {content: legacyContent, reasoning: split.reasoning};
    }
    return {content: split.content, reasoning: split.reasoning};
}

/**
 * Like formatReasoning, but for the case where the chat wrapper already split
 * thought from visible (no need to regex parse). Just assemble per format.
 */
function assembleFormattedFromSegments(
    visibleText: string,
    reasoningText: string,
    format: ResolvedReasoning["reasoningFormat"]
): {content: string, reasoning: string | null} {
    const reasoning = reasoningText.length > 0 ? reasoningText : null;
    if (format === "none") {
        const content = reasoning != null
            ? `<think>${reasoning}</think>\n\n${visibleText}`
            : visibleText;
        return {content, reasoning: null};
    }
    if (format === "deepseek-legacy") {
        const content = reasoning != null
            ? `<think>${reasoning}</think>${visibleText ? "\n\n" + visibleText : ""}`
            : visibleText;
        return {content, reasoning};
    }
    return {content: visibleText, reasoning};
}

/**
 * Detect "ran out of tokens before producing a clean answer" — typical T3 case
 * where Qwen3.5 thinking models fill the entire `max_tokens` budget exploring
 * the problem and never close `</think>` to emit a visible final answer.
 *
 * **Why we can't rely on `<think>` detection alone**: node-llama-tcq's
 * Qwen chat wrapper post-processes responseText and may strip `<think>` tags
 * even when the model never emitted `</think>` (truncated mid-think). We end
 * up with a long content dump that *looks* like normal output but is actually
 * unfinished reasoning.
 *
 * **Trigger conditions (any of)**:
 *   - stopReason=maxTokens AND visible content is empty/whitespace → classic
 *     "wrapper stripped everything" case
 *   - stopReason=maxTokens AND no closing punctuation in last 40 chars
 *     (heuristic: model was probably mid-sentence when cut)
 *
 * Caller can disable by leaving `--reasoning-budget-message` unset.
 */
function maybeApplyBudgetExhaustionMessage(
    visibleContent: string,
    stopReason: ShimStopReason,
    resolved: ResolvedReasoning,
    thoughtTruncated: boolean = false
): string {
    if (resolved.budgetMessage == null || resolved.budgetMessage === "") return visibleContent;

    // Strong signal from chat wrapper: thought segment was open at end → model
    // ran out of budget mid-think regardless of stopReason value.
    if (thoughtTruncated) {
        if (visibleContent.trim().length === 0) return resolved.budgetMessage;
        return `${visibleContent}\n\n${resolved.budgetMessage}`;
    }

    if (stopReason !== "maxTokens") return visibleContent;

    const trimmed = visibleContent.trim();
    if (trimmed.length === 0) return resolved.budgetMessage;

    // Heuristic: trailing 40 chars don't end with sentence-final punctuation → mid-cut
    const tail = trimmed.slice(-40);
    const endsCleanly = /[.!?。！？]\s*[)\]"'’”]?\s*$/.test(tail);
    if (endsCleanly) return visibleContent;
    return `${visibleContent}\n\n${resolved.budgetMessage}`;
}

async function runNonStreaming(opts: RunCtx & {res: ServerResponse}): Promise<void> {
    const {res, body, chatSession, lastUserPrompt, id, created, model, declaredTools} = opts;
    const reasoning = resolveReasoning(opts.session, body);

    let stopReason: ShimStopReason = undefined;
    let meta: Awaited<ReturnType<typeof chatSession.promptWithMeta>>;
    try {
        meta = await chatSession.promptWithMeta(lastUserPrompt, {
            maxTokens: body.max_tokens,
            temperature: body.temperature,
            topP: body.top_p,
            topK: body.top_k,
            seed: body.seed,
            customStopTriggers: normalizeStop(body.stop),
            ...(reasoning.responsePrefix ? {responsePrefix: reasoning.responsePrefix} : {}),
            ...(reasoning.thoughtTokens != null ? {budgets: {thoughtTokens: reasoning.thoughtTokens}} : {})
        });
    } catch (err) {
        // Fallback when our preflight token estimate underestimated due to
        // chat-template overhead and the engine still couldn't compress history.
        if (isContextOverflowError(err)) {
            sendJson(res, 413, makeContextLengthExceededError({
                promptTokens: opts.promptTokens,
                maxTokens: body.max_tokens,
                ctxSize: opts.session.options.contextSize,
                underlying: err
            }));
            return;
        }
        throw err;
    }
    stopReason = mapStopReason((meta as any).stopReason);

    // Use the chat wrapper's segmented response (knows Qwen3.5 thought / Gemma /
    // Llama3 etc.) instead of regex-splitting responseText. Falls back to text
    // split when wrapper didn't segment.
    const bundle = bundleResponse(meta.response);
    const rawVisibleText = stripResponsePrefix(bundle.visibleText, reasoning.responsePrefix);
    const rawReasoningText = bundle.reasoningText;

    // For non-Qwen models that emit `<think>` inline (no segments), splitter still helps.
    const haveSegments = bundle.thoughtSegments > 0;
    const formatted = haveSegments
        ? assembleFormattedFromSegments(rawVisibleText, rawReasoningText, reasoning.reasoningFormat)
        : formatReasoning(rawVisibleText, reasoning.reasoningFormat);

    const {content: extractedContent, toolCalls} = extractToolCallsForFormat(
        formatted.content, declaredTools, opts.useQwenFormat
    );
    const visibleContent = maybeApplyBudgetExhaustionMessage(
        extractedContent,
        stopReason,
        reasoning,
        bundle.thoughtTruncated
    );
    const promptTokens = opts.promptTokens;
    const completionTokens = countTokens(opts.session, rawVisibleText + rawReasoningText);
    if (opts.session.options.debug) {
        console.error(`[TCQ-shim:chat] segments=${bundle.thoughtSegments} thoughtTrunc=${bundle.thoughtTruncated} visLen=${rawVisibleText.length} reaLen=${rawReasoningText.length}`);
    }
    if (opts.session.options.debug) {
        console.error(`[TCQ-shim:chat] respLen=${meta.responseText?.length ?? 0} stopReason=${(meta as any).stopReason} pTok=${promptTokens} cTok=${completionTokens}`);
    }

    const completion: OpenAIChatCompletion = {
        id,
        object: SHIM_OBJECT_NON_STREAM,
        created,
        model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: toolCalls.length > 0 ? null : visibleContent,
                reasoning_content: formatted.reasoning ?? null,
                ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {})
            },
            finish_reason: toOpenAIFinishReason(stopReason, toolCalls.length > 0)
        }],
        usage: makeUsage(promptTokens, completionTokens)
    };

    recordChatTokens(promptTokens, completionTokens);
    sendJson(res, 200, completion);
}

async function runStreaming(opts: RunCtx & {req: IncomingMessage, res: ServerResponse}): Promise<void> {
    const {req, res, body, chatSession, lastUserPrompt, session, id, created, model, declaredTools} = opts;
    const sse = new SseWriter(res);
    const splitter = new StreamReasoningSplitter();
    const sniffer = new StreamToolSniffer(declaredTools);
    const reasoning = resolveReasoning(session, body);
    let totalRaw = "";
    let visibleContentEmitted = "";  // accumulated `delta.content` characters (for budget-msg detection)
    // reasoning_format=none → don't split <think> out of content stream
    // deepseek (default) and deepseek-legacy both route reasoning through splitter
    // (legacy mode's "keep <think> in content" flavor only applies to non-streaming JSON;
    //  documented limitation for now).
    const useReasoningSplitter = reasoning.reasoningFormat !== "none";

    // Initial role chunk (OpenAI convention)
    sse.send(makeChunk(id, created, model, {role: "assistant"}, null));

    const abort = new AbortController();
    req.on("close", () => abort.abort());

    let prefixToStrip = reasoning.responsePrefix ?? "";
    try {
        const meta = await chatSession.promptWithMeta(lastUserPrompt, {
            maxTokens: body.max_tokens,
            temperature: body.temperature,
            topP: body.top_p,
            topK: body.top_k,
            seed: body.seed,
            customStopTriggers: normalizeStop(body.stop),
            signal: abort.signal,
            stopOnAbortSignal: true,
            ...(reasoning.responsePrefix ? {responsePrefix: reasoning.responsePrefix} : {}),
            ...(reasoning.thoughtTokens != null ? {budgets: {thoughtTokens: reasoning.thoughtTokens}} : {}),
            onTextChunk(rawText: string) {
                let text = rawText;
                // Strip injected responsePrefix from the head of the stream
                if (prefixToStrip.length > 0) {
                    if (text.startsWith(prefixToStrip)) {
                        text = text.slice(prefixToStrip.length);
                        prefixToStrip = "";
                    } else if (prefixToStrip.startsWith(text)) {
                        prefixToStrip = prefixToStrip.slice(text.length);
                        return; // entire chunk consumed by prefix
                    } else {
                        // No clean alignment — give up stripping.
                        prefixToStrip = "";
                    }
                }
                totalRaw += text;
                const visible = sniffer.feed(text);
                if (visible.length === 0) return;
                if (!useReasoningSplitter) {
                    // format=none: emit as content directly
                    visibleContentEmitted += visible;
                    sse.send(makeChunk(id, created, model, {content: visible}, null));
                    return;
                }
                const part = splitter.feed(visible);
                if (part.content) visibleContentEmitted += part.content;
                if (part.content || part.reasoning) {
                    sse.send(makeChunk(id, created, model, {
                        ...(part.content ? {content: part.content} : {}),
                        ...(part.reasoning ? {reasoning_content: part.reasoning} : {})
                    }, null));
                }
            }
        });

        // Flush sniffer head if undecided / decided text
        const sniffTail = sniffer.flush();
        if (sniffTail.length > 0) {
            if (!useReasoningSplitter) {
                visibleContentEmitted += sniffTail;
                sse.send(makeChunk(id, created, model, {content: sniffTail}, null));
            } else {
                const part = splitter.feed(sniffTail);
                if (part.content) visibleContentEmitted += part.content;
                if (part.content || part.reasoning) {
                    sse.send(makeChunk(id, created, model, {
                        ...(part.content ? {content: part.content} : {}),
                        ...(part.reasoning ? {reasoning_content: part.reasoning} : {})
                    }, null));
                }
            }
        }

        if (useReasoningSplitter) {
            const tail = splitter.flush();
            if (tail.content) visibleContentEmitted += tail.content;
            if (tail.content || tail.reasoning) {
                sse.send(makeChunk(id, created, model, {
                    ...(tail.content ? {content: tail.content} : {}),
                    ...(tail.reasoning ? {reasoning_content: tail.reasoning} : {})
                }, null));
            }
        }

        // Budget exhausted? Emit fallback content message before final chunk.
        const stopReasonForBudget = mapStopReason((meta as any).stopReason);
        const budgetMsg = maybeApplyBudgetExhaustionMessage("", stopReasonForBudget, reasoning);
        if (visibleContentEmitted.trim().length === 0 && budgetMsg.length > 0) {
            sse.send(makeChunk(id, created, model, {content: budgetMsg}, null));
        }

        // Tool extraction is whole-text only in Phase 1 — emit as single chunk after stream.
        const fullSplit = splitReasoning(totalRaw);
        const {toolCalls} = extractToolCallsForFormat(fullSplit.content, declaredTools, opts.useQwenFormat);
        if (toolCalls.length > 0) {
            for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i]!;
                sse.send(makeChunk(id, created, model, {
                    tool_calls: [{
                        index: i,
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.function.name,
                            arguments: tc.function.arguments
                        }
                    }]
                }, null));
            }
        }

        const stopReason = mapStopReason((meta as any).stopReason);
        const completionTokens = countTokens(session, totalRaw);
        const finalChunk = makeChunk(id, created, model, {}, toOpenAIFinishReason(stopReason, toolCalls.length > 0));
        finalChunk.usage = makeUsage(opts.promptTokens, completionTokens);
        recordChatTokens(opts.promptTokens, completionTokens);
        sse.send(finalChunk);
        sse.done();
    } catch (err) {
        if (isContextOverflowError(err)) {
            incChatError("overflow");
            // SSE already opened with HTTP 200 — best we can do is emit a
            // structured error event that mirrors the 413 JSON body.
            sse.error(new Error(makeContextLengthExceededError({
                promptTokens: opts.promptTokens,
                maxTokens: body.max_tokens,
                ctxSize: session.options.contextSize,
                underlying: err
            }).error.message));
            return;
        }
        incChatError("other");
        sse.error(err);
    }
}

function makeChunk(
    id: string,
    created: number,
    model: string,
    delta: OpenAIChatChunk["choices"][number]["delta"],
    finishReason: string | null
): OpenAIChatChunk {
    return {
        id,
        object: SHIM_OBJECT_STREAM,
        created,
        model,
        choices: [{index: 0, delta, finish_reason: finishReason}]
    };
}

function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
    if (stop == null) return undefined;
    return Array.isArray(stop) ? stop : [stop];
}

function mapStopReason(raw: unknown): ShimStopReason {
    if (typeof raw !== "string") return undefined;
    if (raw === "maxTokens" || raw === "abort" || raw === "eosToken" || raw === "stopGenerationTrigger") return raw;
    return undefined;
}

/**
 * Convert OpenAI message array into:
 *   - systemPrompt: concatenated system messages (+ tool prompt suffix)
 *   - history: ChatHistoryItem[] for messages between system and the last user turn
 *   - lastUserPrompt: the trailing user message text
 *
 * Tool/assistant messages with tool_calls are flattened to text since the underlying
 * chat wrapper does not natively model OpenAI tool call turns yet (Phase 2 task).
 */
function packMessages(messages: OpenAIMessage[], tools: OpenAIChatRequest["tools"], useQwenFormat: boolean): {
    systemPrompt: string,
    history: ChatHistoryItem[],
    lastUserPrompt: string
} {
    const systemParts: string[] = [];
    const middle: ChatHistoryItem[] = [];
    let lastUser = "";

    // Find the last user (or tool) message — that becomes the active prompt.
    // Qwen template requires last turn be user-shaped; if final is `tool` we'll
    // also treat it as the active prompt by wrapping in <tool_response>.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const r = messages[i]!.role;
        if (r === "user" || r === "tool") { lastUserIdx = i; break; }
    }

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        const text = flattenContent(m.content);
        if (m.role === "system") {
            systemParts.push(text);
        } else if (i === lastUserIdx) {
            // Final turn drives the generation prompt
            if (m.role === "tool" && useQwenFormat) {
                lastUser = renderQwenToolResponse(text);
            } else if (m.role === "tool") {
                lastUser = `[tool_result id=${m.tool_call_id ?? ""}] ${text}`;
            } else {
                lastUser = text;
            }
        } else if (m.role === "user") {
            middle.push({type: "user", text});
        } else if (m.role === "assistant") {
            const tcRendered = (m.tool_calls ?? []).map((tc) =>
                useQwenFormat
                    ? renderQwenToolCall(tc)
                    : `[tool_call name=${tc.function.name} args=${tc.function.arguments}]`
            ).join("\n");
            const combined = [text, tcRendered].filter(Boolean).join("\n");
            middle.push({type: "model", response: combined === "" ? [] : [combined]});
        } else if (m.role === "tool") {
            const wrapped = useQwenFormat
                ? renderQwenToolResponse(text)
                : `[tool_result id=${m.tool_call_id ?? ""}] ${text}`;
            middle.push({type: "user", text: wrapped});
        }
    }

    if (tools && tools.length > 0) {
        systemParts.push(useQwenFormat ? buildQwenToolsSystemBlock(tools) : buildToolPromptSuffix(tools));
    }

    // Mitigation：history 含 tool message 且 tools 已宣告 + 走 Qwen 格式時，於 lastUser
    // 尾端 append schema reminder。緩解 Q4 量化 attention recency bias —— 細節見
    // qwenToolFormat.buildQwenToolsReminder 註解。觸發條件刻意寬：只要曾經出現 tool
    // turn，模型下一輪就可能受最近 tool_response keys 干擾，跟 lastUserIdx 是 user 還
    // 是 tool 都有關。
    if (useQwenFormat && tools && tools.length > 0) {
        const hasTool = messages.some((m) => m.role === "tool");
        if (hasTool && lastUser) {
            lastUser = `${lastUser}\n\n${buildQwenToolsReminder(tools)}`;
        }
    }

    return {
        systemPrompt: systemParts.filter(Boolean).join("\n\n"),
        history: middle,
        lastUserPrompt: lastUser
    };
}
