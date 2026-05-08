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
 * M-TCQ-SHIM-FIXUP-1：把 OpenAI tool_choice 翻成 Qwen pythonic-XML 起手前綴。
 * 限定 Qwen 路徑（非 Qwen 的 JSON-fallback 走另一條 GBNF/regex，不在這裡處理）。
 *
 * 對應行為（與 OpenAI spec 一致）：
 *   - undefined / "auto" / "none" → 回 undefined（不強制；"none" 由上層另行決定是否完全跳過 tools 區塊）
 *   - "required" → `<tool_call>\n<function=`（強制要呼叫某個 tool，但讓模型自選 function name）
 *   - {type:"function", function:{name:"X"}} → `<tool_call>\n<function=X>\n`（強制呼叫 X，模型只能補 `<parameter=...>` 與收尾）
 *
 * 設計選擇 — 為什麼用 prefix-token 而不是 GBNF：
 *   GBNF 路線需要把 OpenAI JSON Schema → Qwen pythonic-XML grammar 轉換（M-TCQ-SHIM-2-5
 *   已 defer）。Prefix-token 方案只是把 assistant 回覆的開頭幾個字硬塞給 decoder，
 *   後續 sampling 走原本邏輯。對「強制呼叫」這個需求 100% 夠用，工作量低。
 *
 * 注意：呼叫端要把這段前綴**不剝離**（與 reasoning 的 `</think>\n\n` 前綴不同），
 * parseQwenToolCalls 才看得到完整的 `<tool_call>...</tool_call>` block。
 */
export function buildQwenToolChoicePrefix(toolChoice: unknown): string | undefined {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === "string") {
        if (toolChoice === "required") return "<tool_call>\n<function=";
        return undefined;
    }
    if (typeof toolChoice === "object") {
        const tc = toolChoice as {type?: unknown, function?: {name?: unknown}};
        if (tc.type === "function" && tc.function != null && typeof tc.function.name === "string" && tc.function.name.length > 0) {
            return `<tool_call>\n<function=${tc.function.name}>\n`;
        }
    }
    return undefined;
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
/**
 * M-TCQ-SHIM-FIXUP-3：Q4 量化下模型偶爾把 `<parameter=key>val</parameter>` 退化成
 * 直接的 `<key>val</key>` 變種（debug-c13-mitigations.ts M4 觀察到）。當嚴格 PARAM_RE
 * 0 match 但 inner block 看起來有資料時，回退到這個寬鬆 regex —— 但**只接受**
 * declared tool 的 properties 白名單裡的 key 名稱（避免亂抓 `<think>`、`<code>`、
 * `<tool_response>` 之類的非參數 tag）。
 */
const LOOSE_PARAM_RE = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g;

export type QwenExtractResult = {
    content: string,
    toolCalls: OpenAIToolCall[],
    /** B3：parseQwenToolCalls 完成後 content 仍含的 XML 標記（漏出 / 殘留）。null = 沒漏。 */
    leak: ToolCallLeakReport | null
};

/**
 * B3：tool-format XML 漏出偵測結果。
 *
 * 漏出情境（觀察自 sampling preset E2E）：
 *   - `<tool_call>` 開了沒收（unclosed） → 整段被當文字
 *   - 模型把 `<parameter=k>v</parameter>` 退化成 `<k>v</k>` 但 declared tool 沒這 key
 *   - `<tool_call>` 出現在 prose（解釋自身語法時）— deliberate-but-still-bad
 *   - `<tools>` / `<tool_response>` 區塊漏到 user-visible 內容
 *
 * 此 report 純為觀測：parser 不會替使用者「修補」，因為已有 LOOSE_PARAM_RE
 * 那層補救；漏出代表那層沒救起來，呼叫端要不要 retry / 警示 由更上層決定。
 */
export type ToolCallLeakReport = {
    /** 命中的 marker 種類（去重；按出現順序） */
    markers: ToolCallLeakMarker[],
    /** 第一個 marker 周圍 ±60 字 context，方便 log 對應原文 */
    snippet: string,
    /** content 全長（snippet 是切片） */
    contentLength: number
};

export type ToolCallLeakMarker =
    | "tool_call_open"
    | "tool_call_close"
    | "function_open"
    | "function_close"
    | "parameter_open"
    | "parameter_close"
    | "tools_block"
    | "tool_response";

