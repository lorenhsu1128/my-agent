import {describe, expect, test} from "vitest";
import {StreamToolSniffer} from "../../../src/server/streamToolSniffer.js";

const tools = [{
    type: "function" as const,
    function: {name: "get_weather", description: "", parameters: {type: "object", properties: {city: {type: "string"}}}}
}];

function feedAll(s: StreamToolSniffer, chunks: string[]): {visible: string, suppressed: boolean} {
    let visible = "";
    for (const c of chunks) visible += s.feed(c);
    visible += s.flush();
    return {visible, suppressed: s.suppressedContent()};
}

describe("StreamToolSniffer", () => {
    test("no tools declared → passthrough always", () => {
        const s = new StreamToolSniffer([]);
        const r = feedAll(s, ['{"name":"x"}']);
        expect(r.visible).toBe('{"name":"x"}');
        expect(r.suppressed).toBe(false);
    });

    test("tools + bare JSON start → suppress entire stream", () => {
        const s = new StreamToolSniffer(tools);
        const r = feedAll(s, ['{"c', 'ity', '":"', 'Tokyo', '"}']);
        expect(r.visible).toBe("");
        expect(r.suppressed).toBe(true);
    });

    test("tools + leading whitespace then JSON → still suppress", () => {
        const s = new StreamToolSniffer(tools);
        const r = feedAll(s, ['\n  ', '{"name":"get_weather"}']);
        expect(r.visible).toBe("");
        expect(r.suppressed).toBe(true);
    });

    test("tools + fenced ```json → suppress", () => {
        const s = new StreamToolSniffer(tools);
        const r = feedAll(s, ['```', 'json\n{"x":1}\n```']);
        expect(r.visible).toBe("");
        expect(r.suppressed).toBe(true);
    });

    test("tools + plain prose → emit normally", () => {
        const s = new StreamToolSniffer(tools);
        const r = feedAll(s, ["Hello, ", "I cannot help with that."]);
        expect(r.visible).toBe("Hello, I cannot help with that.");
        expect(r.suppressed).toBe(false);
    });

    test("tools + prose containing `{` mid-text → emit (decided text on first non-{ char)", () => {
        const s = new StreamToolSniffer(tools);
        const r = feedAll(s, ["Sure, here is JSON: {\"x\":1}"]);
        expect(r.visible).toBe("Sure, here is JSON: {\"x\":1}");
        expect(r.suppressed).toBe(false);
    });

    test("tools + newline within first 64 chars flips to text", () => {
        const s = new StreamToolSniffer(tools);
        const r = feedAll(s, ["short reply\nmore text after newline"]);
        expect(r.visible).toBe("short reply\nmore text after newline");
        expect(r.suppressed).toBe(false);
    });
});
