import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";

export type ResolvedMedia = {
    /** absolute file path on disk that LlamaMtmdContext.tokenize can read */
    filePath: string,
    /** true if this is a tmpfile we created and should clean up */
    ephemeral: boolean,
    /** detected MIME hint for logs (image/png, audio/wav, etc.) */
    mime?: string
};

/**
 * Normalize an OpenAI image_url / audio_url / data: URL to a local file path.
 * `data:` URIs are decoded into a tmpfile under the OS temp dir.
 * `file://` URIs are converted to local paths.
 * `http(s)://` URIs are downloaded to a tmpfile.
 */
export async function resolveMedia(url: string): Promise<ResolvedMedia> {
    if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;,]+)?(?:;([^,]+))?,(.*)$/s);
        if (match == null) throw new Error("Malformed data: URL");
        const mime = match[1] || "application/octet-stream";
        const encoding = match[2] || "";
        const payload = match[3] ?? "";
        const buffer = encoding.toLowerCase() === "base64"
            ? Buffer.from(payload, "base64")
            : Buffer.from(decodeURIComponent(payload));
        const ext = mimeToExt(mime);
        const tmp = await writeTmp(buffer, ext);
        return {filePath: tmp, ephemeral: true, mime};
    }

    if (url.startsWith("file://")) {
        const local = new URL(url).pathname;
        // Windows: leading slash before drive letter
        const fixed = process.platform === "win32" && /^\/[a-zA-Z]:/.test(local)
            ? local.slice(1)
            : local;
        return {filePath: path.resolve(fixed), ephemeral: false};
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch media: ${res.status} ${res.statusText}`);
        const mime = res.headers.get("content-type") ?? "application/octet-stream";
        const buffer = Buffer.from(await res.arrayBuffer());
        const tmp = await writeTmp(buffer, mimeToExt(mime));
        return {filePath: tmp, ephemeral: true, mime};
    }

    // bare path
    return {filePath: path.resolve(url), ephemeral: false};
}

export async function cleanupMedia(media: ResolvedMedia): Promise<void> {
    if (!media.ephemeral) return;
    try { await fs.unlink(media.filePath); } catch { /* best effort */ }
}

function mimeToExt(mime: string): string {
    const map: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/ogg": ".ogg"
    };
    return map[mime.toLowerCase()] ?? ".bin";
}

async function writeTmp(buffer: Buffer, ext: string): Promise<string> {
    const name = `tcq-shim-${crypto.randomBytes(8).toString("hex")}${ext}`;
    const full = path.join(os.tmpdir(), name);
    await fs.writeFile(full, buffer);
    return full;
}
