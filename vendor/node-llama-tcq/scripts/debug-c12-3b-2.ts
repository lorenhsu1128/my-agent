// 進階：V7 tool_choice 指名 / V8 user 直接命令 / V9 看 raw prompt 是不是把 tool_choice 吃掉
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const TOOLS = [
    {type: "function", function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}},
    {type: "function", function: {name: "send_alert", description: "發送天氣警報通知", parameters: {type: "object", properties: {city: {type: "string"}, severity: {type: "string", enum: ["low", "medium", "high"]}, message: {type: "string"}}, required: ["city", "severity", "message"]}}}
];
const BASE_HIST = [
    {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"},
    {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
    {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
    {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'}
];

const VARIANTS = [
    {label: "V7 tool_choice 指名 send_alert", body: {messages: BASE_HIST, tools: TOOLS, tool_choice: {type: "function", function: {name: "send_alert"}}, max_tokens: 512}},
    {label: "V8 加 user：『發警報』", body: {messages: [...BASE_HIST, {role: "user", content: "請發警報。"}], tools: TOOLS, tool_choice: "auto", max_tokens: 512}},
    {label: "V9 user 直接命令呼 send_alert", body: {messages: [...BASE_HIST, {role: "user", content: "現在呼叫 send_alert，city=高雄、severity=high、message=高溫 38 度警報。"}], tools: TOOLS, tool_choice: "auto", max_tokens: 512}},
    {label: "V10 tool_choice required + 移除原本 assistant tool_call", body: {messages: [
        {role: "system", content: "你是天氣監控助理。溫度超過 35 度或低於 0 度時必須呼叫 send_alert。"},
        {role: "user", content: "高雄現在 38 度晴。需要警報嗎？"}
    ], tools: TOOLS, tool_choice: "required", max_tokens: 512}}
];
(async () => {
    for (const v of VARIANTS) {
        const t0 = Date.now();
        const res = await fetch(`${BASE}/v1/chat/completions`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({model: MODEL, ...v.body})});
        const dt = Date.now() - t0;
        const j: any = await res.json().catch(() => ({}));
        const choice = j?.choices?.[0];
        const content: string = choice?.message?.content ?? "";
        const tcs = choice?.message?.tool_calls ?? [];
        console.log(`\n${"=".repeat(80)}\n[${v.label}] HTTP ${res.status} ${dt}ms finish=${choice?.finish_reason}`);
        if (j?.error) console.log("ERR:", JSON.stringify(j.error));
        if (tcs.length) for (const t of tcs) console.log(`  tool: ${t.function.name}(${t.function.arguments})`);
        else console.log("  tool_calls: (none)");
        console.log(`  content[0..400]: ${content.slice(0, 400)}`);
        const sa = tcs.find((t: any) => t.function?.name === "send_alert");
        console.log(`  result: ${sa ? "✅" : "❌"}`);
    }
})();
