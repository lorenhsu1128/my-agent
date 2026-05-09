// Convert node-llama-tcq's `meta.response` array (from promptWithMeta) into the
// shapes our OpenAI-compat layer needs.
//
// `meta.response` is `Array<string | ChatModelFunctionCall | ChatModelSegment>` —
// the chat wrapper has already split visible text, thought segments, and (when
// using the engine's native function-calling API) function call objects.
//
// For Qwen3.5: thought segments come pre-stripped from the visible stream;
// crucially, each segment carries an `ended: boolean` flag so we can detect
// "model was truncated mid-think and never closed </think>" — exactly the T3
// case where responseText alone is unreliable.

import {ChatModelFunctionCall, ChatModelResponse, ChatModelSegment, isChatModelResponseFunctionCall, isChatModelResponseSegment} from "../types.js";

export type SegmentBundle = {
    /** Visible text concatenated from string items (excluding thought segments). */
    visibleText: string,
    /** Reasoning text concatenated from `segmentType: "thought"` segments. */
    reasoningText: string,
    /** Comment segments — currently folded into visibleText for OpenAI compatibility. */
    commentText: string,
    /** Native function calls from the chat wrapper (when caller passed `functions`). */
    nativeCalls: ChatModelFunctionCall[],
    /** True if any thought segment was truncated mid-emission (engine ran out of budget). */
    thoughtTruncated: boolean,
    /** Total thought-segment count (for debug / metrics). */
    thoughtSegments: number
};

export function bundleResponse(response: ChatModelResponse["response"]): SegmentBundle {
    let visibleText = "";
    let reasoningText = "";
    let commentText = "";
    const nativeCalls: ChatModelFunctionCall[] = [];
    let thoughtTruncated = false;
    let thoughtSegments = 0;

    for (const item of response) {
        if (typeof item === "string") {
            visibleText += item;
            continue;
        }
        if (isChatModelResponseFunctionCall(item)) {
            nativeCalls.push(item);
            continue;
        }
        if (isChatModelResponseSegment(item)) {
            const seg = item as ChatModelSegment;
            if (seg.segmentType === "thought") {
                reasoningText += seg.text;
                thoughtSegments += 1;
                if (seg.ended === false) thoughtTruncated = true;
            } else if (seg.segmentType === "comment") {
                commentText += seg.text;
            }
            continue;
        }
    }

    return {
        visibleText,
        reasoningText,
        commentText,
        nativeCalls,
        thoughtTruncated,
        thoughtSegments
    };
}
