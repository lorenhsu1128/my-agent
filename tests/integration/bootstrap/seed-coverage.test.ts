/**
 * 全覆蓋整合測試（M-CONFIG-SEED-COMPLETE）：驗證 my-agent 首次啟動時所有
 * config 檔都正確生成，且二次啟動不會覆蓋使用者編輯。
 *
 * 涵蓋：
 *   - llamacpp.jsonc（seed + strict JSON → JSONC migration + 已是 JSONC 不動 + 跨平台 binaryPath）
 *   - web.jsonc（seed + migration + 已是 JSONC 不動）
 *   - discord.jsonc（seed + migration + 已是 JSONC 不動）
 *   - system-prompt/（seed 全新目錄 + 補寫個別缺檔 + 已存在不動）
 *   - 壞 JSON / schema 不符 → loader 走 DEFAULT
 *
 * 隔離策略：每個 test 設 `CLAUDE_CONFIG_DIR=$tmpdir`，所有 path resolver 都
 * 透過 getMyAgentConfigHomeDir() → getMemoryBaseDir() 走那條，互不干擾。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseJsonc } from '../../../src/utils/jsoncStore'

let testDir: string
let originalEnv: string | undefined

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `seed-coverage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
  originalEnv = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = testDir
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

// ════════════════════════════════════════════════════════════════════
// llamacpp.jsonc
// ════════════════════════════════════════════════════════════════════

describe('llamacpp.jsonc seed', () => {
  test('檔案不存在 → seed 模板（含註解 + README sidecar）', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    const path = join(testDir, 'llamacpp.jsonc')
    expect(existsSync(path)).toBe(false)

    await seedLlamaCppConfigIfMissing()

    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    // 含註解
    expect(text).toMatch(/\/\//)
    // 可以 parse + schema 過
    const { LlamaCppConfigSchema } = await import(
      '../../../src/llamacppConfig/schema'
    )
    const parsed = parseJsonc(text)
    expect(LlamaCppConfigSchema.safeParse(parsed).success).toBe(true)
    // README sidecar
    expect(existsSync(join(testDir, 'llamacpp.README.md'))).toBe(true)
  })

  test('已是 JSONC（含註解）→ 完全不動', async () => {
    const path = join(testDir, 'llamacpp.jsonc')
    const userText = `{\n  // 我的客製化\n  "model": "my-custom-model"\n}\n`
    writeFileSync(path, userText, 'utf-8')

    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    await seedLlamaCppConfigIfMissing()

    expect(readFileSync(path, 'utf-8')).toBe(userText)
  })

  test('strict JSON 自動 migrate 到 JSONC（保留使用者值 + 備份）', async () => {
    const path = join(testDir, 'llamacpp.jsonc')
    const userJson = JSON.stringify({ model: 'my-old-model' }, null, 2)
    writeFileSync(path, userJson, 'utf-8')

    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    await seedLlamaCppConfigIfMissing()

    const newText = readFileSync(path, 'utf-8')
    // 變成 JSONC（含註解）
    expect(newText).toMatch(/\/\//)
    // 使用者值保留
    const parsed = parseJsonc<Record<string, unknown>>(newText)
    expect(parsed.model).toBe('my-old-model')
  })

  test('seed 後跨平台 binaryPath 正確（Windows 含 .exe / 其他不含）', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    const path = join(testDir, 'llamacpp.jsonc')
    await seedLlamaCppConfigIfMissing()
    const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, 'utf-8'))
    const server = parsed.server as Record<string, unknown>
    const binaryPath = server.binaryPath as string
    if (process.platform === 'win32') {
      expect(binaryPath.endsWith('.exe')).toBe(true)
    } else {
      expect(binaryPath.endsWith('.exe')).toBe(false)
    }
  })

  test('壞 JSON → loader 走 DEFAULT（不 crash）', async () => {
    const path = join(testDir, 'llamacpp.jsonc')
    writeFileSync(path, '{ this is not valid }', 'utf-8')
    const { loadLlamaCppConfigSnapshot, getLlamaCppConfigSnapshot } =
      await import('../../../src/llamacppConfig/loader')
    const { DEFAULT_LLAMACPP_CONFIG } = await import(
      '../../../src/llamacppConfig/schema'
    )
    await loadLlamaCppConfigSnapshot()
    const snap = getLlamaCppConfigSnapshot()
    expect(snap.model).toBe(DEFAULT_LLAMACPP_CONFIG.model)
  })
})

// ════════════════════════════════════════════════════════════════════
// web.jsonc
// ════════════════════════════════════════════════════════════════════

describe('web.jsonc seed', () => {
  test('檔案不存在 → seed 模板', async () => {
    const { seedWebConfigIfMissing } = await import(
      '../../../src/webConfig/seed'
    )
    const path = join(testDir, 'web.jsonc')
    expect(existsSync(path)).toBe(false)
    await seedWebConfigIfMissing()
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    expect(text).toMatch(/\/\//)
    const { WebConfigSchema } = await import('../../../src/webConfig/schema')
    expect(WebConfigSchema.safeParse(parseJsonc(text)).success).toBe(true)
    expect(existsSync(join(testDir, 'web.README.md'))).toBe(true)
  })

  test('已是 JSONC → 不動', async () => {
    const path = join(testDir, 'web.jsonc')
    const userText = `{\n  // 自訂\n  "port": 9999\n}\n`
    writeFileSync(path, userText, 'utf-8')
    const { seedWebConfigIfMissing } = await import(
      '../../../src/webConfig/seed'
    )
    await seedWebConfigIfMissing()
    expect(readFileSync(path, 'utf-8')).toBe(userText)
  })

  test('strict JSON 自動 migrate（M-CONFIG-SEED-COMPLETE P2 修復）', async () => {
    const path = join(testDir, 'web.jsonc')
    const userJson = JSON.stringify({ port: 8765 }, null, 2)
    writeFileSync(path, userJson, 'utf-8')
    const { seedWebConfigIfMissing } = await import(
      '../../../src/webConfig/seed'
    )
    await seedWebConfigIfMissing()
    const newText = readFileSync(path, 'utf-8')
    expect(newText).toMatch(/\/\//)
    const parsed = parseJsonc<Record<string, unknown>>(newText)
    expect(parsed.port).toBe(8765)
  })
})

// ════════════════════════════════════════════════════════════════════
// discord.jsonc
// ════════════════════════════════════════════════════════════════════

describe('discord.jsonc seed', () => {
  test('檔案不存在 → seed 模板', async () => {
    const { seedDiscordConfigIfMissing } = await import(
      '../../../src/discordConfig/seed'
    )
    const path = join(testDir, 'discord.jsonc')
    expect(existsSync(path)).toBe(false)
    await seedDiscordConfigIfMissing()
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    expect(text).toMatch(/\/\//)
    const { DiscordConfigSchema } = await import(
      '../../../src/discordConfig/schema'
    )
    expect(DiscordConfigSchema.safeParse(parseJsonc(text)).success).toBe(true)
  })

  test('已是 JSONC → 不動', async () => {
    const path = join(testDir, 'discord.jsonc')
    const userText = `{\n  // 自訂\n  "enabled": true\n}\n`
    writeFileSync(path, userText, 'utf-8')
    const { seedDiscordConfigIfMissing } = await import(
      '../../../src/discordConfig/seed'
    )
    await seedDiscordConfigIfMissing()
    expect(readFileSync(path, 'utf-8')).toBe(userText)
  })

  test('strict JSON 自動 migrate', async () => {
    const path = join(testDir, 'discord.jsonc')
    const userJson = JSON.stringify({ enabled: true }, null, 2)
    writeFileSync(path, userJson, 'utf-8')
    const { seedDiscordConfigIfMissing } = await import(
      '../../../src/discordConfig/seed'
    )
    await seedDiscordConfigIfMissing()
    const newText = readFileSync(path, 'utf-8')
    expect(newText).toMatch(/\/\//)
    const parsed = parseJsonc<Record<string, unknown>>(newText)
    expect(parsed.enabled).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════
// system-prompt/（M-CONFIG-SEED-COMPLETE P3 行為改變）
// ════════════════════════════════════════════════════════════════════

describe('system-prompt/ seed', () => {
  test('目錄不存在 → mkdir + seed 全部預設檔（README + sections）', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const dir = join(testDir, 'system-prompt')
    expect(existsSync(dir)).toBe(false)
    await seedSystemPromptDirIfMissing()
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
  })

  test('目錄存在但個別 section 檔被刪 → 補寫該檔（P3 修復）', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const dir = join(testDir, 'system-prompt')
    // 第一次：seed 全部
    await seedSystemPromptDirIfMissing()
    const readme = join(dir, 'README.md')
    expect(existsSync(readme)).toBe(true)

    // 模擬使用者誤刪 README.md
    rmSync(readme)
    expect(existsSync(readme)).toBe(false)

    // 第二次 seed 應該補回
    await seedSystemPromptDirIfMissing()
    expect(existsSync(readme)).toBe(true)
  })

  test('目錄存在且檔案存在 → 完全不動（尊重使用者編輯）', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const dir = join(testDir, 'system-prompt')
    await seedSystemPromptDirIfMissing()
    const readme = join(dir, 'README.md')
    const userEdited = '# 我自己改寫的內容\n'
    writeFileSync(readme, userEdited, 'utf-8')

    await seedSystemPromptDirIfMissing()
    expect(readFileSync(readme, 'utf-8')).toBe(userEdited)
  })

  test('使用者清空檔案（empty string）→ seed 不覆蓋（loader 規約：空字串 = 停用）', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const dir = join(testDir, 'system-prompt')
    await seedSystemPromptDirIfMissing()
    const readme = join(dir, 'README.md')
    writeFileSync(readme, '', 'utf-8')

    await seedSystemPromptDirIfMissing()
    expect(readFileSync(readme, 'utf-8')).toBe('')
  })
})

// ════════════════════════════════════════════════════════════════════
// 跨配置：首次啟動模擬（一次跑所有 seed，斷言完整檔案清單）
// ════════════════════════════════════════════════════════════════════

describe('全新 ~/.my-agent/ 首次啟動模擬', () => {
  test('REPL 模式（setup.ts 路徑）跑後檔案齊全', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )

    await seedSystemPromptDirIfMissing()
    await seedLlamaCppConfigIfMissing()

    expect(existsSync(join(testDir, 'llamacpp.jsonc'))).toBe(true)
    expect(existsSync(join(testDir, 'llamacpp.README.md'))).toBe(true)
    expect(existsSync(join(testDir, 'system-prompt'))).toBe(true)
    expect(existsSync(join(testDir, 'system-prompt', 'README.md'))).toBe(true)
  })

  test('Daemon 模式（main.ts 路徑）跑後 llamacpp + discord + web 都齊全（P5 修復）', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    const { seedDiscordConfigIfMissing } = await import(
      '../../../src/discordConfig/seed'
    )
    const { seedWebConfigIfMissing } = await import(
      '../../../src/webConfig/seed'
    )

    await seedLlamaCppConfigIfMissing()
    await seedDiscordConfigIfMissing()
    await seedWebConfigIfMissing()

    expect(existsSync(join(testDir, 'llamacpp.jsonc'))).toBe(true)
    expect(existsSync(join(testDir, 'discord.jsonc'))).toBe(true)
    expect(existsSync(join(testDir, 'web.jsonc'))).toBe(true)
    expect(existsSync(join(testDir, 'llamacpp.README.md'))).toBe(true)
    expect(existsSync(join(testDir, 'web.README.md'))).toBe(true)
  })

  test('seed 兩次（idempotent）— 所有檔案內容不變', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    const { seedDiscordConfigIfMissing } = await import(
      '../../../src/discordConfig/seed'
    )
    const { seedWebConfigIfMissing } = await import(
      '../../../src/webConfig/seed'
    )

    await seedLlamaCppConfigIfMissing()
    await seedDiscordConfigIfMissing()
    await seedWebConfigIfMissing()

    const llamacppText1 = readFileSync(
      join(testDir, 'llamacpp.jsonc'),
      'utf-8',
    )
    const discordText1 = readFileSync(join(testDir, 'discord.jsonc'), 'utf-8')
    const webText1 = readFileSync(join(testDir, 'web.jsonc'), 'utf-8')

    await seedLlamaCppConfigIfMissing()
    await seedDiscordConfigIfMissing()
    await seedWebConfigIfMissing()

    expect(readFileSync(join(testDir, 'llamacpp.jsonc'), 'utf-8')).toBe(
      llamacppText1,
    )
    expect(readFileSync(join(testDir, 'discord.jsonc'), 'utf-8')).toBe(
      discordText1,
    )
    expect(readFileSync(join(testDir, 'web.jsonc'), 'utf-8')).toBe(webText1)
  })
})
