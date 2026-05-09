import {describe, expect, test} from "vitest";
import {extractToolCalls, buildToolPromptSuffix} from "../../../src/server/toolCallExtract.js";

const tools = [{
    type: "function" as const,
    function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}}}
}];

describe("extractToolCalls", () => {
    test("no tools declared → passthrough", () => {
        const r = extractToolCalls("hello", []);
        expect(r.toolCalls).toEqual([]);
        expect(r.content).toBe("hello");
    });

    test("fenced json call", () => {
        const text = "let me check\n```json\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Taipei\"}}\n```";
        const r = extractToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0]!.function.name).toBe("get_weather");
        expect(r.toolCalls[0]!.function.arguments).toBe('{"city":"Taipei"}');
        expect(r.content).toBe("let me check");
    });

    test("bare json object as final tail", () => {
        const text = '{"name":"get_weather","arguments":{"city":"Tokyo"}}';
        const r = extractToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0]!.function.name).toBe("get_weather");
        expect(r.content).toBe("");
    });

    test("ignores unknown tool name", () => {
        const text = '```json\n{"name":"shutdown","arguments":{}}\n```';
        const r = extractToolCalls(text, tools);
        expect(r.toolCalls).toEqual([]);
    });
});

describe("buildToolPromptSuffix", () => {
    test("empty when no tools", () => {
        expect(buildToolPromptSuffix([])).toBe("");
    });
    test("includes tool names", () => {
        const s = buildToolPromptSuffix(tools);
        expect(s).toContain("get_weather");
        expect(s).toContain("Get weather");
    });
});
