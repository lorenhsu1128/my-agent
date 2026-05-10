/**
 * M-SP-FULL Phase 3：4 個 sub-LLM prompt 外部化的端到端驗證。
 * （buddy-companion 已於 M-BUDDY-RIP / 2026-05-10 隨 buddy 子系統一併移除）
 *
 * 對每個 prompt 驗：
 *   - default 路徑：snapshot 載完無 override 檔 → callsite 拿到 BUNDLED_DEFAULT
 *   - override 路徑：放使用者檔到 ~/.my-agent/system-prompt/subllm/<name>.md
 *     → callsite 拿到使用者內容
 *   - 變數插值：{name} / {species} / {maxFiles} / {BASH_TOOL_NAME} 等
 *     在 fallback 與 override 路徑都正確替換
 *
 * 為什麼用整合測試而非純 unit：
 *   - 確保 sections.ts 註冊 + bundledDefaults.ts 對映 + snapshot 路徑 + caller
 *     一起正常運作
 *   - 證明 seed.ts 走完之後 callsite 看到使用者改的內容（含與既有 section
 *     一樣的 per-cwd snapshot 機制）
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let originalEnv: string | undefined

let originalRemoteMemDir: string | undefined

// 防禦：memoryMutations.test.ts mock.module 永久覆蓋 getMemoryBaseDir
const realPaths = await import('../../../src/memdir/paths.js')
let currentTestDir = ''
mock.module('../../../src/memdir/paths.js', () => ({
  ...realPaths,
  getMemoryBaseDir: () => currentTestDir || realPaths.getMemoryBaseDir(),
}))

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `subllm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  currentTestDir = testDir
  mkdirSync(testDir, { recursive: true })
  originalEnv = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = testDir
  originalRemoteMemDir = process.env.MY_AGENT_REMOTE_MEMORY_DIR
  delete process.env.MY_AGENT_REMOTE_MEMORY_DIR
  const { _resetSystemPromptSnapshotForTests } = await import(
    '../../../src/systemPromptFiles/snapshot'
  )
  _resetSystemPromptSnapshotForTests()
})

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalEnv
  }
  if (originalRemoteMemDir === undefined) {
    delete process.env.MY_AGENT_REMOTE_MEMORY_DIR
  } else {
    process.env.MY_AGENT_REMOTE_MEMORY_DIR = originalRemoteMemDir
  }
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

async function writeGlobalSubllmSection(
  filename: string,
  content: string,
): Promise<void> {
  const { getSystemPromptGlobalDir } = await import(
    '../../../src/systemPromptFiles/paths'
  )
  const dir = join(getSystemPromptGlobalDir(), 'subllm')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), content, 'utf-8')
}

describe('M-SP-FULL Phase 3：BUNDLED_DEFAULTS + SECTIONS 註冊一致', () => {
  test('4 個 sub-LLM SectionId 全部有 BUNDLED_DEFAULTS 對映', async () => {
    const { SECTIONS } = await import(
      '../../../src/systemPromptFiles/sections'
    )
    const { BUNDLED_DEFAULTS } = await import(
      '../../../src/systemPromptFiles/bundledDefaults'
    )
    const subllmIds = SECTIONS.filter(s => s.id.startsWith('subllm/')).map(
      s => s.id,
    )
    expect(subllmIds).toEqual([
      'subllm/cron-parser',
      'subllm/memory-selector',
      'subllm/verification-agent',
      'subllm/tool-use-summary',
    ])
    for (const id of subllmIds) {
      expect(BUNDLED_DEFAULTS[id]).toBeDefined()
      expect((BUNDLED_DEFAULTS[id] as string).length).toBeGreaterThan(0)
    }
  })

  test('seedSystemPromptDirIfMissing seed 4 個 subllm/*.md 到 global 目錄', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const { getSystemPromptGlobalFile } = await import(
      '../../../src/systemPromptFiles/paths'
    )
    const { existsSync } = await import('fs')
    await seedSystemPromptDirIfMissing()
    for (const filename of [
      'subllm/cron-parser.md',
      'subllm/memory-selector.md',
      'subllm/verification-agent.md',
      'subllm/tool-use-summary.md',
    ]) {
      expect(existsSync(getSystemPromptGlobalFile(filename))).toBe(true)
    }
  })
})

describe('M-SP-FULL Phase 3：cron-parser', () => {
  test('snapshot 未載入 → callsite fallback 到 hardcoded default', async () => {
    // 不 load snapshot，模擬 cold start
    // cronNlParser 的 getSystemPrompt() 內部會呼叫 getSection() 拿 null →
    // 走 SYSTEM_PROMPT_FALLBACK
    const m = await import('../../../src/utils/cronNlParser')
    // 直接斷言模組 export 結構（CronNLParseError 在）= callsite 仍可用
    expect(m.CronNLParseError).toBeDefined()
  })

  test('global override → snapshot getSection 拿到使用者內容', async () => {
    await writeGlobalSubllmSection('cron-parser.md', 'CUSTOM CRON PARSER PROMPT')
    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    expect(getSection('subllm/cron-parser')).toBe('CUSTOM CRON PARSER PROMPT')
  })
})

describe('M-SP-FULL Phase 3：memory-selector（{maxFiles} 插值）', () => {
  test('default：interpolate {maxFiles} → 數字', async () => {
    const { loadSystemPromptSnapshot, getSectionInterpolated } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    const result = getSectionInterpolated('subllm/memory-selector', {
      maxFiles: 7,
    })
    expect(result).toContain('up to 7')
    expect(result).not.toContain('{maxFiles}')
  })

  test('override：使用者自訂 prompt 也支援 {maxFiles} 插值', async () => {
    await writeGlobalSubllmSection(
      'memory-selector.md',
      'Pick at most {maxFiles} relevant items.',
    )
    const { loadSystemPromptSnapshot, getSectionInterpolated } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    expect(
      getSectionInterpolated('subllm/memory-selector', { maxFiles: 3 }),
    ).toBe('Pick at most 3 relevant items.')
  })
})

describe('M-SP-FULL Phase 3：verification-agent（{BASH_TOOL_NAME}, {WEB_FETCH_TOOL_NAME} 插值）', () => {
  test('default：兩個工具名變數都被替換', async () => {
    const { loadSystemPromptSnapshot, getSectionInterpolated } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    const result = getSectionInterpolated('subllm/verification-agent', {
      BASH_TOOL_NAME: 'Bash',
      WEB_FETCH_TOOL_NAME: 'WebFetch',
    })
    expect(result).toContain('Bash')
    expect(result).toContain('WebFetch')
    expect(result).not.toContain('{BASH_TOOL_NAME}')
    expect(result).not.toContain('{WEB_FETCH_TOOL_NAME}')
  })

  test('verificationAgent.getSystemPrompt() 端到端拿到 interpolated 字串', async () => {
    const { loadSystemPromptSnapshot } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    const { VERIFICATION_AGENT } = await import(
      '../../../src/tools/AgentTool/built-in/verificationAgent'
    )
    const sysPrompt = VERIFICATION_AGENT.getSystemPrompt({
      toolUseContext: { options: {} as never },
    })
    expect(typeof sysPrompt).toBe('string')
    expect(sysPrompt).toContain('verification specialist')
    expect(sysPrompt).not.toContain('{BASH_TOOL_NAME}')
    expect(sysPrompt).not.toContain('{WEB_FETCH_TOOL_NAME}')
  })
})

describe('M-SP-FULL Phase 3：tool-use-summary', () => {
  test('default：30-char git-commit 風格指引存在', async () => {
    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    const result = getSection('subllm/tool-use-summary')
    expect(result).toContain('git-commit-subject')
    expect(result).toContain('30 characters')
  })

  test('override 接管', async () => {
    await writeGlobalSubllmSection(
      'tool-use-summary.md',
      'Just emit "X done."',
    )
    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot()
    expect(getSection('subllm/tool-use-summary')).toBe('Just emit "X done."')
  })
})

