import type {IncomingMessage, ServerResponse} from "node:http";
import {URL} from "node:url";
import {ServerSession} from "./session.js";
import {handleChatCompletions} from "./chatCompletions.js";
import {sendJson, sendText, readJsonBody} from "./httpHelpers.js";
import {makeError, NOT_IMPLEMENTED_501} from "./errors.js";
import {
    listModels, listOllamaTags, healthBody, propsBody, slotsBody,
    handleTokenize, handleDetokenize, handleApplyTemplate, handleCountTokens,
    metricsBody, sendMetrics, handlePropsPost
} from "./miscEndpoints.js";
import {incRequests} from "./metrics.js";

export type RouterOptions = {
    aliases: string[],
    apiKey?: string,
    enableCorsProxy: boolean,
    enableTools: boolean,
    webuiDir?: string
};

export type Counters = {requests: number, promptTokens: number, completionTokens: number};

const PUBLIC_PATHS = new Set([
    "/health", "/v1/health",
    "/models", "/v1/models",
    "/api/tags"
]);

export async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    session: ServerSession,
    opts: RouterOptions,
    counters: Counters
): Promise<void> {
    counters.requests++;
    incRequests();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    const primaryAlias = opts.aliases[0] ?? "model";

    // Auth check
    if (opts.apiKey != null && !PUBLIC_PATHS.has(pathname)) {
        const auth = req.headers["authorization"];
        if (auth !== `Bearer ${opts.apiKey}`) {
            sendJson(res, 401, makeError("invalid_api_key", "Missing or invalid Authorization header"));
            return;
        }
    }

    // CORS preflight
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // GET endpoints
    if (method === "GET") {
        switch (pathname) {
            case "/health":
            case "/v1/health":
                return sendJson(res, 200, healthBody());
            case "/models":
            case "/v1/models":
                return sendJson(res, 200, listModels(opts.aliases));
            case "/api/tags":
                return sendJson(res, 200, listOllamaTags(opts.aliases));
            case "/props":
                return sendJson(res, 200, propsBody(session, primaryAlias));
            case "/slots":
                return sendJson(res, 200, slotsBody(session));
            case "/metrics":
                return sendMetrics(res, metricsBody(counters));
            case "/lora-adapters":
                return sendJson(res, 200, []);
            case "/cors-proxy":
                if (!opts.enableCorsProxy) return notFound(res, pathname);
                return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "cors_proxy_not_implemented"));
            case "/tools":
                if (!opts.enableTools) return notFound(res, pathname);
                return sendJson(res, 200, {tools: []});
            default:
                return notFound(res, pathname);
        }
    }

    if (method !== "POST") {
        sendJson(res, 405, makeError("method_not_allowed", `Method ${method} not allowed for ${pathname}`));
        return;
    }

    // POST endpoints — read body once
    let body: any;
    try { body = await readJsonBody(req); }
    catch (e) {
        sendJson(res, 400, makeError("invalid_json", (e as Error).message));
        return;
    }

    switch (pathname) {
        case "/v1/chat/completions":
        case "/chat/completions":
            return handleChatCompletions(req, res, body, session, primaryAlias);

        case "/v1/completions":
        case "/completion":
        case "/completions":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "completions_phase_pending"));

        case "/v1/embeddings":
        case "/embedding":
        case "/embeddings":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "embeddings_phase_pending"));

        case "/v1/rerank":
        case "/v1/reranking":
        case "/rerank":
        case "/reranking":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "rerank_phase_pending"));

        case "/v1/responses":
        case "/responses":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "responses_phase_pending"));

        case "/v1/messages":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "anthropic_messages_phase_pending"));

        case "/v1/messages/count_tokens":
            return handleCountTokens(res, body, session);

        case "/api/chat":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "ollama_chat_phase_pending"));

        case "/tokenize":
            return handleTokenize(res, body, session);

        case "/detokenize":
            return handleDetokenize(res, body, session);

        case "/apply-template":
            return handleApplyTemplate(res, body, session);

        case "/infill":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "infill_phase_pending"));

        case "/lora-adapters":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "lora_hot_swap_not_supported"));

        case "/props":
            return handlePropsPost(res, body, session, primaryAlias);

        case "/models/load":
        case "/models/unload":
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "router_mode_not_supported"));

        case "/cors-proxy":
            if (!opts.enableCorsProxy) return notFound(res, pathname);
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "cors_proxy_not_implemented"));

        case "/tools":
            if (!opts.enableTools) return notFound(res, pathname);
            return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "tools_endpoint_not_implemented"));

        default: {
            // /slots/{id}?action=...
            const slotMatch = pathname.match(/^\/slots\/(\d+)$/);
            if (slotMatch != null) {
                return sendJson(res, 501, NOT_IMPLEMENTED_501(pathname, "slot_save_restore_phase_pending"));
            }
            return notFound(res, pathname);
        }
    }
}

function notFound(res: ServerResponse, pathname: string): void {
    sendJson(res, 404, makeError("not_found", `Path ${pathname} not found`));
}
