import {describe, expect, test} from "vitest";
import {assertTCQCompatibleHeadDim, isTCQAvailable} from "../../../src/tcq/compatibility.js";

describe("tcq/compatibility", () => {
    describe("assertTCQCompatibleHeadDim", () => {
        test.each([128, 256, 384, 512])("head_dim=%i 通過", (d) => {
            expect(() => assertTCQCompatibleHeadDim(d)).not.toThrow();
        });

        test.each([64, 96, 100, 127, 130])("head_dim=%i 拋錯", (d) => {
            expect(() => assertTCQCompatibleHeadDim(d)).toThrow(/head_dim % 128/);
        });

        test("非整數或非正數拋錯", () => {
            expect(() => assertTCQCompatibleHeadDim(0)).toThrow(/invalid head_dim/);
            expect(() => assertTCQCompatibleHeadDim(-128)).toThrow(/invalid head_dim/);
            expect(() => assertTCQCompatibleHeadDim(128.5)).toThrow(/invalid head_dim/);
            expect(() => assertTCQCompatibleHeadDim(NaN)).toThrow(/invalid head_dim/);
        });
    });

    describe("isTCQAvailable", () => {
        test("回傳 ok flag 與 reason 結構", () => {
            const result = isTCQAvailable();
            expect(result).toHaveProperty("ok");
            expect(typeof result.ok).toBe("boolean");
            if (!result.ok) expect(typeof result.reason).toBe("string");
        });

        test("Windows / Linux 應為 ok=true（CUDA 假設可用）", () => {
            if (process.platform === "win32" || process.platform === "linux") {
                expect(isTCQAvailable().ok).toBe(true);
            }
        });

        test("macOS 應為 ok=false（Metal 不支援）", () => {
            if (process.platform === "darwin") {
                expect(isTCQAvailable().ok).toBe(false);
                expect(isTCQAvailable().reason).toMatch(/Metal/i);
            }
        });
    });
});
