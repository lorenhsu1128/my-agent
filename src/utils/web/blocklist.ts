/**
 * Website access blocklist for URL-capable tools (WebCrawl, WebBrowser).
 *
 * Ported from Hermes Agent `tools/website_policy.py`. Loads user-managed
 * blocklist from `{CLAUDE_CONFIG_DIR}/website-blocklist.yaml` with optional
 * shared-list files. Cached in-memory with 30s TTL.
 *
 * Fail-open: if the config file is missing, malformed, or unreadable, web
 * tools continue to work (a config typo should not break everything).
 *
 * Config shape:
 *   enabled: true
 *   domains:
 *     - bad.example.com
 *     - "*.ads.example.com"
 *   shared_files:
 *     - blocklist-shared.txt   # relative to CLAUDE_CONFIG_DIR, or absolute
 */

import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { parse as parseYaml } from 'yaml'
import { getMyAgentConfigHomeDir } from '../envUtils.js'
import { logError } from '../log.js'

export interface BlockResult {
  url: string
  host: string
  rule: string
  source: string
  message: string
}

interface CompiledRule {
  pattern: string
  source: string
}

interface Policy {
  enabled: boolean
  rules: CompiledRule[]
}

const CACHE_TTL_MS = 30_000
let cached: Policy | null = null
let cachedAt = 0

const DEFAULT_POLICY: Policy = { enabled: false, rules: [] }

function getConfigPath(): string {
  return join(getMyAgentConfigHomeDir(), 'website-blocklist.yaml')
}

function normalizeHost(host: string): string {
  return (host || '').trim().toLowerCase().replace(/\.+$/, '')
}

function normalizeRule(rule: unknown): string | null {
  if (typeof rule !== 'string') return null
  let value = rule.trim().toLowerCase()
  if (!value || value.startsWith('#')) return null
  if (value.includes('://')) {
    try {
      const parsed = new URL(value)
      value = parsed.host || parsed.pathname
    } catch {
      value = value.split('://', 2)[1] ?? value
    }
  }
  value = value.split('/', 1)[0]!.trim().replace(/\.+$/, '')
  if (value.startsWith('www.')) value = value.slice(4)
  return value || null
}

function loadSharedFile(path: string): string[] {
  try {
    const raw = readFileSync(path, 'utf8')
    const out: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      const n = normalizeRule(line)
      if (n) out.push(n)
    }
    return out
  } catch (err) {
    logError(
      `[blocklist] Failed to read shared file ${path}: ${(err as Error).message}`,
    )
    return []
  }
}

function parsePolicy(configPath: string): Policy {
  if (!existsSync(configPath)) return { ...DEFAULT_POLICY }

  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8')) ?? {}
  } catch (err) {
    logError(
      `[blocklist] Invalid YAML at ${configPath} (failing open): ${(err as Error).message}`,
    )
    return { ...DEFAULT_POLICY }
  }

  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_POLICY }

  const root = parsed as Record<string, unknown>
  const security =
    root.security && typeof root.security === 'object'
      ? (root.security as Record<string, unknown>)
      : root
  const wb = security.website_blocklist ?? security
  if (typeof wb !== 'object' || wb === null) return { ...DEFAULT_POLICY }

  const cfg = wb as Record<string, unknown>
  const enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled)
  const rawDomains = Array.isArray(cfg.domains) ? cfg.domains : []
  const rawShared = Array.isArray(cfg.shared_files) ? cfg.shared_files : []

  const rules: CompiledRule[] = []
  const seen = new Set<string>()

  for (const d of rawDomains) {
    const n = normalizeRule(d)
    if (!n) continue
    const key = `config:${n}`
    if (seen.has(key)) continue
    rules.push({ pattern: n, source: 'config' })
    seen.add(key)
  }

  for (const sf of rawShared) {
    if (typeof sf !== 'string' || !sf.trim()) continue
    const p = isAbsolute(sf) ? sf : join(getMyAgentConfigHomeDir(), sf)
    for (const n of loadSharedFile(p)) {
      const key = `${p}:${n}`
      if (seen.has(key)) continue
      rules.push({ pattern: n, source: p })
      seen.add(key)
    }
  }

  return { enabled, rules }
}

function getPolicy(): Policy {
  const now = Date.now()
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached
  try {
    cached = parsePolicy(getConfigPath())
  } catch (err) {
    logError(
      `[blocklist] Unexpected error loading policy (failing open): ${(err as Error).message}`,
    )
    cached = { ...DEFAULT_POLICY }
  }
  cachedAt = now
  return cached
}

/** Force next lookup to re-read the config file. Used by tests. */
export function invalidateBlocklistCache(): void {
  cached = null
  cachedAt = 0
}

function matchHost(host: string, pattern: string): boolean {
  if (!host || !pattern) return false
  if (pattern.startsWith('*.')) {
    // *.example.com matches foo.example.com but not example.com
    const suffix = pattern.slice(1) // ".example.com"
    return host.endsWith(suffix)
  }
  return host === pattern || host.endsWith(`.${pattern}`)
}

function extractHost(url: string): string {
  try {
    const u = new URL(url)
    return normalizeHost(u.hostname)
  } catch {
    if (!url.includes('://')) {
      try {
        const u = new URL(`http://${url}`)
        return normalizeHost(u.hostname)
      } catch {
        return ''
      }
    }
    return ''
  }
}

/**
 * Check whether a URL is allowed by the blocklist. Returns `null` if the
 * URL is allowed, or a `BlockResult` describing the matched rule if blocked.
 *
 * Never throws — fails open on any error so a config issue can't nuke the
 * web tools.
 */
export function checkBlocklist(url: string): BlockResult | null {
  const policy = getPolicy()
  if (!policy.enabled || policy.rules.length === 0) return null

  const host = extractHost(url)
  if (!host) return null

  for (const rule of policy.rules) {
    if (matchHost(host, rule.pattern)) {
      return {
        url,
        host,
        rule: rule.pattern,
        source: rule.source,
        message: `Blocked by website policy: '${host}' matched rule '${rule.pattern}' from ${rule.source}`,
      }
    }
  }
  return null
}
