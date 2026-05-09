// Live HTTP test runner for TCQ-shim. Run with: bun scripts/live-test-shim.ts
// Source file is UTF-8 → request bodies preserve Chinese correctly.
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
let pass = 0, fail = 0;

type Json = Record<string, unknown>;

async function chat(name: string, body: Json, opts: {expectTool?: boolean} = {}) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });
    const dt = Date.now() - t0;
    const json: any = await res.json().catch(() => ({}));
    const choice = json?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content ?? "";
    const toolCalls = choice?.message?.tool_calls ?? null;
    const finish = choice?.finish_reason ?? "?";
    const usage = json?.usage ?? {};
    const pTok = Number(usage.prompt_tokens ?? 0);
    const cTok = Number(usage.completion_tokens ?? 0);
    // 非串流無法分離 prompt-eval / generation 時間，所以 pRate 是 prompt_tokens / total_time
    // (上限速度，實際 prompt eval 多半比這個快)；cRate 同理為下限速度。
    const sec = dt / 1000;
    const pRate = sec > 0 ? (pTok / sec).toFixed(1) : "?";
    const cRate = sec > 0 ? (cTok / sec).toFixed(1) : "?";
    console.log(`\n===== ${name} =====`);
    console.log(`time=${dt}ms finish=${finish} content=${content.length}ch reasoning=${reasoning.length}ch tokens(p=${pTok} c=${cTok}) p_rate=${pRate}t/s c_rate=${cRate}t/s [非串流：總時間平均]`);
    if (content) console.log(`-- content[0..200]:\n${content.slice(0, 200)}`);
    if (reasoning) console.log(`-- reasoning[0..160]:\n${reasoning.slice(0, 160)}`);
    if (toolCalls) console.log(`-- tool_calls: ${JSON.stringify(toolCalls)}`);
    const ok = opts.expectTool ? Array.isArray(toolCalls) && toolCalls.length > 0 : content.length > 0;
    if (ok) { pass++; console.log("PASS"); } else { fail++; console.log("FAIL"); }
    return {content, reasoning, toolCalls, finish};
}

async function streamChat(name: string, body: Json, opts: {expectTool?: boolean} = {}) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({...body, stream: true})
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "", chunks = 0, contentDelta = "", reasoningDelta = "", toolDeltas = 0, done = false;
    let ttftMs: number | null = null; // time to first token (任何類型 delta)
    let lastUsage: any = null;
    while (true) {
        const {done: d, value} = await reader.read();
        if (d) break;
        buf += decoder.decode(value, {stream: true});
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") { done = true; continue; }
                chunks++;
                try {
                    const j = JSON.parse(data);
                    const d2 = j?.choices?.[0]?.delta ?? {};
                    const sawDelta = (typeof d2.content === "string" && d2.content !== "")
                        || (typeof d2.reasoning_content === "string" && d2.reasoning_content !== "")
                        || (Array.isArray(d2.tool_calls) && d2.tool_calls.length > 0);
                    if (sawDelta && ttftMs == null) ttftMs = Date.now() - t0;
                    if (typeof d2.content === "string") contentDelta += d2.content;
                    if (typeof d2.reasoning_content === "string") reasoningDelta += d2.reasoning_content;
                    if (Array.isArray(d2.tool_calls)) toolDeltas += d2.tool_calls.length;
                    if (j?.usage) lastUsage = j.usage;
                } catch { /* skip */ }
            }
        }
    }
    const dt = Date.now() - t0;
    const pTok = Number(lastUsage?.prompt_tokens ?? 0);
    const cTok = Number(lastUsage?.completion_tokens ?? 0);
    const promptSec = (ttftMs ?? dt) / 1000;
    const genSec = (dt - (ttftMs ?? dt)) / 1000;
    // 串流可分離：TTFT ≈ prompt eval 時間；TTFT 之後才是 generation
    const pRate = promptSec > 0 ? (pTok / promptSec).toFixed(1) : "?";
    const cRate = genSec > 0 ? (cTok / genSec).toFixed(1) : "?";
    console.log(`\n===== ${name} (stream) =====`);
    console.log(`time=${dt}ms ttft=${ttftMs ?? "?"}ms chunks=${chunks} done=${done} content=${contentDelta.length}ch reasoning=${reasoningDelta.length}ch tool_deltas=${toolDeltas}`);
    console.log(`tokens(p=${pTok} c=${cTok}) p_rate=${pRate}t/s [TTFT 內] c_rate=${cRate}t/s [TTFT 後]`);
    if (contentDelta) console.log(`-- content[0..200]:\n${contentDelta.slice(0, 200)}`);
    if (reasoningDelta) console.log(`-- reasoning[0..160]:\n${reasoningDelta.slice(0, 160)}`);
    const ok = opts.expectTool ? toolDeltas > 0 : contentDelta.length > 0;
    if (ok && done) { pass++; console.log("PASS"); } else { fail++; console.log("FAIL"); }
}

