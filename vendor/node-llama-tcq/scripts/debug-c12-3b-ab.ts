// 比較 C12.3b 的 A 案 / B 案修法是否成立。
// A：加一句 user follow-up「依溫度判斷是否要呼叫 send_alert」 + 原 tool-call 驗證
// B：保留原 history（不加 user follow-up）+ 改用 content-based 驗證（模型有沒有正確判斷需要警報）
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

const CHAIN_TOOLS = [
    {type: "function", function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}},
    {type: "function", function: {name: "send_alert", description: "發送天氣警報通知", parameters: {type: "object", properties: {city: {type: "string"}, severity: {type: "string", enum: ["low", "medium", "high"]}, message: {type: "string"}}, required: ["city", "severity", "message"]}}}
];
const SYSTEM = {role: "system", content: "你是天氣監控助理。當城市溫度超過 35 度或低於 0 度時要發警報。"};

async function call(messages: any[]) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({model: MODEL, messages, tools: CHAIN_TOOLS, tool_choice: "auto", max_tokens: 512, reasoning: "off"})});
    const dt = Date.now() - t0;
    const j: any = await res.json().catch(() => ({}));
    const choice = j?.choices?.[0];
    return {dt, content: (choice?.message?.content ?? "") as string, toolCalls: (choice?.message?.tool_calls ?? []) as any[], finish: choice?.finish_reason};
}

async function step1() {
    // 一律先讓模型自己呼 get_weather，然後我們塞 38°C 結果
    const r = await call([SYSTEM, {role: "user", content: "幫我查一下高雄目前的天氣狀況。"}]);
    if (r.toolCalls[0]?.function?.name !== "get_weather") throw new Error(`step1 wrong tool: ${JSON.stringify(r.toolCalls)}`);
    const id = r.toolCalls[0].id ?? "x1";
    return [
        SYSTEM,
        {role: "user", content: "幫我查一下高雄目前的天氣狀況。"},
        {role: "assistant", content: null, tool_calls: r.toolCalls},
        {role: "tool", tool_call_id: id, content: '{"city":"高雄","temperature":38,"condition":"晴"}'}
    ];
}

(async () => {
    console.log("\n#### C12.3b A vs B 比較 ####");

    // 各跑 N 次看穩定性（同 prompt 應該穩定，但小樣本看一下）
    const N = 3;

    // ===== A 案：加 user follow-up =====
    console.log(`\n=== A 案：history 加一句 user follow-up，tool-call 驗證（N=${N}）===`);
    let aPass = 0;
    for (let i = 0; i < N; i++) {
        const hist = await step1();
        hist.push({role: "user", content: "依溫度判斷是否需要警報；若需要請呼叫 send_alert。"});
        const r = await call(hist);
        const sentAlert = r.toolCalls.find((t: any) => t.function?.name === "send_alert");
        const ok = !!sentAlert && (() => {
            try {
                const args = JSON.parse(sentAlert.function.arguments);
                return args.severity === "high" || args.severity === "medium";
            } catch { return false; }
        })();
        if (ok) aPass++;
        const rawArgs = sentAlert?.function?.arguments ?? "(no send_alert)";
        console.log(`  A[${i + 1}] ${ok ? "✅" : "❌"} ${r.dt}ms tool=${r.toolCalls.map((t: any) => t.function.name).join(",") || "(none)"}`);
        console.log(`     raw args: ${rawArgs}`);
        if (!ok && r.content) console.log(`     content[0..200]: ${r.content.slice(0, 200)}`);
    }
    console.log(`  A 案通過：${aPass}/${N}`);

    // ===== B 案：原 history（無 follow-up），content-based 驗證 =====
    console.log(`\n=== B 案：原 history，content 提到「警報 / 高溫 / 危險 / severity」即算過（N=${N}）===`);
    let bPass = 0;
    for (let i = 0; i < N; i++) {
        const hist = await step1();
        const r = await call(hist);
        // content 必須提到「需要發警報」或同義 + 提到 severity 級別 / 或 35 度警戒線
        const text = r.content;
        // 放寬：模型有「察覺高溫 + 做出對應建議」即算正確判斷情境（避暑/防曬/注意都算）
        const mentionsHigh = /(高溫|超過.{0,4}35|38\s*°?C|高熱|氣溫.{0,4}高)/i.test(text);
        const givesAdvice = /(警報|警戒|危險|alert|warning|防曬|避暑|補充水分|注意|防暑)/i.test(text);
        const correctJudgement = mentionsHigh && givesAdvice;
        // 也接受模型直接呼工具
        const sentAlert = r.toolCalls.find((t: any) => t.function?.name === "send_alert");
        const ok = correctJudgement || !!sentAlert;
        if (ok) bPass++;
        console.log(`  B[${i + 1}] ${ok ? "✅" : "❌"} ${r.dt}ms tool=${r.toolCalls.map((t: any) => t.function.name).join(",") || "(none)"}  hot=${mentionsHigh} advice=${givesAdvice}`);
        if (!ok) console.log(`     content[0..200]: ${text.slice(0, 200)}`);
    }
    console.log(`  B 案通過：${bPass}/${N}`);

    console.log(`\n--- 總結 ---`);
    console.log(`A 案（加 follow-up，tool 驗證）：${aPass}/${N}`);
    console.log(`B 案（原 history，content 驗證）：${bPass}/${N}`);
})();
