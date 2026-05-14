/**
 * M-SP-FULL Phase 2：system-prompt-override.md / system-prompt-append.md 載入測試。
 *
 * 驗證：
 *   - per-project override / append 各自獨立載入
 *   - 優先序：per-project > global
 *   - 空字串 / 純註解 → 視為未啟用（undefined，不傳給 runner）
 *   - 同 cwd 重複 load 命中 cache；不同 cwd 隔離；並發 de-dup
 *   - composeFullDefaultPrompt 拼出 29 個 section + 各段註解分隔
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let originalEnv: string | undefined

let originalRemoteMemDir: string | undefined

// 防禦：memoryMutations.test.ts 用 mock.module 永久覆蓋 getMemoryBaseDir 指到
// 它的 tmpMemDir，跨檔污染。我們重新 mock 指到本檔測試的 testDir。
// （宣告在 module top-level，因為 bun mock.module 必須在 beforeEach 之外註冊一次。）
const realPaths = await import('../../../src/memdir/paths.js')
let currentTestDir = ''
mock.module('../../../src/memdir/paths.js', () => ({
  ...realPaths,
  getMemoryBaseDir: () => currentTestDir || realPaths.getMemoryBaseDir(),
}))

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `sp-overrides-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  currentTestDir = testDir
  mkdirSync(testDir, { recursive: true })
  originalEnv = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = testDir
  originalRemoteMemDir = process.env.MY_AGENT_REMOTE_MEMORY_DIR
  delete process.env.MY_AGENT_REMOTE_MEMORY_DIR
  const { _resetProjectPromptOverridesForTests } = await import(
    '../../../src/systemPromptFiles/overrides'
  )
  _resetProjectPromptOverridesForTests()
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

async function freshProjectCwd(name: string): Promise<string> {
  const cwd = join(testDir, name)
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(cwd, '.git'), { recursive: true })
  return cwd
}

async function writeProjectOverride(cwd: string, content: string): Promise<void> {
  const { getOverrideProjectFileForCwd } = await import(
    '../../../src/systemPromptFiles/paths'
  )
  const path = getOverrideProjectFileForCwd(cwd)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

async function writeProjectAppend(cwd: string, content: string): Promise<void> {
  const { getAppendProjectFileForCwd } = await import(
    '../../../src/systemPromptFiles/paths'
  )
  const path = getAppendProjectFileForCwd(cwd)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

async function writeGlobalOverride(content: string): Promise<void> {
  const { getOverrideGlobalFile } = await import(
    '../../../src/systemPromptFiles/paths'
  )
  writeFileSync(getOverrideGlobalFile(), content, 'utf-8')
}

async function writeGlobalAppend(content: string): Promise<void> {
  const { getAppendGlobalFile } = await import(
    '../../../src/systemPromptFiles/paths'
  )
  writeFileSync(getAppendGlobalFile(), content, 'utf-8')
}

describe('M-SP-FULL Phase 2：override / append 載入', () => {
  test('per-project override 取代 default', async () => {
    const cwd = await freshProjectCwd('proj-1')
    await writeProjectOverride(cwd, '你是測試 1 號人格')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).override).toBe('你是測試 1 號人格')
    expect(getProjectPromptOverrides(cwd).append).toBeUndefined()
  })

  test('per-project append 獨立載入', async () => {
    const cwd = await freshProjectCwd('proj-append')
    await writeProjectAppend(cwd, '\n\n[追加] 不要說再見')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).append).toBe('\n\n[追加] 不要說再見')
    expect(getProjectPromptOverrides(cwd).override).toBeUndefined()
  })

  test('per-project override 優先於 global override', async () => {
    const cwd = await freshProjectCwd('proj-priority')
    await writeGlobalOverride('GLOBAL 人格')
    await writeProjectOverride(cwd, 'PROJECT 人格')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).override).toBe('PROJECT 人格')
  })

  test('global override 在 per-project 缺檔時生效', async () => {
    const cwd = await freshProjectCwd('proj-fallback')
    await writeGlobalOverride('GLOBAL 人格')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).override).toBe('GLOBAL 人格')
  })

  test('純空白 → 未啟用（undefined）', async () => {
    const cwd = await freshProjectCwd('proj-empty')
    await writeProjectOverride(cwd, '   \n\n  \t\n')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).override).toBeUndefined()
  })

  test('純 HTML 註解 → 未啟用（undefined）', async () => {
    const cwd = await freshProjectCwd('proj-comments')
    await writeProjectOverride(
      cwd,
      '<!-- 暫時停用 -->\n<!-- 還是停用 -->\n',
    )

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).override).toBeUndefined()
  })

  test('註解 + 內容 → 啟用（整段含註解原樣傳）', async () => {
    const cwd = await freshProjectCwd('proj-mixed')
    await writeProjectOverride(cwd, '<!-- 註解 -->\n你是測試人格')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    expect(getProjectPromptOverrides(cwd).override).toBe(
      '<!-- 註解 -->\n你是測試人格',
    )
  })

  test('兩個不同 cwd 各自獨立 override', async () => {
    const cwdA = await freshProjectCwd('iso-a')
    const cwdB = await freshProjectCwd('iso-b')
    await writeProjectOverride(cwdA, 'AAA 人格')
    await writeProjectOverride(cwdB, 'BBB 人格')

    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await Promise.all([
      loadProjectPromptOverrides(cwdA),
      loadProjectPromptOverrides(cwdB),
    ])
    expect(getProjectPromptOverrides(cwdA).override).toBe('AAA 人格')
    expect(getProjectPromptOverrides(cwdB).override).toBe('BBB 人格')
  })

  test('同 cwd 重複 load 命中 cache（reference equal）', async () => {
    const cwd = await freshProjectCwd('cache-test')
    const { loadProjectPromptOverrides } = await import(
      '../../../src/systemPromptFiles/overrides'
    )
    const first = await loadProjectPromptOverrides(cwd)
    const second = await loadProjectPromptOverrides(cwd)
    expect(second).toBe(first)
  })

  test('同 cwd 並發 load de-dup', async () => {
    const cwd = await freshProjectCwd('dedup-test')
    const { loadProjectPromptOverrides } = await import(
      '../../../src/systemPromptFiles/overrides'
    )
    const [a, b] = await Promise.all([
      loadProjectPromptOverrides(cwd),
      loadProjectPromptOverrides(cwd),
    ])
    expect(a).toBe(b)
  })

  test('沒有任何檔案 → 空物件', async () => {
    const cwd = await freshProjectCwd('proj-bare')
    const { loadProjectPromptOverrides, getProjectPromptOverrides } =
      await import('../../../src/systemPromptFiles/overrides')
    await loadProjectPromptOverrides(cwd)
    const o = getProjectPromptOverrides(cwd)
    expect(o.override).toBeUndefined()
    expect(o.append).toBeUndefined()
  })
})

describe('M-SP-FULL Phase 2：composeFullDefaultPrompt + seed', () => {
  test('composeFullDefaultPrompt 包含 SECTIONS 註冊表內所有 externalized + 非空 section', async () => {
    const { composeFullDefaultPrompt } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const { SECTIONS } = await import(
      '../../../src/systemPromptFiles/sections'
    )
    const { BUNDLED_DEFAULTS } = await import(
      '../../../src/systemPromptFiles/bundledDefaults'
    )

    const prompt = composeFullDefaultPrompt()

    // header 含警告與優先序說明
    expect(prompt).toContain('M-SP-FULL Phase 2')
    expect(prompt).toContain('刪除本檔即回到')
    expect(prompt).toContain('per-project: ~/.virtual-assistant-desktop/projects/')

    // 每個 externalized + 非空 section 都帶分隔註解
    for (const section of SECTIONS) {
      const content = BUNDLED_DEFAULTS[section.id]
      if (!section.externalized || content == null || content === '') continue
      expect(prompt).toContain(`<!-- ===== ${section.id} ===== -->`)
    }
  })

  test('seedSystemPromptDirIfMissing 會 seed system-prompt-override.md 但不 seed append.md', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const { getOverrideGlobalFile, getAppendGlobalFile } = await import(
      '../../../src/systemPromptFiles/paths'
    )

    await seedSystemPromptDirIfMissing()

    const overridePath = getOverrideGlobalFile()
    const appendPath = getAppendGlobalFile()
    expect(existsSync(overridePath)).toBe(true)
    expect(existsSync(appendPath)).toBe(false)
  })

  test('seed 對已存在的 override.md 不覆蓋', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const { getOverrideGlobalFile } = await import(
      '../../../src/systemPromptFiles/paths'
    )

    // 先放使用者編輯版
    mkdirSync(testDir, { recursive: true })
    writeFileSync(getOverrideGlobalFile(), '使用者已改', 'utf-8')

    await seedSystemPromptDirIfMissing()

    const { readFileSync } = await import('fs')
    expect(readFileSync(getOverrideGlobalFile(), 'utf-8')).toBe('使用者已改')
  })
})
