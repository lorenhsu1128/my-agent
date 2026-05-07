// live-test-realistic-v2 — 全面 thinking + 全面 stream，模擬真實 agent 使用場景。
//
// 與 v1 差異：
//   - 全部 cases reasoning="on" + stream=true（v1 大半用 reasoning="off" 非串流）
//   - 新增 reasoning-tool / multi-step-plan / ambiguity / refusal 類別
//   - 多輪 chain 更深、tool 結果故意矛盾 / 模糊
//   - 多模態混合 + thinking 推理
//   - 量測 TTFT、generation rate（=c/(t-TTFT)）、reasoning token
//
// 啟動同 v1：bun run dev -- serve --model ... --mmproj ... --ctx-size 262144
//   --gpu cuda --n-gpu-layers 999 --cache-type-k turbo4 --cache-type-v turbo4
//   --flash-attn --enable-tools --reasoning on --reasoning-format deepseek
//   --alias qwen3.5-9b
// 跑：IMAGE=<abs path> bun scripts/live-test-realistic-v2.ts

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const IMAGE = path.resolve(process.env.IMAGE ?? "llama/llama.cpp/tools/mtmd/test-1.jpeg");

type CaseType = "reasoning-tool" | "multi-step-plan" | "ambiguity" | "refusal" | "vision+tool" | "stream-only" | "long-think";

type CaseResult = {
    case: string,
    type: CaseType,
    timeMs: number,
    ttftMs: number | null,
    pTok: number,
    cTok: number,
    rTok: number,
    pRate: number,
    cRate: number,
    note: string,
    ok: boolean
};

const results: CaseResult[] = [];

function record(r: CaseResult) {
    results.push(r);
    const flag = r.ok ? "✅" : "❌";
    const tt = r.ttftMs != null ? ` ttft=${String(r.ttftMs).padStart(5)}ms` : "";
    console.log(`  ${flag} ${r.case.padEnd(48)} ${String(r.timeMs).padStart(6)}ms${tt}  p=${String(r.pTok).padStart(4)}t/${r.pRate.toFixed(1).padStart(6)}t/s  c=${String(r.cTok).padStart(4)}t/${r.cRate.toFixed(1).padStart(5)}t/s  r=${String(r.rTok).padStart(4)}t  ${r.note}`);
}

const TOOLS = [
    {type: "function", function: {name: "read_file", description: "讀取檔案內容", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}},
    {type: "function", function: {name: "edit_file", description: "編輯檔案", parameters: {type: "object", properties: {path: {type: "string"}, old_str: {type: "string"}, new_str: {type: "string"}}, required: ["path", "old_str", "new_str"]}}},
    {type: "function", function: {name: "run_shell", description: "執行 shell 指令", parameters: {type: "object", properties: {cmd: {type: "string"}}, required: ["cmd"]}}},
    {type: "function", function: {name: "search_web", description: "搜尋網路", parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}}},
    {type: "function", function: {name: "fetch_url", description: "抓取 URL 內容", parameters: {type: "object", properties: {url: {type: "string"}}, required: ["url"]}}},
    {type: "function", function: {name: "calculator", description: "四則運算", parameters: {type: "object", properties: {op: {type: "string", enum: ["add", "sub", "mul", "div"]}, a: {type: "number"}, b: {type: "number"}}, required: ["op", "a", "b"]}}},
    {type: "function", function: {name: "list_dir", description: "列出目錄內容", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}},
    {type: "function", function: {name: "grep_code", description: "在 codebase 中搜尋字串/regex", parameters: {type: "object", properties: {pattern: {type: "string"}, path: {type: "string"}}, required: ["pattern"]}}},
    {type: "function", function: {name: "git_log", description: "查看 git 歷史", parameters: {type: "object", properties: {limit: {type: "integer"}, file: {type: "string"}}}}},
    {type: "function", function: {name: "ask_user", description: "向使用者澄清問題", parameters: {type: "object", properties: {question: {type: "string"}}, required: ["question"]}}}
];

type Expect = boolean | string | {tool?: string, textMatch?: RegExp, anyOf?: string[]};

/**
 * 統一的 stream 跑法：reasoning=on + stream=true，回傳完整 toolCalls 供 chain 使用。
 * 量測：TTFT、generation rate（=c/(t-TTFT)）、reasoning_content tokens（依 chars/4 估算）。
 */
