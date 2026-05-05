// 模擬 my-agent 真實使用情境的混合測試 — 在單次 session 內交錯
// chat / tool / vision / streaming，並量測 prompt 填充與 generation 速度。
//
// 啟動：bun run dev -- serve ... --ctx-size 131072 --mmproj ...
// 跑：IMAGE=<abs path> bun scripts/live-test-realistic.ts

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const IMAGE = path.resolve(process.env.IMAGE ?? "llama/llama.cpp/tools/mtmd/test-1.jpeg");

type CaseResult = {
    case: string,
    type: "chat" | "stream" | "vision" | "tool" | "vision+tool",
    timeMs: number,
    ttftMs: number | null,
    pTok: number,
    cTok: number,
    pRate: number,    // prompt-fill: stream 用 TTFT 切；非 stream 用 totalTime
    cRate: number,    // generation: stream 用 (total-TTFT)；非 stream 用 totalTime
    note: string,
    ok: boolean
};

const results: CaseResult[] = [];

function record(r: CaseResult) {
    results.push(r);
    const flag = r.ok ? "✅" : "❌";
    const tt = r.ttftMs != null ? ` ttft=${r.ttftMs}ms` : "";
    console.log(`  ${flag} ${r.case.padEnd(38)} ${String(r.timeMs).padStart(6)}ms${tt}  p=${r.pTok}t/${r.pRate.toFixed(1)}t/s  c=${r.cTok}t/${r.cRate.toFixed(1)}t/s  ${r.note}`);
}

const TOOLS = [
    {type: "function", function: {name: "read_file", description: "讀取檔案內容", parameters: {type: "object", properties: {path: {type: "string", description: "absolute or repo-relative path"}}, required: ["path"]}}},
    {type: "function", function: {name: "edit_file", description: "編輯檔案", parameters: {type: "object", properties: {path: {type: "string"}, old_str: {type: "string"}, new_str: {type: "string"}}, required: ["path", "old_str", "new_str"]}}},
    {type: "function", function: {name: "run_shell", description: "執行 shell 指令", parameters: {type: "object", properties: {cmd: {type: "string"}, cwd: {type: "string", description: "working dir, optional"}}, required: ["cmd"]}}},
    {type: "function", function: {name: "search_web", description: "搜尋網路", parameters: {type: "object", properties: {query: {type: "string"}, max_results: {type: "integer"}}, required: ["query"]}}},
    {type: "function", function: {name: "fetch_url", description: "抓取 URL 內容", parameters: {type: "object", properties: {url: {type: "string"}}, required: ["url"]}}},
    {type: "function", function: {name: "get_weather", description: "查詢城市天氣", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}},
    {type: "function", function: {name: "translate", description: "翻譯", parameters: {type: "object", properties: {text: {type: "string"}, target_lang: {type: "string", enum: ["en", "zh-TW", "ja"]}}, required: ["text", "target_lang"]}}},
    {type: "function", function: {name: "calculator", description: "四則運算", parameters: {type: "object", properties: {op: {type: "string", enum: ["add", "sub", "mul", "div"]}, a: {type: "number"}, b: {type: "number"}}, required: ["op", "a", "b"]}}},
    {type: "function", function: {name: "git_status", description: "顯示 git 狀態", parameters: {type: "object", properties: {}}}},
    {type: "function", function: {name: "create_pr", description: "建立 PR", parameters: {type: "object", properties: {title: {type: "string"}, body: {type: "string"}, base: {type: "string"}}, required: ["title", "body"]}}}
];

async function chat(opts: {
    name: string,
    type: CaseResult["type"],
    body: any,
    expectTool?: boolean | string,
    note?: string
}): Promise<{content: string, toolCalls: any[], usage: any}> {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(opts.body)
    });
    const dt = Date.now() - t0;
    const j: any = await res.json().catch(() => ({}));
    const choice = j?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const toolCalls = choice?.message?.tool_calls ?? [];
    const usage = j?.usage ?? {};
    const pTok = Number(usage.prompt_tokens ?? 0);
    const cTok = Number(usage.completion_tokens ?? 0);
    const sec = dt / 1000;

    let ok = res.status === 200;
    if (opts.expectTool === true) ok = ok && toolCalls.length > 0;
    else if (typeof opts.expectTool === "string") ok = ok && toolCalls.some((t: any) => t.function?.name === opts.expectTool);
    else ok = ok && (content.length > 0 || toolCalls.length > 0);

    record({
        case: opts.name,
        type: opts.type,
        timeMs: dt,
        ttftMs: null,
        pTok, cTok,
        pRate: sec > 0 ? pTok / sec : 0,
        cRate: sec > 0 ? cTok / sec : 0,
        note: opts.note ?? (toolCalls.length > 0 ? `tools=[${toolCalls.map((t: any) => t.function.name).join(",")}]` : ""),
        ok
    });
    return {content, toolCalls, usage};
}

