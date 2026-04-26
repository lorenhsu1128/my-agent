/**
 * M-WEB-CLOSEOUT-6：Client-side secret scan
 *
 * 為了避免把整個 Node 端 src/ 模組拉進 Vite bundle，這裡複刻 src/utils/web/secretScan.ts
 * 的 `containsSecret`（PREFIX_PATTERNS + PRIVATE_KEY_RE 兩個關鍵）。
 *
 * 行為與後端必須一致 — server 端 422 是雙重保護，client 端先警告讓使用者
 * 在送 PUT/POST 前能勾「override」。修補時兩處同步改。
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

const PRIVATE_KEY_RE =
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g

export function containsSecret(text: string): boolean {
  if (!text) return false
  PREFIX_RE.lastIndex = 0
  if (PREFIX_RE.test(text)) return true
  PRIVATE_KEY_RE.lastIndex = 0
  if (PRIVATE_KEY_RE.test(text)) return true
  return false
}
