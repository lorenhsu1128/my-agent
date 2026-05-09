// 重現並驗證 single-slot inference-lock 在 client 中途斷線時的死鎖修法。
// pre-fix：runNonStreaming 完全沒接 abort signal、runStreaming 只在函式內局部建。
// post-fix：handler 共用 abort，runNonStreaming/runStreaming 都拿到，promptWithMeta
//   走 stopOnAbortSignal:true 路徑，client 斷線後 generation 立即停。
//
// 使用：BASE=http://127.0.0.1:8081 MODEL=qwen3.5-9b bun scripts/stress-abort.ts
//
// 為避免 pre-fix 死等到 max_tokens 跑完才 release（要 30+s）影響 drain 觀察，
// 一律用 max_tokens=256（pre-fix 仍會跑完才釋鎖約 5–6s，足夠分辨；post-fix 應 <2s）。

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function metric(key: string): Promise<number> {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    const m = text.match(new RegExp(`^${key}\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : -1;
}

async function fireAndAbort(stream: boolean, abortAfterMs: number): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), abortAfterMs);
    try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: MODEL,
                messages: [{role: "user", content: "寫一段中文故事，至少 200 字。"}],
                max_tokens: 256,
                stream
            }),
            signal: ctrl.signal
        });
        if (stream) {
            const reader = res.body?.getReader();
            if (reader) while (true) { const {done} = await reader.read(); if (done) break; }
        } else {
            await res.text();
        }
        return "completed-pre-abort";
    } catch (e) {
        return (e as Error).message.includes("abort") ? "aborted" : `err:${(e as Error).message}`;
    } finally {
        clearTimeout(t);
    }
}

async function fireNormal(timeoutMs: number): Promise<{ok: boolean, durMs: number}> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: MODEL, messages: [{role: "user", content: "回答兩個字：你好"}], max_tokens: 16, stream: false}),
            signal: ctrl.signal
        });
        await res.text();
        return {ok: res.status === 200, durMs: Date.now() - t0};
    } catch (e) {
        return {ok: false, durMs: Date.now() - t0};
    } finally {
        clearTimeout(t);
    }
}

/** 等到 inflight=0 或 timeoutMs 到期 — 回傳實際耗時毫秒 */
async function waitDrain(timeoutMs: number): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (await metric("tcq_shim_inflight") === 0) return Date.now() - t0;
        await sleep(500);
    }
    return -1; // timeout
}

(async () => {
    console.log(`#### TCQ-shim abort-stress against ${BASE} ####\n`);

    const results: {name: string, ok: boolean, drainMs: number, note: string}[] = [];

    async function caseOne(name: string, stream: boolean, parallel: number, drainBudgetMs: number) {
        // 等乾淨
        await waitDrain(20000);
        console.log(`\n[${name}] ${parallel}× ${stream ? "stream" : "non-stream"}, abort@200ms`);
        const promises: Promise<string>[] = [];
        for (let i = 0; i < parallel; i++) promises.push(fireAndAbort(stream, 200));
        const fates = await Promise.all(promises);
        const aborted = fates.filter(f => f === "aborted").length;
        console.log(`  client-side aborted: ${aborted}/${parallel}`);
        const drained = await waitDrain(drainBudgetMs);
        const ok = drained >= 0;
        const note = ok ? `drain in ${drained}ms` : `❌ DRAIN TIMEOUT (>${drainBudgetMs}ms) inflight=${await metric("tcq_shim_inflight")}`;
        console.log(`  ${ok ? "✅" : "❌"} ${note}`);
        results.push({name, ok, drainMs: drained, note});
    }

    await caseOne("A1 single non-stream", false, 1, 15000);
    await caseOne("A2 single stream",      true,  1, 15000);
    await caseOne("B1 5 parallel non-stream", false, 5, 60000);
    await caseOne("B2 5 parallel stream",     true,  5, 60000);
    await caseOne("C1 20 parallel mix",        false, 20, 180000); // half stream half non — actually all non here
    // 真正的 mix
    {
        await waitDrain(20000);
        console.log(`\n[C2] 20 parallel mix (10 stream + 10 non-stream), abort@200ms`);
        const ps: Promise<string>[] = [];
        for (let i = 0; i < 20; i++) ps.push(fireAndAbort(i < 10, 200));
        const fates = await Promise.all(ps);
        console.log(`  client-side aborted: ${fates.filter(f => f === "aborted").length}/20`);
        const drained = await waitDrain(180000);
        const ok = drained >= 0;
        const note = ok ? `drain in ${drained}ms` : `❌ DRAIN TIMEOUT inflight=${await metric("tcq_shim_inflight")}`;
        console.log(`  ${ok ? "✅" : "❌"} ${note}`);
        results.push({name: "C2 20 mix", ok, drainMs: drained, note});
    }

    // Final probe — server still responsive？
    console.log(`\n[Probe] 正常 request 應 200`);
    const p = await fireNormal(15000);
    const probeOk = p.ok;
    console.log(`  ${probeOk ? "✅" : "❌"} HTTP probe ${p.durMs}ms`);
    results.push({name: "Probe", ok: probeOk, drainMs: p.durMs, note: probeOk ? "200" : "failed"});

    const m = await metric("tcq_shim_inflight");
    const q = await metric("llamacpp_queue_size");

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Final metrics: inflight=${m} queue=${q}`);
    console.log(`Per-case:`);
    for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.name.padEnd(28)} ${r.note}`);
    const allPass = results.every(r => r.ok) && m === 0 && q === 0;
    console.log(allPass ? "\n✅ ALL PASS" : "\n❌ FAIL");
    process.exit(allPass ? 0 : 1);
})();
