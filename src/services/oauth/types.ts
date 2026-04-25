// my-agent: OAuth types stub. The Anthropic OAuth path has been decoupled
// (M-DECOUPLE-2 Phase 3). These types are kept as concrete shapes so that
// type-only imports across the codebase continue to resolve, but the real
// runtime values are no longer produced anywhere — every OAuth client function
// has been stubbed to return null/undefined/no-op in services/oauth/client.ts.
//
// Do NOT add new functionality here. New consumers should use the
// llama.cpp / Anthropic-direct paths and not depend on these shapes.

export type SubscriptionType = 'pro' | 'max' | 'team' | 'enterprise'

export type RateLimitTier = string

export type BillingType = string

export type TokenAccountInfo = {
  uuid: string
  emailAddress: string
  organizationUuid?: string
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: SubscriptionType | null
  rateLimitTier?: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: TokenAccountInfo
}

export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  account?: { uuid: string; email_address: string }
  organization?: { uuid: string }
}

export type OAuthProfileResponse = {
  account: {
    uuid: string
    email: string
    display_name?: string | null
    created_at?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
  }
  organization: {
    uuid: string
    organization_type?:
      | 'claude_max'
      | 'claude_pro'
      | 'claude_enterprise'
      | 'claude_team'
      | string
    rate_limit_tier?: RateLimitTier | null
    has_extra_usage_enabled?: boolean | null
    billing_type?: BillingType | null
    subscription_created_at?: string | null
  }
}

export type UserRolesResponse = {
  organization_role?: string
  workspace_role?: string
  organization_name?: string
}
