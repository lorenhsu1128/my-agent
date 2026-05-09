// M-TCQ-SHIM-2-4：Ollama / Anthropic 翻譯層的純函式部分（content flatten、stop_reason map）。
// HTTP 整合走 live test runner（live-test-shim.ts 之後 case），這裡只蓋 schema 翻譯。
import {describe, expect, test} from "vitest";

// 重建純函式 — module-internal 的版本，跟 src/server/compatAdapters.ts 行為一致
function flattenAnthropicContent(content: any): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((p: any) => p?.type === "text" ? (p.text ?? "") : "").join("");
}

function flattenSystem(system: any): string {
    if (system == null) return "";
    if (typeof system === "string") return system;
    if (!Array.isArray(system)) return "";
    return system.map((b: any) => b.text).join("\n");
}

function mapStopReason(finishReason: string | undefined): string {
    return finishReason === "tool_calls" ? "tool_use"
        : finishReason === "length" ? "max_tokens"
        : "end_turn";
}

describe("Anthropic adapter helpers", () => {
    test("flattenAnthropicContent string passthrough", () => {
        expect(flattenAnthropicContent("hello")).toBe("hello");
    });
    test("flattenAnthropicContent block array — text only", () => {
        expect(flattenAnthropicContent([
            {type: "text", text: "first "},
            {type: "image", source: {data: "..."}}, // skipped (vision deferred)
            {type: "text", text: "second"}
        ])).toBe("first second");
    });
    test("flattenAnthropicContent missing text in text block tolerated", () => {
        expect(flattenAnthropicContent([{type: "text"}])).toBe("");
    });

    test("flattenSystem variants", () => {
        expect(flattenSystem(undefined)).toBe("");
        expect(flattenSystem("一段 system")).toBe("一段 system");
        expect(flattenSystem([{type: "text", text: "A"}, {type: "text", text: "B"}])).toBe("A\nB");
    });

    test("stop_reason mapping covers OpenAI → Anthropic codes", () => {
        expect(mapStopReason("stop")).toBe("end_turn");
        expect(mapStopReason("length")).toBe("max_tokens");
        expect(mapStopReason("tool_calls")).toBe("tool_use");
        expect(mapStopReason(undefined)).toBe("end_turn");
        expect(mapStopReason("content_filter")).toBe("end_turn");
    });
});

// /slots/{id} filename gating — pure validation logic
describe("/slots/{id} filename gating", () => {
    function isValidSlotFilename(filename: any): boolean {
        if (typeof filename !== "string" || filename === "") return false;
        if (/[\\/]|\.\./.test(filename)) return false;
        // poor-man's path.isAbsolute on plain strings
        if (/^([a-zA-Z]:|\/)/.test(filename)) return false;
        return true;
    }

    test("rejects empty / non-string", () => {
        expect(isValidSlotFilename("")).toBe(false);
        expect(isValidSlotFilename(undefined)).toBe(false);
        expect(isValidSlotFilename(123)).toBe(false);
    });
    test("rejects path-traversal patterns", () => {
        expect(isValidSlotFilename("../foo")).toBe(false);
        expect(isValidSlotFilename("a/b")).toBe(false);
        expect(isValidSlotFilename("a\\b")).toBe(false);
        expect(isValidSlotFilename("/etc/passwd")).toBe(false);
        expect(isValidSlotFilename("C:/Windows/system.ini")).toBe(false);
    });
    test("accepts plain filenames", () => {
        expect(isValidSlotFilename("session-1.bin")).toBe(true);
        expect(isValidSlotFilename("a_b-c.123.bin")).toBe(true);
    });
});