async function streamChat(opts: {
    name: string,
    body: any,
    expectTool?: boolean,
    note?: string
}) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({...opts.body, stream: true})
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "", contentDelta = "", reasoningDelta = "", toolDeltas = 0, done = false;
    let ttftMs: number | null = null;
    let lastUsage: any = null;
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
                    const sawDelta = (d.content || d.reasoning_content || (d.tool_calls?.length > 0));
                    if (sawDelta && ttftMs == null) ttftMs = Date.now() - t0;
                    if (typeof d.content === "string") contentDelta += d.content;
                    if (typeof d.reasoning_content === "string") reasoningDelta += d.reasoning_content;
                    if (Array.isArray(d.tool_calls)) toolDeltas += d.tool_calls.length;
                    if (j?.usage) lastUsage = j.usage;
                } catch { /* */ }
            }
        }
    }
    const dt = Date.now() - t0;
    const pTok = Number(lastUsage?.prompt_tokens ?? 0);
    const cTok = Number(lastUsage?.completion_tokens ?? 0);
    const promptSec = (ttftMs ?? dt) / 1000;
    const genSec = (dt - (ttftMs ?? dt)) / 1000;
    let ok = done;
    if (opts.expectTool) ok = ok && toolDeltas > 0;
    else ok = ok && contentDelta.length > 0;
    record({
        case: opts.name,
        type: "stream",
        timeMs: dt,
        ttftMs,
        pTok, cTok,
        pRate: promptSec > 0 ? pTok / promptSec : 0,
        cRate: genSec > 0 ? cTok / genSec : 0,
        note: opts.note ?? (toolDeltas > 0 ? `tool_deltas=${toolDeltas}` : `chunks=${contentDelta.length}ch`),
        ok
    });
}

const fileUrl = `file:///${IMAGE.replace(/\\/g, "/")}`;
const dataUrlOnce = () => `data:image/jpeg;base64,${fs.readFileSync(IMAGE).toString("base64")}`;

