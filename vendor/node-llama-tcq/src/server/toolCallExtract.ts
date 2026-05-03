// Phase 1 tool_calls extraction: post-process the raw assistant text looking for
// fenced ```json blocks or {"name":..., "arguments":...} JSON. This is the lowest-
// common-denominator approach that works without GBNF grammar.
//
// Phase 2 will replace this with LlamaJsonSchemaGrammar to force structured output.

import {nanoid} from "nanoid";
import {OpenAIToolCall, OpenAIToolDef} from "./types.js";

export type ExtractResult = {
    /** assistant text with tool-call JSON stripped out */
    content: string,
    toolCalls: OpenAIToolCall[]
};

export function extractToolCalls(text: string, declaredTools: OpenAIToolDef[]): ExtractResult {
    if (declaredTools.length === 0) return {content: text, toolCalls: []};
    const names = new Set(declaredTools.map((t) => t.function.name));

    // Try fenced ```json block first
    const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    const found: OpenAIToolCall[] = [];
    let stripped = text;

    for (const match of text.matchAll(fenced)) {
        const inner = match[1];
        if (inner == null) continue;
        const call = tryParseCall(inner, names);
        if (call != null) {
            found.push(call);
            stripped = stripped.replace(match[0], "");
        }
    }

    // Bare JSON object as final tail (very common llm output pattern)
    if (found.length === 0) {
        const trimmed = stripped.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            const call = tryParseCall(trimmed, names);
            if (call != null) {
                found.push(call);
                stripped = "";
            }
        }
    }

    return {content: stripped.trim(), toolCalls: found};
}

function tryParseCall(jsonStr: string, validNames: Set<string>): OpenAIToolCall | null {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonStr); } catch { return null; }
    if (parsed == null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : null;
    if (name == null || !validNames.has(name)) return null;
    const args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    return {
        id: `call_${nanoid(10)}`,
        type: "function",
        function: {
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args)
        }
    };
}

/**
 * Build a system-prompt suffix that lists the declared tools. Used when the user
 * passes `tools` in the request — we inject a brief instruction so the model
 * emits the JSON we then parse out.
 */
export function buildToolPromptSuffix(tools: OpenAIToolDef[]): string {
    if (tools.length === 0) return "";
    const lines = tools.map((t) => {
        const params = JSON.stringify(t.function.parameters);
        return `- ${t.function.name}: ${t.function.description ?? ""} (params schema: ${params})`;
    });
    return [
        "",
        "You have access to the following tools. To call a tool, respond ONLY with",
        'a single fenced ```json block containing {\"name\":\"<tool_name>\",\"arguments\":{...}}.',
        "Do not add any prose before or after the JSON when you decide to call a tool.",
        "Available tools:",
        ...lines
    ].join("\n");
}
