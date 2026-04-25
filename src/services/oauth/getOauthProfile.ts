// my-agent: M-DECOUPLE-2 Phase 3 — OAuth profile fetch decoupled.
//
// Both helpers used to round-trip /api/claude_cli_profile or
// /api/oauth/profile to look up Max/Pro subscription state. With OAuth
// removed, both return undefined unconditionally.
import type { OAuthProfileResponse } from './types.js'

/**
 * Returns OAuth profile for an API-key-authenticated user. With OAuth
 * decoupled, always undefined — callers (e.g. useCanSwitchToExistingSubscription)
 * gracefully fall through to "no subscription notice".
 */
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  return undefined
}

/**
 * Returns OAuth profile for an access-token-authenticated user. With OAuth
 * decoupled, always undefined.
 */
export async function getOauthProfileFromOauthToken(
  _accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  void _accessToken
  return undefined
}
