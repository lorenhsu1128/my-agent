// 完整混合測試 — 一次跑遍 SHIM-1 + SHIM-2 全部功能。
// 啟動條件：
//   bun run dev -- serve --model ... --mmproj ... --ctx-size 4096 \
//     --slot-save-path /tmp/tcq-slots --reasoning auto --reasoning-format deepseek
//
// Run:
//   IMAGE=<abs path to image> bun scripts/live-test-full.ts

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const IMAGE = path.resolve(process.env.IMAGE ?? "llama/llama.cpp/tools/mtmd/test-1.jpeg");
const SLOT_DIR = process.env.SLOT_DIR ?? "/tmp/tcq-slots";

let pass = 0, fail = 0;
const failures: string[] = [];

function record(name: string, ok: boolean, note: string = "") {
    if (ok) { pass++; console.log(`  ✅ ${name}${note ? "  " + note : ""}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${note ? "  " + note : ""}`); }
}

async function chat(body: any, opts: {tag: string, expectTool?: string | true, expectError?: number} = {tag: ""}) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });
    const dt = Date.now() - t0;
    const json: any = await res.json().catch(() => ({}));
    if (opts.expectError != null) {
        const ok = res.status === opts.expectError;
        record(opts.tag, ok, `HTTP=${res.status} (expected ${opts.expectError}) ${dt}ms` + (json?.error?.code ? ` code=${json.error.code}` : ""));
        return json;
    }
    const choice = json?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const tools = choice?.message?.tool_calls ?? null;
    const usage = json?.usage ?? {};
    let ok = res.status === 200;
    let note = `${dt}ms p=${usage.prompt_tokens ?? "?"} c=${usage.completion_tokens ?? "?"}`;
    if (opts.expectTool === true) ok = ok && Array.isArray(tools) && tools.length > 0;
    else if (typeof opts.expectTool === "string") ok = ok && Array.isArray(tools) && tools.some((t: any) => t.function?.name === opts.expectTool);
    else ok = ok && (content.length > 0 || (Array.isArray(tools) && tools.length > 0));
    if (tools) note += ` tools=[${tools.map((t: any) => t.function.name).join(",")}]`;
    if (content && !tools) note += ` content="${content.slice(0, 60).replace(/\s+/g, " ")}…"`;
    record(opts.tag, ok, note);
    return json;
}

async function streamChat(body: any, opts: {tag: string, expectTool?: boolean} = {tag: ""}) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({...body, stream: true})
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "", contentDelta = "", toolDeltas = 0, done = false, ttft: number | null = null;
    while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, {stream: true});
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") { done = true; continue; }
                try {
                    const j = JSON.parse(data);
                    const d = j?.choices?.[0]?.delta ?? {};
                    if ((d.content || d.reasoning_content || (d.tool_calls?.length > 0)) && ttft == null) ttft = Date.now() - t0;
                    if (typeof d.content === "string") contentDelta += d.content;
                    if (Array.isArray(d.tool_calls)) toolDeltas += d.tool_calls.length;
                } catch { /* */ }
            }
        }
    }
    const dt = Date.now() - t0;
    let ok = done;
    if (opts.expectTool) ok = ok && toolDeltas > 0;
    else ok = ok && contentDelta.length > 0;
    record(opts.tag, ok, `${dt}ms ttft=${ttft ?? "?"}ms tools=${toolDeltas} content=${contentDelta.length}ch`);
}

