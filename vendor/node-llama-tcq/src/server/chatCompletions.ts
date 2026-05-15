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
    parseQwenToolCalls,
    buildQwenToolChoicePrefix
} from "./qwenToolFormat.js";
import {flattenContent, extractMediaParts} from "./visionPath.js";
import {handleChatWithVision} from "./visionInference.js";
import {sendJson} from "./httpHelpers.js";
import {buildRepeatPenalty} from "./samplerCoalesce.js";

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

    // Single shared abort controller for the whole request lifecycle.
    // Triggered by client TCP close（瀏覽器/curl/fetch abort）— 跟著傳到
    // promptWithMeta 的 signal，下層 LlamaChatSession 會 stopOnAbortSignal
    // 中止 generation，立刻釋放 inferenceLockScope，避免後續 request hang。
    // pre-fix bug：runNonStreaming 完全沒接 signal，runStreaming 也只在
    // 函式內局部建（取到 lock 之後才綁），都在 client 已斷時無效。
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    res.on("close", () => abort.abort());

    // (B) Server-side wall-clock safety timeout — 兜底防呆，cover「fetch
    // AbortController 客戶端 abort 但 TCP 沒關」的情況（Bun fetch / undici
    // 不一定發 FIN/RST，server 永遠看不到 close）。env 可調，預設 5 分鐘。
    const serverTimeoutMs = Number(process.env.TCQ_SERVER_REQUEST_TIMEOUT_MS) || 300_000;
    const serverTimer = setTimeout(() => {
        if (!abort.signal.aborted) {
            // biome-ignore lint/suspicious/noConsole: loud warn for diagnostic
            console.warn(`[TCQ-shim] request id=${id} exceeded ${serverTimeoutMs}ms wall-clock — forcing abort`);
            abort.abort();
        }
    }, serverTimeoutMs);

    inflightStart();
    try { await withLock(session.inferenceLockScope, async () => {
        // 取到 lock 後若 client 已斷就直接 return，不浪費 prefill。
        if (abort.signal.aborted) return;

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
                promptTokens, abort
            });
        } else {
            await runNonStreaming({
                res, body, chatSession, lastUserPrompt,
                systemPrompt, history, session, useQwenFormat,
                id, created, model, declaredTools: body.tools ?? [],
                promptTokens, abort
            });
        }
    }); } finally { clearTimeout(serverTimer); inflightEnd(); }
}

export type RunCtx = {
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
    promptTokens: number,
    /** Shared abort controller — handler 進入點建一次，cover 整個 request lifecycle。
     *  傳 controller 而非僅 signal 是為了讓 keepalive ping 失敗時能主動 abort()。 */
    abort: AbortController
};

export function extractToolCallsForFormat(
    text: string,
    declaredTools: OpenAIChatRequest["tools"],
    useQwenFormat: boolean
): {content: string, toolCalls: ReturnType<typeof extractToolCalls>["toolCalls"], leak?: import("./qwenToolFormat.js").ToolCallLeakReport | null} {
    if (useQwenFormat) {
        const r = parseQwenToolCalls(text, declaredTools ?? []);
        if (r.leak != null) warnToolCallLeak(r.leak, r.toolCalls.length);
        return {content: r.content, toolCalls: r.toolCalls, leak: r.leak};
    }
    return extractToolCalls(text, declaredTools ?? []);
}

/**
 * B3：把 tool-format XML 漏出印到 stderr。env `QWEN_TOOL_LEAK_WARN=0` 可關。
 * 每隔 1 秒最多印一次（同 process 的 burst 漏出避免洗版），但 stats 會累計。
 */
let lastLeakWarnAt = 0;
const leakStats: Record<string, number> = {};
function warnToolCallLeak(leak: import("./qwenToolFormat.js").ToolCallLeakReport, recoveredCalls: number): void {
    if (process.env.QWEN_TOOL_LEAK_WARN === "0") return;
    for (const m of leak.markers) leakStats[m] = (leakStats[m] ?? 0) + 1;
    const now = Date.now();
    if (now - lastLeakWarnAt < 1000) return;
    lastLeakWarnAt = now;
    const markers = leak.markers.join(",");
    const stats = Object.entries(leakStats).map(([k, v]) => `${k}=${v}`).join(" ");
    console.warn(`[qwen-tool-leak] markers=[${markers}] recovered=${recoveredCalls} contentLen=${leak.contentLength} stats=[${stats}]\n  snippet: ${leak.snippet.replace(/\n/g, "\\n")}`);
}

