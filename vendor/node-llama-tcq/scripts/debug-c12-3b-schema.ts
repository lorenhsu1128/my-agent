// 鎖定假設：A 案模型呼 send_alert 時 args 是 {city, temperature, condition, message}，
// 完全照抄上一個 tool_response 的 keys。
// T1: 把 tool_response 的 keys 改名 → 看模型有沒有跟著抄
// T2: 第二步只宣告 send_alert（拿掉 get_weather）→ 看是否 multi-tool schema 混淆
// T3: 不走 chain，文字塞 user → 看 send_alert schema 在乾淨 context 是否正確

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

const GET_WEATHER = {type: "function", function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}};
const SEND_ALERT = {type: "function", function: {name: "send_alert", description: "發送天氣警報通知", parameters: {type: "object", properties: {city: {type: "string"}, severity: {type: "string", enum: ["low", "medium", "high"]}, message: {type: "string"}}, required: ["city", "severity", "message"]}}};
const SYSTEM = {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"};

async function call(messages: any[], tools: any[]) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({model: MODEL, messages, tools, tool_choice: "auto", max_tokens: 512, reasoning: "off"})});
    const dt = Date.now() - t0;
    const j: any = await res.json().catch(() => ({}));
    const choice = j?.choices?.[0];
    return {dt, content: (choice?.message?.content ?? "") as string, toolCalls: (choice?.message?.tool_calls ?? []) as any[]};
}

(async () => {
    // ===== T1: result keys 改名 =====
    console.log("\n=== T1: tool_response 改用怪 keys（location_name/temp_celsius/sky_state）===");
    {
        const hist = [
            SYSTEM,
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"location_name":"高雄","temp_celsius":38,"sky_state":"sunny"}'},
            {role: "user", content: "依溫度判斷是否需要警報；若需要請呼叫 send_alert。"}
        ];
        const r = await call(hist, [GET_WEATHER, SEND_ALERT]);
        const tc = r.toolCalls.find((t: any) => t.function?.name === "send_alert");
        console.log(`  ${r.dt}ms tool=${r.toolCalls.map((t: any) => t.function.name).join(",") || "(none)"}`);
        if (tc) console.log(`  raw args: ${tc.function.arguments}`);
        if (r.content) console.log(`  content[0..200]: ${r.content.slice(0, 200)}`);
    }

    // ===== T2: 第二步 tools 只剩 send_alert =====
    console.log("\n=== T2: 第二步只宣告 send_alert（無 get_weather 干擾）===");
    {
        const hist = [
            SYSTEM,
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'},
            {role: "user", content: "依溫度判斷是否需要警報；若需要請呼叫 send_alert。"}
        ];
        const r = await call(hist, [SEND_ALERT]);
        const tc = r.toolCalls.find((t: any) => t.function?.name === "send_alert");
        console.log(`  ${r.dt}ms tool=${r.toolCalls.map((t: any) => t.function.name).join(",") || "(none)"}`);
        if (tc) console.log(`  raw args: ${tc.function.arguments}`);
        if (r.content) console.log(`  content[0..200]: ${r.content.slice(0, 200)}`);
    }

    // ===== T3: 乾淨 history，文字塞溫度資訊 =====
    console.log("\n=== T3: 乾淨 history，user 直接告知溫度（無 prior tool_call）===");
    {
        const hist = [
            SYSTEM,
            {role: "user", content: "高雄目前氣溫 38 度，天氣晴。請判斷並若需要警報就呼叫 send_alert。"}
        ];
        const r = await call(hist, [GET_WEATHER, SEND_ALERT]);
        const tc = r.toolCalls.find((t: any) => t.function?.name === "send_alert");
        console.log(`  ${r.dt}ms tool=${r.toolCalls.map((t: any) => t.function.name).join(",") || "(none)"}`);
        if (tc) console.log(`  raw args: ${tc.function.arguments}`);
        if (r.content) console.log(`  content[0..200]: ${r.content.slice(0, 200)}`);
    }

    // ===== T4: 同 T1 但兩個 tools 都在 =====（控制組）
    console.log("\n=== T4: 控制組 — 跟 T1 一樣的乾淨 keys，看與 baseline 比較 ===");
    {
        const hist = [
            SYSTEM,
            {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
            {role: "assistant", content: null, tool_calls: [{id: "x1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "高雄"})}}]},
            {role: "tool", tool_call_id: "x1", content: '{"city":"高雄","temperature":38,"condition":"晴"}'},
            {role: "user", content: "依溫度判斷是否需要警報；若需要請呼叫 send_alert。"}
        ];
        const r = await call(hist, [GET_WEATHER, SEND_ALERT]);
        const tc = r.toolCalls.find((t: any) => t.function?.name === "send_alert");
        console.log(`  ${r.dt}ms tool=${r.toolCalls.map((t: any) => t.function.name).join(",") || "(none)"}`);
        if (tc) console.log(`  raw args: ${tc.function.arguments}`);
        if (r.content) console.log(`  content[0..200]: ${r.content.slice(0, 200)}`);
    }
})();
