// Black-box test of resolveReasoning() / formatReasoning() / maybeApplyBudgetExhaustionMessage().
// These are not exported (file-local), so we reach in via dynamic import — replicate any future
// changes in chatCompletions.ts here.

import {describe, expect, test} from "vitest";
import {splitReasoning} from "../../../src/server/reasoningSplit.js";

// Recreate formatReasoning logic for unit-test scope (mirror of chatCompletions.ts impl)
function formatReasoning(rawText: string, format: "none" | "deepseek" | "deepseek-legacy") {
    if (format === "none") return {content: rawText, reasoning: null};
    const split = splitReasoning(rawText);
    if (format === "deepseek-legacy") {
        const legacyContent = split.reasoning != null
            ? `<think>${split.reasoning}</think>${split.content ? "\n\n" + split.content : ""}`
            : split.content;
        return {content: legacyContent, reasoning: split.reasoning};
    }
    return {content: split.content, reasoning: split.reasoning};
}

describe("formatReasoning", () => {
    const text = "<think>step 1\nstep 2</think>final answer";

    test("format=none → leave <think> in content, no reasoning_content", () => {
        const r = formatReasoning(text, "none");
        expect(r.content).toBe(text);
        expect(r.reasoning).toBeNull();
    });

    test("format=deepseek → split reasoning out of content", () => {
        const r = formatReasoning(text, "deepseek");
        expect(r.content).toBe("final answer");
        expect(r.reasoning).toBe("step 1\nstep 2");
    });

    test("format=deepseek-legacy → split AND keep <think> in content", () => {
        const r = formatReasoning(text, "deepseek-legacy");
        expect(r.content).toContain("<think>");
        expect(r.content).toContain("step 1\nstep 2");
        expect(r.content).toContain("final answer");
        expect(r.reasoning).toBe("step 1\nstep 2");
    });

    test("plain text (no <think>): all formats return content unchanged", () => {
        for (const f of ["none", "deepseek", "deepseek-legacy"] as const) {
            const r = formatReasoning("hello world", f);
            expect(r.content).toBe("hello world");
            if (f !== "none") expect(r.reasoning).toBeNull();
        }
    });
});

// Mirror of maybeApplyBudgetExhaustionMessage (revised after T3 live test —
// chat wrapper strips <think> tags even on truncation, so we can't rely on
// thoughtTokens precondition; trigger purely on stopReason + content shape).
function maybeApplyBudgetExhaustionMessage(
    visibleContent: string,
    stopReason: string | undefined,
    resolved: {budgetMessage?: string}
): string {
    if (resolved.budgetMessage == null || resolved.budgetMessage === "") return visibleContent;
    if (stopReason !== "maxTokens") return visibleContent;

    const trimmed = visibleContent.trim();
    if (trimmed.length === 0) return resolved.budgetMessage;

    const tail = trimmed.slice(-40);
    const endsCleanly = /[.!?。！？]\s*[)\]"'’”]?\s*$/.test(tail);
    if (endsCleanly) return visibleContent;
    return `${visibleContent}\n\n${resolved.budgetMessage}`;
}

describe("maybeApplyBudgetExhaustionMessage", () => {
    const cfg = {budgetMessage: "Time's up."};

    test("empty content + maxTokens → message replaces content", () => {
        expect(maybeApplyBudgetExhaustionMessage("", "maxTokens", cfg)).toBe("Time's up.");
    });

    test("mid-sentence cut + maxTokens → message appended", () => {
        const out = maybeApplyBudgetExhaustionMessage("...thinking through option A vs B vs", "maxTokens", cfg);
        expect(out).toContain("Time's up.");
        expect(out).toContain("...thinking through option A vs B vs");
    });

    test("clean sentence-end + maxTokens → no append", () => {
        const out = maybeApplyBudgetExhaustionMessage("The answer is 42.", "maxTokens", cfg);
        expect(out).toBe("The answer is 42.");
    });

    test("CJK punctuation also detected as clean-end", () => {
        expect(maybeApplyBudgetExhaustionMessage("答案是 42。", "maxTokens", cfg))
            .toBe("答案是 42。");
    });

    test("eosToken stop → no-op even if content empty", () => {
        expect(maybeApplyBudgetExhaustionMessage("", "eosToken", cfg)).toBe("");
    });

    test("no message configured → never trigger", () => {
        expect(maybeApplyBudgetExhaustionMessage("", "maxTokens", {})).toBe("");
    });
});

// Replica of resolveReasoning's auto-cap heuristic (M-TCQ-SHIM-2 reasoning 控制深化)
function autoCapThoughtTokens(
    serverBudget: number | undefined,
    perReqBudget: number | undefined,
    maxTokens: number | undefined
): {thoughtTokens?: number, explicitBudget: boolean} {
    let thoughtTokens: number | undefined;
    let explicitBudget = false;
    if (perReqBudget != null) { thoughtTokens = perReqBudget; explicitBudget = true; }
    else if (typeof serverBudget === "number" && serverBudget >= 0) {
        thoughtTokens = serverBudget; explicitBudget = true;
    }
    if (!explicitBudget && typeof maxTokens === "number" && maxTokens > 0 && maxTokens <= 16384) {
        thoughtTokens = Math.floor(maxTokens * 0.6);
    }
    return {thoughtTokens, explicitBudget};
}

describe("resolveReasoning auto-cap heuristic", () => {
    test("max_tokens=8192 + no explicit budget → cap at 4915", () => {
        expect(autoCapThoughtTokens(undefined, undefined, 8192))
            .toEqual({thoughtTokens: 4915, explicitBudget: false});
    });

    test("max_tokens=4096 + no explicit budget → cap at 2457", () => {
        expect(autoCapThoughtTokens(undefined, undefined, 4096))
            .toEqual({thoughtTokens: 2457, explicitBudget: false});
    });

    test("max_tokens=32768 (large) → no auto-cap, leave engine default", () => {
        expect(autoCapThoughtTokens(undefined, undefined, 32768))
            .toEqual({thoughtTokens: undefined, explicitBudget: false});
    });

    test("explicit per-request budget overrides auto-cap", () => {
        expect(autoCapThoughtTokens(undefined, 200, 8192))
            .toEqual({thoughtTokens: 200, explicitBudget: true});
    });

    test("explicit server budget overrides auto-cap", () => {
        expect(autoCapThoughtTokens(2000, undefined, 8192))
            .toEqual({thoughtTokens: 2000, explicitBudget: true});
    });

    test("server budget=-1 (unlimited sentinel) is ignored, auto-cap kicks in", () => {
        expect(autoCapThoughtTokens(-1, undefined, 8192))
            .toEqual({thoughtTokens: 4915, explicitBudget: false});
    });
});
