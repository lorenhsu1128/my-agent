// Vision/audio handling. The shim's main chat path falls back to text-only when
// no media parts are present; when present we route through LlamaMtmdContext.
//
// Phase 1 limitation: we tokenize media + text together via mtmd.tokenize, then
// run mtmd.evalChunks + mtmd.generate. Multi-turn history with media is not
// preserved across requests yet (we treat each turn as a fresh session).

import {ResolvedMedia, resolveMedia, cleanupMedia} from "./mediaResolver.js";
import type {OpenAIContentPart, OpenAIMessage} from "./types.js";

export type MediaInput = {type: "image" | "audio", url: string};

export function extractMediaParts(messages: OpenAIMessage[]): MediaInput[] {
    const out: MediaInput[] = [];
    for (const m of messages) {
        if (typeof m.content === "string" || m.content == null) continue;
        for (const part of m.content) {
            if (part.type === "image_url") out.push({type: "image", url: part.image_url.url});
            else if (part.type === "input_audio") out.push({type: "audio", url: dataUrlFromInputAudio(part.input_audio)});
            else if (part.type === "audio_url") out.push({type: "audio", url: part.audio_url.url});
        }
    }
    return out;
}

export function flattenContent(content: string | null | OpenAIContentPart[]): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    return content.filter((p) => p.type === "text").map((p) => (p as {type: "text", text: string}).text).join("\n");
}

function dataUrlFromInputAudio(audio: {data: string, format?: string}): string {
    const mime = audio.format === "mp3" ? "audio/mpeg" : `audio/${audio.format ?? "wav"}`;
    return `data:${mime};base64,${audio.data}`;
}

export async function resolveAllMedia(parts: MediaInput[]): Promise<ResolvedMedia[]> {
    return await Promise.all(parts.map((p) => resolveMedia(p.url)));
}

export async function cleanupAllMedia(resolved: ResolvedMedia[]): Promise<void> {
    await Promise.all(resolved.map(cleanupMedia));
}
