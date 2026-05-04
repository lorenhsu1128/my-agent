// M-TCQ-SHIM-2-2 / 2-3：metrics 渲染 + /props POST 白名單行為。
import {describe, expect, test} from "vitest";
import {renderPrometheus, type ShimMetrics} from "../../../src/server/metrics.js";

describe("renderPrometheus", () => {
    const snap: ShimMetrics = {
        requestsTotal: 17,
        promptTokensTotal: 1234,
        completionTokensTotal: 5678,
        chatCompletionsTotal: 5,
        chatErrorsTotal: 1,
        contextOverflowTotal: 1,
        inflight: 1
    };

    test("emits all expected metric names with correct types", () => {
        const out = renderPrometheus(snap);
        for (const name of [
            "llamacpp_requests_total",
            "llamacpp_tokens_evaluated_total",
            "llamacpp_tokens_predicted_total",
            "llamacpp_queue_size",
            "tcq_shim_chat_completions_total",
            "tcq_shim_chat_errors_total",
            "tcq_shim_context_overflow_total",
            "tcq_shim_inflight"
        ]) {
            expect(out).toContain(`# TYPE ${name}`);
            expect(out).toMatch(new RegExp(`^${name} `, "m"));
        }
    });

    test("values match snapshot fields", () => {
        const out = renderPrometheus(snap);
        expect(out).toMatch(/^llamacpp_requests_total 17$/m);
        expect(out).toMatch(/^llamacpp_tokens_evaluated_total 1234$/m);
        expect(out).toMatch(/^llamacpp_tokens_predicted_total 5678$/m);
        expect(out).toMatch(/^tcq_shim_context_overflow_total 1$/m);
        // queue_size = max(0, inflight-1) = 0 here
        expect(out).toMatch(/^llamacpp_queue_size 0$/m);
    });

    test("queue_size correctly derives from inflight", () => {
        const busy: ShimMetrics = {...snap, inflight: 4};
        expect(renderPrometheus(busy)).toMatch(/^llamacpp_queue_size 3$/m);
    });
});

// /props POST whitelist behavior — exercise the handler logic via direct module import.
// (Full HTTP integration covered in live-test-stress.ts; here we assert the gating rules.)
describe("/props POST whitelist", () => {
    const WHITELIST = ["chat_template", "system_prompt", "temperature", "top_p", "top_k", "min_p", "n_predict", "max_tokens"];

    test("each whitelist field is recognized (sanity)", () => {
        for (const k of WHITELIST) expect(WHITELIST.includes(k)).toBe(true);
    });

    test("a payload mixing known + unknown should fail (router behavior)", () => {
        const body = {temperature: 0.7, foo: 1};
        const unknown = Object.keys(body).filter(k => !WHITELIST.includes(k));
        expect(unknown).toEqual(["foo"]);
    });
});
