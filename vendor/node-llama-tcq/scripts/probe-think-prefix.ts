// 驗證：給 shim HTTP 加 responsePrefix=<think>\n 是否能讓 streaming 切出 reasoning。
// 走 OpenAI-compat /v1/chat/completions stream 模式（跟 buun 行為對齊驗證）。
//
// 方法：直接戳 shim、模擬「shim 已修為 reasoning=on 時注入字面 <think>\n prefix」的行為，
// 用 user prompt 開頭 "<think>" 字串 trick 模型續寫 thinking。看 stream 收到的字串
// 是否含字面 <think>...</think>，這樣現有 StreamReasoningSplitter 就能切。

const BASE = "http://127.0.0.1:8081";

async function probe(label: string, body: any) {
    console.log(`\n=== ${label} ===`);
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({...body, stream: true})
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "", contentDelta = "", reasoningDelta = "";
    while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, {stream: true});
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const d = line.slice(6).trim();
                if (d === "[DONE]") continue;
                try {
                    const j = JSON.parse(d);
                    const dlt = j?.choices?.[0]?.delta ?? {};
                    if (typeof dlt.content === "string") contentDelta += dlt.content;
                    if (typeof dlt.reasoning_content === "string") reasoningDelta += dlt.reasoning_content;
                } catch {}
            }
        }
    }
    console.log(`time=${Date.now() - t0}ms`);
    console.log(`reasoning (${reasoningDelta.length}ch):`, JSON.stringify(reasoningDelta.slice(0, 200)));
    console.log(`content   (${contentDelta.length}ch):`, JSON.stringify(contentDelta.slice(0, 250)));
    console.log(`含字面 <think>:`, contentDelta.includes("<think>") || reasoningDelta.includes("<think>") ? "YES" : "no");
    console.log(`含字面 </think>:`, contentDelta.includes("</think>") || reasoningDelta.includes("</think>") ? "YES" : "no");
}

const PROMPT = "請逐步推理：費馬大定理的陳述是什麼？並給最後簡短結論。";

// Probe A：標準 reasoning=on（現行 shim 行為，預期 reasoning=0）
await probe("A 標準 reasoning=on", {
    model: "qwen3.5-9b", reasoning: "on", max_tokens: 600,
    messages: [{role: "user", content: PROMPT}]
});

// Probe B：user prompt 末尾要求模型用 <think> 標籤包推理
await probe("B prompt 引導模型用 <think>...</think> 包推理", {
    model: "qwen3.5-9b", reasoning: "on", max_tokens: 600,
    messages: [{role: "user", content: PROMPT + "\n\n請務必把推理過程包在字面 <think>...</think> 標籤裡，最後輸出可見答案。"}]
});

// Probe C：assistant prefix + <think> — 在 history 中放半句 assistant 開頭
await probe("C assistant role 預塞 <think>", {
    model: "qwen3.5-9b", reasoning: "on", max_tokens: 600,
    messages: [
        {role: "user", content: PROMPT},
        {role: "assistant", content: "<think>\n"}
    ]
});

console.log("\n結論：哪個 probe 收到 reasoning_content > 0 就是正確路徑");
process.exit(0);
