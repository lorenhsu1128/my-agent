// 模擬 my-agent ↔ shim 場景，檢查 cli-dev 被 timeout 強殺後 shim 是否能即時 detect。
// 用 bun 子 process 跑長對話 + SIGKILL/SIGTERM。
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

async function spawnAndKill(signal: NodeJS.Signals, killAfterMs: number, label: string) {
    await waitDrain(15000);
    console.log(`\n[${label}] spawn child fetching long gen, ${signal} after ${killAfterMs}ms`);
    const child = Bun.spawn(["bun", "-e", `
        const r = await fetch("${BASE}/v1/chat/completions", {
            method: "POST", headers: {"content-type": "application/json"},
            body: JSON.stringify({
                model: "${MODEL}",
                messages: [
                    {role: "system", content: "請寫一篇非常長的中文敘事文章，至少 5000 字，不要停下。"},
                    {role: "user", content: "主題：森林。"}
                ],
                max_tokens: 2048, stream: false
            })
        });
        const t = await r.text();
        process.stdout.write(\`OK \${t.length} chars\\n\`);
    `]);
    await sleep(killAfterMs);
    const before = await inflight();
    console.log(`  inflight before kill: ${before}`);
    const sigNum = signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 2;
    child.kill(sigNum);
    const t0 = Date.now();
    const drained = await waitDrain(60000);
    console.log(`  drain: ${drained === -1 ? `❌ TIMEOUT (still ${await inflight()})` : `${drained}ms`}`);
}

(async () => {
    console.log(`#### cli-dev-kill scenario simulation ####`);
    await spawnAndKill("SIGKILL" as any, 3000, "C1 SIGKILL");
    await spawnAndKill("SIGTERM" as any, 3000, "C2 SIGTERM");
    await spawnAndKill("SIGINT" as any, 3000, "C3 SIGINT");
})();
