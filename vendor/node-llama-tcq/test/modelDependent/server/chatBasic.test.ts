// TCQ-shim live integration: chat-basic
//
// SETUP（記憶 feedback_node_llama_tcq_test_preset：preset 預設 TURBO4_0 + CUDA）：
//   set TCQ_SHIM_MODEL=C:\path\to\Qwen3.5-9B-Q5_K_M.gguf
//   bun test test/modelDependent/server/
//
// Skip when env not set so CI / standalone runs stay green.

import {describe, expect, test, beforeAll, afterAll} from "vitest";
import {startTcqShimServer, type ShimServerHandle} from "../../../src/server/httpServer.js";
import {disposeSession} from "../../../src/server/session.js";

const MODEL = process.env.TCQ_SHIM_MODEL;
const PORT  = Number(process.env.TCQ_SHIM_PORT ?? 18181);
const cond  = MODEL ? describe : describe.skip;

cond("TCQ-shim chat-basic (live)", () => {
    let handle: ShimServerHandle;
    const base = `http://127.0.0.1:${PORT}`;

    beforeAll(async () => {
        handle = await startTcqShimServer({
            host: "127.0.0.1", port: PORT,
            cors: false, parallel: 1,
            modelPath: MODEL!,
            aliases: ["tcq-shim-test"],
            contextSize: 4096, gpuLayers: 99,
            cacheTypeK: "turbo4", cacheTypeV: "turbo4",
            flashAttention: true, noMmap: false,
            enableCorsProxy: false, enableTools: false,
            debug: true
        });
    }, 10 * 60_000);

    afterAll(async () => {
        await handle?.close();
        await disposeSession();
    });

    test("/health", async () => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({status: "ok"});
    });

    test("/v1/models", async () => {
        const res = await fetch(`${base}/v1/models`);
        const j = await res.json() as any;
        expect(j.data[0].id).toBe("tcq-shim-test");
    });

    test("/v1/chat/completions non-stream", async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                model: "tcq-shim-test",
                messages: [{role: "user", content: "Reply with exactly: OK"}],
                max_tokens: 8,
                temperature: 0
            })
        });
        const j = await res.json() as any;
        expect(j.object).toBe("chat.completion");
        expect(j.choices[0].message.role).toBe("assistant");
        expect(typeof j.choices[0].message.content).toBe("string");
        expect(j.usage.total_tokens).toBeGreaterThan(0);
    }, 60_000);
});