const TOOLS = [
    {type: "function", function: {name: "get_weather", description: "City weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}},
    {type: "function", function: {name: "calculator", description: "Math", parameters: {type: "object", properties: {op: {type: "string", enum: ["add", "sub", "mul", "div"]}, a: {type: "number"}, b: {type: "number"}}, required: ["op", "a", "b"]}}},
    {type: "function", function: {name: "translate", description: "Translate text", parameters: {type: "object", properties: {text: {type: "string"}, target_lang: {type: "string", enum: ["en", "zh-TW", "ja"]}}, required: ["text", "target_lang"]}}},
    {type: "function", function: {name: "current_time", description: "Server time", parameters: {type: "object", properties: {}}}}
];

const filler = (approxTok: number) => Array(Math.ceil(approxTok / 24)).fill("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ").join("");

(async () => {
    console.log(`\n#### LIVE FULL TEST against ${BASE} ####`);
    if (!fs.existsSync(IMAGE)) { console.error(`IMAGE not found: ${IMAGE}`); process.exit(2); }

    /* --- 區段 1：基本 chat（含 reasoning + memory） --- */
    console.log("\n[1] 基本 chat / reasoning / 多輪");
    await chat({model: MODEL, messages: [{role: "user", content: "用一句話說：你好嗎？"}], max_tokens: 256, reasoning: "off"}, {tag: "S1.1 think off 簡答"});
    await chat({model: MODEL, messages: [{role: "user", content: "用一句話說：你好嗎？"}], max_tokens: 1024, reasoning: "on"}, {tag: "S1.2 think on 含 reasoning_content"});
    await chat({model: MODEL, messages: [
        {role: "user", content: "我叫 Loren。"},
        {role: "assistant", content: "好的 Loren。"},
        {role: "user", content: "我叫什麼名字？"}
    ], max_tokens: 128, reasoning: "off"}, {tag: "S1.3 多輪記憶"});

    /* --- 區段 2：tool calls 多樣性 --- */
    console.log("\n[2] tool_calls — 5 種設計");
    await chat({model: MODEL, messages: [{role: "user", content: "台北天氣？用 get_weather 查"}], tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, {tag: "S2.1 單參 get_weather", expectTool: "get_weather"});
    await chat({model: MODEL, messages: [{role: "user", content: "計算 25 乘以 4"}], tools: TOOLS, tool_choice: {type: "function", function: {name: "calculator"}}, max_tokens: 256, reasoning: "off"}, {tag: "S2.2 強制 calculator", expectTool: "calculator"});
    await chat({model: MODEL, messages: [{role: "user", content: "把『早安』翻成日文"}], tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, {tag: "S2.3 enum 必填 translate", expectTool: "translate"});
    await chat({model: MODEL, messages: [{role: "user", content: "現在伺服器時間？"}], tools: TOOLS, tool_choice: "auto", max_tokens: 128, reasoning: "off"}, {tag: "S2.4 無參 current_time", expectTool: "current_time"});
    await chat({model: MODEL, messages: [{role: "user", content: "查東京天氣，再算 1500*3"}], tools: TOOLS, tool_choice: "auto", max_tokens: 512, reasoning: "off"}, {tag: "S2.5 單輪多 tool"});

    /* --- 區段 3：tool roundtrip --- */
    console.log("\n[3] tool 回合制");
    await chat({model: MODEL, messages: [
        {role: "user", content: "新竹天氣？"},
        {role: "assistant", content: null, tool_calls: [{id: "c1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "新竹"})}}]},
        {role: "tool", tool_call_id: "c1", content: '{"city":"新竹","temperature":24,"condition":"晴"}'},
        {role: "user", content: "簡短摘要這個天氣。"}
    ], tools: TOOLS, max_tokens: 256, reasoning: "off"}, {tag: "S3.1 tool_response 再回答"});

    /* --- 區段 4：streaming --- */
    console.log("\n[4] streaming");
    await streamChat({model: MODEL, messages: [{role: "user", content: "從 1 數到 5，每行一個"}], max_tokens: 128, reasoning: "off"}, {tag: "S4.1 stream 基本"});
    await streamChat({model: MODEL, messages: [{role: "user", content: "高雄天氣？"}], tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"}, {tag: "S4.2 stream + tool", expectTool: true});

    /* --- 區段 5：context overflow（precondition + reason 完整） --- */
    console.log("\n[5] context overflow 413");
    const big = filler(5000);
    const result = await chat({model: MODEL, messages: [{role: "user", content: big + "\n\n簡短回答：剛剛那段是什麼？"}], max_tokens: 256}, {tag: "S5.1 prompt 5000+max 256 → 413", expectError: 413});
    const ctxMsg = (result as any)?.error?.message ?? "";
    record("S5.2 413 reason 含 ctx_size", ctxMsg.includes("4096"), `msg fragment="${ctxMsg.slice(0, 80)}…"`);
    record("S5.3 413 code=context_length_exceeded", (result as any)?.error?.code === "context_length_exceeded");

    /* --- 區段 6：vision (4 cases) --- */
    console.log("\n[6] vision mtmd");
    const fileUrl = `file:///${IMAGE.replace(/\\/g, "/")}`;
    const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(IMAGE).toString("base64")}`;
    await chat({model: MODEL, messages: [{role: "user", content: [
        {type: "image_url", image_url: {url: fileUrl}},
        {type: "text", text: "用 1 句話描述這張圖。"}
    ]}], max_tokens: 200, temperature: 0}, {tag: "S6.1 image via file://"});
    await chat({model: MODEL, messages: [{role: "user", content: [
        {type: "image_url", image_url: {url: dataUrl}},
        {type: "text", text: "Describe in one English sentence."}
    ]}], max_tokens: 150, temperature: 0}, {tag: "S6.2 image via data:base64"});
    await chat({model: MODEL, messages: [{role: "user", content: [
        {type: "image_url", image_url: {url: IMAGE}},
        {type: "text", text: "圖片中是什麼新聞？"}
    ]}], max_tokens: 150, temperature: 0}, {tag: "S6.3 image via bare path"});
    await chat({model: MODEL, messages: [{role: "user", content: [
        {type: "text", text: "我給你一張圖："},
        {type: "image_url", image_url: {url: fileUrl}},
        {type: "text", text: "請問裡面有幾隻動物？"}
    ]}], max_tokens: 150, temperature: 0}, {tag: "S6.4 multi-text-part"});

    /* --- 區段 7：Ollama /api/chat --- */
    console.log("\n[7] Ollama 相容");
    {
        const r = await fetch(`${BASE}/api/chat`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: MODEL, messages: [{role: "user", content: "用一句話說：今天天氣好嗎？"}], stream: false, options: {num_predict: 128, temperature: 0.7}})
        });
        const j: any = await r.json();
        record("S7.1 /api/chat (non-stream)", r.status === 200 && typeof j?.message?.content === "string" && j.message.content.length > 0, `done=${j?.done} eval_count=${j?.eval_count}`);
    }
    {
        const r = await fetch(`${BASE}/api/chat`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: MODEL, messages: [{role: "user", content: "hi"}], stream: true})
        });
        const j: any = await r.json();
        record("S7.2 /api/chat stream → 501", r.status === 501 && j?.error?.code === "ollama_stream_not_supported");
    }
    {
        const r = await fetch(`${BASE}/api/tags`);
        const j: any = await r.json();
        record("S7.3 /api/tags 回 model 列表", r.status === 200 && Array.isArray(j?.models) && j.models[0]?.name === MODEL);
    }

    /* --- 區段 8：Anthropic /v1/messages + count_tokens --- */
    console.log("\n[8] Anthropic 相容");
    {
        const r = await fetch(`${BASE}/v1/messages`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: MODEL,
                system: "You are a concise assistant.",
                messages: [{role: "user", content: "Say 'hello' in 3 languages."}],
                max_tokens: 200
            })
        });
        const j: any = await r.json();
        record("S8.1 /v1/messages (non-stream)", r.status === 200 && j?.type === "message" && Array.isArray(j?.content) && j.content.some((b: any) => b.type === "text" && b.text), `stop=${j?.stop_reason} tokens(${j?.usage?.input_tokens}/${j?.usage?.output_tokens})`);
    }
    {
        const r = await fetch(`${BASE}/v1/messages`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: MODEL,
                messages: [{role: "user", content: "What is 7*8?"}],
                tools: [{name: "calculator", description: "Math", input_schema: {type: "object", properties: {a: {type: "number"}, b: {type: "number"}, op: {type: "string"}}, required: ["a", "b", "op"]}}],
                max_tokens: 200
            })
        });
        const j: any = await r.json();
        const hasToolUse = Array.isArray(j?.content) && j.content.some((b: any) => b.type === "tool_use");
        record("S8.2 /v1/messages tool_use 區塊", r.status === 200 && hasToolUse, `stop=${j?.stop_reason}`);
    }
    {
        const r = await fetch(`${BASE}/v1/messages/count_tokens`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: MODEL, messages: [{role: "user", content: "Hello world this is a test of tokenization."}]})
        });
        const j: any = await r.json();
        record("S8.3 /v1/messages/count_tokens", r.status === 200 && typeof j?.input_tokens === "number" && j.input_tokens > 0, `input_tokens=${j?.input_tokens}`);
    }
    {
        const r = await fetch(`${BASE}/v1/messages`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: MODEL, messages: [{role: "user", content: "hi"}], max_tokens: 50, stream: true})
        });
        const j: any = await r.json();
        record("S8.4 /v1/messages stream → 501", r.status === 501 && j?.error?.code === "anthropic_stream_not_supported");
    }

    /* --- 區段 9：/props GET + POST + whitelist --- */
    console.log("\n[9] /props");
    {
        const r = await fetch(`${BASE}/props`);
        const j: any = await r.json();
        record("S9.1 GET /props", r.status === 200 && typeof j?.n_ctx === "number" && typeof j?.model_alias === "string");
    }
    {
        const r = await fetch(`${BASE}/props`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({temperature: 0.7, top_p: 0.9})});
        const j: any = await r.json();
        record("S9.2 POST /props 白名單通過", r.status === 200 && Array.isArray(j?.accepted) && j.accepted.length === 2);
    }
    {
        const r = await fetch(`${BASE}/props`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({foo: 1, bar: 2})});
        const j: any = await r.json();
        record("S9.3 POST /props 未列拒絕 400", r.status === 400 && j?.error?.code === "unknown_field");
    }

    /* --- 區段 10：/metrics 計數 --- */
    console.log("\n[10] /metrics");
    {
        const r = await fetch(`${BASE}/metrics`);
        const text = await r.text();
        const reqCount = parseInt(text.match(/^llamacpp_requests_total (\d+)$/m)?.[1] ?? "0");
        const chatCount = parseInt(text.match(/^tcq_shim_chat_completions_total (\d+)$/m)?.[1] ?? "0");
        const tokensEval = parseInt(text.match(/^llamacpp_tokens_evaluated_total (\d+)$/m)?.[1] ?? "0");
        const overflow = parseInt(text.match(/^tcq_shim_context_overflow_total (\d+)$/m)?.[1] ?? "0");
        record("S10.1 requests_total >= 25", r.status === 200 && reqCount >= 25, `requests=${reqCount}`);
        record("S10.2 chat_completions_total >= 12", chatCount >= 12, `chat=${chatCount}`);
        record("S10.3 tokens_evaluated_total > 1000", tokensEval > 1000, `eval=${tokensEval}`);
        record("S10.4 context_overflow_total >= 1（S5.1 計入）", overflow >= 1, `overflow=${overflow}`);
    }

    /* --- 區段 11：/slots --- */
    console.log("\n[11] /slots");
    {
        const r = await fetch(`${BASE}/slots`);
        const j: any = await r.json();
        record("S11.1 GET /slots", r.status === 200 && Array.isArray(j) && j[0]?.id === 0);
    }
    {
        const r = await fetch(`${BASE}/slots/0?action=erase`, {method: "POST"});
        const j: any = await r.json();
        record("S11.2 erase", r.status === 200 && j?.id_slot === 0);
    }
    {
        // save 需 --slot-save-path 啟動，且檔名安全
        const r = await fetch(`${BASE}/slots/0?action=save`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({filename: "test-state.bin"})});
        const j: any = await r.json();
        record("S11.3 save (--slot-save-path enabled)", r.status === 200 && typeof j?.file_size === "number");
    }
    {
        // 拒絕 path traversal
        const r = await fetch(`${BASE}/slots/0?action=save`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({filename: "../escape.bin"})});
        const j: any = await r.json();
        record("S11.4 reject path traversal", r.status === 400 && j?.error?.code === "invalid_filename");
    }
    {
        const r = await fetch(`${BASE}/slots/9?action=erase`, {method: "POST"});
        const j: any = await r.json();
        record("S11.5 invalid slot id → 404", r.status === 404 && j?.error?.code === "invalid_slot_id");
    }

    /* --- 區段 12：health + models --- */
    console.log("\n[12] meta");
    {
        const r1 = await fetch(`${BASE}/health`); const j1: any = await r1.json();
        record("S12.1 /health", r1.status === 200 && j1?.status === "ok");
        const r2 = await fetch(`${BASE}/v1/models`); const j2: any = await r2.json();
        record("S12.2 /v1/models", r2.status === 200 && Array.isArray(j2?.data) && j2.data[0]?.id === MODEL);
    }

    /* --- 結尾 --- */
    console.log(`\n=================================================`);
    console.log(`Total: PASS=${pass} FAIL=${fail}  ${fail === 0 ? "✅ ALL GREEN" : "❌"}`);
    if (failures.length > 0) {
        console.log("Failures:");
        for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(fail);
})();
