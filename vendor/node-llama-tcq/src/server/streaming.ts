import type {ServerResponse} from "node:http";

export class SseWriter {
    constructor(private readonly res: ServerResponse) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });
    }

    send(payload: unknown): void {
        this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    done(): void {
        this.res.write("data: [DONE]\n\n");
        this.res.end();
    }

    error(err: unknown): void {
        try {
            const message = err instanceof Error ? err.message : String(err);
            this.res.write(`data: ${JSON.stringify({error: {message, type: "server_error", code: "internal_error"}})}\n\n`);
        } finally {
            this.res.end();
        }
    }
}
