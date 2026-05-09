// C1.3 變體 — 測 reasoning on/off 對 Q4 quant tool-call 退化的影響。
const BASE = "http://127.0.0.1:8081";
const MODEL = "qwen3.5-9b";

const TOOLS = [
    {type: "function", function: {name: "read_file", description: "讀取檔案內容", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}},
    {type: "function", function: {name: "edit_file", description: "編輯檔案", parameters: {type: "object", properties: {path: {type: "string"}, old_str: {type: "string"}, new_str: {type: "string"}}, required: ["path", "old_str", "new_str"]}}},
    {type: "function", function: {name: "run_shell", description: "執行 shell 指令", parameters: {type: "object", properties: {cmd: {type: "string"}}, required: ["cmd"]}}}
];

const HISTORY = [
    {role: "system", content: "你是 my-agent 的 coding agent。會用工具讀檔、改檔、跑指令。簡短回答，能呼叫工具就直接呼叫。"},
    {role: "user", content: "幫我看一下 src/server/utils.ts 有什麼 export，然後告訴我有沒有 todo 標記。"},
    {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "read_file", arguments: JSON.stringify({path: "src/server/utils.ts"})}}]},
    {role: "tool", tool_call_id: "x1", content: "export function delay(ms: number) {...}\nexport const VERSION = '1.2.0';\n// TODO: refactor delay to use AbortSignal\nexport class Cache<K,V> {...}"},
    {role: "assistant", content: "src/server/utils.ts 匯出 delay、VERSION、Cache，有一個 TODO 標記在 delay 旁邊（建議改用 AbortSignal）。"},
    {role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"}
];

async function trial(label: string, reasoning: "on" | "off" | "auto") {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({model: MODEL, messages: HISTORY, tools: TOOLS, tool_choice: "auto", max_tokens: 1024, reasoning})
    });
    const j: any = await res.json();
    const ch = j?.choices?.[0];
    const dt = Date.now() - t0;
    const tcs = ch?.message?.tool_calls ?? [];
    const tcStr = tcs.map((t: any) => `${t.function.name}(${t.function.arguments})`).join(" | ");
    console.log(`[${label} reasoning=${reasoning}] ${dt}ms p=${j.usage?.prompt_tokens} c=${j.usage?.completion_tokens}`);
    console.log(`  tool_calls: ${tcStr || "(none)"}`);
    if (ch?.message?.reasoning_content) console.log(`  reasoning(${ch.message.reasoning_content.length}ch): ${ch.message.reasoning_content.slice(0, 200)}...`);
    if (ch?.message?.content) console.log(`  content(${ch.message.content.length}ch): ${ch.message.content.slice(0, 200)}`);
    const ok = tcs.some((t: any) => t.function?.name === "edit_file" && t.function.arguments && t.function.arguments !== "{}");
    console.log(`  => ${ok ? "PASS" : "FAIL"}\n`);
}

(async () => {
    for (let i = 0; i < 3; i++) {
        console.log(`\n========== run ${i + 1} ==========`);
        await trial("C1.3", "off");
        await trial("C1.3", "on");
    }
})();
