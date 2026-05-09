// Module-level metrics singleton. Both the router (incoming request count) and
// chatCompletions (per-response token totals) push into the same instance so
// /metrics can read everything without plumbing a Counters object everywhere.
//
// Single-process / single-slot — a Map / atomic counter would be overkill.

export type ShimMetrics = {
    requestsTotal: number,
    promptTokensTotal: number,
    completionTokensTotal: number,
    chatCompletionsTotal: number,
    chatErrorsTotal: number,
    contextOverflowTotal: number,
    /** Currently in-flight chat-completion requests (gauge, derived from withLock contention). */
    inflight: number
};

const _state: ShimMetrics = {
    requestsTotal: 0,
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    chatCompletionsTotal: 0,
    chatErrorsTotal: 0,
    contextOverflowTotal: 0,
    inflight: 0
};

export function getMetricsSnapshot(): Readonly<ShimMetrics> { return _state; }

export function incRequests(): void { _state.requestsTotal++; }
export function recordChatTokens(prompt: number, completion: number): void {
    _state.promptTokensTotal += prompt;
    _state.completionTokensTotal += completion;
    _state.chatCompletionsTotal++;
}
export function incChatError(kind: "overflow" | "other"): void {
    _state.chatErrorsTotal++;
    if (kind === "overflow") _state.contextOverflowTotal++;
}
export function inflightStart(): void { _state.inflight++; }
export function inflightEnd(): void { if (_state.inflight > 0) _state.inflight--; }

/** Pretend-Prometheus text format aligned with llama.cpp server convention. */
export function renderPrometheus(snap: Readonly<ShimMetrics>): string {
    const lines: string[] = [];
    const metric = (help: string, type: string, name: string, value: number) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
    };
    metric("Total HTTP requests processed", "counter", "llamacpp_requests_total", snap.requestsTotal);
    metric("Tokens evaluated (input prompt) across all chat completions", "counter", "llamacpp_tokens_evaluated_total", snap.promptTokensTotal);
    metric("Tokens predicted (output) across all chat completions", "counter", "llamacpp_tokens_predicted_total", snap.completionTokensTotal);
    metric("Total chat-completion requests answered", "counter", "tcq_shim_chat_completions_total", snap.chatCompletionsTotal);
    metric("Total chat-completion requests that errored", "counter", "tcq_shim_chat_errors_total", snap.chatErrorsTotal);
    metric("Total requests rejected with context_length_exceeded", "counter", "tcq_shim_context_overflow_total", snap.contextOverflowTotal);
    metric("Currently in-flight chat-completion requests (single-slot gauge)", "gauge", "tcq_shim_inflight", snap.inflight);
    metric("Queue size (waiting on inference lock) — derived from inflight - 1", "gauge", "llamacpp_queue_size", Math.max(0, snap.inflight - 1));
    lines.push("");
    return lines.join("\n");
}
