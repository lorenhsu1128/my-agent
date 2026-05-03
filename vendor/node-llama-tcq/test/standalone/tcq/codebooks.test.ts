import {describe, expect, test, beforeEach, afterEach} from "vitest";
import path from "node:path";
import {applyTCQCodebooks, clearTCQCodebooks, defaultCodebooks, isTCQType} from "../../../src/tcq/codebooks.js";
import {GgmlType} from "../../../src/gguf/types/GgufTensorInfoTypes.js";

describe("tcq/codebooks", () => {
    beforeEach(() => clearTCQCodebooks());
    afterEach(() => clearTCQCodebooks());

    test("defaultCodebooks 指向打包的 .bin 檔（路徑有 codebooks/3bit 與 2bit）", () => {
        expect(defaultCodebooks.threeBit).toMatch(/codebooks[\\/]3bit[\\/].*\.bin$/);
        expect(defaultCodebooks.twoBit).toMatch(/codebooks[\\/]2bit[\\/].*\.bin$/);
    });

    test("applyTCQCodebooks 預設值套用到 process.env", () => {
        applyTCQCodebooks();
        expect(process.env.TURBO_TCQ_CB).toBe(defaultCodebooks.threeBit);
        expect(process.env.TURBO_TCQ_CB2).toBe(defaultCodebooks.twoBit);
        expect(process.env.TURBO_LAYER_ADAPTIVE).toBeUndefined();
    });

    test("applyTCQCodebooks 自訂路徑覆蓋預設值", () => {
        applyTCQCodebooks({
            threeBit: "/custom/3bit.bin",
            twoBit: "/custom/2bit.bin",
            layerAdaptive: true
        });
        expect(process.env.TURBO_TCQ_CB).toBe("/custom/3bit.bin");
        expect(process.env.TURBO_TCQ_CB2).toBe("/custom/2bit.bin");
        expect(process.env.TURBO_LAYER_ADAPTIVE).toBe("1");
    });

    test("clearTCQCodebooks 清除所有 env 變數", () => {
        applyTCQCodebooks({layerAdaptive: true});
        clearTCQCodebooks();
        expect(process.env.TURBO_TCQ_CB).toBeUndefined();
        expect(process.env.TURBO_TCQ_CB2).toBeUndefined();
        expect(process.env.TURBO_LAYER_ADAPTIVE).toBeUndefined();
    });

    describe("G1 runtime tunables", () => {
        test("encodeAlpha / alpha / alphaV / decodeAlphaK / decodeAlphaV", () => {
            applyTCQCodebooks({
                encodeAlpha: "context",
                alpha: 0.5,
                alphaV: 0.6,
                decodeAlphaK: 0.7,
                decodeAlphaV: 0.8
            });
            expect(process.env.TURBO_TCQ_ENCODE_ALPHA).toBe("context");
            expect(process.env.TURBO_TCQ_ALPHA).toBe("0.5");
            expect(process.env.TURBO_TCQ_ALPHA_V).toBe("0.6");
            expect(process.env.TURBO_TCQ_DECODE_ALPHA_K).toBe("0.7");
            expect(process.env.TURBO_TCQ_DECODE_ALPHA_V).toBe("0.8");
        });

        test("prefillVec / mmaFused / decodeNative 開關", () => {
            applyTCQCodebooks({prefillVec: true, mmaFused: false, decodeNative: true});
            expect(process.env.TURBO_PREFILL_VEC).toBe("1");
            expect(process.env.GGML_TURBO_MMA_FUSED).toBe("0");
            expect(process.env.GGML_TURBO_DECODE_NATIVE).toBe("1");
        });

        test("innerq trio", () => {
            applyTCQCodebooks({innerq: true, innerqMode: "static", innerqStrength: 0.3});
            expect(process.env.TURBO_INNERQ).toBe("1");
            expect(process.env.TURBO_INNERQ_MODE).toBe("static");
            expect(process.env.TURBO_INNERQ_STRENGTH).toBe("0.3");
        });

        test("clearTCQCodebooks 也清 G1 旋鈕", () => {
            applyTCQCodebooks({alpha: 0.5, mmaFused: true, innerqMode: "dynamic", dumpErrors: true});
            clearTCQCodebooks();
            expect(process.env.TURBO_TCQ_ALPHA).toBeUndefined();
            expect(process.env.GGML_TURBO_MMA_FUSED).toBeUndefined();
            expect(process.env.TURBO_INNERQ_MODE).toBeUndefined();
            expect(process.env.TURBO_TCQ_DUMP_ERRORS).toBeUndefined();
        });
    });

    describe("isTCQType", () => {
        test.each([
            [GgmlType.TURBO3_0, true],
            [GgmlType.TURBO4_0, true],
            [GgmlType.TURBO2_0, true],
            [GgmlType.TURBO3_TCQ, true],
            [GgmlType.TURBO2_TCQ, true],
            [GgmlType.F16, false],
            [GgmlType.Q8_0, false],
            [GgmlType.Q4_0, false],
            [undefined, false]
        ])("%s -> %s", (type, expected) => {
            expect(isTCQType(type)).toBe(expected);
        });
    });
});
