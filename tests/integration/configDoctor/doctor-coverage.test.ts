/**
 * Config doctor 全覆蓋整合測試（M-CONFIG-DOCTOR）。
 *
 * 隔離：每個 test 設 CLAUDE_CONFIG_DIR=$tmpdir，所有 path resolver 都走那條。
 * 為了避免 cache 污染，動態 import 每個 doctor 模組。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `doctor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
  savedEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    LLAMA_BASE_URL: process.env.LLAMA_BASE_URL,
    LLAMA_MODEL: process.env.LLAMA_MODEL,
    LLAMACPP_CONFIG_PATH: process.env.LLAMACPP_CONFIG_PATH,
    MYAGENT_WEB_CONFIG_PATH: process.env.MYAGENT_WEB_CONFIG_PATH,
    DISCORD_CONFIG_PATH: process.env.DISCORD_CONFIG_PATH,
  }
  process.env.CLAUDE_CONFIG_DIR = testDir
  delete process.env.LLAMA_BASE_URL
  delete process.env.LLAMA_MODEL
  delete process.env.LLAMACPP_CONFIG_PATH
  delete process.env.MYAGENT_WEB_CONFIG_PATH
  delete process.env.DISCORD_CONFIG_PATH
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('runConfigDoctor — 全綠（all configs seeded）', () => {
  test('全部 seed 後 check 應該無 error', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    const { seedWebConfigIfMissing } = await import(
      '../../../src/webConfig/seed'
    )
    const { seedDiscordConfigIfMissing } = await import(
      '../../../src/discordConfig/seed'
    )
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    const { seedGlobalConfigIfMissingSync } = await import(
      '../../../src/globalConfig/seed'
    )
    await seedLlamaCppConfigIfMissing()
    await seedWebConfigIfMissing()
    await seedDiscordConfigIfMissing()
    await seedSystemPromptDirIfMissing()
    seedGlobalConfigIfMissingSync(join(testDir, '.my-agent.jsonc'))

    const { runConfigDoctor, hasErrors } = await import(
      '../../../src/configDoctor/index'
    )
    const r = await runConfigDoctor({ mode: 'check' })
    // 種完不應該有 error；warning 可能有（template-new-fields 等）
    expect(hasErrors(r)).toBe(false)
  })
})

describe('llamacppCheck', () => {
  test('檔案不存在 → llamacpp.missing ERROR + autoFixable', async () => {
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check', onlyModule: 'llamacpp' })
    const issue = r.issues.find(i => i.code === 'llamacpp.missing')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.autoFixable).toBe(true)
  })

  test('壞 JSON → llamacpp.parse-failed ERROR + autoFixable', async () => {
    writeFileSync(join(testDir, 'llamacpp.jsonc'), '{ bad json }', 'utf-8')
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check', onlyModule: 'llamacpp' })
    const issue = r.issues.find(i => i.code === 'llamacpp.parse-failed')
    expect(issue).toBeDefined()
    expect(issue?.autoFixable).toBe(true)
  })

  test('alias mismatch → llamacpp.alias-mismatch ERROR（不 autofix）', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    await seedLlamaCppConfigIfMissing()
    // 改 model
    const path = join(testDir, 'llamacpp.jsonc')
    let text = readFileSync(path, 'utf-8')
    text = text.replace('"model": "qwen3.5-9b"', '"model": "DIFFERENT-MODEL"')
    writeFileSync(path, text, 'utf-8')

    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check', onlyModule: 'llamacpp' })
    const issue = r.issues.find(i => i.code === 'llamacpp.alias-mismatch')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.autoFixable).toBe(false)
  })

  test('strict JSON → llamacpp.strict-json WARNING + autoFixable', async () => {
    writeFileSync(
      join(testDir, 'llamacpp.jsonc'),
      JSON.stringify({ model: 'qwen3.5-9b' }),
      'utf-8',
    )
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check', onlyModule: 'llamacpp' })
    const issue = r.issues.find(i => i.code === 'llamacpp.strict-json')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
    expect(issue?.autoFixable).toBe(true)
  })

  test('env override → llamacpp.env-override WARNING', async () => {
    const { seedLlamaCppConfigIfMissing } = await import(
      '../../../src/llamacppConfig/seed'
    )
    await seedLlamaCppConfigIfMissing()
    process.env.LLAMA_MODEL = 'env-override-value'
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check', onlyModule: 'llamacpp' })
    const issue = r.issues.find(i => i.code === 'llamacpp.env-override')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
  })
})

describe('webCheck / discordCheck — strict JSON 偵測', () => {
  test('web 壞 JSON → ERROR', async () => {
    writeFileSync(join(testDir, 'web.jsonc'), '}{', 'utf-8')
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check' })
    const issue = r.issues.find(i => i.code === 'web.parse-failed')
    expect(issue).toBeDefined()
  })

  test('discord 壞 JSON → ERROR', async () => {
    writeFileSync(join(testDir, 'discord.jsonc'), '}{', 'utf-8')
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check' })
    const issue = r.issues.find(i => i.code === 'discord.parse-failed')
    expect(issue).toBeDefined()
  })
})

describe('systemPromptCheck', () => {
  test('目錄不存在 → ERROR autofix', async () => {
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check' })
    const issue = r.issues.find(i => i.code === 'systemPrompt.dir-missing')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.autoFixable).toBe(true)
  })

  test('目錄存在但 README 缺 → WARNING autofix', async () => {
    const { seedSystemPromptDirIfMissing } = await import(
      '../../../src/systemPromptFiles/seed'
    )
    await seedSystemPromptDirIfMissing()
    rmSync(join(testDir, 'system-prompt', 'README.md'))

    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const r = await runConfigDoctor({ mode: 'check' })
    const issue = r.issues.find(i => i.code === 'systemPrompt.readme-missing')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
    expect(issue?.autoFixable).toBe(true)
  })
})

describe('--fix 模式', () => {
  test('全部缺檔 → fix 後再 check 應該無 ERROR', async () => {
    const { runConfigDoctor, hasErrors } = await import(
      '../../../src/configDoctor/index'
    )
    // 第一次 check：很多 ERROR
    const before = await runConfigDoctor({ mode: 'check' })
    expect(hasErrors(before)).toBe(true)

    // 跑 fix
    const fix = await runConfigDoctor({ mode: 'fix' })
    expect(fix.fixResult).toBeDefined()
    expect(fix.fixResult!.fixed.length).toBeGreaterThan(0)

    // 第二次 check：ERROR 應該大幅減少（剩 alias-mismatch / binary-not-found 等不可自動修的）
    const after = await runConfigDoctor({ mode: 'check' })
    const seedFixedErrors = [
      'llamacpp.missing',
      'systemPrompt.dir-missing',
      'global.missing',
    ]
    for (const code of seedFixedErrors) {
      expect(after.issues.find(i => i.code === code)).toBeUndefined()
    }
  })

  test('壞 JSON → fix 備份壞檔 + re-seed', async () => {
    writeFileSync(join(testDir, 'llamacpp.jsonc'), '{ bad', 'utf-8')
    const { runConfigDoctor } = await import('../../../src/configDoctor/index')
    const fix = await runConfigDoctor({ mode: 'fix', onlyModule: 'llamacpp' })
    expect(fix.fixResult!.fixed).toContain('llamacpp.parse-failed')
    expect(
      fix.fixResult!.sideEffects.some(s => s.includes('moved corrupt file')),
    ).toBe(true)
    // 新檔應 parseable
    const newText = readFileSync(join(testDir, 'llamacpp.jsonc'), 'utf-8')
    expect(newText).toMatch(/\/\//) // JSONC with comments
  })
})

describe('formatReport', () => {
  test('plain 模式輸出含 ERROR 標記', async () => {
    const { runConfigDoctor, formatReport } = await import(
      '../../../src/configDoctor/index'
    )
    const r = await runConfigDoctor({ mode: 'check' })
    const out = formatReport(r, false)
    expect(out).toContain('Config Doctor 報告')
    expect(out).toContain('llamacpp')
  })

  test('json 模式輸出可 parse 為 JSON', async () => {
    const { runConfigDoctor, formatReport } = await import(
      '../../../src/configDoctor/index'
    )
    const r = await runConfigDoctor({ mode: 'check' })
    const out = formatReport(r, true)
    const parsed = JSON.parse(out)
    expect(Array.isArray(parsed.issues)).toBe(true)
    expect(parsed.modulePaths).toBeDefined()
  })
})