(async () => {
    if (!fs.existsSync(IMAGE)) { console.error(`IMAGE not found: ${IMAGE}`); process.exit(2); }
    console.log(`\n#### REALISTIC MIXED TEST against ${BASE} (ctx 128k) ####\n`);

    /* ============================================================
       C1：編程除錯會話 — 多輪 + 多 tool 交錯
       ============================================================ */
    console.log("[C1] 編程會話：read → analyze → edit → run → 修 → commit");
    let history: any[] = [
        {role: "system", content: "你是 my-agent 的 coding agent。會用工具讀檔、改檔、跑指令。簡短回答，能呼叫工具就直接呼叫。"}
    ];
    history.push({role: "user", content: "幫我看一下 src/server/utils.ts 有什麼 export，然後告訴我有沒有 todo 標記。"});
    let r = await chat({
        name: "C1.1 user 提問 → tool",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"},
        expectTool: "read_file"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x1", content: "export function delay(ms: number) {...}\nexport const VERSION = '1.2.0';\n// TODO: refactor delay to use AbortSignal\nexport class Cache<K,V> {...}"});

    r = await chat({
        name: "C1.2 解析 tool result",
        type: "chat",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 200, reasoning: "off"}
    });
    history.push({role: "assistant", content: r.content || null, ...(r.toolCalls.length > 0 ? {tool_calls: r.toolCalls} : {})});

    history.push({role: "user", content: "幫我把那個 TODO 的 delay 改成接受 AbortSignal。直接 edit_file。"});
    r = await chat({
        name: "C1.3 多輪後再次 tool call",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 512, reasoning: "off"},
        expectTool: "edit_file"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x2", content: "edit applied successfully"});

    history.push({role: "user", content: "好，跑一下 typecheck 看有沒有壞掉。"});
    r = await chat({
        name: "C1.4 連續 tool 鏈",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"},
        expectTool: "run_shell"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x3", content: "$ tsc --noEmit\n0 errors found"});

    r = await chat({
        name: "C1.5 收尾 — 純文字回答",
        type: "chat",
        body: {model: MODEL, messages: history, max_tokens: 200, reasoning: "off"}
    });

    /* ============================================================
       C2：研究會話 — 搜尋 → 抓網頁 → 摘要 → 追問
       ============================================================ */
    console.log("\n[C2] 研究會話：search → fetch → 摘要 → 追問 → 第二輪 search");
    history = [
        {role: "system", content: "你是研究助理。可用 search_web / fetch_url 工具。"},
        {role: "user", content: "幫我查一下 OpenAI o1 的 reasoning_effort 參數有哪些值。"}
    ];
    r = await chat({
        name: "C2.1 search_web",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"},
        expectTool: "search_web"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x", content: JSON.stringify({results: [
        {title: "OpenAI Reasoning models guide", url: "https://platform.openai.com/docs/guides/reasoning", snippet: "reasoning_effort accepts: low, medium, high. Default medium."},
        {title: "o1 release notes", url: "https://openai.com/blog/o1", snippet: "..."}
    ]})});

    r = await chat({
        name: "C2.2 fetch_url 接續",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"},
        expectTool: "fetch_url"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x", content: "Reasoning effort: low (~256 thought tokens) / medium (~1024) / high (~4096). Affects latency and cost."});

    r = await chat({
        name: "C2.3 摘要 — 純文字",
        type: "chat",
        body: {model: MODEL, messages: history, max_tokens: 300, reasoning: "off"}
    });
    history.push({role: "assistant", content: r.content});

    history.push({role: "user", content: "那 Anthropic 的 thinking budget 怎麼設？再查一下。"});
    r = await chat({
        name: "C2.4 追問 → 第二輪 search",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"},
        expectTool: "search_web"
    });

    /* ============================================================
       C3：圖文交錯 — 多輪 vision + 文字討論
       注意：vision 後 history 中 image_url 會被剝離，模型看不到舊圖。
       ============================================================ */
    console.log("\n[C3] 圖文交錯：第一張圖 → 文字討論 → 第二張圖（同檔）→ 純文字 follow-up");
    history = [
        {role: "system", content: "你是視覺助理。簡短回答。"},
        {role: "user", content: [
            {type: "text", text: "看這張圖，告訴我主題是什麼。"},
            {type: "image_url", image_url: {url: fileUrl}}
        ]}
    ];
    r = await chat({
        name: "C3.1 第一張圖描述",
        type: "vision",
        body: {model: MODEL, messages: history, max_tokens: 200, temperature: 0}
    });
    history.push({role: "assistant", content: r.content});

    history.push({role: "user", content: "圖裡提到的事件大約是哪一年？"});
    r = await chat({
        name: "C3.2 純文字 follow-up（vision 後）",
        type: "chat",
        body: {model: MODEL, messages: history, max_tokens: 100, reasoning: "off"}
    });
    history.push({role: "assistant", content: r.content});

    history.push({role: "user", content: [
        {type: "text", text: "再給你看一次（同一張）："},
        {type: "image_url", image_url: {url: fileUrl}},
        {type: "text", text: "請數一下標題大概有幾個字。"}
    ]});
    r = await chat({
        name: "C3.3 第二次 vision call",
        type: "vision",
        body: {model: MODEL, messages: history, max_tokens: 200, temperature: 0}
    });

    /* ============================================================
       C4：圖+工具混合 — 看圖 → 用工具處理圖中資訊
       ============================================================ */
    console.log("\n[C4] 圖文+工具：vision 抽資訊 → tool 處理 → tool_result → 摘要");
    history = [
        {role: "system", content: "助理：先看圖，需要時用 tool。"},
        {role: "user", content: [
            {type: "text", text: "從這張圖認出年份和事件，然後用 calculator 算今年距離那年幾年（今年 2026）。"},
            {type: "image_url", image_url: {url: fileUrl}}
        ]}
    ];
    // 第一輪：vision 識別（不能 tool_call 因為 vision path 不過 chat wrapper tool injection）
    r = await chat({
        name: "C4.1 vision 識別年份",
        type: "vision",
        body: {model: MODEL, messages: history, max_tokens: 200, temperature: 0}
    });
    history.push({role: "assistant", content: r.content});
    // 第二輪：純文字 user prompt 觸發 tool
    history.push({role: "user", content: "好，現在用 calculator(sub, 2026, 1969) 算一下。"});
    r = await chat({
        name: "C4.2 vision 後 tool_call",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"},
        expectTool: "calculator"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x", content: '{"result": 57}'});
    r = await chat({
        name: "C4.3 整合圖文+tool 結果",
        type: "chat",
        body: {model: MODEL, messages: history, max_tokens: 200, reasoning: "off"}
    });

    /* ============================================================
       C5：工具鏈 — 連續多 tool 餵接
       ============================================================ */
    console.log("\n[C5] 工具鏈：weather × 3 城市 → translate → 摘要");
    history = [
        {role: "system", content: "助理：可用 get_weather / translate / calculator。"},
        {role: "user", content: "查台北、東京、首爾的天氣。"}
    ];
    r = await chat({
        name: "C5.1 並行多 tool（同 turn）",
        type: "tool",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 512, reasoning: "off"},
        expectTool: "get_weather"
    });
    history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    for (const tc of r.toolCalls) {
        const args = JSON.parse(tc.function.arguments || "{}");
        history.push({role: "tool", tool_call_id: tc.id, content: JSON.stringify({city: args.city, temp: 20 + Math.floor(Math.random() * 10), condition: "晴"})});
    }
    r = await chat({
        name: "C5.2 收 tool 結果 → 提議翻譯",
        type: "chat",
        body: {model: MODEL, messages: history, tools: TOOLS, tool_choice: "auto", max_tokens: 300, reasoning: "off"}
    });
    if (r.toolCalls.length > 0) {
        history.push({role: "assistant", content: null, tool_calls: r.toolCalls});
        for (const tc of r.toolCalls) history.push({role: "tool", tool_call_id: tc.id, content: '{"translated": "Sunny weather across all three cities."}'});
        r = await chat({
            name: "C5.3 最終摘要",
            type: "chat",
            body: {model: MODEL, messages: history, max_tokens: 300, reasoning: "off"}
        });
    } else {
        history.push({role: "assistant", content: r.content});
        record({case: "C5.3 (skipped — no translate)", type: "chat", timeMs: 0, ttftMs: null, pTok: 0, cTok: 0, pRate: 0, cRate: 0, note: "skipped", ok: true});
    }

    /* ============================================================
       C6：streaming 大量輸出 — 量測 generation 速率
       ============================================================ */
    console.log("\n[C6] streaming 大量輸出 — 量產出速度");
    await streamChat({
        name: "C6.1 stream 1000 tok 長文",
        body: {model: MODEL, messages: [
            {role: "system", content: "簡短助理。"},
            {role: "user", content: "用繁體中文寫一段約 800 字的散文，主題：台灣的春天。"}
        ], max_tokens: 1024, reasoning: "off"}
    });
    await streamChat({
        name: "C6.2 stream + thinking",
        body: {model: MODEL, messages: [
            {role: "user", content: "三個質數的和是 30，找出所有可能組合並逐步驗證。"}
        ], max_tokens: 2048, reasoning: "on"}
    });

    /* ============================================================
       C7：長 history 累積（壓 ctx 的中間負載）
       ============================================================ */
    console.log("\n[C7] 長 history 累積：8 輪 + 每輪 ~500 tok 內容");
    history = [{role: "system", content: "簡短助理，2 句以內回答。"}];
    for (let i = 1; i <= 8; i++) {
        history.push({role: "user", content: `第 ${i} 題：請寫一段大約 200 字介紹編號 ${i} 的概念，主題自選（例如：物理、文學、料理、歷史、運動、音樂、程式、藝術）。`});
        history.push({role: "assistant", content: `這是關於主題 ${i} 的 200 字介紹。其涉及核心概念、常見應用以及代表案例。歷史脈絡可追溯至古代，現代應用包括各種跨領域整合。實際使用時需注意細節差異。總結來說，主題 ${i} 是值得深入探討的領域。`.repeat(3)});
    }
    history.push({role: "user", content: "我們剛才聊了多少個主題？簡短回答。"});
    r = await chat({
        name: "C7.1 8 輪後追問",
        type: "chat",
        body: {model: MODEL, messages: history, max_tokens: 100, reasoning: "off"}
    });

    /* ============================================================
       C8：短指令快速問答 — 量測小 request 平均速度
       ============================================================ */
    console.log("\n[C8] 短指令快速問答（5 連發）");
    const quickQuestions = [
        "台灣的首都？", "1+1=?", "Python 副檔名？", "GIT 全名？", "今天星期幾？這題你不知道也沒關係，回答不知道就好。"
    ];
    for (let i = 0; i < quickQuestions.length; i++) {
        await chat({
            name: `C8.${i + 1} 短 Q${i + 1}`,
            type: "chat",
            body: {model: MODEL, messages: [{role: "user", content: quickQuestions[i]}], max_tokens: 64, reasoning: "off"}
        });
    }

    /* ============================================================
       C9：tool_choice 強制 + reasoning on（thinking + 結構化 tool）
       ============================================================ */
    console.log("\n[C9] thinking + 強制 tool（最複雜的 tool-call 情境）");
    await chat({
        name: "C9.1 thinking + 強制 calculator",
        type: "tool",
        body: {model: MODEL, messages: [
            {role: "user", content: "請逐步計算：(123 + 456) × 2 - 100。然後用 calculator 工具呼叫，把最後一步交給工具。"}
        ], tools: TOOLS, tool_choice: {type: "function", function: {name: "calculator"}}, max_tokens: 1024, reasoning: "on"},
        expectTool: "calculator"
    });

    /* ============================================================
       C10：vision + streaming（完整圖描述串流）
       ============================================================ */
    console.log("\n[C10] vision + streaming");
    await streamChat({
        name: "C10.1 vision stream 描述",
        body: {model: MODEL, messages: [{role: "user", content: [
            {type: "image_url", image_url: {url: fileUrl}},
            {type: "text", text: "用繁體中文，3 段描述這張圖，每段 80 字左右。"}
        ]}], max_tokens: 600, temperature: 0}
    });

    /* ============================================================
       彙總
       ============================================================ */
    console.log(`\n${"=".repeat(120)}`);
    console.log("彙總：時間 / token rate（依 type 分組）");
    console.log("=".repeat(120));

    const byType: Record<string, CaseResult[]> = {};
    for (const r of results) {
        if (!byType[r.type]) byType[r.type] = [];
        byType[r.type]!.push(r);
    }
    for (const [type, list] of Object.entries(byType)) {
        const passList = list.filter(r => r.ok);
        const passRate = list.length > 0 ? (passList.length / list.length * 100).toFixed(1) : "0.0";
        const totalP = list.reduce((s, r) => s + r.pTok, 0);
        const totalC = list.reduce((s, r) => s + r.cTok, 0);
        const totalT = list.reduce((s, r) => s + r.timeMs, 0);
        const avgPRate = list.length > 0 ? list.reduce((s, r) => s + r.pRate, 0) / list.length : 0;
        const avgCRate = list.length > 0 ? list.reduce((s, r) => s + r.cRate, 0) / list.length : 0;
        console.log(`[${type.padEnd(12)}] pass=${passList.length}/${list.length} (${passRate}%)  time=${totalT}ms p=${totalP}t c=${totalC}t  avg p_rate=${avgPRate.toFixed(1)}t/s avg c_rate=${avgCRate.toFixed(1)}t/s`);
    }
    const passN = results.filter(r => r.ok).length;
    const failedList = results.filter(r => !r.ok);
    const overallRate = results.length > 0 ? (passN / results.length * 100).toFixed(1) : "0.0";
    console.log(`${"-".repeat(120)}`);
    console.log(`Overall: ${passN}/${results.length} 通過率 ${overallRate}%  ${passN === results.length ? "✅ ALL GREEN" : "❌"}`);
    if (failedList.length > 0) {
        console.log("Failed cases:");
        for (const f of failedList) console.log(`  - [${f.type}] ${f.case}  ${f.note}`);
    }
    process.exit(passN === results.length ? 0 : 1);
})();
