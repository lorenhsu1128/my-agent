import {nanoid} from "nanoid";
import {withLock} from "lifecycle-utils";
import type {IncomingMessage, ServerResponse} from "node:http";
import {LlamaChatSession} from "../evaluator/LlamaChatSession/LlamaChatSession.js";
import type {ChatHistoryItem} from "../types.js";
import {ServerSession} from "./session.js";
import {SseWriter} from "./streaming.js";
import {OpenAIChatChunk, OpenAIChatRequest, OpenAIChatCompletion, OpenAIMessage} from "./types.js";
import {makeError} from "./errors.js";
import {makeUsage} from "./usage.js";
import {toOpenAIFinishReason, ShimStopReason} from "./finishReason.js";
import {splitReasoning, StreamReasoningSplitter} from "./reasoningSplit.js";
import {extractToolCalls, buildToolPromptSuffix} from "./toolCallExtract.js";
import {flattenContent, extractMediaParts} from "./visionPath.js";
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
        sendJson(res, 501, makeError(
            "vision_phase_pending",
            "Vision/audio inference path is scaffolded but not yet wired in M-TCQ-SHIM-1. " +
            "Track in M-TCQ-SHIM-1-7.",
            "not_implemented"
        ));
        return;
    }

    const {systemPrompt, history, lastUserPrompt} = packMessages(body.messages, body.tools ?? []);

    const id = `chatcmpl-${nanoid(16)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = primaryAlias;
    const stream = body.stream === true;

    await withLock(session.inferenceLockScope, async () => {
        // Reset sequence to clear cache from previous request — stateless OpenAI semantics.
        await session.sequence.clearHistory();

        const chatSession = new LlamaChatSession({
            contextSequence: session.sequence,
            systemPrompt,
            // Use the model's resolved chat wrapper (auto)
            autoDisposeSequence: false
        });

        if (history.length > 0) {
            chatSession.setChatHistory(history);
        }

        if (stream) {
            await runStreaming({
                req, res, body, chatSession, lastUserPrompt,
                id, created, model, declaredTools: body.tools ?? []
            });
        } else {
            await runNonStreaming({
                res, body, chatSession, lastUserPrompt,
                id, created, model, declaredTools: body.tools ?? []
            });
        }
    });
}

type RunCtx = {
    body: OpenAIChatRequest,
    chatSession: LlamaChatSession,
    lastUserPrompt: string,
    id: string,
    created: number,
    model: string,
    declaredTools: NonNullable<OpenAIChatRequest["tools"]>
};

async function runNonStreaming(opts: RunCtx & {res: ServerResponse}): Promise<void> {
    const {res, body, chatSession, lastUserPrompt, id, created, model, declaredTools} = opts;

    let stopReason: ShimStopReason = undefined;
    const meta = await chatSession.promptWithMeta(lastUserPrompt, {
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
        topK: body.top_k,
        seed: body.seed,
        customStopTriggers: normalizeStop(body.stop)
    });
    stopReason = mapStopReason((meta as any).stopReason);

    const split = splitReasoning(meta.responseText);
    const {content, toolCalls} = extractToolCalls(split.content, declaredTools);

    const completion: OpenAIChatCompletion = {
        id,
        object: SHIM_OBJECT_NON_STREAM,
        created,
        model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: toolCalls.length > 0 ? null : content,
                reasoning_content: split.reasoning,
                ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {})
            },
            finish_reason: toOpenAIFinishReason(stopReason, toolCalls.length > 0)
        }],
        usage: makeUsage(
            (meta as any).usage?.promptTokens ?? 0,
            (meta as any).usage?.completionTokens ?? 0
        )
    };

    sendJson(res, 200, completion);
}

async function runStreaming(opts: RunCtx & {req: IncomingMessage, res: ServerResponse}): Promise<void> {
    const {req, res, body, chatSession, lastUserPrompt, id, created, model, declaredTools} = opts;
    const sse = new SseWriter(res);
    const splitter = new StreamReasoningSplitter();
    let totalRaw = "";

    // Initial role chunk (OpenAI convention)
    sse.send(makeChunk(id, created, model, {role: "assistant"}, null));

    const abort = new AbortController();
    req.on("close", () => abort.abort());

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
            onTextChunk(text: string) {
                totalRaw += text;
                const part = splitter.feed(text);
                if (part.content || part.reasoning) {
                    sse.send(makeChunk(id, created, model, {
                        ...(part.content ? {content: part.content} : {}),
                        ...(part.reasoning ? {reasoning_content: part.reasoning} : {})
                    }, null));
                }
            }
        });

        const tail = splitter.flush();
        if (tail.content || tail.reasoning) {
            sse.send(makeChunk(id, created, model, {
                ...(tail.content ? {content: tail.content} : {}),
                ...(tail.reasoning ? {reasoning_content: tail.reasoning} : {})
            }, null));
        }

        // Tool extraction is whole-text only in Phase 1 — emit as single chunk after stream.
        const fullSplit = splitReasoning(totalRaw);
        const {toolCalls} = extractToolCalls(fullSplit.content, declaredTools);
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
        const finalChunk = makeChunk(id, created, model, {}, toOpenAIFinishReason(stopReason, toolCalls.length > 0));
        finalChunk.usage = makeUsage(
            (meta as any).usage?.promptTokens ?? 0,
            (meta as any).usage?.completionTokens ?? 0
        );
        sse.send(finalChunk);
        sse.done();
    } catch (err) {
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
function packMessages(messages: OpenAIMessage[], tools: OpenAIChatRequest["tools"]): {
    systemPrompt: string,
    history: ChatHistoryItem[],
    lastUserPrompt: string
} {
    const systemParts: string[] = [];
    const middle: ChatHistoryItem[] = [];
    let lastUser = "";

    // Find the last user message — that becomes the active prompt.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") { lastUserIdx = i; break; }
    }

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        const text = flattenContent(m.content);
        if (m.role === "system") {
            systemParts.push(text);
        } else if (i === lastUserIdx) {
            lastUser = text;
        } else if (m.role === "user") {
            middle.push({type: "user", text});
        } else if (m.role === "assistant") {
            const toolCallText = (m.tool_calls ?? []).map((tc) =>
                `[tool_call name=${tc.function.name} args=${tc.function.arguments}]`
            ).join("\n");
            const combined = [text, toolCallText].filter(Boolean).join("\n");
            middle.push({type: "model", response: combined === "" ? [] : [combined]});
        } else if (m.role === "tool") {
            middle.push({type: "user", text: `[tool_result id=${m.tool_call_id ?? ""}] ${text}`});
        }
    }

    if (tools && tools.length > 0) {
        systemParts.push(buildToolPromptSuffix(tools));
    }

    return {
        systemPrompt: systemParts.filter(Boolean).join("\n\n"),
        history: middle,
        lastUserPrompt: lastUser
    };
}
