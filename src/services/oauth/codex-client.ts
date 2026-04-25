// my-agent: M-DECOUPLE-2 Phase 3 — OpenAI Codex OAuth client decoupled.
//
// The full PKCE login flow (auth URL, local HTTP server on port 1455, code
// exchange, token refresh) is no longer wired up. The remaining surface is
// just the CodexTokens type, kept so utils/auth.ts (which still persists +
// reads codex tokens from GlobalConfig if a previous build wrote them) can
// continue to type-check.

export type CodexTokens = {
  /** OpenAI access token (JWT) */
  accessToken: string
  /** OpenAI refresh token */
  refreshToken: string
  /** Absolute epoch timestamp (ms) when the access token expires */
  expiresAt: number
  /** ChatGPT account ID extracted from the JWT */
  accountId: string
}
