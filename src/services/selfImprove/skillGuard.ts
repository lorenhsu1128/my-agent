// Skill Guard — security scanner for agent-created skills.
// Ported from Hermes Agent's skills_guard.py (15 threat categories, 483 regex).
// This is a simplified TypeScript version focusing on the 8 most critical categories.
//
// Trust policy for agent-created skills:
//   safe     → allow
//   caution  → allow
//   dangerous → block (no human to "ask", so block outright)

export type FindingSeverity = 'high' | 'critical'
export type FindingCategory =
  | 'exfiltration'
  | 'injection'
  | 'destructive'
  | 'persistence'
  | 'obfuscation'
  | 'supply_chain'
  | 'credential_exposure'
  | 'agent_config_mod'
  | 'structure'

export type Finding = {
  category: FindingCategory
  severity: FindingSeverity
  pattern: string
  match: string
}

export type ScanResult = {
  verdict: 'safe' | 'caution' | 'dangerous'
  findings: Finding[]
}

// ── Threat patterns ──────────────────────────────────────────────────────

type PatternDef = {
  regex: RegExp
  severity: FindingSeverity
  description: string
}

const THREAT_PATTERNS: Record<string, PatternDef[]> = {
  exfiltration: [
    { regex: /curl\s.*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, severity: 'critical', description: 'curl with credential variable' },
    { regex: /wget\s.*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, severity: 'critical', description: 'wget with credential variable' },
    { regex: /cat\s+~?\/?\.(?:env|ssh|aws|kube|docker|hermes\/\.env)/i, severity: 'critical', description: 'read sensitive dotfile' },
    { regex: /printenv|os\.environ/i, severity: 'high', description: 'environment variable access' },
  ],
  injection: [
    { regex: /ignore\s+(?:previous|all|above|prior)\s+instructions/i, severity: 'critical', description: 'prompt injection: ignore instructions' },
    { regex: /you\s+are\s+now\s+/i, severity: 'critical', description: 'prompt injection: role hijack' },
    { regex: /do\s+not\s+tell\s+the\s+user/i, severity: 'critical', description: 'prompt injection: hide from user' },
    { regex: /system\s+prompt\s+override/i, severity: 'critical', description: 'prompt injection: system override' },
    { regex: /disregard\s+(?:all\s+)?rules/i, severity: 'critical', description: 'prompt injection: disregard rules' },
    { regex: /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i, severity: 'critical', description: 'prompt injection: remove restrictions' },
  ],
  destructive: [
    { regex: /rm\s+-rf\s+\//i, severity: 'critical', description: 'recursive delete root' },
    { regex: /rmdir\s+.*\$HOME/i, severity: 'critical', description: 'delete home directory' },
    { regex: /chmod\s+777/i, severity: 'high', description: 'world-writable permissions' },
    { regex: /mkfs\b/i, severity: 'critical', description: 'format filesystem' },
    { regex: /dd\s+if=.*of=\/dev\//i, severity: 'critical', description: 'raw device write' },
  ],
  persistence: [
    { regex: /crontab\b/i, severity: 'high', description: 'crontab modification' },
    { regex: />>?\s*~?\/?\.(?:bashrc|zshrc|profile|bash_profile)/i, severity: 'critical', description: 'shell config modification' },
    { regex: /authorized_keys/i, severity: 'critical', description: 'SSH authorized_keys modification' },
    { regex: /systemctl\s+enable/i, severity: 'high', description: 'systemd service enable' },
    { regex: /\/etc\/sudoers/i, severity: 'critical', description: 'sudoers modification' },
  ],
  obfuscation: [
    { regex: /base64\s+-d\s*\|\s*(?:bash|sh|zsh)/i, severity: 'critical', description: 'base64 decode to shell' },
    { regex: /eval\s*\(/i, severity: 'high', description: 'eval() usage' },
    { regex: /exec\s*\(/i, severity: 'high', description: 'exec() usage' },
    { regex: /echo\s+.*\|\s*(?:python|node|ruby|perl)/i, severity: 'high', description: 'pipe to interpreter' },
    { regex: /__import__\s*\(\s*['"]os['"]\s*\)/i, severity: 'critical', description: 'Python dynamic os import' },
    { regex: /String\.fromCharCode/i, severity: 'high', description: 'character code construction' },
  ],
  supply_chain: [
    { regex: /curl\s+.*\|\s*(?:bash|sh|zsh)/i, severity: 'critical', description: 'curl pipe to shell' },
    { regex: /wget\s+.*\|\s*(?:bash|sh|zsh)/i, severity: 'critical', description: 'wget pipe to shell' },
    { regex: /pip\s+install\s+(?!.*==)[^\s]+\s*$/im, severity: 'high', description: 'pip install without version pin' },
    { regex: /npm\s+install\s+(?!.*@\d)[^\s]+\s*$/im, severity: 'high', description: 'npm install without version' },
  ],
  credential_exposure: [
    { regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i, severity: 'critical', description: 'private key in content' },
    { regex: /(?:sk-|pk-|api[_-]?key|token|secret)\s*[=:]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/i, severity: 'critical', description: 'hardcoded credential' },
  ],
  agent_config_mod: [
    { regex: /(?:CLAUDE|AGENTS|MY-AGENT)\.md/i, severity: 'high', description: 'agent config file reference' },
    { regex: /\.(?:cursorrules|clinerules)/i, severity: 'high', description: 'IDE agent config modification' },
    { regex: /\.(?:claude|my-agent)\/(?:settings|config)/i, severity: 'high', description: 'agent settings modification' },
  ],
}

// ── Structure limits ─────────────────────────────────────────────────────

const MAX_SKILL_SIZE_KB = 10
const MAX_TOTAL_SKILLS = 50

// ── Scanner ──────────────────────────────────────────────────────────────

function scanPatterns(content: string): Finding[] {
  const findings: Finding[] = []

  for (const [category, patterns] of Object.entries(THREAT_PATTERNS)) {
    for (const { regex, severity, description } of patterns) {
      const match = content.match(regex)
      if (match) {
        findings.push({
          category: category as FindingCategory,
          severity,
          pattern: description,
          match: match[0].slice(0, 100),
        })
      }
    }
  }

  return findings
}

function checkStructure(content: string): Finding[] {
  const findings: Finding[] = []
  const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024

  if (sizeKB > MAX_SKILL_SIZE_KB) {
    findings.push({
      category: 'structure',
      severity: 'high',
      pattern: `skill content exceeds ${MAX_SKILL_SIZE_KB}KB limit (${sizeKB.toFixed(1)}KB)`,
      match: `size: ${sizeKB.toFixed(1)}KB`,
    })
  }

  return findings
}

function determineVerdict(findings: Finding[]): 'safe' | 'caution' | 'dangerous' {
  if (findings.length === 0) return 'safe'
  const hasCritical = findings.some(f => f.severity === 'critical')
  if (hasCritical) return 'dangerous'
  return 'caution'
}

export function scanSkill(content: string): ScanResult {
  const patternFindings = scanPatterns(content)
  const structureFindings = checkStructure(content)
  const allFindings = [...patternFindings, ...structureFindings]

  return {
    verdict: determineVerdict(allFindings),
    findings: allFindings,
  }
}

export { MAX_SKILL_SIZE_KB, MAX_TOTAL_SKILLS }
