import {describe, expect, test} from "vitest";
import {splitReasoning, StreamReasoningSplitter} from "../../../src/server/reasoningSplit.js";

describe("splitReasoning", () => {
    test("no think tag → content only", () => {
        expect(splitReasoning("hello world")).toEqual({content: "hello world", reasoning: null});
    });

    test("clean think + answer", () => {
        const r = splitReasoning("<think>step 1\nstep 2</think>final answer");
        expect(r.reasoning).toBe("step 1\nstep 2");
        expect(r.content).toBe("final answer");
    });

    test("think with leading content", () => {
        const r = splitReasoning("preamble<think>cot</think>tail");
        expect(r.reasoning).toBe("cot");
        expect(r.content).toBe("preambletail");
    });

    test("unclosed think tag → all tail = reasoning", () => {
        const r = splitReasoning("<think>still thinking…");
        expect(r.reasoning).toBe("still thinking…");
        expect(r.content).toBe("");
    });
});

describe("StreamReasoningSplitter", () => {
    function feed(chunks: string[]): {content: string, reasoning: string} {
        const s = new StreamReasoningSplitter();
        let content = ""; let reasoning = "";
        for (const c of chunks) {
            const part = s.feed(c);
            content += part.content; reasoning += part.reasoning;
        }
        const tail = s.flush();
        return {content: content + tail.content, reasoning: reasoning + tail.reasoning};
    }

    test("plain text streamed", () => {
        expect(feed(["hel", "lo ", "world"])).toEqual({content: "hello world", reasoning: ""});
    });

    test("think tag straddling chunk boundary", () => {
        const out = feed(["before<thi", "nk>cot</thi", "nk>after"]);
        expect(out.content).toBe("beforeafter");
        expect(out.reasoning).toBe("cot");
    });

    test("only reasoning (unclosed)", () => {
        const out = feed(["<think>", "still thinking"]);
        expect(out.content).toBe("");
        expect(out.reasoning).toBe("still thinking");
    });
});
