/**
 * Cloud-endpoint constants that survive OAuth removal.
 *
 * In prod my-agent, these all return ''（PROD_OAUTH_CONFIG 已是空字串），caller
 * 自然 fail-soft；staging（USER_TYPE=ant + USE_STAGING_OAUTH）/ local
 * （USE_LOCAL_OAUTH）/ 自定義 base URL（MY_AGENT_CUSTOM_OAUTH_URL）仍可用於開發。
 *
 * 其餘 OAuth flow URLs（CONSOLE_AUTHORIZE_URL / TOKEN_URL / CLIENT_ID 等）已隨
 * services/oauth/ 一併刪除（M-DECOUPLE-2）。
 */

import { isEnvTruthy } from 'src/utils/envUtils.js'

type Env = 'prod' | 'staging' | 'local'

function getEnv(): Env {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) return 'local'
    if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) return 'staging'
  }
  return 'prod'
}

const ALLOWED_CUSTOM_BASE_URLS = [
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]

function getCustomBase(): string | null {
  const raw = process.env.MY_AGENT_CUSTOM_OAUTH_URL
  if (!raw) return null
  const base = raw.replace(/\/$/, '')
  if (!ALLOWED_CUSTOM_BASE_URLS.includes(base)) {
    throw new Error('MY_AGENT_CUSTOM_OAUTH_URL is not an approved endpoint.')
  }
  return base
}

function getLocalApiBase(): string {
  return (
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ??
    'http://localhost:8000'
  )
}

function getLocalAppsBase(): string {
  return (
    process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, '') ??
    'http://localhost:4000'
  )
}

export function getApiBaseUrl(): string {
  const custom = getCustomBase()
  if (custom) return custom
  switch (getEnv()) {
    case 'local':
      return getLocalApiBase()
    case 'staging':
      return 'https://api-staging.anthropic.com'
    case 'prod':
      return ''
  }
}

export function getClaudeAiOrigin(): string {
  const custom = getCustomBase()
  if (custom) return custom
  switch (getEnv()) {
    case 'local':
      return getLocalAppsBase()
    case 'staging':
      return 'https://claude-ai.staging.ant.dev'
    case 'prod':
      return ''
  }
}

export function getKeychainFileSuffix(): string {
  if (process.env.MY_AGENT_CUSTOM_OAUTH_URL) return '-custom-oauth'
  switch (getEnv()) {
    case 'local':
      return '-local-oauth'
    case 'staging':
      return '-staging-oauth'
    case 'prod':
      return ''
  }
}

export function getMcpProxyUrl(): string {
  switch (getEnv()) {
    case 'local':
      return 'http://localhost:8205'
    case 'staging':
      return 'https://mcp-proxy-staging.anthropic.com'
    case 'prod':
      return ''
  }
}

export function getMcpProxyPath(): string {
  switch (getEnv()) {
    case 'local':
      return '/v1/toolbox/shttp/mcp/{server_id}'
    case 'staging':
      return '/v1/mcp/{server_id}'
    case 'prod':
      return ''
  }
}

/**
 * Client ID Metadata Document URL for MCP OAuth (CIMD / SEP-991).
 * 已停用，永遠 return ''.
 */
export function getMcpClientMetadataUrl(): string {
  return ''
}

/**
 * MCP elicitation beta header — 仍由 MCP client 使用。
 */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const
