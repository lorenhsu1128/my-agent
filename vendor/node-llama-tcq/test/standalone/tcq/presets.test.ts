import {describe, expect, test} from "vitest";
import {TCQPresets} from "../../../src/tcq/presets.js";
import {GgmlType, resolveGgmlTypeOption} from "../../../src/gguf/types/GgufTensorInfoTypes.js";

describe("tcq/presets", () => {
    test("預設組四個皆有 keyType / valueType / label / bpv", () => {
        for (const preset of Object.values(TCQPresets)) {
            expect(preset).toMatchObject({
                keyType: expect.any(Number),
                valueType: expect.any(Number),
                label: expect.any(String),
                bpv: expect.any(Number)
            });
            expect(preset.bpv).toBeGreaterThan(0);
        }
    });

    test("TURBO4 = TURBO4_0 對稱", () => {
        expect(TCQPresets.TURBO4.keyType).toBe(GgmlType.TURBO4_0);
        expect(TCQPresets.TURBO4.valueType).toBe(GgmlType.TURBO4_0);
        expect(TCQPresets.TURBO4.bpv).toBe(4.25);
    });

    test("TURBO3_TCQ 對稱", () => {
        expect(TCQPresets.TURBO3_TCQ.keyType).toBe(GgmlType.TURBO3_TCQ);
        expect(TCQPresets.TURBO3_TCQ.valueType).toBe(GgmlType.TURBO3_TCQ);
    });

    test("TURBO2_TCQ 對稱", () => {
        expect(TCQPresets.TURBO2_TCQ.keyType).toBe(GgmlType.TURBO2_TCQ);
        expect(TCQPresets.TURBO2_TCQ.valueType).toBe(GgmlType.TURBO2_TCQ);
    });

    test("ASYMMETRIC_275: 3-bit key + 2-bit value", () => {
        expect(TCQPresets.ASYMMETRIC_275.keyType).toBe(GgmlType.TURBO3_TCQ);
        expect(TCQPresets.ASYMMETRIC_275.valueType).toBe(GgmlType.TURBO2_TCQ);
        expect(TCQPresets.ASYMMETRIC_275.bpv).toBe(2.75);
    });

    test("preset.keyType / valueType 可直接被 resolveGgmlTypeOption 接受", () => {
        for (const preset of Object.values(TCQPresets)) {
            expect(resolveGgmlTypeOption(preset.keyType)).toBe(preset.keyType);
            expect(resolveGgmlTypeOption(preset.valueType)).toBe(preset.valueType);
        }
    });
});