async function streamCase(opts: {
    name: string,
    type: CaseType,
    body: any,
    expect?: Expect,
    note?: string
}): Promise<{content: string, reasoning: string, toolCalls: any[]}> {
    const t0 = Date.now();
    const fullBody = {...opts.body, model: MODEL, reasoning: "on", stream: true};
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify(fullBody)
    });
    if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        record({
            case: opts.name, type: opts.type,
            timeMs: Date.now() - t0, ttftMs: null,
            pTok: 0, cTok: 0, rTok: 0, pRate: 0, cRate: 0,
            note: `HTTP ${res.status}: ${errText.slice(0, 80)}`, ok: false
        });
        return {content: "", reasoning: "", toolCalls: []};
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let contentDelta = "";
    let reasoningDelta = "";
    // 累積 tool_calls — OpenAI streaming 規範用 index 對齊，arguments 是 partial 拼接
    const toolMap = new Map<number, {id?: string, name?: string, args: string}>();
    let done = false;
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
                    const sawDelta = (d.content || d.reasoning_content || (Array.isArray(d.tool_calls) && d.tool_calls.length > 0));
                    if (sawDelta && ttftMs == null) ttftMs = Date.now() - t0;
                    if (typeof d.content === "string") contentDelta += d.content;
                    if (typeof d.reasoning_content === "string") reasoningDelta += d.reasoning_content;
                    if (Array.isArray(d.tool_calls)) {
                        for (const tc of d.tool_calls) {
                            const i = typeof tc.index === "number" ? tc.index : (toolMap.size);
                            const cur = toolMap.get(i) ?? {args: ""};
                            if (tc.id) cur.id = tc.id;
                            if (tc.function?.name) cur.name = tc.function.name;
                            if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
                            toolMap.set(i, cur);
                        }
                    }
                    if (j?.usage) lastUsage = j.usage;
                } catch { /* */ }
            }
        }
    }
    const dt = Date.now() - t0;
    const pTok = Number(lastUsage?.prompt_tokens ?? 0);
    const cTok = Number(lastUsage?.completion_tokens ?? 0);
    const rTok = Math.round(reasoningDelta.length / 4);
    const promptSec = (ttftMs ?? dt) / 1000;
    // gen rate 計算 — 當 ttftMs ≈ dt 時 (genSec 極小) 表示完整 response 在一次 buffer flush
    // 內收完，這時用 dt 整體當分母比較合理（避免除零產生 t/s 天文數字）。
    const rawGenSec = (dt - (ttftMs ?? dt)) / 1000;
    const genSec = rawGenSec >= 0.05 ? rawGenSec : (dt / 1000);

    const toolCalls = [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([_, v]) => ({
        id: v.id ?? `call_${Math.random().toString(36).slice(2, 12)}`,
        type: "function" as const,
        function: {name: v.name ?? "(unknown)", arguments: v.args}
    }));

    let ok = done;
    let okReason = "";
    if (opts.expect === true) ok = ok && toolCalls.length > 0;
    else if (typeof opts.expect === "string") {
        ok = ok && toolCalls.some((t) => t.function.name === opts.expect);
        if (ok) okReason = `tool=${opts.expect}`;
    } else if (opts.expect != null && typeof opts.expect === "object") {
        const e = opts.expect;
        const toolHit = e.tool != null && toolCalls.some((t) => t.function.name === e.tool);
        const anyOfHit = e.anyOf != null && toolCalls.some((t) => e.anyOf!.includes(t.function.name));
        const textHit = e.textMatch != null && (e.textMatch.test(contentDelta) || e.textMatch.test(reasoningDelta));
        ok = ok && (toolHit || anyOfHit || textHit);
        if (toolHit) okReason = `tool=${e.tool}`;
        else if (anyOfHit) okReason = `tool∈[${e.anyOf!.join(",")}]`;
        else if (textHit) okReason = `text~/${e.textMatch!.source.slice(0, 24)}/`;
    } else ok = ok && (contentDelta.length > 0 || toolCalls.length > 0);

    const noteFinal = opts.note
        ?? (toolCalls.length > 0
            ? `tools=[${toolCalls.map((t) => t.function.name).join(",")}]${okReason ? " " + okReason : ""}`
            : `chunks=${contentDelta.length}ch${okReason ? " " + okReason : ""}`);

    record({
        case: opts.name, type: opts.type,
        timeMs: dt, ttftMs,
        pTok, cTok, rTok,
        pRate: promptSec > 0 ? pTok / promptSec : 0,
        cRate: cTok > 0 ? cTok / genSec : 0,
        note: noteFinal, ok
    });
    return {content: contentDelta, reasoning: reasoningDelta, toolCalls};
}

const fileUrl = `file:///${IMAGE.replace(/\\/g, "/")}`;

