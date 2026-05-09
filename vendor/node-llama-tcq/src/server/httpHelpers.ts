import type {IncomingMessage, ServerResponse} from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload).toString()
    });
    res.end(payload);
}

export function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body).toString()
    });
    res.end(body);
}

const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB — image/audio data: URLs can be large

export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (c: Buffer) => {
            total += c.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (raw.length === 0) { resolve({} as T); return; }
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`Invalid JSON body: ${(e as Error).message}`)); }
        });
        req.on("error", reject);
    });
}

export function applyCorsHeaders(res: ServerResponse, enabled: boolean): void {
    if (!enabled) return;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Spec-Type, X-TCQ-Preset, X-Request-Id");
}
