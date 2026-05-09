import {describe, expect, test} from "vitest";
import {resolveCacheType} from "../../../src/server/tcqPresetMap.js";
import {GgmlType} from "../../../src/gguf/types/GgufTensorInfoTypes.js";
import {isTCQAvailable} from "../../../src/tcq/compatibility.js";

describe("resolveCacheType", () => {
    test("f16 standard", () => {
        const r = resolveCacheType("f16");
        expect(r.type).toBe(GgmlType.F16);
        expect(r.isTcq).toBe(false);
    });

    test("q8_0 standard", () => {
        const r = resolveCacheType("q8_0");
        expect(r.type).toBe(GgmlType.Q8_0);
        expect(r.label).toBe("q80");
    });

    test("turbo4 case-insensitive + underscore-tolerant", () => {
        const r1 = resolveCacheType("turbo4");
        const r2 = resolveCacheType("TURBO_4");
        const r3 = resolveCacheType("Turbo-4");
        if (isTCQAvailable()) {
            expect(r1.type).toBe(GgmlType.TURBO4_0);
            expect(r1.isTcq).toBe(true);
            expect(r2.type).toBe(GgmlType.TURBO4_0);
            expect(r3.type).toBe(GgmlType.TURBO4_0);
        } else {
            // macOS Metal etc. — falls back to F16 with marker label
            expect(r1.type).toBe(GgmlType.F16);
            expect(r1.label).toContain("fallback");
        }
    });

    test("turbo3_tcq aliases collapse", () => {
        const r = resolveCacheType("turbo3");
        const r2 = resolveCacheType("turbo3_tcq");
        if (isTCQAvailable()) {
            expect(r.type).toBe(GgmlType.TURBO3_TCQ);
            expect(r2.type).toBe(GgmlType.TURBO3_TCQ);
        }
    });

    test("unknown type throws", () => {
        expect(() => resolveCacheType("bogus")).toThrow(/Unknown --cache-type/);
    });
});
