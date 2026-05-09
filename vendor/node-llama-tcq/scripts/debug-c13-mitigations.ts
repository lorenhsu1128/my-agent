// 驗 C1.3 各種 mitigation：tool_choice 強制 / 增加 hint / 拿掉 prior tool history。
const BASE = "http://127.0.0.1:8081";
const MODEL = "qwen3.5-9b";

const TOOLS_10 = [
    {type: "function", function: {name: "read_file", description: "讀取檔案內容", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}},
    {type: "function", function: {name: "edit_file", description: "編輯檔案", parameters: {type: "object", properties: {path: {type: "string"}, old_str: {type: "string"}, new_str: {type: "string"}}, required: ["path", "old_str", "new_str"]}}},
    {type: "function", function: {name: "run_shell", description: "執行 shell 指令", parameters: {type: "object", properties: {cmd: {type: "string"}, cwd: {type: "string"}}, required: ["cmd"]}}},
    {type: "function", function: {name: "search_web", description: "搜尋網路", parameters: {type: "object", properties: {query: {type: "string"}, max_results: {type: "integer"}}, required: ["query"]}}},
    {type: "function", function: {name: "fetch_url", description: "抓取 URL 內容", parameters: {type: "object", properties: {url: {type: "string"}}, required: ["url"]}}},
    {type: "function", function: {name: "get_weather", description: "查詢城市天氣", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}},
    {type: "function", function: {name: "translate", description: "翻譯", parameters: {type: "object", properties: {text: {type: "string"}, target_lang: {type: "string", enum: ["en", "zh-TW", "ja"]}}, required: ["text", "target_lang"]}}},
    {type: "function", function: {name: "calculator", description: "四則運算", parameters: {type: "object", properties: {op: {type: "string", enum: ["add", "sub", "mul", "div"]}, a: {type: "number"}, b: {type: "number"}}, required: ["op", "a", "b"]}}},
    {type: "function", function: {name: "git_status", description: "顯示 git 狀態", parameters: {type: "object", properties: {}}}},
    {type: "function", function: {name: "create_pr", description: "建立 PR", parameters: {type: "object", properties: {title: {type: "string"}, body: {type: "string"}, base: {type: "string"}}, required: ["title", "body"]}}}
];

const BASE_HISTORY = [
    {role: "system", content: "你是 my-agent 的 coding agent。會用工具讀檔、改檔、跑指令。簡短回答，能呼叫工具就直接呼叫。"},
    {role: "user", content: "幫我看一下 src/server/utils.ts 有什麼 export，然後告訴我有沒有 todo 標記。"},
    {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "read_file", arguments: JSON.stringify({path: "src/server/utils.ts"})}}]},
    {role: "tool", tool_call_id: "x1", content: "export function delay(ms: number) {...}\nexport const VERSION = '1.2.0';\n// TODO: refactor delay to use AbortSignal\nexport class Cache<K,V> {...}"},
    {role: "assistant", content: "src/server/utils.ts 匯出 delay、VERSION、Cache，有一個 TODO 標記在 delay 旁邊（建議改用 AbortSignal）。"}
];

async function trial(label: string, body: any) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({...body, model: MODEL})
    });
    const j: any = await res.json();
    const ch = j?.choices?.[0];
    const tcs = ch?.message?.tool_calls ?? [];
    const tcStr = tcs.map((t: any) => `${t.function.name}(${t.function.arguments})`).join(" | ");
    console.log(`[${label}] ${Date.now() - t0}ms p=${j.usage?.prompt_tokens} c=${j.usage?.completion_tokens} finish=${ch?.finish_reason}`);
    console.log(`  tool_calls: ${tcStr || "(none)"}`);
    if (ch?.message?.content) console.log(`  content: ${ch.message.content.slice(0, 200)}`);
    const ok = tcs.some((t: any) => {
        if (t.function?.name !== "edit_file") return false;
        try { const a = JSON.parse(t.function.arguments); return a.path && a.new_str; } catch { return false; }
    });
    console.log(`  => ${ok ? "PASS" : "FAIL"}\n`);
}

(async () => {
    /* M0：原版 — 10 tools, tool_choice auto */
    await trial("M0 原版 (10 tools)", {
        messages: [...BASE_HISTORY, {role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"}],
        tools: TOOLS_10, tool_choice: "auto", max_tokens: 512, reasoning: "off"
    });

    /* M1：tool_choice 強制 edit_file */
    await trial("M1 強制 edit_file", {
        messages: [...BASE_HISTORY, {role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"}],
        tools: TOOLS_10, tool_choice: {type: "function", function: {name: "edit_file"}}, max_tokens: 512, reasoning: "off"
    });

    /* M2：tool_choice required */
    await trial("M2 tool_choice required", {
        messages: [...BASE_HISTORY, {role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"}],
        tools: TOOLS_10, tool_choice: "required", max_tokens: 512, reasoning: "off"
    });

    /* M3：開 thinking + 10 tools */
    await trial("M3 thinking on (10 tools)", {
        messages: [...BASE_HISTORY, {role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"}],
        tools: TOOLS_10, tool_choice: "auto", max_tokens: 1024, reasoning: "on"
    });

    /* M4：更明確的 user prompt — 給 path / old_str 範例 */
    await trial("M4 明確 user prompt", {
        messages: [...BASE_HISTORY, {role: "user", content: "請呼叫 edit_file 工具，把 src/server/utils.ts 的 'function delay(ms: number)' 替換為 'function delay(ms: number, signal?: AbortSignal)'。"}],
        tools: TOOLS_10, tool_choice: "auto", max_tokens: 512, reasoning: "off"
    });
})();
