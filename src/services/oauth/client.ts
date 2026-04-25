// my-agent: M-DECOUPLE-2 Phase 3 — Anthropic OAuth client decoupled.
//
// All real OAuth flows (auth-url construction, code exchange, token refresh,
// profile fetch, role fetch, API key creation) have been removed. The only
// surface kept here is the two helpers still imported by upstream callers
// (initReplBridge / RemoteTriggerTool / preconditions / teleport / init):
//
//   - getOrganizationUUID()           → falls back to GlobalConfig only
//   - populateOAuthAccountInfoIfNeeded() → respects MY_AGENT_ENV vars only
//
// Both return safe no-op values in the absence of a Claude.ai OAuth session,
// which is the my-agent default state.

import { getGlobalConfig } from '../../utils/config.js'

/**
 * Gets the organization UUID from cached config. Network OAuth profile fetch
 * has been removed; if the value isn't already in GlobalConfig we return null.
 */
export async function getOrganizationUUID(): Promise<string | null> {
  return getGlobalConfig().oauthAccount?.organizationUuid ?? null
}

/**
 * Populate the OAuth account info from MY_AGENT_* env vars only. The network
 * round-trip to api/oauth/profile that previously backfilled this from a live
 * access token has been removed.
 *
 * Returns true if env-var-supplied values were written to config, false
 * otherwise (existing config or no env vars).
 */
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  const envAccountUuid = process.env.MY_AGENT_ACCOUNT_UUID
  const envUserEmail = process.env.MY_AGENT_USER_EMAIL
  const envOrganizationUuid = process.env.MY_AGENT_ORGANIZATION_UUID
  if (!envAccountUuid || !envUserEmail || !envOrganizationUuid) {
    return false
  }
  const cfg = getGlobalConfig()
  if (cfg.oauthAccount) {
    return false
  }
  const { saveGlobalConfig } = await import('../../utils/config.js')
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: {
      accountUuid: envAccountUuid,
      emailAddress: envUserEmail,
      organizationUuid: envOrganizationUuid,
    },
  }))
  return true
}
