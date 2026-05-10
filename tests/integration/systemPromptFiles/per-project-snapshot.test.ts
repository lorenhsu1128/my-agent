/**
 * M-SP-FULL Phase 1：per-cwd snapshot 隔離測試。
 *
 * 驗證：
 *   - 不同 cwd 的 snapshot 各自獨立（A 的 override 不影響 B）
 *   - 同 cwd 重複 load 命中 cache
 *   - 無 cwd 走 DEFAULT_KEY snapshot（向後相容 REPL）
 *   - getSection(id, cwd) 路由到對應 snapshot
 *   - runWithSystemPromptCwd ALS scope 正確設定 cwd
 *   - 並發載入兩個 cwd 不互相污染
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let originalEnv: string | undefined

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `sp-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
  originalEnv = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = testDir
  // 重設 snapshot module-level Map（避免上一個 test 殘留）
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
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/**
 * Helper：在指定 cwd 對應的 per-project system-prompt 目錄寫一個 section 檔。
 * Slug 由 getProjectSlugForCwd 算（findCanonicalGitRoot ?? cwd → sanitizePath）。
 */
async function writeProjectSection(
  cwd: string,
  filename: string,
  content: string,
): Promise<string> {
  const { getSystemPromptProjectDirForCwd } = await import(
    '../../../src/systemPromptFiles/paths'
  )
  const dir = getSystemPromptProjectDirForCwd(cwd)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, filename)
  writeFileSync(path, content, 'utf-8')
  return path
}

describe('M-SP-FULL Phase 1：per-cwd snapshot 隔離', () => {
  test('兩個不同 cwd 的 override 互不影響', async () => {
    const cwdA = join(testDir, 'project-a')
    const cwdB = join(testDir, 'project-b')
    mkdirSync(cwdA, { recursive: true })
    mkdirSync(cwdB, { recursive: true })
    // 製造獨立 git root，避免 findGitRoot 走到 $HOME/.git 等外部 repo
    mkdirSync(join(cwdA, '.git'), { recursive: true })
    mkdirSync(join(cwdB, '.git'), { recursive: true })

    await writeProjectSection(cwdA, 'tone-style.md', '# A 風格\n你是 A 人格')
    await writeProjectSection(cwdB, 'tone-style.md', '# B 風格\n你是 B 人格')

    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot(cwdA)
    await loadSystemPromptSnapshot(cwdB)

    expect(getSection('tone-style', cwdA)).toBe('# A 風格\n你是 A 人格')
    expect(getSection('tone-style', cwdB)).toBe('# B 風格\n你是 B 人格')
  })

  test('同 cwd 重複 load 命中 cache（snapshot 物件 reference 相等）', async () => {
    const cwd = join(testDir, 'cache-test')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })

    const { loadSystemPromptSnapshot } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    const first = await loadSystemPromptSnapshot(cwd)
    const second = await loadSystemPromptSnapshot(cwd)
    expect(second).toBe(first)
  })

  test('無 cwd → DEFAULT_KEY snapshot（不會撞到任何 cwd-keyed snapshot）', async () => {
    const cwd = join(testDir, 'project-x')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })
    await writeProjectSection(cwd, 'tone-style.md', '# X 專屬')

    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    await loadSystemPromptSnapshot(cwd)
    await loadSystemPromptSnapshot() // 載入 DEFAULT_KEY

    // X 的 override 拿到的是專屬內容
    expect(getSection('tone-style', cwd)).toBe('# X 專屬')
    // DEFAULT_KEY 不會看到 cwd=project-x 的 override（除非 process cwd 剛好就是 X）
    const defaultSection = getSection('tone-style')
    expect(defaultSection).not.toBe('# X 專屬')
  })

  test('runWithSystemPromptCwd 在 ALS scope 內正確路由 getSection', async () => {
    const cwd = join(testDir, 'als-test')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })
    await writeProjectSection(cwd, 'tone-style.md', '# ALS 內容')

    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    const { runWithSystemPromptCwd, getCurrentSystemPromptCwd } = await import(
      '../../../src/systemPromptFiles/cwdContext'
    )

    await loadSystemPromptSnapshot(cwd)

    // ALS 外
    expect(getCurrentSystemPromptCwd()).toBeUndefined()

    // ALS 內：cwd 可取，getSection 直接拿（無需顯式傳 cwd）
    const result = runWithSystemPromptCwd(cwd, () => {
      const seen = getCurrentSystemPromptCwd()
      const section = getSection('tone-style', seen)
      return { seen, section }
    })
    expect(result.seen).toBe(cwd)
    expect(result.section).toBe('# ALS 內容')

    // ALS scope 退出後狀態還原
    expect(getCurrentSystemPromptCwd()).toBeUndefined()
  })

  test('並發 loadSystemPromptSnapshot 兩個不同 cwd 不互相污染', async () => {
    const cwdA = join(testDir, 'concurrent-a')
    const cwdB = join(testDir, 'concurrent-b')
    mkdirSync(cwdA, { recursive: true })
    mkdirSync(cwdB, { recursive: true })
    mkdirSync(join(cwdA, '.git'), { recursive: true })
    mkdirSync(join(cwdB, '.git'), { recursive: true })
    // 製造獨立 git root，避免 findGitRoot 走到 $HOME/.git 等外部 repo
    mkdirSync(join(cwdA, '.git'), { recursive: true })
    mkdirSync(join(cwdB, '.git'), { recursive: true })

    await writeProjectSection(cwdA, 'tone-style.md', 'AAA')
    await writeProjectSection(cwdB, 'tone-style.md', 'BBB')

    const { loadSystemPromptSnapshot, getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    // 同時 fire — Promise.all 確保並發載入
    await Promise.all([
      loadSystemPromptSnapshot(cwdA),
      loadSystemPromptSnapshot(cwdB),
    ])

    expect(getSection('tone-style', cwdA)).toBe('AAA')
    expect(getSection('tone-style', cwdB)).toBe('BBB')
  })

  test('同 cwd 並發載入 de-dup（同一 in-flight Promise）', async () => {
    const cwd = join(testDir, 'dedup-test')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })

    const { loadSystemPromptSnapshot } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    const [a, b] = await Promise.all([
      loadSystemPromptSnapshot(cwd),
      loadSystemPromptSnapshot(cwd),
    ])
    expect(a).toBe(b)
  })

  test('getSection 在尚未 load 的 cwd 回 null（fallback 給呼叫端）', async () => {
    const cwd = join(testDir, 'never-loaded')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })

    const { getSection } = await import(
      '../../../src/systemPromptFiles/snapshot'
    )
    expect(getSection('tone-style', cwd)).toBeNull()
  })
})