export function countTokens(session: ServerSession, text: string | undefined): number {
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
export function countFullPromptTokens(
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

/**
 * M-TCQ-SHIM-FIXUP-1：把 reasoning 前綴與 Qwen tool_choice 強制前綴組合成一個 engine
 * responsePrefix，但只剝離 reasoning 的部分（tool_choice 前綴必須留在輸出裡，
 * parseQwenToolCalls 才看得到 `<tool_call>...</tool_call>` 完整 block）。
 *
 * 限縮：tool_choice 前綴只在 useQwenFormat=true 時才產生；非 Qwen 路徑（JSON-fallback）
 * 完全不受影響。
 */
export function composeResponsePrefix(
    reasoning: ResolvedReasoning,
    body: OpenAIChatRequest,
    useQwenFormat: boolean,
    declaredTools: NonNullable<OpenAIChatRequest["tools"]>
): {engineResponsePrefix: string | undefined, stripPrefix: string | undefined} {
    const reasoningPrefix = reasoning.responsePrefix ?? "";    // 剝離（off mode 的 </think>\n\n）
    const toolPrefix = (useQwenFormat && declaredTools.length > 0)
        ? (buildQwenToolChoicePrefix((body as any).tool_choice) ?? "")
        : "";

    // M-TCQ-SHIM-FIXUP-5：限縮 useQwenFormat 才注入 `<think>\n`；非 Qwen 路徑（OpenAI-compat
    // JSON-fallback）不動。reasoning=off 時 reasoningPrefix=`</think>\n\n` 已主導，跳過
    // think open。tool_choice=required/named 時 toolPrefix 已強制，跳過 think open（避免
    // 模型在 `<think>\n<tool_call>` 的奇怪複合 prefix 下混亂；強制 tool 場景用戶已選擇放棄
    // thinking）。
    const thinkOpenPrefix = (
        useQwenFormat
        && reasoning.thinkOpenPrefix != null
        && reasoningPrefix === ""
        && toolPrefix === ""
    ) ? reasoning.thinkOpenPrefix : "";

    if (reasoningPrefix === "" && toolPrefix === "" && thinkOpenPrefix === "") {
        return {engineResponsePrefix: undefined, stripPrefix: undefined};
    }
    return {
        // 順序：reasoningPrefix（off 用）+ thinkOpenPrefix（on 用）+ toolPrefix（強制 tool）。
        // off + tool = 跳 thinking 直接強制 tool；on + 沒 tool = 開 thinking；on + 有 tool = 跳 thinking 強制 tool。
        engineResponsePrefix: reasoningPrefix + thinkOpenPrefix + toolPrefix,
        // 只剝 reasoningPrefix（off mode）；thinkOpenPrefix 留給 splitter；toolPrefix 留給 parseQwenToolCalls。
        stripPrefix: reasoningPrefix === "" ? undefined : reasoningPrefix
    };
}

/** Strip the responsePrefix we injected (e.g. "</think>\n\n") from start of model output, if present. */
export function stripResponsePrefix(text: string, prefix: string | undefined): string {
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
    /**
     * M-TCQ-SHIM-FIXUP-5：reasoning="on"/"auto" 模式下的 thinking 啟動旗標。
     *
     * 為什麼需要：QwenChatWrapper 把 `<think>` 設為 SpecialTokensText —— 模型 emit 的是
     * special token id 而非字面字串，wrapper detokenize 後字面 `<think>` 從 stream 中消失。
     * `onTextChunk` 只給 main response 段，thoughts 整個被 wrapper 收進 segment、不流到
     * streaming 路徑。對比 buun-llama-cpp 走 GGUF jinja template，`<think>` 是字面 token
     * 直接在 stream 裡 emit，server 端解析後寫進 `delta.reasoning_content`，my-agent
     * adapter 才接得到。
     *
     * 修法：useQwenFormat 路徑下，reasoning=on/auto 時把字面 `<think>\n` 注入為
     * responsePrefix（用 string 介面 → wrapper 把它當「字面文字」放進 main response，
     * 模型接著用字面文字繼續寫 thinking、最後 emit 字面 `</think>` 收尾）。stream 中
     * 字面 `<think>...</think>` 出現後，現有 `StreamReasoningSplitter` 就能切到
     * reasoning_content，行為與 buun 一致。
     */
    thinkOpenPrefix?: string,
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
export function resolveReasoning(session: ServerSession, body: OpenAIChatRequest): ResolvedReasoning {
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

    // M-TCQ-SHIM-FIXUP-5：reasoning=on/auto 路徑回 thinkOpenPrefix=`<think>\n`。
    // composeResponsePrefix 會在 useQwenFormat 路徑下把它疊進 engine responsePrefix
    // 但**不剝離**，讓 StreamReasoningSplitter 看到字面 `<think>` 後切到 reasoning_content。
    return {
        responsePrefix: undefined,
        thinkOpenPrefix: "<think>\n",
        thoughtTokens,
        reasoningFormat,
        budgetMessage,
        explicitBudget
    };
}

/**
 * Apply the configured `reasoning_format` to a raw response text (used when the
 * chat wrapper didn't expose thought segments — fallback to inline <think> regex).
 */
export function formatReasoning(
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
export function assembleFormattedFromSegments(
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
export function maybeApplyBudgetExhaustionMessage(
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

/**
 * Pure-logic core of non-streaming chat completion — runs the actual prompt +
 * parses tool_calls + builds OpenAI ChatCompletion **without** writing to any
 * HTTP response. HTTP handler (runNonStreaming) and embedded adapter（in-process
 * mascot 端 import this directly）共用同一條路徑。
 *
 * 回傳的 discriminated union 讓 caller 決定怎麼處理：
 *  - 'completion'：正常產出 → HTTP 200 / Anthropic translate
 *  - 'aborted'：client/呼叫端 abort → HTTP 靜默 return / 上層判斷
 *  - 'contextOverflow'：preflight 沒抓到的 ctx overflow → HTTP 413 / 上層 raise
 *
 * 注意：throw 出去的 unknown error（既不是 abort 也不是 overflow）保持原樣
 * propagate，由 caller 包 try/catch。
 */
export async function runChatCompletionCoreNonStreaming(
    opts: RunCtx
): Promise<
    | {type: "completion"; completion: OpenAIChatCompletion}
    | {type: "aborted"}
    | {type: "contextOverflow"; underlying: unknown}
> {
    const {body, chatSession, lastUserPrompt, id, created, model, declaredTools, abort} = opts;
    const abortSignal = abort.signal;
    const reasoning = resolveReasoning(opts.session, body);
    const {engineResponsePrefix, stripPrefix} = composeResponsePrefix(reasoning, body, opts.useQwenFormat, declaredTools);

    let stopReason: ShimStopReason = undefined;
    let meta: Awaited<ReturnType<typeof chatSession.promptWithMeta>>;
    try {
        const sd = opts.session.options.samplerDefaults;
        const repeatPenaltyOpts = buildRepeatPenalty(body, sd);
        meta = await chatSession.promptWithMeta(lastUserPrompt, {
            maxTokens: body.max_tokens,
            temperature: body.temperature ?? sd?.temperature,
            topP: body.top_p ?? sd?.topP,
            topK: body.top_k ?? sd?.topK,
            minP: body.min_p ?? sd?.minP,
            seed: body.seed,
            ...(repeatPenaltyOpts ? {repeatPenalty: repeatPenaltyOpts} : {}),
            customStopTriggers: normalizeStop(body.stop),
            signal: abortSignal,
            stopOnAbortSignal: true,
            ...(engineResponsePrefix ? {responsePrefix: engineResponsePrefix} : {}),
            ...(reasoning.thoughtTokens != null ? {budgets: {thoughtTokens: reasoning.thoughtTokens}} : {})
        });
    } catch (err) {
        if (abortSignal.aborted) return {type: "aborted"};
        if (isContextOverflowError(err)) return {type: "contextOverflow", underlying: err};
        throw err;
    }
    if (abortSignal.aborted) return {type: "aborted"};
    stopReason = mapStopReason((meta as any).stopReason);

    const bundle = bundleResponse(meta.response);
    const rawVisibleText = stripResponsePrefix(bundle.visibleText, stripPrefix);
    const rawReasoningText = bundle.reasoningText;

    const haveSegments = bundle.thoughtSegments > 0;
    const formatted = haveSegments
        ? assembleFormattedFromSegments(rawVisibleText, rawReasoningText, reasoning.reasoningFormat)
        : formatReasoning(rawVisibleText, reasoning.reasoningFormat);

    const {content: extractedContent, toolCalls, leak} = extractToolCallsForFormat(
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
        usage: makeUsage(promptTokens, completionTokens),
        ...(leak != null ? {_qwen_tool_leak: {markers: leak.markers, recovered: toolCalls.length, contentLength: leak.contentLength, snippet: leak.snippet}} : {})
    };

    recordChatTokens(promptTokens, completionTokens);
    return {type: "completion", completion};
}

/**
 * HTTP wrapper：呼叫 core function 把結果寫進 ServerResponse。維持與舊版完全
 * 一樣的對外行為（200 / 413 / 靜默 abort）。
 */
async function runNonStreaming(opts: RunCtx & {res: ServerResponse}): Promise<void> {
    const result = await runChatCompletionCoreNonStreaming(opts);
    if (result.type === "aborted") return;
    if (result.type === "contextOverflow") {
        sendJson(opts.res, 413, makeContextLengthExceededError({
            promptTokens: opts.promptTokens,
            maxTokens: opts.body.max_tokens,
            ctxSize: opts.session.options.contextSize,
            underlying: result.underlying
        }));
        return;
    }
    sendJson(opts.res, 200, result.completion);
}

/**
 * Pure-logic streaming sink — I/O 抽象。HTTP path 用 SseWriter sink wrap
 * IncomingMessage/ServerResponse；embedded（in-process）path 用 ReadableStream
 * sink wrap controller.enqueue。
 *
 * 設計對齊既有 runStreaming 行為：
 *  - onChunk：每個 OpenAI ChatCompletion chunk（含 role / content delta /
 *    reasoning_content / tool_calls / 最終 usage chunk）
 *  - onError：mid-stream 錯誤（非 abort），caller 決定是否 propagate 到 client
 *  - onDone：正常結束，caller 關閉 stream
 *
 * keepalive ping 與 res.destroyed 偵測屬於 HTTP-specific 邏輯，留在 HTTP wrapper，
 * 不下放到 core；embedded path 不需要 TCP keepalive。
 */
export interface StreamingSink {
    /** Emit one OpenAI ChatCompletion streaming chunk. */
    onChunk(chunk: OpenAIChatChunk): void;
    /** Mid-stream error（context overflow 以外）。core 已 incChatError；caller
     *  決定怎麼把錯誤傳給 client（HTTP 走 sse.error；embedded 走 controller.error）。 */
    onError(err: Error): void;
    /** Normal completion — caller 關閉 stream（SseWriter.done / controller.close）。 */
    onDone(): void;
}

/**
 * Pure-logic core of streaming chat completion — runs the actual prompt +
 * streams OpenAI chunks via sink **without** touching HTTP res. HTTP handler
 * (runStreaming) 與 embedded adapter 共用同一條路徑。
 *
 * Sink 收到的 chunk 序列與舊 runStreaming 寫進 SseWriter 的內容完全一致：
 *   1. role:assistant 初始 chunk
 *   2. N × content / reasoning_content delta chunks（promptWithMeta.onTextChunk 觸發）
 *   3. sniffer / splitter flush 後可能 0-2 個尾巴 chunk
 *   4. budget exhaustion fallback chunk（如觸發）
 *   5. tool_calls chunks（每個 tool call 一個）
 *   6. final chunk（含 finish_reason + usage）
 *
 * 回傳 discriminated union 與 runChatCompletionCoreNonStreaming 對稱：
 *  - 'completion'：正常完成，sink.onDone 已呼叫
 *  - 'aborted'：client/呼叫端 abort，sink 已停止接收 chunk（caller 通常靜默 return）
 *  - 'contextOverflow'：mid-stream overflow（preflight 沒抓到），sink 沒 onError
 *    呼叫，由 caller 自行決定要不要對 client 噴錯（HTTP 走 sse.error；embedded
 *    可包成 Anthropic error event）
 *
 * 其他 unknown error 已透過 sink.onError 通報並 return 'completion'（與舊行為
 * 對齊 — sse.error 後 SSE 直接結束）。
 */
export async function runChatCompletionCoreStreaming(
    opts: RunCtx,
    sink: StreamingSink
): Promise<
    | {type: "completion"}
    | {type: "aborted"}
    | {type: "contextOverflow"; underlying: unknown}
> {
    const {body, chatSession, lastUserPrompt, session, id, created, model, declaredTools, abort} = opts;
    const abortSignal = abort.signal;
    const splitter = new StreamReasoningSplitter();
    const sniffer = new StreamToolSniffer(declaredTools);
    const reasoning = resolveReasoning(session, body);
    const {engineResponsePrefix, stripPrefix} = composeResponsePrefix(reasoning, body, opts.useQwenFormat, declaredTools);
    let totalRaw = "";
    let visibleContentEmitted = "";
    const useReasoningSplitter = reasoning.reasoningFormat !== "none";

    sink.onChunk(makeChunk(id, created, model, {role: "assistant"}, null));

    let prefixToStrip = stripPrefix ?? "";
    try {
        const sd = session.options.samplerDefaults;
        const repeatPenaltyOpts = buildRepeatPenalty(body, sd);
        const meta = await chatSession.promptWithMeta(lastUserPrompt, {
            maxTokens: body.max_tokens,
            temperature: body.temperature ?? sd?.temperature,
            topP: body.top_p ?? sd?.topP,
            topK: body.top_k ?? sd?.topK,
            minP: body.min_p ?? sd?.minP,
            seed: body.seed,
            ...(repeatPenaltyOpts ? {repeatPenalty: repeatPenaltyOpts} : {}),
            customStopTriggers: normalizeStop(body.stop),
            signal: abortSignal,
            stopOnAbortSignal: true,
            ...(engineResponsePrefix ? {responsePrefix: engineResponsePrefix} : {}),
            ...(reasoning.thoughtTokens != null ? {budgets: {thoughtTokens: reasoning.thoughtTokens}} : {}),
            onTextChunk(rawText: string) {
                let text = rawText;
                if (prefixToStrip.length > 0) {
                    if (text.startsWith(prefixToStrip)) {
                        text = text.slice(prefixToStrip.length);
                        prefixToStrip = "";
                    } else if (prefixToStrip.startsWith(text)) {
                        prefixToStrip = prefixToStrip.slice(text.length);
                        return;
                    } else {
                        prefixToStrip = "";
                    }
                }
                totalRaw += text;
                const visible = sniffer.feed(text);
                if (visible.length === 0) return;
                if (!useReasoningSplitter) {
                    visibleContentEmitted += visible;
                    sink.onChunk(makeChunk(id, created, model, {content: visible}, null));
                    return;
                }
                const part = splitter.feed(visible);
                if (part.content) visibleContentEmitted += part.content;
                if (part.content || part.reasoning) {
                    sink.onChunk(makeChunk(id, created, model, {
                        ...(part.content ? {content: part.content} : {}),
                        ...(part.reasoning ? {reasoning_content: part.reasoning} : {})
                    }, null));
                }
            }
        });

        const sniffTail = sniffer.flush();
        if (sniffTail.length > 0) {
            if (!useReasoningSplitter) {
                visibleContentEmitted += sniffTail;
                sink.onChunk(makeChunk(id, created, model, {content: sniffTail}, null));
            } else {
                const part = splitter.feed(sniffTail);
                if (part.content) visibleContentEmitted += part.content;
                if (part.content || part.reasoning) {
                    sink.onChunk(makeChunk(id, created, model, {
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
                sink.onChunk(makeChunk(id, created, model, {
                    ...(tail.content ? {content: tail.content} : {}),
                    ...(tail.reasoning ? {reasoning_content: tail.reasoning} : {})
                }, null));
            }
        }

        const stopReasonForBudget = mapStopReason((meta as any).stopReason);
        const budgetMsg = maybeApplyBudgetExhaustionMessage("", stopReasonForBudget, reasoning);
        if (visibleContentEmitted.trim().length === 0 && budgetMsg.length > 0) {
            sink.onChunk(makeChunk(id, created, model, {content: budgetMsg}, null));
        }

        const fullSplit = splitReasoning(totalRaw);
        const {toolCalls, leak} = extractToolCallsForFormat(fullSplit.content, declaredTools, opts.useQwenFormat);
        if (toolCalls.length > 0) {
            for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i]!;
                sink.onChunk(makeChunk(id, created, model, {
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
        if (leak != null) {
            finalChunk._qwen_tool_leak = {
                markers: leak.markers,
                recovered: toolCalls.length,
                contentLength: leak.contentLength,
                snippet: leak.snippet
            };
        }
        recordChatTokens(opts.promptTokens, completionTokens);
        sink.onChunk(finalChunk);
        sink.onDone();
        return {type: "completion"};
    } catch (err) {
        if (abortSignal.aborted) return {type: "aborted"};
        if (isContextOverflowError(err)) {
            incChatError("overflow");
            return {type: "contextOverflow", underlying: err};
        }
        incChatError("other");
        sink.onError(err instanceof Error ? err : new Error(String(err)));
        return {type: "completion"};
    }
}

/**
 * HTTP wrapper：把 IncomingMessage/ServerResponse 包成 SseWriter sink，串接
 * keepalive ping + res.destroyed 偵測（embedded path 不需要），呼叫 core
 * function。維持與舊 runStreaming 完全一樣的對外行為。
 */
async function runStreaming(opts: RunCtx & {req: IncomingMessage, res: ServerResponse}): Promise<void> {
    const {res, id, abort, body, session} = opts;
    const abortSignal = abort.signal;
    const sse = new SseWriter(res);

    // (A) Streaming keepalive ping — 每 KEEPALIVE_INTERVAL_MS 寫一行 SSE comment
    // （spec 規定 client 必須忽略以 ":" 開頭的行）。寫失敗（EPIPE/ECONNRESET）或
    // res 被 destroy 時主動 abort，cover「fetch AbortController 客戶端 abort 但
    // TCP 沒關」這條（Bun / undici 可能不發 FIN）— req.on('close') 永不觸發，但
    // 實際上 client 不再讀，久了 server 寫的 chunks 會塞滿 TCP send buffer 然後
    // write 開始 throw／res 變 destroyed，這時被偵測到。
    const KEEPALIVE_INTERVAL_MS = Number(process.env.TCQ_STREAM_KEEPALIVE_MS) || 10_000;
    const keepalive = setInterval(() => {
        if (abortSignal.aborted) return;
        try {
            if (res.destroyed || res.writableEnded) {
                // biome-ignore lint/suspicious/noConsole: loud warn for diagnostic
                console.warn(`[TCQ-shim] stream id=${id} res destroyed/ended — aborting`);
                abort.abort();
                return;
            }
            const ok = res.write(": keep-alive\n\n");
            if (!ok && (res.destroyed || res.writableEnded)) abort.abort();
        } catch (e) {
            // biome-ignore lint/suspicious/noConsole: loud warn for diagnostic
            console.warn(`[TCQ-shim] stream id=${id} keepalive write failed: ${(e as Error).message} — aborting`);
            abort.abort();
        }
    }, KEEPALIVE_INTERVAL_MS);
    abortSignal.addEventListener("abort", () => clearInterval(keepalive));

    const sink: StreamingSink = {
        onChunk: (chunk) => sse.send(chunk),
        onError: (err) => {
            // Client 已斷：靜默 return，不寫 sse.error（EPIPE）也不算 server error。
            if (abortSignal.aborted) return;
            sse.error(err);
        },
        onDone: () => sse.done(),
    };

    try {
        const result = await runChatCompletionCoreStreaming(opts, sink);
        if (result.type === "aborted") return;
        if (result.type === "contextOverflow") {
            if (abortSignal.aborted) return;
            // SSE already opened with HTTP 200 — best we can do is emit a
            // structured error event that mirrors the 413 JSON body.
            sse.error(new Error(makeContextLengthExceededError({
                promptTokens: opts.promptTokens,
                maxTokens: body.max_tokens,
                ctxSize: session.options.contextSize,
                underlying: result.underlying
            }).error.message));
            return;
        }
    } finally {
        clearInterval(keepalive);
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

export function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
    if (stop == null) return undefined;
    return Array.isArray(stop) ? stop : [stop];
}

export function mapStopReason(raw: unknown): ShimStopReason {
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
export function packMessages(messages: OpenAIMessage[], tools: OpenAIChatRequest["tools"], useQwenFormat: boolean): {
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
