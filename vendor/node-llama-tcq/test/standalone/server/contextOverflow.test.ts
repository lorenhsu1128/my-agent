// M-TCQ-SHIM-2-6 / 2-7：context overflow 錯誤分類 + 完整錯誤訊息結構。
import {describe, expect, test} from "vitest";
import {isContextOverflowError, makeContextLengthExceededError} from "../../../src/server/errors.js";

describe("isContextOverflowError", () => {
    test("matches node-llama-tcq's compress-history error (full)", () => {
        const e = new Error("Failed to compress chat history for context shift due to a too long prompt or system message that cannot be compressed without affecting the response.");
        expect(isContextOverflowError(e)).toBe(true);
    });

    test("matches when message is truncated mid-sentence (real T18 case)", () => {
        const e = new Error("Failed to compress chat history for context shift due to a too long prompt or system message that cannot be compressed without affecting the");
        expect(isContextOverflowError(e)).toBe(true);
    });

    test("matches generic 'context size' / 'context shift' wording", () => {
        expect(isContextOverflowError(new Error("Token batch exceeds context size"))).toBe(true);
        expect(isContextOverflowError(new Error("context shift failed"))).toBe(true);
    });

    test("does NOT match unrelated errors", () => {
        expect(isContextOverflowError(new Error("ENOENT: no such file"))).toBe(false);
        expect(isContextOverflowError(new Error("invalid grammar"))).toBe(false);
        expect(isContextOverflowError(undefined)).toBe(false);
    });
});

describe("makeContextLengthExceededError", () => {
    test("OpenAI-shaped 413 body with code=context_length_exceeded", () => {
        const body = makeContextLengthExceededError({promptTokens: 2762, maxTokens: 1024, ctxSize: 2048});
        expect(body.error.code).toBe("context_length_exceeded");
        expect(body.error.type).toBe("invalid_request_error");
        expect(body.error.param).toBe("messages");
        expect(body.error.message).toContain("2762");
        expect(body.error.message).toContain("1024");
        expect(body.error.message).toContain("2048");
        expect(body.error.message).toMatch(/Reduce max_tokens|shorten the prompt/);
    });

    test("omits max_tokens segment when undefined", () => {
        const body = makeContextLengthExceededError({promptTokens: 3000, maxTokens: undefined, ctxSize: 2048});
        expect(body.error.message).toContain("3000");
        expect(body.error.message).not.toMatch(/max_tokens\) =/);
    });

    test("appends underlying engine message when provided", () => {
        const underlying = new Error("Failed to compress chat history");
        const body = makeContextLengthExceededError({promptTokens: 100, maxTokens: 50, ctxSize: 128, underlying});
        expect(body.error.message).toContain("engine: Failed to compress chat history");
    });
});
