/**
 * M-DISCORD-3c：getDiscordBotToken env > config.botToken fallback 測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetDiscordConfigForTests,
  getDiscordBotToken,
  loadDiscordConfigSnapshot,
} from '../../../src/discordConfig/index'

const ENV_KEY = 'DISCORD_BOT_TOKEN'
const CONFIG_PATH_KEY = 'DISCORD_CONFIG_PATH'

let tmpDir: string
let origEnv: string | undefined
let origCfgPath: string | undefined

beforeEach(() => {
  origEnv = process.env[ENV_KEY]
  origCfgPath = process.env[CONFIG_PATH_KEY]
  delete process.env[ENV_KEY]
  tmpDir = mkdtempSync(join(tmpdir(), 'disc-tok-'))
  _resetDiscordConfigForTests()
})
afterEach(() => {
  if (origEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = origEnv
  if (origCfgPath === undefined) delete process.env[CONFIG_PATH_KEY]
  else process.env[CONFIG_PATH_KEY] = origCfgPath
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  _resetDiscordConfigForTests()
})

function writeCfg(content: unknown): void {
  const path = join(tmpDir, 'discord.json')
  writeFileSync(path, JSON.stringify(content))
  process.env[CONFIG_PATH_KEY] = path
}

describe('getDiscordBotToken', () => {
  test('env var only → returns env value', async () => {
    writeCfg({ enabled: false })
    await loadDiscordConfigSnapshot()
    process.env[ENV_KEY] = 'env-token-xxx'
    expect(getDiscordBotToken()).toBe('env-token-xxx')
  })

  test('config.botToken only → returns config value', async () => {
    writeCfg({ enabled: false, botToken: 'cfg-token-yyy' })
    await loadDiscordConfigSnapshot()
    expect(getDiscordBotToken()).toBe('cfg-token-yyy')
  })

  test('env wins over config.botToken', async () => {
    writeCfg({ enabled: false, botToken: 'cfg-token-lose' })
    await loadDiscordConfigSnapshot()
    process.env[ENV_KEY] = 'env-token-win'
    expect(getDiscordBotToken()).toBe('env-token-win')
  })

  test('neither → undefined', async () => {
    writeCfg({ enabled: false })
    await loadDiscordConfigSnapshot()
    expect(getDiscordBotToken()).toBeUndefined()
  })

  test('empty strings treated as unset', async () => {
    writeCfg({ enabled: false, botToken: '   ' })
    await loadDiscordConfigSnapshot()
    process.env[ENV_KEY] = '   '
    expect(getDiscordBotToken()).toBeUndefined()
  })

  test('whitespace trimmed', async () => {
    writeCfg({ enabled: false, botToken: '  token-with-ws  ' })
    await loadDiscordConfigSnapshot()
    expect(getDiscordBotToken()).toBe('token-with-ws')
  })
})