(async () => {
    // T1: simple greeting (think off)
    await chat("T1 你好嗎 (think off)", {
        model: MODEL,
        messages: [{role: "user", content: "用一句話回答：你好嗎？"}],
        max_tokens: 256, reasoning: "off"
    });

    // T2: simple greeting (think on)
    await chat("T2 你好嗎 (think on)", {
        model: MODEL,
        messages: [{role: "user", content: "用一句話回答：你好嗎？"}],
        max_tokens: 1024, reasoning: "on"
    });

    // T3: logic CoT (think on, large budget) — the famously-hard case
    await chat("T3 蘋果邏輯 (think on)", {
        model: MODEL,
        messages: [{role: "user", content: "小明有3顆蘋果，給了小華一半再買了4顆，現在有幾顆？請逐步思考。"}],
        max_tokens: 8192, reasoning: "on"
    });

    // T4: math (think auto)
    await chat("T4 17×23 (auto)", {
        model: MODEL,
        messages: [{role: "user", content: "17 乘以 23 等於多少？"}],
        max_tokens: 1024
    });

    // T5: multi-turn memory
    await chat("T5 多輪記憶", {
        model: MODEL,
        messages: [
            {role: "user", content: "我叫 Loren。"},
            {role: "assistant", content: "好的 Loren，有什麼可以幫忙？"},
            {role: "user", content: "剛剛我叫什麼名字？"}
        ],
        max_tokens: 256, reasoning: "off"
    });

    // T6: tool_calls non-stream (Qwen native pythonic-XML)
    await chat("T6 tool_calls 非串流", {
        model: MODEL,
        messages: [{role: "user", content: "台北現在天氣如何？用 get_weather 查詢。"}],
        tools: [{
            type: "function",
            function: {
                name: "get_weather",
                description: "Get current weather for a city",
                parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}
            }
        }],
        tool_choice: "auto", max_tokens: 1024, reasoning: "off"
    }, {expectTool: true});

    // T7: streaming basic
    await streamChat("T7 串流 1→5", {
        model: MODEL,
        messages: [{role: "user", content: "從 1 數到 5，每個數字一行。"}],
        max_tokens: 128, reasoning: "off"
    });

    // T8: streaming + tool sniffer (suppress JSON content delta)
    await streamChat("T8 串流 + tool", {
        model: MODEL,
        messages: [{role: "user", content: "高雄天氣？用 get_weather 查詢。"}],
        tools: [{
            type: "function",
            function: {
                name: "get_weather",
                description: "Weather",
                parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}
            }
        }],
        tool_choice: "auto", max_tokens: 512, reasoning: "off"
    }, {expectTool: true});

    // T9: tool roundtrip — assistant calls tool, we feed tool_response, model summarizes
    await chat("T9 tool 回合制", {
        model: MODEL,
        messages: [
            {role: "user", content: "新竹天氣？"},
            {role: "assistant", content: null, tool_calls: [{
                id: "call_1", type: "function",
                function: {name: "get_weather", arguments: JSON.stringify({city: "新竹"})}
            }]},
            {role: "tool", tool_call_id: "call_1", content: '{"city":"新竹","temperature":24,"condition":"晴"}'},
            {role: "user", content: "簡短摘要這個天氣。"}
        ],
        tools: [{
            type: "function",
            function: {
                name: "get_weather",
                description: "Weather",
                parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}
            }
        }],
        max_tokens: 256, reasoning: "off"
    });

    // T10: complex CoT with budget message — force budget exhaustion check
    await chat("T10 budget 耗盡訊息", {
        model: MODEL,
        messages: [{role: "user", content: "請用至少 2000 字詳細推導費馬大定理的證明思路，逐步展開每個關鍵引理。"}],
        max_tokens: 512, reasoning: "on", reasoning_budget: 400
    });

    // Meta endpoints
    console.log("\n===== /health /v1/models =====");
    console.log(await (await fetch(`${BASE}/health`)).text());
    console.log(await (await fetch(`${BASE}/v1/models`)).text());

    console.log(`\n================================\nTotal: PASS=${pass} FAIL=${fail}`);
    process.exit(fail);
})();
