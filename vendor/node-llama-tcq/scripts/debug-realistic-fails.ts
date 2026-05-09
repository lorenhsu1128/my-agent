// 把 live-test-realistic 4 個 fail case 抽出來單跑，印出 reasoning + 回應全文。
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const IMAGE = path.resolve(process.env.IMAGE ?? "llama/llama.cpp/tools/mtmd/test-1.jpeg");
const fileUrl = `file:///${IMAGE.replace(/\\/g, "/")}`;

const TOOLS = [
    {type: "function", function: {name: "read_file", description: "讀取檔案內容", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}},
    {type: "function", function: {name: "edit_file", description: "編輯檔案", parameters: {type: "object", properties: {path: {type: "string"}, old_str: {type: "string"}, new_str: {type: "string"}}, required: ["path", "old_str", "new_str"]}}},
    {type: "function", function: {name: "run_shell", description: "執行 shell 指令", parameters: {type: "object", properties: {cmd: {type: "string"}, cwd: {type: "string"}}, required: ["cmd"]}}},
    {type: "function", function: {name: "search_web", description: "搜尋網路", parameters: {type: "object", properties: {query: {type: "string"}, max_results: {type: "integer"}}, required: ["query"]}}},
    {type: "function", function: {name: "fetch_url", description: "抓取 URL 內容", parameters: {type: "object", properties: {url: {type: "string"}}, required: ["url"]}}},
    {type: "function", function: {name: "calculator", description: "四則運算", parameters: {type: "object", properties: {op: {type: "string", enum: ["add", "sub", "mul", "div"]}, a: {type: "number"}, b: {type: "number"}}, required: ["op", "a", "b"]}}}
];

async function run(label: string, body: any, expectTool?: string) {
    console.log(`\n${"=".repeat(80)}\n[${label}] expectTool=${expectTool ?? "(any)"}\n${"=".repeat(80)}`);
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({...body, model: MODEL})
    });
    const j: any = await res.json().catch(() => ({}));
    const dt = Date.now() - t0;
    const ch = j?.choices?.[0];
    const content = ch?.message?.content ?? "";
    const reasoning = ch?.message?.reasoning_content ?? "";
    const toolCalls = ch?.message?.tool_calls ?? [];
    const usage = j?.usage ?? {};
    console.log(`status=${res.status} time=${dt}ms p=${usage.prompt_tokens}t c=${usage.completion_tokens}t finish=${ch?.finish_reason}`);
    if (reasoning) console.log(`-- reasoning_content (${reasoning.length}ch) --\n${reasoning}\n`);
    if (toolCalls.length > 0) {
        console.log(`-- tool_calls (${toolCalls.length}) --`);
        for (const tc of toolCalls) console.log(`  ${tc.function.name}(${tc.function.arguments})`);
    }
    if (content) console.log(`-- content (${content.length}ch) --\n${content}\n`);
    const ok = expectTool ? toolCalls.some((t: any) => t.function?.name === expectTool) : true;
    console.log(`=> ${ok ? "PASS" : "FAIL"}`);
    return {ok, content, reasoning, toolCalls};
}

(async () => {
    /* C1.3：多輪後再次 tool call — 期望 edit_file，實得 read_file */
    {
        const history = [
            {role: "system", content: "你是 my-agent 的 coding agent。會用工具讀檔、改檔、跑指令。簡短回答，能呼叫工具就直接呼叫。"},
            {role: "user", content: "幫我看一下 src/server/utils.ts 有什麼 export，然後告訴我有沒有 todo 標記。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "read_file", arguments: JSON.stringify({path: "src/server/utils.ts"})}}]},
            {role: "tool", tool_call_id: "x1", content: "export function delay(ms: number) {...}\nexport const VERSION = '1.2.0';\n// TODO: refactor delay to use AbortSignal\nexport class Cache<K,V> {...}"},
            {role: "assistant", content: "src/server/utils.ts 匯出 delay、VERSION、Cache，有一個 TODO 標記在 delay 旁邊（建議改用 AbortSignal）。"},
            {role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"}
        ];
        await run("C1.3 edit_file expected", {messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 512, reasoning: "off"}, "edit_file");
    }

    /* C1.4：連續 tool 鏈 — 期望 run_shell，實得純文字 */
    {
        const history = [
            {role: "system", content: "你是 my-agent 的 coding agent。會用工具讀檔、改檔、跑指令。簡短回答，能呼叫工具就直接呼叫。"},
            {role: "user", content: "幫我看一下 src/server/utils.ts 有什麼 export。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "read_file", arguments: JSON.stringify({path: "src/server/utils.ts"})}}]},
            {role: "tool", tool_call_id: "x1", content: "export function delay(...)..."},
            {role: "assistant", content: "看到了，有個 TODO。"},
            {role: "user", content: "把 TODO 那個 delay 改成接受 AbortSignal。直接 edit_file。"},
            {role: "assistant", content: null, tool_calls: [{id: "x2", type: "function", function: {name: "edit_file", arguments: JSON.stringify({path: "src/server/utils.ts", old_str: "function delay(ms: number)", new_str: "function delay(ms: number, signal?: AbortSignal)"})}}]},
            {role: "tool", tool_call_id: "x2", content: "edit applied successfully"},
            {role: "user", content: "好，跑一下 typecheck 看有沒有壞掉。"}
        ];
        await run("C1.4 run_shell expected", {messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, "run_shell");
    }

    /* C2.2：fetch_url 接續 — 期望 fetch_url，實得純文字 */
    {
        const history = [
            {role: "system", content: "你是研究助理。可用 search_web / fetch_url 工具。"},
            {role: "user", content: "幫我查一下 OpenAI o1 的 reasoning_effort 參數有哪些值。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "search_web", arguments: JSON.stringify({query: "OpenAI o1 reasoning_effort values"})}}]},
            {role: "tool", tool_call_id: "x1", content: JSON.stringify({results: [
                {title: "OpenAI Reasoning models guide", url: "https://platform.openai.com/docs/guides/reasoning", snippet: "reasoning_effort accepts: low, medium, high. Default medium."},
                {title: "o1 release notes", url: "https://openai.com/blog/o1", snippet: "..."}
            ]})}
        ];
        await run("C2.2 fetch_url expected", {messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, "fetch_url");
    }

    /* C4.2：vision 後 tool_call — 期望 calculator，實得純文字 */
    {
        const history = [
            {role: "system", content: "助理：先看圖，需要時用 tool。"},
            {role: "user", content: [
                {type: "text", text: "從這張圖認出年份和事件，然後用 calculator 算今年距離那年幾年（今年 2026）。"},
                {type: "image_url", image_url: {url: fileUrl}}
            ]},
            {role: "assistant", content: "圖中是阿波羅11號登月（1969 年）。"},
            {role: "user", content: "好，現在用 calculator(sub, 2026, 1969) 算一下。"}
        ];
        await run("C4.2 calculator expected (vision-history)", {messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, "calculator");

        // 對照組：拿掉 vision history，只留純文字 — 應該成功
        const history2 = [
            {role: "system", content: "助理：先看圖，需要時用 tool。"},
            {role: "user", content: "我之前看了一張圖，認出是阿波羅11號登月（1969 年）。"},
            {role: "assistant", content: "了解，1969 年。"},
            {role: "user", content: "好，現在用 calculator(sub, 2026, 1969) 算一下。"}
        ];
        await run("C4.2-control text-only history", {messages: history2, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, "calculator");
    }
})();
