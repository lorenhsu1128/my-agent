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
