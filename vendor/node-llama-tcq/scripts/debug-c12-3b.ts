// 針對 C12.3b 鏈式 step2 抽測：模型拿到 38°C 後到底要怎麼樣才願意呼 send_alert？
// 跑 6 個變體，印 tool_calls / content / reasoning，定位是 prompting / reasoning / temp 的問題。
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

const TOOLS = [
    {type: "function", function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}},
    {type: "function", function: {name: "send_alert", description: "發送天氣警報通知", parameters: {type: "object", properties: {city: {type: "string"}, severity: {type: "string", enum: ["low", "medium", "high"]}, message: {type: "string"}}, required: ["city", "severity", "message"]}}}
];

type V = {label: string, messages: any[], extra?: any};
const VARIANTS: V[] = [
    {
        label: "V1 原樣（advanced runner 用的）",
        messages: [
            {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"},
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'}
        ]
    },
    {
        label: "V2 加一句 user follow-up",
        messages: [
            {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"},
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'},
            {role: "user", content: "看溫度判斷要不要發警報。"}
        ]
    },
    {
        label: "V3 system 更強硬",
        messages: [
            {role: "system", content: "你是天氣監控助理。流程：先用 get_weather 查溫度 → 若 >35 或 <0 必須立刻呼叫 send_alert（不要只用文字回答）。這是強制 SOP。"},
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'}
        ]
    },
    {
        label: "V4 reasoning=on max=2048",
        messages: [
            {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"},
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'}
        ],
        extra: {reasoning: "on", max_tokens: 2048}
    },
    {
        label: "V5 tool 結果更誇張 + danger 字眼",
        messages: [
            {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"},
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":42,"condition":"晴","note":"危險高溫"}'}
        ]
    },
    {
        label: "V6 tool_choice=required 強迫呼工具",
        messages: [
            {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"},
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'}
        ],
        extra: {tool_choice: "required"}
    }
];

(async () => {
    for (const v of VARIANTS) {
        const t0 = Date.now();
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: MODEL,
                messages: v.messages,
                tools: TOOLS,
                tool_choice: "auto",
                max_tokens: 512,
                reasoning: "off",
                ...(v.extra ?? {})
            })
        });
        const dt = Date.now() - t0;
        const j: any = await res.json().catch(() => ({}));
        const choice = j?.choices?.[0];
        const content: string = choice?.message?.content ?? "";
        const reasoning: string = choice?.message?.reasoning_content ?? "";
        const tcs = choice?.message?.tool_calls ?? [];
        const usage = j?.usage ?? {};
        console.log(`\n${"=".repeat(80)}`);
        console.log(`[${v.label}] HTTP ${res.status} ${dt}ms p=${usage.prompt_tokens} c=${usage.completion_tokens} finish=${choice?.finish_reason}`);
        if (reasoning) console.log(`-- reasoning (${reasoning.length}ch):\n${reasoning.slice(0, 600)}`);
        if (tcs.length) {
            console.log(`-- tool_calls(${tcs.length}):`);
            for (const t of tcs) console.log(`   • ${t.function.name}(${t.function.arguments})`);
        } else {
            console.log("-- tool_calls: (none)");
        }
        console.log(`-- content (${content.length}ch):\n${content.slice(0, 600)}`);
        const sentAlert = tcs.find((t: any) => t.function?.name === "send_alert");
        console.log(`-- result: ${sentAlert ? "✅ send_alert" : "❌ no send_alert"}`);
    }
})();
