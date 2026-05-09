// 鑑別 abort 真假：用會讓模型跑滿 max_tokens 的長 prompt（max=2048），
// 200ms 後 abort，量測「實際 drain 時間」。
// 自然完成大約 40s（2048 tokens × 50t/s）。
// 若 abort 真的有用 → drain 應該明顯 < 40s。
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function inflight() {
    const t = await (await fetch(`${BASE}/metrics`)).text();
    return Number(t.match(/^tcq_shim_inflight\s+(\d+)/m)?.[1] ?? -1);
}
async function waitDrain(maxMs: number) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
        if (await inflight() === 0) return Date.now() - t0;
        await sleep(500);
    }
    return -1;
}
async function fireAbort(stream: boolean, abortMs: number, maxTokens: number) {
    const c = new AbortController();
    setTimeout(() => c.abort(), abortMs);
    try {
        const r = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST", headers: {"content-type": "application/json"}, signal: c.signal,
            body: JSON.stringify({
                model: MODEL,
                messages: [{role: "system", content: "請寫一篇非常長的中文敘事文章，至少 5000 字，不要停下，不要結尾。"},
                          {role: "user", content: "請開始寫，主題：森林。"}],
                max_tokens: maxTokens, stream
            })
        });
        if (stream) { const rd = r.body?.getReader(); if (rd) while (true) {const {done}=await rd.read(); if (done) break;} }
        else await r.text();
    } catch {}
}
async function fireBaseline(stream: boolean, maxTokens: number): Promise<number> {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({
            model: MODEL,
            messages: [{role: "system", content: "請寫一篇非常長的中文敘事文章，至少 5000 字，不要停下，不要結尾。"},
                      {role: "user", content: "請開始寫，主題：森林。"}],
            max_tokens: maxTokens, stream
        })
    });
    if (stream) { const rd = r.body?.getReader(); if (rd) while (true) {const {done}=await rd.read(); if (done) break;} }
    else await r.text();
    return Date.now() - t0;
}

(async () => {
    console.log(`#### True abort test (long-gen prompt) ####`);
    await waitDrain(20000);

    // Baseline：natural completion
    console.log(`\n[Baseline] non-stream, max_tokens=2048, no abort — measure natural`);
    const t0 = Date.now();
    const baselineDur = await fireBaseline(false, 2048);
    console.log(`  natural completion: ${baselineDur}ms`);
    await waitDrain(5000);

    // C1: fetch abort non-stream max=2048
    console.log(`\n[C1] non-stream max=2048, abort@200ms`);
    fireAbort(false, 200, 2048);  // fire-and-forget; we measure drain not request
    await sleep(300); // ensure request reached server
    const d1 = await waitDrain(60000);
    console.log(`  drain: ${d1}ms ${d1 > 0 && d1 < baselineDur * 0.7 ? "✅ abort effective" : "❌ abort not effective (similar to natural)"}`);

    // C2: fetch abort stream max=2048
    console.log(`\n[C2] stream max=2048, abort@200ms`);
    fireAbort(true, 200, 2048);
    await sleep(300);
    const d2 = await waitDrain(60000);
    console.log(`  drain: ${d2}ms ${d2 > 0 && d2 < baselineDur * 0.7 ? "✅ abort effective" : "❌ abort not effective"}`);

    // C3: child SIGKILL non-stream
    console.log(`\n[C3] child bun SIGKILL non-stream max=2048`);
    const child = Bun.spawn(["bun", "-e", `
        await fetch("${BASE}/v1/chat/completions", {
            method: "POST", headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: "${MODEL}",
                messages: [{role: "system", content: "請寫一篇非常長的中文敘事文章，至少 5000 字，不要停下，不要結尾。"},
                          {role: "user", content: "請開始寫，主題：森林。"}],
                max_tokens: 2048, stream: false
            })
        }).then(r => r.text());
    `]);
    await sleep(800);
    child.kill(9);
    const d3 = await waitDrain(60000);
    console.log(`  drain: ${d3}ms ${d3 > 0 && d3 < baselineDur * 0.7 ? "✅ kill detected" : "❌ kill not detected (req kept running)"}`);
})();
