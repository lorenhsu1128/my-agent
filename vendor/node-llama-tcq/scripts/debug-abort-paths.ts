// 比較 4 種 abort 觸發方式對 shim 端 req.on('close') 的影響。
// 每個 case 之間 sleep 8s + 觀察 metrics。
const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function inflight(): Promise<number> {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    const m = text.match(/^tcq_shim_inflight\s+(\d+)/m);
    return m ? Number(m[1]) : -1;
}

async function caseFetchAbort(stream: boolean) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST", headers: {"content-type": "application/json"}, signal: ctrl.signal,
            body: JSON.stringify({model: MODEL, messages: [{role: "user", content: "故事 200 字"}], max_tokens: 4096, stream})
        });
        if (stream) { const r = res.body?.getReader(); if (r) while (true) {const {done}=await r.read(); if (done) break;} }
        else await res.text();
    } catch {}
}

(async () => {
    console.log(`#### Abort path test (debug log on shim stderr) ####`);

    console.log(`\n--- C1: fetch AbortController stream ---`);
    await caseFetchAbort(true);
    await sleep(8000);
    console.log(`  inflight after 8s: ${await inflight()}`);

    console.log(`\n--- C2: fetch AbortController non-stream ---`);
    await caseFetchAbort(false);
    for (let i = 1; i <= 12; i++) {
        await sleep(5000);
        const f = await inflight();
        console.log(`  +${i*5}s inflight=${f}`);
        if (f === 0) break;
    }

    console.log(`\n--- C3: bun spawn fetch + SIGKILL ---`);
    // 起子 process 跑 fetch，500ms 後 SIGKILL
    const child = Bun.spawn(["bun", "-e", `
        const c = new AbortController();
        const p = fetch("${BASE}/v1/chat/completions", {
            method: "POST",
            headers: {"content-type": "application/json"},
            signal: c.signal,
            body: JSON.stringify({model: "${MODEL}", messages: [{role: "user", content: "故事 200 字"}], max_tokens: 4096, stream: false})
        }).then(r => r.text()).then(() => process.exit(0));
        setTimeout(() => {}, 60000); // keep alive
    `], {stdout: "pipe", stderr: "pipe"});
    await sleep(500);
    child.kill(9);
    await sleep(8000);
    console.log(`  inflight after 8s: ${await inflight()}`);

    console.log(`\n--- C4: bun spawn fetch streaming + SIGKILL ---`);
    const child2 = Bun.spawn(["bun", "-e", `
        const r = await fetch("${BASE}/v1/chat/completions", {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: "${MODEL}", messages: [{role: "user", content: "故事 500 字"}], max_tokens: 4096, stream: true})
        });
        const reader = r.body.getReader();
        while (true) { const {done} = await reader.read(); if (done) break; }
    `], {stdout: "pipe", stderr: "pipe"});
    await sleep(500);
    child2.kill(9);
    await sleep(15000);
    console.log(`  inflight after 15s: ${await inflight()}`);
})();
