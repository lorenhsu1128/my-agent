// 針對 C11.5 二元一次方程組單獨抽測，跑 5 次（reasoning on / off 各 + 不同 max_tokens），
// 印完整 content + reasoning，並用原 regex 與更寬鬆 regex 對照，定位 fail 是模型還是 regex。
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

const ORIG_X = /x\s*=\s*2/;
const ORIG_Y = /y\s*=\s*5/;
// 更寬鬆：容許負號 / 等號前後任何空白 / 中文等號 / LaTeX \boxed{}
const LOOSE_X = /x\s*[=＝:]\s*\(?\s*2\b/;
const LOOSE_Y = /y\s*[=＝:]\s*\(?\s*5\b/;

const RUNS: {label: string, body: any}[] = [
    {label: "R1 reasoning=on max=1024", body: {reasoning: "on", max_tokens: 1024}},
    {label: "R2 reasoning=off max=1024", body: {reasoning: "off", max_tokens: 1024}},
    {label: "R3 reasoning=on max=2048", body: {reasoning: "on", max_tokens: 2048}},
    {label: "R4 reasoning=off max=2048", body: {reasoning: "off", max_tokens: 2048}},
    {label: "R5 reasoning=on max=4096 temperature=0", body: {reasoning: "on", max_tokens: 4096, temperature: 0}}
];

(async () => {
    for (const r of RUNS) {
        const t0 = Date.now();
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: MODEL,
                messages: [{role: "user", content: "解 { 3x + 2y = 16, 5x - y = 7 }。逐步用代入或消去，給 (x, y)。"}],
                ...r.body
            })
        });
        const dt = Date.now() - t0;
        const j: any = await res.json().catch(() => ({}));
        const choice = j?.choices?.[0];
        const content: string = choice?.message?.content ?? "";
        const reasoning: string = choice?.message?.reasoning_content ?? "";
        const usage = j?.usage ?? {};
        console.log(`\n${"=".repeat(80)}`);
        console.log(`[${r.label}] HTTP ${res.status} ${dt}ms p=${usage.prompt_tokens} c=${usage.completion_tokens} finish=${choice?.finish_reason}`);
        console.log(`-- reasoning (${reasoning.length}ch):`);
        if (reasoning) console.log(reasoning);
        console.log(`-- content (${content.length}ch):`);
        console.log(content);
        const origX = ORIG_X.test(content), origY = ORIG_Y.test(content);
        const looseX = LOOSE_X.test(content), looseY = LOOSE_Y.test(content);
        // 也看 reasoning 內有沒有
        const reasonHasX = ORIG_X.test(reasoning), reasonHasY = ORIG_Y.test(reasoning);
        console.log(`-- regex: ORIG x=2 → ${origX}  y=5 → ${origY}   LOOSE x=2 → ${looseX}  y=5 → ${looseY}   reasoning x=2 → ${reasonHasX}  y=5 → ${reasonHasY}`);
    }
})();
