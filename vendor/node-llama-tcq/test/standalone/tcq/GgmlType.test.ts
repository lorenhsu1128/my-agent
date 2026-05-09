import {describe, expect, test} from "vitest";
import {GgmlType, resolveGgmlTypeOption} from "../../../src/gguf/types/GgufTensorInfoTypes.js";

describe("GgmlType (TCQ extensions)", () => {
    test("TURBO 系列 enum 值與 buun-llama-cpp 一致", () => {
        expect(GgmlType.Q1_0).toBe(41);
        expect(GgmlType.TURBO3_0).toBe(42);
        expect(GgmlType.TURBO4_0).toBe(43);
        expect(GgmlType.TURBO2_0).toBe(44);
        expect(GgmlType.TURBO3_TCQ).toBe(45);
        expect(GgmlType.TURBO2_TCQ).toBe(46);
    });

    test("resolveGgmlTypeOption 接受字串 'TURBO3_TCQ'", () => {
        expect(resolveGgmlTypeOption("TURBO3_TCQ")).toBe(45);
    });

    test("resolveGgmlTypeOption 接受數字 45", () => {
        expect(resolveGgmlTypeOption(45 as GgmlType)).toBe(45);
    });

    test("resolveGgmlTypeOption 仍支援既有 q8_0 等", () => {
        expect(resolveGgmlTypeOption("Q8_0")).toBe(GgmlType.Q8_0);
        expect(resolveGgmlTypeOption("F16")).toBe(GgmlType.F16);
    });
});
