import {describe, expect, test} from "vitest";
import {
    isQwenModel,
    buildQwenToolsSystemBlock,
    renderQwenToolCall,
    renderQwenToolResponse,
    parseQwenToolCalls,
    detectToolCallLeak
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
        expect(r.leak).toBeNull();
    });
});

// B3：tool-format XML 漏出偵測
describe("detectToolCallLeak", () => {
    test("empty content → null", () => {
        expect(detectToolCallLeak("")).toBeNull();
    });

    test("clean content (無 marker) → null", () => {
        expect(detectToolCallLeak("Hello, the weather is sunny.")).toBeNull();
    });

    test("L1 unclosed <tool_call>（漏出 open 但無 close）", () => {
        const text = "Let me check the weather. <tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei";
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.markers).toContain("tool_call_open");
        expect(r!.markers).toContain("function_open");
        expect(r!.markers).toContain("parameter_open");
        expect(r!.snippet).toContain("<tool_call>");
    });

    test("L2 dangling </function> 沒前面 open（截斷漏出）", () => {
        const text = "weather data\n</function>\n</tool_call>\nThe weather is fine.";
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.markers).toEqual(expect.arrayContaining(["function_close", "tool_call_close"]));
    });

    test("L3 prose 中提到 <tool_call>（解釋語法時的合法漏出，但仍要警示）", () => {
        const text = "The Qwen tool format uses <tool_call> XML tags around function invocations.";
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.markers).toContain("tool_call_open");
    });

    test("L4 <tools> 系統 block 漏到 user-visible 內容", () => {
        const text = "Here are the available tools:\n<tools>\n{\"name\":\"get_weather\"}\n</tools>";
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.markers).toContain("tools_block");
    });

    test("L5 <tool_response> 區塊漏出（chat-history format leak）", () => {
        const text = "Sure thing.\n<tool_response>\n{\"city\":\"Taipei\"}\n</tool_response>";
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.markers).toContain("tool_response");
    });

    test("L6 snippet 包含 anchor 周邊 ±60 字 + ellipsis（長 content）", () => {
        const before = "x".repeat(200);
        const after = "y".repeat(200);
        const text = `${before}<tool_call>${after}`;
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.snippet.startsWith("…")).toBe(true);
        expect(r!.snippet.endsWith("…")).toBe(true);
        expect(r!.snippet).toContain("<tool_call>");
    });

    test("L7 多種 marker 同時出現（依出現順序去重）", () => {
        const text = "<tool_call><function=foo></function></tool_call><parameter=bar></parameter>";
        const r = detectToolCallLeak(text);
        expect(r).not.toBeNull();
        expect(r!.markers.length).toBeGreaterThanOrEqual(4);
        // markers 集合去重 — 不應重複
        expect(new Set(r!.markers).size).toBe(r!.markers.length);
    });
});

// B3：parseQwenToolCalls 串 leak
describe("parseQwenToolCalls leak field", () => {
    test("正常 tool call → 抽乾淨後 leak null", () => {
        const text = "<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei\n</parameter>\n</function>\n</tool_call>";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.leak).toBeNull();
    });

    test("unclosed tool_call → 0 calls + leak 報告", () => {
        const text = "I will check.\n<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(0);
        expect(r.leak).not.toBeNull();
        expect(r.leak!.markers).toContain("tool_call_open");
    });

    test("一個成功 + 一個漏出 → 抽出 1 個 + 殘留 leak", () => {
        const good = "<tool_call>\n<function=get_weather>\n<parameter=city>\nTaipei\n</parameter>\n</function>\n</tool_call>";
        const bad = "<tool_call>\n<function=get_weather>\n<parameter=city>\nTokyo";
        const r = parseQwenToolCalls(`${good}\n\nAlso: ${bad}`, tools);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.leak).not.toBeNull();
    });

    test("plain prose mentioning <tool_call> → 0 calls + leak（解釋語法）", () => {
        const text = "The shim parses <tool_call>...</tool_call> XML blocks.";
        const r = parseQwenToolCalls(text, tools);
        expect(r.toolCalls).toHaveLength(0);
        expect(r.leak).not.toBeNull();
        expect(r.leak!.markers).toEqual(expect.arrayContaining(["tool_call_open", "tool_call_close"]));
    });
});
