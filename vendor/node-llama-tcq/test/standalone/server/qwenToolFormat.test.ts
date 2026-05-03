import {describe, expect, test} from "vitest";
import {
    isQwenModel,
    buildQwenToolsSystemBlock,
    renderQwenToolCall,
    renderQwenToolResponse,
    parseQwenToolCalls
} from "../../../src/server/qwenToolFormat.js";

const tools = [{
    type: "function" as const,
    function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}
}];

describe("isQwenModel", () => {
    test.each([
        ["qwen3.5-9b", true],
        ["Qwen3.5-9B-Q4", true],
        ["QWEN", true],
        ["qwen-coder-2.5", true],
        ["llama3", false],
        ["mistral-7b", false],
        ["", false]
    ])("%s → %s", (alias, expected) => {
        expect(isQwenModel(alias)).toBe(expected);
    });
});

describe("buildQwenToolsSystemBlock", () => {
    test("empty when no tools", () => {
        expect(buildQwenToolsSystemBlock([])).toBe("");
    });
    test("contains <tools> tag + JSON schema + native instruction wording", () => {
        const s = buildQwenToolsSystemBlock(tools);
        expect(s).toContain("<tools>");
        expect(s).toContain("</tools>");
        expect(s).toContain("get_weather");
        expect(s).toContain("<tool_call>");
        expect(s).toContain("<function=example_function_name>");
        expect(s).toContain("<IMPORTANT>");
    });
});

describe("renderQwenToolCall", () => {
    test("scalar args", () => {
        const out = renderQwenToolCall({
            id: "x", type: "function",
            function: {name: "get_weather", arguments: '{"city":"Taipei"}'}
        });
        expect(out).toBe(
            "<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei\n</parameter>\n</function>\n</tool_call>"
        );
    });
    test("nested object args → JSON-stringified value", () => {
        const out = renderQwenToolCall({
            id: "x", type: "function",
            function: {name: "f", arguments: '{"opts":{"k":1}}'}
        });
        expect(out).toContain("<parameter=opts>");
        expect(out).toContain('{"k":1}');
    });
    test("malformed arguments → empty params (no throw)", () => {
        const out = renderQwenToolCall({
            id: "x", type: "function",
            function: {name: "f", arguments: "not json"}
        });
        expect(out).toContain("<function=f>");
        expect(out).toContain("</function>");
    });
});

describe("renderQwenToolResponse", () => {
    test("wraps content in <tool_response>", () => {
        expect(renderQwenToolResponse('{"x":1}')).toBe('<tool_response>\n{"x":1}\n</tool_response>');
    });
});

describe("parseQwenToolCalls", () => {
    test("single tool call, scalar param", () => {
        const text = "<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0]!.function.name).toBe("get_weather");
        expect(r.toolCalls[0]!.function.arguments).toBe('{"city":"Taipei"}');
        expect(r.content).toBe("");
    });

    test("preamble prose retained as content", () => {
        const text = "Let me check the weather for you.\n<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.content).toBe("Let me check the weather for you.");
    });

    test("multi-line param value", () => {
        const text = "<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei\nTaiwan\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls[0]!.function.arguments).toContain("Taipei\\nTaiwan");
    });

    test("numeric coercion", () => {
        const numTools = [{type: "function" as const, function: {name: "f", description: "", parameters: {type: "object", properties: {n: {type: "number"}, b: {type: "boolean"}}}}}];
        const text = "<tool_call>\n<function=f>\n<parameter=n>\n42\n</parameter>\n<parameter=b>\ntrue\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, numTools);
        const args = JSON.parse(r.toolCalls[0]!.function.arguments);
        expect(args.n).toBe(42);
        expect(args.b).toBe(true);
    });

    test("nested JSON object param", () => {
        const objTools = [{type: "function" as const, function: {name: "f", description: "", parameters: {type: "object", properties: {opts: {type: "object"}}}}}];
        const text = '<tool_call>\n<function=f>\n<parameter=opts>\n{"k":1,"v":[1,2,3]}\n</parameter>\n</function>\n</tool_call>';
        const r = parseQwenToolCalls(text, objTools);
        const args = JSON.parse(r.toolCalls[0]!.function.arguments);
        expect(args.opts).toEqual({k: 1, v: [1, 2, 3]});
    });

    test("unknown tool name filtered out", () => {
        const text = "<tool_call>\n<function=evil>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(0);
    });

    test("multiple tool_calls in same response", () => {
        const text = "<tool_call>\n<function=get_weather>\n<parameter=city>\nA\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=get_weather>\n<parameter=city>\nB\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(2);
        expect(JSON.parse(r.toolCalls[0]!.function.arguments).city).toBe("A");
        expect(JSON.parse(r.toolCalls[1]!.function.arguments).city).toBe("B");
    });

    test("plain text → no tool calls", () => {
        const r = parseQwenToolCalls("Hello world!", tools);
        expect(r.toolCalls).toEqual([]);
        expect(r.content).toBe("Hello world!");
    });
});
