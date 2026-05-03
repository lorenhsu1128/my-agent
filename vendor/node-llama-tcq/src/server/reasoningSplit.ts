// Phase 1 reasoning_content extractor: splits Qwen-style <think>...</think> wrapped
// chains-of-thought from the visible content. For other models, returns content
// unchanged with reasoning = null.

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export type SplitResult = {content: string, reasoning: string | null};

export function splitReasoning(text: string): SplitResult {
    const open = text.indexOf(THINK_OPEN);
    if (open === -1) return {content: text, reasoning: null};
    const close = text.indexOf(THINK_CLOSE, open + THINK_OPEN.length);
    if (close === -1) {
        // Unclosed think tag — treat whole tail as reasoning.
        return {
            content: text.slice(0, open).trimEnd(),
            reasoning: text.slice(open + THINK_OPEN.length)
        };
    }
    const reasoning = text.slice(open + THINK_OPEN.length, close);
    const content = (text.slice(0, open) + text.slice(close + THINK_CLOSE.length)).trimStart();
    return {content, reasoning};
}

/**
 * Streaming variant: maintain a small buffer that decides whether each emitted
 * fragment belongs to `content` or `reasoning`. Caller invokes feed() per chunk
 * and consumes the returned partial deltas.
 */
export class StreamReasoningSplitter {
    private buf = "";
    private state: "content" | "reasoning" = "content";

    feed(chunk: string): {content: string, reasoning: string} {
        this.buf += chunk;
        let outContent = "";
        let outReasoning = "";

        while (true) {
            if (this.state === "content") {
                const idx = this.buf.indexOf(THINK_OPEN);
                if (idx === -1) {
                    // Withhold up to THINK_OPEN.length-1 chars in case the tag straddles a chunk.
                    const safe = Math.max(0, this.buf.length - (THINK_OPEN.length - 1));
                    outContent += this.buf.slice(0, safe);
                    this.buf = this.buf.slice(safe);
                    break;
                }
                outContent += this.buf.slice(0, idx);
                this.buf = this.buf.slice(idx + THINK_OPEN.length);
                this.state = "reasoning";
            } else {
                const idx = this.buf.indexOf(THINK_CLOSE);
                if (idx === -1) {
                    const safe = Math.max(0, this.buf.length - (THINK_CLOSE.length - 1));
                    outReasoning += this.buf.slice(0, safe);
                    this.buf = this.buf.slice(safe);
                    break;
                }
                outReasoning += this.buf.slice(0, idx);
                this.buf = this.buf.slice(idx + THINK_CLOSE.length);
                this.state = "content";
            }
        }
        return {content: outContent, reasoning: outReasoning};
    }

    /** Flush remaining buffer (called on stream end). */
    flush(): {content: string, reasoning: string} {
        const tail = this.buf;
        this.buf = "";
        if (this.state === "content") return {content: tail, reasoning: ""};
        return {content: "", reasoning: tail};
    }
}
