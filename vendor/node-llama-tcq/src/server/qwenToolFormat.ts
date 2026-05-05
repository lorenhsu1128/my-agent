// Qwen3.5-native tool calling format (pythonic-XML).
// Mirrors what tokenizer_config.json's chat template emits & expects, so models
// see the format they were fine-tuned on instead of the generic JSON injection
// my Phase 1 fallback uses.
//
// Reference: https://huggingface.co/Qwen/Qwen3.5-9B → chat_template
//
// Tool definition block (injected into system message):
//   # Tools
//
//   You have access to the following functions:
//
//   <tools>
//   {"name":"get_weather","description":"...","parameters":{...}}
//   </tools>
//
//   If you choose to call a function ONLY reply in the following format ...
//
// Tool call (assistant emits):
//   <tool_call>
//   <function=get_weather>
//   <parameter=city>
//   Taipei
//   </parameter>
//   </function>
//   </tool_call>
//
// Tool result (user-side, in chat history):
//   <tool_response>
//   {"city":"Taipei","temperature":28}
//   </tool_response>

import {nanoid} from "nanoid";
import {OpenAIToolCall, OpenAIToolDef} from "./types.js";

export function isQwenModel(alias: string | undefined): boolean {
    if (alias == null) return false;
    return /^qwen/i.test(alias);
}

/**
 * Build the system-message block that lists declared tools using Qwen3.5's
 * native instruction wording verbatim (matches the chat_template Jinja literal
 * so model behavior matches HF transformers / vLLM / SGLang exactly).
 */
export function buildQwenToolsSystemBlock(tools: OpenAIToolDef[]): string {
    if (tools.length === 0) return "";
    const lines: string[] = [
        "# Tools",
        "",
        "You have access to the following functions:",
        "",
        "<tools>"
    ];
    for (const t of tools) {
        lines.push(JSON.stringify(t.function));
    }
    lines.push("</tools>");
    lines.push("");
    lines.push("If you choose to call a function ONLY reply in the following format with NO suffix:");
    lines.push("");
    lines.push("<tool_call>");
    lines.push("<function=example_function_name>");
    lines.push("<parameter=example_parameter_1>");
    lines.push("value_1");
    lines.push("</parameter>");
    lines.push("<parameter=example_parameter_2>");
    lines.push("This is the value for the second parameter");
    lines.push("that can span");
    lines.push("multiple lines");
    lines.push("</parameter>");
    lines.push("</function>");
    lines.push("</tool_call>");
    lines.push("");
    lines.push("<IMPORTANT>");
    lines.push("Reminder:");
    lines.push("- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags");
    lines.push("- Required parameters MUST be specified");
    lines.push("- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after");
    lines.push("- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls");
    lines.push("</IMPORTANT>");
    return lines.join("\n");
}

/** Render a single OpenAI tool_call into Qwen's <tool_call><function=...><parameter=...> form. */
export function renderQwenToolCall(call: OpenAIToolCall): string {
    let argsObj: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(call.function.arguments || "{}");
        if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
            argsObj = parsed as Record<string, unknown>;
        }
    } catch { /* leave empty */ }

    const paramLines: string[] = [];
    for (const [k, v] of Object.entries(argsObj)) {
        const valueStr = (typeof v === "object" && v != null) ? JSON.stringify(v) : String(v);
        paramLines.push(`<parameter=${k}>`);
        paramLines.push(valueStr);
        paramLines.push(`</parameter>`);
    }
    return [
        "<tool_call>",
        `<function=${call.function.name}>`,
        ...paramLines,
        "</function>",
        "</tool_call>"
    ].join("\n");
}

/** Wrap a tool result (string content) for inclusion in a chat-history user turn. */
export function renderQwenToolResponse(content: string): string {
    return `<tool_response>\n${content}\n</tool_response>`;
}

/**
 * Compact schema reminder for re-injecting tool schemas near the generation point.
 * Mitigation for Q4 量化 attention recency bias：當 chat 走到 chain-of-tool step 2
 * （上一輪 tool_response 剛出現）時，模型 priors 偏向「沿用最近看過的 keys」而非
 * 從 system 段 retrieve schema，導致呼下一個 tool 時 args schema 錯填（缺必填、
 * 多虛構欄位）。把同樣的 <tools> 區塊放到 lastUser 尾端，schema 會落在模型 attention
 * 的近端視窗。比 buildQwenToolsSystemBlock 短（無 IMPORTANT 區塊）— 系統段已有完整
 * 版本，這裡只重 inject schema JSON，省 prompt token。
 */
export function buildQwenToolsReminder(tools: OpenAIToolDef[]): string {
    if (tools.length === 0) return "";
    const lines: string[] = ["# Available functions (reminder):", "<tools>"];
    for (const t of tools) lines.push(JSON.stringify(t.function));
    lines.push("</tools>");
    return lines.join("\n");
}

const TOOL_CALL_RE = /<tool_call>\s*<function=([^>]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
const PARAM_RE = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

export type QwenExtractResult = {
    content: string,
    toolCalls: OpenAIToolCall[]
};

/**
 * Parse all <tool_call> blocks from a model response. Returns the leftover
 * (non-tool-call) text as `content` and the recovered calls in OpenAI shape.
 *
 * Coercion: integer / float / boolean / nested JSON values are auto-typed; bare
 * strings stay strings. Unknown tool names are filtered out.
 */
export function parseQwenToolCalls(text: string, declaredTools: OpenAIToolDef[]): QwenExtractResult {
    const names = new Set(declaredTools.map((t) => t.function.name));
    const calls: OpenAIToolCall[] = [];
    let stripped = text;

    const matches = [...text.matchAll(TOOL_CALL_RE)];
    for (const m of matches) {
        const name = (m[1] ?? "").trim();
        const inner = m[2] ?? "";
        if (!names.has(name)) continue;
        const args: Record<string, unknown> = {};
        for (const p of inner.matchAll(PARAM_RE)) {
            const k = (p[1] ?? "").trim();
            const raw = (p[2] ?? "").trim();
            args[k] = coerceParamValue(raw);
        }
        calls.push({
            id: `call_${nanoid(10)}`,
            type: "function",
            function: {name, arguments: JSON.stringify(args)}
        });
        stripped = stripped.replace(m[0], "");
    }
    return {content: stripped.trim(), toolCalls: calls};
}

function coerceParamValue(raw: string): unknown {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    if (/^-?\d+$/.test(raw)) {
        const n = Number(raw);
        if (Number.isSafeInteger(n)) return n;
    }
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(raw)) {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
    }
    if (raw.startsWith("{") || raw.startsWith("[")) {
        try { return JSON.parse(raw); } catch { /* fall through */ }
    }
    return raw;
}