const LEAK_PATTERNS: ReadonlyArray<{kind: ToolCallLeakMarker, re: RegExp}> = [
    {kind: "tool_call_open", re: /<tool_call\b[^>]*>/},
    {kind: "tool_call_close", re: /<\/tool_call>/},
    {kind: "function_open", re: /<function=[^>]+>/},
    {kind: "function_close", re: /<\/function>/},
    {kind: "parameter_open", re: /<parameter=[^>]+>/},
    {kind: "parameter_close", re: /<\/parameter>/},
    {kind: "tools_block", re: /<\/?tools>/},
    {kind: "tool_response", re: /<\/?tool_response>/}
];

/**
 * B3：掃描 parseQwenToolCalls 留下的 content 是否含 tool-format XML 殘骸。
 * 命中任一即視為漏出，回 ToolCallLeakReport；無漏 = null（呼叫端 if 判斷簡潔）。
 *
 * 不消耗大量 CPU：每個 pattern 一次 RegExp.exec（非全域），早 break 用第一個命中當 anchor。
 */
export function detectToolCallLeak(content: string): ToolCallLeakReport | null {
    if (content.length === 0) return null;
    const hits: {kind: ToolCallLeakMarker, index: number}[] = [];
    for (const {kind, re} of LEAK_PATTERNS) {
        const m = re.exec(content);
        if (m != null) hits.push({kind, index: m.index});
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.index - b.index);
    const anchor = hits[0]!;
    const start = Math.max(0, anchor.index - 60);
    const end = Math.min(content.length, anchor.index + 120);
    const snippet = (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
    return {
        markers: [...new Set(hits.map((h) => h.kind))],
        snippet,
        contentLength: content.length
    };
}

/**
 * Parse all <tool_call> blocks from a model response. Returns the leftover
 * (non-tool-call) text as `content` and the recovered calls in OpenAI shape.
 *
 * Coercion: integer / float / boolean / nested JSON values are auto-typed; bare
 * strings stay strings. Unknown tool names are filtered out.
 */
/** M-TCQ-SHIM-FIXUP-3：取出某個 tool 的 properties key 白名單（用於寬鬆解析）。 */
function getToolParamKeys(tool: OpenAIToolDef): Set<string> {
    const params = tool.function.parameters as any;
    const props = (params != null && typeof params === "object") ? params.properties : null;
    if (props == null || typeof props !== "object") return new Set();
    return new Set(Object.keys(props));
}

export function parseQwenToolCalls(text: string, declaredTools: OpenAIToolDef[]): QwenExtractResult {
    const toolByName = new Map(declaredTools.map((t) => [t.function.name, t]));
    const calls: OpenAIToolCall[] = [];
    let stripped = text;

    const matches = [...text.matchAll(TOOL_CALL_RE)];
    for (const m of matches) {
        const name = (m[1] ?? "").trim();
        const inner = m[2] ?? "";
        const tool = toolByName.get(name);
        if (tool == null) continue;
        const args: Record<string, unknown> = {};
        for (const p of inner.matchAll(PARAM_RE)) {
            const k = (p[1] ?? "").trim();
            const raw = (p[2] ?? "").trim();
            args[k] = coerceParamValue(raw);
        }
        // M-TCQ-SHIM-FIXUP-3：嚴格 0 match → 寬鬆（白名單限定 declared properties）。
        // 同時保留嚴格優先 — 嚴格抓得到任何一個就不啟用寬鬆，避免兩種格式並存時誤抓。
        if (Object.keys(args).length === 0) {
            const allowedKeys = getToolParamKeys(tool);
            if (allowedKeys.size > 0) {
                for (const p of inner.matchAll(LOOSE_PARAM_RE)) {
                    const k = (p[1] ?? "").trim();
                    if (!allowedKeys.has(k)) continue;
                    const raw = (p[2] ?? "").trim();
                    args[k] = coerceParamValue(raw);
                }
            }
        }
        calls.push({
            id: `call_${nanoid(10)}`,
            type: "function",
            function: {name, arguments: JSON.stringify(args)}
        });
        stripped = stripped.replace(m[0], "");
    }
    const finalContent = stripped.trim();
    return {content: finalContent, toolCalls: calls, leak: detectToolCallLeak(finalContent)};
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