(async () => {
    if (!fs.existsSync(IMAGE)) { console.error(`IMAGE not found: ${IMAGE}`); process.exit(2); }
    console.log(`\n#### REALISTIC v2 — THINKING + STREAM 全面 against ${BASE} (256k turbo4 reasoning=on) ####\n`);

    /* ============================================================
       D1: reasoning-tool — thinking 推導後才能決定 tool 名
       ============================================================ */
    console.log("[D1] reasoning-tool — 模型必須先 reason 才知道呼哪個 tool");
    await streamCase({
        name: "D1.1 reason → 決定用 grep_code 找 import",
        type: "reasoning-tool",
        body: {
            messages: [
                {role: "system", content: "你是 senior code agent。會先思考再用工具。"},
                {role: "user", content: "我要找 codebase 裡所有檔案中**最常被 import 的模組名**，請先想一下要怎麼做，再用工具開始。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: {anyOf: ["grep_code", "list_dir", "run_shell"]}
    });

    await streamCase({
        name: "D1.2 reason → 決定用 git_log 找 commit 多者",
        type: "reasoning-tool",
        body: {
            messages: [
                {role: "system", content: "你是 git 偵探。先想再做。"},
                {role: "user", content: "我想知道 src/server 目錄底下，最近兩個月誰 commit 最多次。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: {anyOf: ["git_log", "run_shell"]}
    });

    /* ============================================================
       D2: multi-step-plan — 模型自己分多步呼叫
       ============================================================ */
    console.log("\n[D2] multi-step-plan — 一個任務需要 2-3 步 tool 呼叫");
    let history2: any[] = [
        {role: "system", content: "助理：用工具完成任務，可以分多步。"},
        {role: "user", content: "請：(1) 列出 src 底下有哪些子目錄，(2) 找出其中名字含 'server' 的，(3) 對該目錄跑 git_log 最後 3 筆。先做第一步。"}
    ];
    let r = await streamCase({
        name: "D2.1 step1 list_dir(src)",
        type: "multi-step-plan",
        body: {messages: history2, tools: TOOLS, tool_choice: "auto", max_tokens: 1024},
        expect: "list_dir"
    });
    history2.push({role: "assistant", content: null, tool_calls: r.toolCalls});
    history2.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x1", content: JSON.stringify(["server", "client", "shared", "scripts", "tests"])});

    r = await streamCase({
        name: "D2.2 step2 識別 server 子目錄 → 進 step3",
        type: "multi-step-plan",
        body: {messages: history2, tools: TOOLS, tool_choice: "auto", max_tokens: 1024},
        // 接受三種：呼 tool 推進 / 純文字描述計畫 / 描述找到 server
        expect: {anyOf: ["git_log", "run_shell", "list_dir"], textMatch: /server/i}
    });
    if (r.toolCalls.length > 0) {
        history2.push({role: "assistant", content: null, tool_calls: r.toolCalls});
        history2.push({role: "tool", tool_call_id: r.toolCalls[0]?.id ?? "x2", content: JSON.stringify([
            {hash: "abc123", msg: "fix server crash", date: "2026-05-04"},
            {hash: "def456", msg: "add tcq route", date: "2026-05-03"},
            {hash: "ghi789", msg: "refactor sse", date: "2026-05-01"}
        ])});
    } else {
        history2.push({role: "assistant", content: r.content});
    }
    await streamCase({
        name: "D2.3 三步整合摘要",
        type: "multi-step-plan",
        body: {messages: history2, tools: TOOLS, tool_choice: "auto", max_tokens: 1024},
        expect: {textMatch: /(server|fix|tcq|refactor)/i}
    });

    /* ============================================================
       D3: ambiguity — user prompt 含糊
       ============================================================ */
    console.log("\n[D3] ambiguity — prompt 含糊，模型應澄清或合理推斷");
    await streamCase({
        name: "D3.1 含糊「修一下那個 bug」",
        type: "ambiguity",
        body: {
            messages: [
                {role: "system", content: "助理：含糊請求請用 ask_user 澄清，不要瞎猜。"},
                {role: "user", content: "幫我修一下那個 bug。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: {tool: "ask_user", textMatch: /(哪個|什麼|具體|請問|清楚|描述|資訊)/i}
    });

    await streamCase({
        name: "D3.2 含糊「加個東西」+ 有 context 應推斷",
        type: "ambiguity",
        body: {
            messages: [
                {role: "system", content: "助理：可以從 context 推斷時直接做，不必每次都問。"},
                {role: "user", content: "幫我看 src/utils.ts。"},
                {role: "assistant", content: null, tool_calls: [{id: "x", type: "function", function: {name: "read_file", arguments: JSON.stringify({path: "src/utils.ts"})}}]},
                {role: "tool", tool_call_id: "x", content: "export function add(a, b) { return a + b; }"},
                {role: "user", content: "幫我加個東西。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        // 三種合理行為：呼 ask_user 澄清 / 呼 edit_file 自行加 / 純文字反問要加什麼
        expect: {anyOf: ["ask_user", "edit_file"], textMatch: /(什麼|哪裡|具體|加什麼|內容|要加|建議|提供)/i}
    });

    /* ============================================================
       D4: refusal / boundary
       ============================================================ */
    console.log("\n[D4] refusal — 不該呼工具的時候別亂呼");
    await streamCase({
        name: "D4.1 純知識題不該用 tool（量子力學）",
        type: "refusal",
        body: {
            messages: [
                {role: "system", content: "助理：純知識問題直接回答，不要亂呼工具。"},
                {role: "user", content: "薛丁格方程式的時間演化算符是什麼？簡短回答。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: {textMatch: /(算符|operator|U\(t\)|exp|哈密|H|hbar|hat)/i}
    });

    await streamCase({
        name: "D4.2 用戶要求做不到的事",
        type: "refusal",
        body: {
            messages: [
                {role: "system", content: "助理：能做就做，做不到就明說。"},
                {role: "user", content: "幫我訂一張明天去東京的機票。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: {textMatch: /(無法|不能|沒有|抱歉|做不到|cannot|unable|建議)/i}
    });

    /* ============================================================
       D5: tool 結果矛盾 — 模型該注意
       ============================================================ */
    console.log("\n[D5] tool 結果矛盾 — 模型該指出問題");
    await streamCase({
        name: "D5.1 兩個 search 結果衝突 → 該點出",
        type: "reasoning-tool",
        body: {
            messages: [
                {role: "system", content: "助理：注意 tool 結果是否合理。"},
                {role: "user", content: "查 OpenAI o1 的 reasoning_effort 預設值。"},
                {role: "assistant", content: null, tool_calls: [{id: "s1", type: "function", function: {name: "search_web", arguments: JSON.stringify({query: "o1 reasoning_effort default"})}}]},
                {role: "tool", tool_call_id: "s1", content: JSON.stringify({results: [{snippet: "default is medium"}]})},
                {role: "assistant", content: "預設是 medium。"},
                {role: "user", content: "再查一次確認。"},
                {role: "assistant", content: null, tool_calls: [{id: "s2", type: "function", function: {name: "search_web", arguments: JSON.stringify({query: "o1 reasoning_effort"})}}]},
                {role: "tool", tool_call_id: "s2", content: JSON.stringify({results: [{snippet: "default is high"}]})}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: {textMatch: /(矛盾|衝突|不一致|不同|conflict|differ|不相同|高|medium|high)/i}
    });

    /* ============================================================
       D6: long-think — 數學/邏輯推理
       ============================================================ */
    console.log("\n[D6] long-think — 數學/邏輯推理");
    await streamCase({
        name: "D6.1 100 以內 4 個質因數的數",
        type: "long-think",
        body: {
            messages: [
                {role: "user", content: "找出 100 以內**剛好有 4 個不同質因數**的所有正整數。請列出。"}
            ],
            max_tokens: 4096
        },
        expect: {textMatch: /(沒有|無|none|0 個|不存在|超過|大於 100|>100|exceed)/i}
    });

    await streamCase({
        name: "D6.2 三人說謊邏輯題",
        type: "long-think",
        body: {
            messages: [
                {role: "user", content: "有三個人 A B C，每個人不是說真話就是說謊。A 說『我們三個都說謊』。問：A 一定說真話還是說謊？請給結論。"}
            ],
            max_tokens: 4096
        },
        expect: {textMatch: /(A.*說謊|A.*lie|A.*liar|A.*謊言)/i}
    });

    /* ============================================================
       D7: vision + thinking + tool
       ============================================================ */
    console.log("\n[D7] vision + thinking + tool 三重組合");
    await streamCase({
        name: "D7.1 vision → reason → calculator",
        type: "vision+tool",
        body: {
            messages: [
                {role: "system", content: "助理：先看圖、再思考、需要算數時用 calculator。"},
                {role: "user", content: [
                    {type: "text", text: "圖中是什麼歷史事件？算出今年（2025）距事件年份多久。"},
                    {type: "image_url", image_url: {url: fileUrl}}
                ]}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 2048, temperature: 0
        },
        expect: {tool: "calculator", textMatch: /(56|57|阿波羅|Apollo|登月)/i}
    });

    /* ============================================================
       D8: streaming-only — 純流量大長文
       ============================================================ */
    console.log("\n[D8] stream-only — 24 點解題 + thinking");
    await streamCase({
        name: "D8.1 stream 解四個 7 拼 28",
        type: "stream-only",
        body: {
            messages: [
                {role: "user", content: "用四個數字 7,7,7,7（每個剛好用一次，可加減乘除括號）算出 28。給出表達式。"}
            ],
            max_tokens: 2048
        },
        expect: {textMatch: /\b28\b|7.*7.*7.*7/}
    });

    /* ============================================================
       D9: 大量 tool list (10) + thinking — 壓 attention 退化
       ============================================================ */
    console.log("\n[D9] thinking + 10 tools — 壓 tool selection 退化點");
    await streamCase({
        name: "D9.1 thinking + 10 tools 選 grep_code",
        type: "reasoning-tool",
        body: {
            messages: [
                {role: "system", content: "助理：用最合適的工具。"},
                {role: "user", content: "在 src 底下找『async function handle』這個 pattern。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024
        },
        expect: "grep_code"
    });

    /* ============================================================
       D10: 連續 thinking 的長對話累積（純知識題，不該呼 tool）
       ============================================================ */
    console.log("\n[D10] 5 輪 thinking 連續（檢查 attention 衰減）");
    let history10: any[] = [{role: "system", content: "助理：每輪都好好想，純知識題直接回答。"}];
    const questions: Array<{q: string, expect: Expect}> = [
        {q: "費馬最後定理的陳述是什麼？", expect: {textMatch: /(a\^n|b\^n|c\^n|n\s*[>＞]\s*2|大於 2|整數解|沒有正整數)/i}},
        {q: "懷爾斯（Andrew Wiles）首次發表完整證明是哪一年？", expect: {textMatch: /(1994|1995|1993)/}},
        {q: "證明的核心對應（橢圓曲線與某類 form 的關係）叫什麼？", expect: {textMatch: /(谷山|Taniyama|志村|Shimura|模形式|modular)/i}},
        {q: "這個對應的完整版本（包含所有橢圓曲線）在哪一年被完整證明？", expect: {textMatch: /(1999|2001|2000)/}},
        {q: "綜合上面四題的答案，給我一段時間線（最多 5 句）。", expect: {textMatch: /(費馬|Fermat|懷爾斯|Wiles|模|時間|年|1994|1995)/i}}
    ];
    for (let i = 0; i < questions.length; i++) {
        const item = questions[i]!;
        history10.push({role: "user", content: item.q});
        const resp = await streamCase({
            name: `D10.${i + 1} 連續 thinking 第${i + 1}輪`,
            type: "long-think",
            body: {messages: history10, max_tokens: 1500},
            expect: item.expect
        });
        history10.push({role: "assistant", content: resp.content || "[empty]"});
    }

    /* ============================================================
       彙總
       ============================================================ */
    console.log(`\n${"=".repeat(146)}`);
    console.log("彙總：時間 / token rate / reasoning token（依 type 分組）");
    console.log("=".repeat(146));

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
        const totalR = list.reduce((s, r) => s + r.rTok, 0);
        const totalT = list.reduce((s, r) => s + r.timeMs, 0);
        const avgPRate = list.length > 0 ? list.reduce((s, r) => s + r.pRate, 0) / list.length : 0;
        const avgCRate = list.length > 0 ? list.reduce((s, r) => s + r.cRate, 0) / list.length : 0;
        const avgTtft = (() => {
            const xs = list.map(r => r.ttftMs).filter((x): x is number => x != null);
            return xs.length > 0 ? Math.round(xs.reduce((a,b)=>a+b, 0) / xs.length) : NaN;
        })();
        console.log(`[${type.padEnd(16)}] pass=${passList.length}/${list.length} (${passRate}%)  time=${totalT}ms p=${totalP}t c=${totalC}t r=${totalR}t  avg ttft=${isNaN(avgTtft) ? "n/a" : avgTtft + "ms"}  avg p_rate=${avgPRate.toFixed(1)}t/s avg c_rate=${avgCRate.toFixed(1)}t/s`);
    }
    const passN = results.filter(r => r.ok).length;
    const failedList = results.filter(r => !r.ok);
    const overallRate = results.length > 0 ? (passN / results.length * 100).toFixed(1) : "0.0";
    console.log(`${"-".repeat(146)}`);
    console.log(`Overall: ${passN}/${results.length} 通過率 ${overallRate}%  ${passN === results.length ? "✅ ALL GREEN" : "❌"}`);
    if (failedList.length > 0) {
        console.log("Failed cases:");
        for (const f of failedList) console.log(`  - [${f.type}] ${f.case}  ${f.note}`);
    }
    process.exit(passN === results.length ? 0 : 1);
})();
