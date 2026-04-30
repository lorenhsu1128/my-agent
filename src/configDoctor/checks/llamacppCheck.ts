/**
 * llamacpp.jsonc 健康檢查（M-CONFIG-DOCTOR）。
 *
 * 檢查項目：
 *   - 檔案存在（缺 → ERROR，可 autofix）
 *   - JSONC 解析（壞 → ERROR）
 *   - Schema 驗證（不符 → ERROR）
 *   - model ≠ server.alias（mismatch → ERROR，但不 autofix）
 *   - binaryPath 跨平台副檔名（Windows 必 .exe / 其他不可有 → ERROR，可 autofix）
 *   - binaryPath 指向不存在檔（→ WARNING）
 *   - strict JSON（非 JSONC → WARNING，可 autofix migrate）
 *   - env override 覆蓋了非 default 值（→ WARNING）
 */
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import type { Issue } from '../types.js'
import { getLlamaCppConfigPath } from '../../llamacppConfig/paths.js'
import {
  LlamaCppConfigSchema,
  DEFAULT_LLAMACPP_CONFIG,
} from '../../llamacppConfig/schema.js'
import { parseJsonc, hasJsoncComments } from '../../utils/jsoncStore.js'
import { getProjectRoot } from '../../bootstrap/state.js'

const ENV_OVERRIDES: Array<[string, string]> = [
  ['LLAMA_BASE_URL', 'baseUrl'],
  ['LLAMA_MODEL', 'model'],
  ['LLAMACPP_CTX_SIZE', 'contextSize'],
  ['LLAMACPP_COMPACT_BUFFER', 'autoCompactBufferTokens'],
  ['LLAMA_DEBUG', 'debug'],
]

export async function checkLlamaCpp(): Promise<{
  issues: Issue[]
  paths: Record<string, string>
}> {
  const issues: Issue[] = []
  const path = getLlamaCppConfigPath()
  const paths = { llamacpp: path }

  if (!existsSync(path)) {
    issues.push({
      code: 'llamacpp.missing',
      severity: 'error',
      module: 'llamacpp',
      path,
      summary: 'llamacpp.jsonc 不存在',
      detail: '會走 DEFAULT 設定。--fix 會 seed 模板（含繁中註解）。',
      autoFixable: true,
    })
    return { issues, paths }
  }

  let raw: string
  try {
    raw = (await readFile(path, 'utf-8')).replace(/^﻿/, '')
  } catch (err) {
    issues.push({
      code: 'llamacpp.read-failed',
      severity: 'error',
      module: 'llamacpp',
      path,
      summary: `無法讀取：${err instanceof Error ? err.message : String(err)}`,
      autoFixable: false,
    })
    return { issues, paths }
  }

  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (err) {
    issues.push({
      code: 'llamacpp.parse-failed',
      severity: 'error',
      module: 'llamacpp',
      path,
      summary: 'JSONC 解析失敗',
      detail:
        (err instanceof Error ? err.message : String(err)) +
        '\n--fix 會備份壞檔並重新 seed。',
      autoFixable: true,
    })
    return { issues, paths }
  }

  const validated = LlamaCppConfigSchema.safeParse(parsed)
  if (!validated.success) {
    issues.push({
      code: 'llamacpp.schema-invalid',
      severity: 'error',
      module: 'llamacpp',
      path,
      summary: 'Schema 驗證失敗',
      detail: validated.error.issues
        .slice(0, 5)
        .map(
          i =>
            `  - ${i.path.join('.') || '(root)'}: ${i.message} (${i.code})`,
        )
        .join('\n'),
      autoFixable: false,
    })
    return { issues, paths }
  }

  const cfg = validated.data

  // model vs server.alias
  if (cfg.server && cfg.model && cfg.server.alias && cfg.model !== cfg.server.alias) {
    issues.push({
      code: 'llamacpp.alias-mismatch',
      severity: 'error',
      module: 'llamacpp',
      path,
      summary: `model "${cfg.model}" ≠ server.alias "${cfg.server.alias}"`,
      detail:
        'llama-server 會以 server.alias 為準回應；my-agent 送 model 字串給 server，' +
        '兩者不一致 server 會 400 拒絕。手動改其中一個讓它們一致。',
      autoFixable: false,
    })
  }

  // binaryPath 跨平台
  if (cfg.server?.binaryPath) {
    const bp = cfg.server.binaryPath
    const isWin = process.platform === 'win32'
    const endsExe = bp.toLowerCase().endsWith('.exe')
    if (isWin && !endsExe) {
      issues.push({
        code: 'llamacpp.binary-path-platform',
        severity: 'error',
        module: 'llamacpp',
        path,
        summary: `Windows 平台但 binaryPath 缺 .exe 副檔名：${bp}`,
        detail: '--fix 會自動補 .exe',
        autoFixable: true,
        fixHint: { current: bp, suggested: bp + '.exe' },
      })
    } else if (!isWin && endsExe) {
      issues.push({
        code: 'llamacpp.binary-path-platform',
        severity: 'error',
        module: 'llamacpp',
        path,
        summary: `非 Windows 平台但 binaryPath 含 .exe：${bp}`,
        detail: '--fix 會自動移除 .exe',
        autoFixable: true,
        fixHint: { current: bp, suggested: bp.slice(0, -'.exe'.length) },
      })
    }

    // binaryPath 指向不存在檔
    const absBin = isAbsolute(bp) ? bp : join(getProjectRoot(), bp)
    if (!existsSync(absBin)) {
      issues.push({
        code: 'llamacpp.binary-not-found',
        severity: 'warning',
        module: 'llamacpp',
        path,
        summary: `binaryPath 指向不存在的檔：${absBin}`,
        detail: 'shell 端 serve.sh 啟動會失敗。請確認檔案存在或修正路徑。',
        autoFixable: false,
      })
    }
  }

  // strict JSON 沒升級
  if (!hasJsoncComments(raw)) {
    issues.push({
      code: 'llamacpp.strict-json',
      severity: 'warning',
      module: 'llamacpp',
      path,
      summary: '檔案是 strict JSON（無註解）',
      detail:
        'seed 偵測到 strict JSON 會自動升級為 JSONC（保留使用者值）。' +
        '--fix 會主動觸發 migration。',
      autoFixable: true,
    })
  }

  // env override 警告
  for (const [env, field] of ENV_OVERRIDES) {
    const val = process.env[env]
    if (val !== undefined && val !== '') {
      issues.push({
        code: 'llamacpp.env-override',
        severity: 'warning',
        module: 'llamacpp',
        summary: `env ${env} 覆蓋了 ${field}（實際使用 "${val}"）`,
        detail: '使用者 jsonc 設定不會生效，直到 unset 此 env。',
        autoFixable: false,
      })
    }
  }

  // ctxSize sanity（client < server 時 compact 算錯）
  if (
    cfg.server?.ctxSize !== undefined &&
    cfg.contextSize !== undefined &&
    cfg.server.ctxSize < cfg.contextSize
  ) {
    issues.push({
      code: 'llamacpp.ctx-mismatch',
      severity: 'warning',
      module: 'llamacpp',
      path,
      summary: `server.ctxSize (${cfg.server.ctxSize}) < contextSize (${cfg.contextSize})`,
      detail: 'auto-compact 閾值會算錯。建議讓 server.ctxSize >= contextSize。',
      autoFixable: false,
    })
  }

  // INFO：模型摘要
  void DEFAULT_LLAMACPP_CONFIG
  return { issues, paths }
}
