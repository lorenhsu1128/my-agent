// Stress test: mixed tool-calls + context overflow handling.
// Run with: bun scripts/live-test-stress.ts
// 假設 shim 已啟動於 $BASE。Overflow 測試需要 shim 用小 ctx 重啟（建議 --ctx-size 2048）。
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const PHASE = (process.env.PHASE ?? "mix") as "mix" | "overflow";
let pass = 0, fail = 0, soft = 0;

type Json = Record<string, unknown>;

// 多種 tool 設計：不同 schema 形狀（單參、多必填、巢狀 enum、可選欄位、無參）
const TOOLS = [
    {
        type: "function" as const,
        function: {
            name: "get_weather",
            description: "查詢城市目前天氣",
            parameters: {
                type: "object",
                properties: {city: {type: "string", description: "城市名稱"}},
                required: ["city"]
            }
        }
    },
    {
        type: "function" as const,
        function: {
            name: "calculator",
            description: "執行四則運算",
            parameters: {
                type: "object",
                properties: {
                    op: {type: "string", enum: ["add", "sub", "mul", "div"]},
                    a: {type: "number"},
                    b: {type: "number"}
                },
                required: ["op", "a", "b"]
            }
        }
    },
    {
        type: "function" as const,
        function: {
            name: "translate",
            description: "翻譯文字到指定語言",
            parameters: {
                type: "object",
                properties: {
                    text: {type: "string"},
                    target_lang: {type: "string", enum: ["en", "zh-TW", "ja"]},
                    formality: {type: "string", enum: ["casual", "formal"], description: "可選"}
                },
                required: ["text", "target_lang"]
            }
        }
    },
    {
        type: "function" as const,
        function: {
            name: "current_time",
            description: "取得目前伺服器時間（無參數）",
            parameters: {type: "object", properties: {}}
        }
    },
    {
        type: "function" as const,
        function: {
            name: "search_db",
            description: "查詢內部資料庫",
            parameters: {
                type: "object",
                properties: {
                    table: {type: "string", description: "table 名稱"},
                    filters: {
                        type: "object",
                        description: "過濾條件鍵值對",
                        additionalProperties: true
                    },
                    limit: {type: "integer", description: "結果上限，預設 10"}
                },
                required: ["table"]
            }
        }
    }
];

function classifyError(status: number, json: any): string {
    const code = json?.error?.code ?? json?.error?.type ?? "?";
    const msg = json?.error?.message ?? "";
    return `HTTP ${status} code=${code} msg="${String(msg).slice(0, 140)}"`;
}

async function chat(name: string, body: Json, opts: {expectTool?: boolean | string, expectError?: boolean} = {}) {
    const t0 = Date.now();
    let res: Response, json: any;
    try {
        res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(body)
        });
        json = await res.json().catch(() => ({}));
    } catch (e) {
        const dt = Date.now() - t0;
        console.log(`\n===== ${name} =====`);
        console.log(`time=${dt}ms NETWORK_ERROR=${(e as Error).message}`);
        if (opts.expectError) { soft++; console.log("SOFT-PASS (expected error path)"); }
        else { fail++; console.log("FAIL"); }
        return;
    }
    const dt = Date.now() - t0;
    const choice = json?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content ?? "";
    const toolCalls = choice?.message?.tool_calls ?? null;
    const finish = choice?.finish_reason ?? "?";
    const usage = json?.usage ?? {};
    const sec = dt / 1000;
    const pTok = Number(usage.prompt_tokens ?? 0);
    const cTok = Number(usage.completion_tokens ?? 0);

    console.log(`\n===== ${name} =====`);
    if (res.status >= 400 || json?.error) {
        console.log(`time=${dt}ms ${classifyError(res.status, json)}`);
        if (opts.expectError) { pass++; console.log("PASS (expected error)"); }
        else { fail++; console.log("FAIL (unexpected error)"); }
        return;
    }

    console.log(`time=${dt}ms finish=${finish} content=${content.length}ch reasoning=${reasoning.length}ch p=${pTok} c=${cTok} c_rate=${sec > 0 ? (cTok/sec).toFixed(1) : "?"}t/s`);
    if (content) console.log(`-- content[0..160]:\n${content.slice(0, 160)}`);
    if (toolCalls) {
        const names = toolCalls.map((t: any) => `${t.function?.name}(${(t.function?.arguments ?? "").slice(0, 60)})`);
        console.log(`-- tool_calls(${toolCalls.length}): ${names.join(" | ")}`);
    }

    let ok = true;
    if (opts.expectTool === true) ok = Array.isArray(toolCalls) && toolCalls.length > 0;
    else if (typeof opts.expectTool === "string") {
        ok = Array.isArray(toolCalls) && toolCalls.some((t: any) => t.function?.name === opts.expectTool);
    } else if (!opts.expectError) {
        ok = content.length > 0 || (Array.isArray(toolCalls) && toolCalls.length > 0);
    }

    if (opts.expectError) { fail++; console.log("FAIL (expected error but got success)"); }
    else if (ok) { pass++; console.log("PASS"); }
    else { fail++; console.log("FAIL"); }
}

