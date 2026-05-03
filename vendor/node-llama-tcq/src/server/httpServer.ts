import http from "node:http";
import {nanoid} from "nanoid";
import chalk from "chalk";
import {ensureSession, type SessionInitOptions} from "./session.js";
import {dispatch, type Counters, type RouterOptions} from "./openAiRouter.js";
import {applyCorsHeaders} from "./httpHelpers.js";
import {makeError} from "./errors.js";
import {sendJson} from "./httpHelpers.js";

export type ShimServerOptions = SessionInitOptions & {
    host: string,
    port: number,
    cors: boolean,
    apiKey?: string,
    aliases: string[],
    parallel: number,
    enableCorsProxy: boolean,
    enableTools: boolean,
    webuiDir?: string,
    reasoning?: "on" | "off" | "auto",
    reasoningBudget?: number
};

export type ShimServerHandle = {
    close: () => Promise<void>,
    address: {host: string, port: number}
};

export async function startTcqShimServer(opts: ShimServerOptions): Promise<ShimServerHandle> {
    const session = await ensureSession({
        modelPath: opts.modelPath,
        mmprojPath: opts.mmprojPath,
        contextSize: opts.contextSize,
        gpuLayers: opts.gpuLayers,
        gpu: opts.gpu,
        threads: opts.threads,
        batchSize: opts.batchSize,
        ubatchSize: opts.ubatchSize,
        cacheTypeK: opts.cacheTypeK,
        cacheTypeV: opts.cacheTypeV,
        flashAttention: opts.flashAttention,
        noMmap: opts.noMmap,
        debug: opts.debug,
        reasoning: opts.reasoning,
        reasoningBudget: opts.reasoningBudget
    });

    const routerOpts: RouterOptions = {
        aliases: opts.aliases,
        apiKey: opts.apiKey,
        enableCorsProxy: opts.enableCorsProxy,
        enableTools: opts.enableTools,
        webuiDir: opts.webuiDir
    };
    const counters: Counters = {requests: 0, promptTokens: 0, completionTokens: 0};

    const server = http.createServer(async (req, res) => {
        const requestId = nanoid(12);
        res.setHeader("X-Request-Id", requestId);
        applyCorsHeaders(res, opts.cors);

        try {
            await dispatch(req, res, session, routerOpts, counters);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`[TCQ-shim:${requestId}] unhandled error: ${message}`));
            if (!res.headersSent) {
                sendJson(res, 500, makeError("internal_error", message, "server_error"));
            } else {
                try { res.end(); } catch { /* */ }
            }
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, opts.host, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    console.error(chalk.green(`[TCQ-shim] listening on http://${opts.host}:${opts.port}`));
    console.error(chalk.gray(`[TCQ-shim]   model:    ${opts.modelPath}`));
    console.error(chalk.gray(`[TCQ-shim]   aliases:  ${opts.aliases.join(", ")}`));
    console.error(chalk.gray(`[TCQ-shim]   ctx:      ${opts.contextSize}`));
    console.error(chalk.gray(`[TCQ-shim]   kv-cache: k=${session.cacheTypeKLabel} v=${session.cacheTypeVLabel}`));
    if (opts.mmprojPath) console.error(chalk.gray(`[TCQ-shim]   mmproj:   ${opts.mmprojPath}`));

    return {
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close((err) => err ? reject(err) : resolve());
            });
        },
        address: {host: opts.host, port: opts.port}
    };
}
