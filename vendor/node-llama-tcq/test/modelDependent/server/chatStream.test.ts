// SSE streaming round-trip — needs TCQ_SHIM_MODEL env, see chatBasic.test.ts.

import {describe, expect, test, beforeAll, afterAll} from "vitest";
import {startTcqShimServer, type ShimServerHandle} from "../../../src/server/httpServer.js";
import {disposeSession} from "../../../src/server/session.js";

const MODEL = process.env.TCQ_SHIM_MODEL;
const PORT  = Number(process.env.TCQ_SHIM_PORT ?? 18182);
const cond  = MODEL ? describe : describe.skip;

cond("TCQ-shim chat-stream (live)", () => {
    let handle: ShimServerHandle;
    const base = `http://127.0.0.1:${PORT}`;

    beforeAll(async () => {
        handle = await startTcqShimServer({
            host: "127.0.0.1", port: PORT,
            cors: false, parallel: 1,
            modelPath: MODEL!,
            aliases: ["tcq-shim-stream"],
            contextSize: 4096, gpuLayers: 99,
            cacheTypeK: "turbo4", cacheTypeV: "turbo4",
            flashAttention: true, noMmap: false,
            enableCorsProxy: false, enableTools: false,
            debug: false
        });
    }, 10 * 60_000);

    afterAll(async () => {
        await handle?.close();
        await disposeSession();
    });

    test("SSE chunks then [DONE]", async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                model: "tcq-shim-stream",
                messages: [{role: "user", content: "count to 3"}],
                max_tokens: 32,
                stream: true
            })
        });
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
        const text = await res.text();
        expect(text).toContain("data: [DONE]");

        // First chunk should announce role
        const firstChunk = text.split("\n\n").find((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
        expect(firstChunk).toBeDefined();
        const obj = JSON.parse(firstChunk!.replace(/^data: /, ""));
        expect(obj.object).toBe("chat.completion.chunk");
        expect(obj.choices[0].delta.role).toBe("assistant");
    }, 60_000);
});
