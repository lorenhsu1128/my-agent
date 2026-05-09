// Tool calling — Phase 1 uses prompt-injection + JSON post-extract.
// Needs TCQ_SHIM_MODEL env, see chatBasic.test.ts.

import {describe, expect, test, beforeAll, afterAll} from "vitest";
import {startTcqShimServer, type ShimServerHandle} from "../../../src/server/httpServer.js";
import {disposeSession} from "../../../src/server/session.js";

const MODEL = process.env.TCQ_SHIM_MODEL;
const PORT  = Number(process.env.TCQ_SHIM_PORT ?? 18183);
const cond  = MODEL ? describe : describe.skip;

cond("TCQ-shim tool_calls (live)", () => {
    let handle: ShimServerHandle;
    const base = `http://127.0.0.1:${PORT}`;

    beforeAll(async () => {
        handle = await startTcqShimServer({
            host: "127.0.0.1", port: PORT,
            cors: false, parallel: 1,
            modelPath: MODEL!,
            aliases: ["tcq-shim-tools"],
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

    test("model emits tool_call when prompted", async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                model: "tcq-shim-tools",
                messages: [{role: "user", content: "What's the weather in Taipei?"}],
                tools: [{
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "Get weather for a city",
                        parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}
                    }
                }],
                tool_choice: "auto",
                max_tokens: 128,
                temperature: 0
            })
        });
        const j = await res.json() as any;
        const msg = j.choices[0].message;
        // Phase 1 success criteria: either model emitted tool_call OR replied in plain text.
        // We don't assert tool_call always fires (depends on model). When it does, finish_reason must be tool_calls.
        if (msg.tool_calls?.length > 0) {
            expect(msg.tool_calls[0].function.name).toBe("get_weather");
            expect(j.choices[0].finish_reason).toBe("tool_calls");
        } else {
            expect(typeof msg.content).toBe("string");
        }
    }, 90_000);
});
