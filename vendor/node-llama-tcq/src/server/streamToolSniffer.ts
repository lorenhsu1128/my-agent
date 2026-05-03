// Phase 1.5 streaming guard: when tools are declared and the model starts
// emitting JSON (or a ```json fence) as the first non-whitespace token, suppress
// content delta chunks so the SSE stream looks like a clean OpenAI tool_call —
// no partial JSON leaking through `delta.content`.
//
// Decision logic (per stream):
//   - tools declared? no  → never sniff, pass everything through.
//   - decided 'text'?     → pass everything through.
//   - decided 'tool'?     → suppress everything (return "").
//   - undecided           → buffer head; flip to 'tool' on `{` or ```json,
//                           else flip to 'text' once we've seen enough
//                           non-JSON-y content (or a newline ending the head).
//
// Notes:
//   - Bytes are still accumulated by the caller into a separate `totalRaw` so
//     `extractToolCalls` can parse the full payload at end-of-stream.
//   - For mixed output ("let me check\n```json\n{...}\n```") this sniffer
//     decides 'text' early (because preamble doesn't start with `{`/```),
//     letting prose stream as content; the trailing fenced JSON is recovered
//     by `extractToolCalls` at finish, like before. Phase 2 (GBNF) removes
//     the ambiguity entirely.

import {OpenAIToolDef} from "./types.js";

const MAX_HEAD = 64;       // sniff window in chars before falling back to text
const FENCE_HINT = "```";

export class StreamToolSniffer {
    private head = "";
    private decided: "tool" | "text" | null = null;
    private readonly hasTools: boolean;

    constructor(declaredTools: OpenAIToolDef[]) {
        this.hasTools = declaredTools.length > 0;
    }

    /**
     * Consume a model text chunk; return the substring (if any) that should be
     * emitted as `delta.content`. Returns "" while buffering or after deciding
     * it's a tool call.
     */
    feed(chunk: string): string {
        if (!this.hasTools || this.decided === "text") return chunk;
        if (this.decided === "tool") return "";

        this.head += chunk;
        const trimmed = this.head.trimStart();

        if (trimmed.length === 0) return ""; // still leading whitespace

        if (trimmed.startsWith("{") || trimmed.startsWith(FENCE_HINT)) {
            this.decided = "tool";
            return "";
        }

        // Stop sniffing once we have enough evidence (or hit a newline that
        // terminates the first line cleanly — models that prelude tool calls
        // with prose typically include one).
        if (this.head.length >= MAX_HEAD || this.head.includes("\n")) {
            this.decided = "text";
            const out = this.head;
            this.head = "";
            return out;
        }

        return "";
    }

    /**
     * Called once at end-of-stream. If we never decided it was a tool, flush
     * the remaining buffered head as final content. If we decided 'tool',
     * return "" — caller emits tool_calls instead.
     */
    flush(): string {
        if (this.decided === "tool") return "";
        const out = this.head;
        this.head = "";
        if (this.decided === null) this.decided = "text";
        return out;
    }

    suppressedContent(): boolean {
        return this.decided === "tool";
    }
}
