// my-agent: 不再從 api.anthropic.com 拉 official MCP registry；
// isOfficialMcpUrl 永遠回 false，所有 MCP URL 視為非官方。
let officialUrls: Set<string> | undefined = undefined

/**
 * Fire-and-forget fetch of the official MCP registry.
 * my-agent: no-op，保留簽章供 main.tsx caller 不破壞。
 */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  officialUrls = new Set()
}

/**
 * Returns true iff the given (already-normalized via getLoggingSafeMcpBaseUrl)
 * URL is in the official MCP registry. Undefined registry → false (fail-closed).
 */
export function isOfficialMcpUrl(normalizedUrl: string): boolean {
  return officialUrls?.has(normalizedUrl) ?? false
}

export function resetOfficialMcpUrlsForTesting(): void {
  officialUrls = undefined
}
