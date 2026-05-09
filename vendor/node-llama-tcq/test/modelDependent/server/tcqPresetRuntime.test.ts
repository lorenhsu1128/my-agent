// Verify --cache-type-k turbo4 actually loads as TURBO4_0 GgmlType in the live context.

import {describe, expect, test, beforeAll, afterAll} from "vitest";
import {startTcqShimServer, type ShimServerHandle} from "../../../src/server/httpServer.js";
import {disposeSession, getSessionSync} from "../../../src/server/session.js";
import {GgmlType} from "../../../src/gguf/types/GgufTensorInfoTypes.js";
import {isTCQAvailable} from "../../../src/tcq/compatibility.js";

const MODEL = process.env.TCQ_SHIM_MODEL;
const PORT  = Number(process.env.TCQ_SHIM_PORT ?? 18184);
const cond  = (MODEL && isTCQAvailable()) ? describe : describe.skip;

cond("TCQ-shim TURBO4_0 preset (live)", () => {
    let handle: ShimServerHandle;

    beforeAll(async () => {
        handle = await startTcqShimServer({
            host: "127.0.0.1", port: PORT,
            cors: false, parallel: 1,
            modelPath: MODEL!,
            aliases: ["tcq-shim-preset"],
            contextSize: 2048, gpuLayers: 99,
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

    test("session reports TURBO4_0 cache type", () => {
        const s = getSessionSync();
        expect(s.cacheTypeKLabel).toBe("turbo4");
        expect(s.cacheTypeVLabel).toBe("turbo4");
        expect(s.context.kvCacheKeyType).toBe(GgmlType.TURBO4_0);
        expect(s.context.kvCacheValueType).toBe(GgmlType.TURBO4_0);
    });

    test("/props echoes turbo4 in extras", async () => {
        const res = await fetch(`http://127.0.0.1:${PORT}/props`);
        const j = await res.json() as any;
        expect(j.cache_type_k).toBe("turbo4");
        expect(j.cache_type_v).toBe("turbo4");
    });
});
