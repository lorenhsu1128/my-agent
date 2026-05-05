// Shared SSE utilities: ASCII-safe JSON encoder + event formatter + line iterator.
// Pure functions, no external deps — both adapters (vanilla / tcq-shim) import here.
// Lifted from src/services/api/llamacpp-fetch-adapter.ts (line 952-999).

const NON_ASCII_RE = new RegExp('[\\u0080-\\uffff]', 'g')

/**
 * JSON.stringify but escape all non-ASCII chars as \uXXXX.
 * SSE event payload travels through stdio buffers / pipes — keep it ASCII-safe.
 */
export function jsonStringifyAsciiSafe(data: unknown): string {
  return JSON.stringify(data).replace(
    NON_ASCII_RE,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Frame as SSE: `event: NAME\ndata: JSON\n\n` */
export function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${jsonStringifyAsciiSafe(data)}\n\n`
}

/**
 * Split OpenAI SSE byte stream into line buffer, yield each JSON payload
 * (strip `data: ` prefix, stop on `[DONE]`).
 *
 * Don't use TextDecoder({ stream: true })! On Bun 1.3.6 Windows the streaming
 * TextDecoder slices multi-byte UTF-8 mid-character at chunk boundaries (e.g.
 * Chinese 3-byte chars) -> garbled bytes -> JSON.parse fails -> tool input becomes {}.
 *
 * Instead: accumulate raw bytes, split on \n (0x0a, single-byte ASCII), then
 * decode each whole line as UTF-8. SSE delimiter \n is single-byte so it can't
 * land mid-character, guaranteeing each line is valid UTF-8.
 */
export async function* iterOpenAISSELines(
  upstream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = upstream.getReader()
  let rawBuf = Buffer.alloc(0)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      rawBuf = Buffer.concat([rawBuf, Buffer.from(value)])
      let idx: number
      while ((idx = rawBuf.indexOf(0x0a)) !== -1) {
        const lineBytes = rawBuf.subarray(0, idx)
        rawBuf = rawBuf.subarray(idx + 1)
        const line = lineBytes.toString('utf-8').replace(/\r$/, '')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') return
        yield payload
      }
    }
  } finally {
    reader.releaseLock()
  }
}