const filler = (kbApprox: number) => {
    // 約 1KB 中文 ≈ 333 字（UTF-8 3 byte/字）→ token 約 ~250
    const para = "這是一段填充文字用來占用上下文空間。我們需要它變得很長，因為目標是把 token 數推高到接近上下文限制。";
    const reps = Math.ceil((kbApprox * 1024) / (para.length * 3));
    return Array(reps).fill(para).join(" ");
};

// 每段約 100 token，重複 N 段
const fillerByTokens = (approxTokens: number) => {
    const seg = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
    const segTok = 24;
    return Array(Math.ceil(approxTokens / segTok)).fill(seg).join("");
};

(async () => {
    if (PHASE === "mix") {
        console.log(`\n##### PHASE = mix (一般 ctx) #####`);

        // T11: 一句話順序混合（T1+T4+T6 風格）—— 同 user message 同時要求簡答 + 計算 + 工具
        await chat("T11 一句多意圖（無 tool 提示）", {
            model: MODEL,
            messages: [{role: "user", content: "請先回答 17 加 23 等於多少，然後翻譯『早安』成日文。"}],
            tools: TOOLS, tool_choice: "auto", max_tokens: 1024, reasoning: "off"
        });

        // T12: 多輪混合（T5 記憶 + T6 tool + T9 tool 回合制 + T1 閒聊收尾）
        await chat("T12 多輪混合 + 多種 tool", {
            model: MODEL,
            messages: [
                {role: "user", content: "我叫 Loren，住在新竹。"},
                {role: "assistant", content: "好的 Loren。"},
                {role: "user", content: "查一下我所在城市的天氣，再幫我把『晴天真好』翻成英文。"},
                {role: "assistant", content: null, tool_calls: [
                    {id: "c1", type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: "新竹"})}},
                    {id: "c2", type: "function", function: {name: "translate", arguments: JSON.stringify({text: "晴天真好", target_lang: "en"})}}
                ]},
                {role: "tool", tool_call_id: "c1", content: '{"city":"新竹","temperature":26,"condition":"晴"}'},
                {role: "tool", tool_call_id: "c2", content: '{"translated":"Sunny days are wonderful."}'},
                {role: "user", content: "用一句話總結，並再問我叫什麼名字。"}
            ],
            tools: TOOLS, max_tokens: 512, reasoning: "off"
        });

        // T13: 強制工具選擇（calculator / search_db）
        await chat("T13 tool_choice 強制 calculator", {
            model: MODEL,
            messages: [{role: "user", content: "幫我計算 123 乘以 456。"}],
            tools: TOOLS,
            tool_choice: {type: "function", function: {name: "calculator"}},
            max_tokens: 256, reasoning: "off"
        }, {expectTool: "calculator"});

        // T14: 巢狀參數 search_db
        await chat("T14 巢狀 search_db", {
            model: MODEL,
            messages: [{role: "user", content: "從 users 表找 status=active 且 city=Taipei 的前 5 筆。"}],
            tools: TOOLS, tool_choice: "auto", max_tokens: 512, reasoning: "off"
        }, {expectTool: "search_db"});

        // T15: 無參數 tool current_time
        await chat("T15 無參 tool current_time", {
            model: MODEL,
            messages: [{role: "user", content: "現在伺服器時間是？"}],
            tools: TOOLS, tool_choice: "auto", max_tokens: 256, reasoning: "off"
        }, {expectTool: "current_time"});

        // T16: 多步混合（thinking on + 多輪 + 多 tool）
        await chat("T16 thinking + 連串 tool", {
            model: MODEL,
            messages: [
                {role: "user", content: "我想規劃一個東京三日遊，先告訴我東京現在天氣，再翻譯『謝謝』成日文，最後計算 1500*3 預算。"}
            ],
            tools: TOOLS, tool_choice: "auto", max_tokens: 2048, reasoning: "on"
        });

    } else if (PHASE === "overflow") {
        console.log(`\n##### PHASE = overflow (小 ctx) #####`);
        console.log(`提醒：請以 --ctx-size 2048 重啟 shim 才有效`);

        // T17: prompt 略大於 ctx → 應該 4xx error
        const bigPrompt = fillerByTokens(3000);
        await chat("T17 prompt 超過 ctx 2048 (>3000 tok)", {
            model: MODEL,
            messages: [
                {role: "system", content: "你是助理。"},
                {role: "user", content: bigPrompt + "\n\n請回答：剛才那段文字總共有幾段？"}
            ],
            max_tokens: 128, reasoning: "off"
        }, {expectError: true});

        // T18: prompt + max_tokens 累積爆量（prompt 可塞但 max_tokens 太大）
        const midPrompt = fillerByTokens(1500);
        await chat("T18 prompt 1500 + max_tokens 1024 (合計 >ctx 2048)", {
            model: MODEL,
            messages: [{role: "user", content: midPrompt + "\n\n簡短回答：以上這段在說什麼？"}],
            max_tokens: 1024, reasoning: "off"
        });
        // 這個情況不一定錯誤 —— 可能正常完成（截斷）或 finish=length；只要不 crash 就行

        // T19: 多輪累積到爆 —— 模擬長對話
        const turns: Json[] = [];
        for (let i = 0; i < 12; i++) {
            turns.push({role: "user", content: `第 ${i + 1} 輪：${fillerByTokens(200)}`});
            turns.push({role: "assistant", content: `這是第 ${i + 1} 輪的回覆。${fillerByTokens(80)}`});
        }
        turns.push({role: "user", content: "請告訴我第一輪我說了什麼？"});
        await chat("T19 12 輪累積 ~3360 tok 超過 ctx", {
            model: MODEL,
            messages: turns,
            max_tokens: 128, reasoning: "off"
        }, {expectError: true});

        // T20: tool history 累積爆量
        const toolTurns: Json[] = [];
        for (let i = 0; i < 8; i++) {
            toolTurns.push({role: "user", content: `查詢第 ${i + 1} 個城市天氣，城市叫做 City${i}_${fillerByTokens(150)}`});
            toolTurns.push({role: "assistant", content: null, tool_calls: [
                {id: `t${i}`, type: "function", function: {name: "get_weather", arguments: JSON.stringify({city: `City${i}`})}}
            ]});
            toolTurns.push({role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({city: `City${i}`, temp: 20 + i, note: fillerByTokens(80)})});
        }
        toolTurns.push({role: "user", content: "總結所有城市的氣溫。"});
        await chat("T20 多 tool roundtrip 累積 ~2880 tok", {
            model: MODEL,
            messages: toolTurns, tools: TOOLS,
            max_tokens: 256, reasoning: "off"
        }, {expectError: true});

        // T21: 邊界 —— 剛好等於 ctx
        await chat("T21 邊界 prompt ~2000 tok（留 48 給生成）", {
            model: MODEL,
            messages: [{role: "user", content: fillerByTokens(2000) + "\n\n答 OK 即可。"}],
            max_tokens: 32, reasoning: "off"
        });
    }

    console.log(`\n================================`);
    console.log(`PHASE=${PHASE} Total: PASS=${pass} FAIL=${fail}${soft > 0 ? ` SOFT=${soft}` : ""}`);
    process.exit(fail);
})();
