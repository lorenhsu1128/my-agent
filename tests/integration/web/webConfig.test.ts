/**
 * M-WEB-2：webConfig schema / loader / seed / updateField 單元測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetWebConfigForTests,
  DEFAULT_WEB_CONFIG,
  getWebConfigPath,
  getWebConfigSnapshot,
  isWebEnabled,
  loadWebConfigSnapshot,
  seedWebConfigIfMissing,
  updateWebConfigField,
  WebConfigSchema,
} from '../../../src/webConfig/index.js'

const PATH_KEY = 'MYAGENT_WEB_CONFIG_PATH'

let tmpDir: string
let origPath: string | undefined

beforeEach(() => {
  origPath = process.env[PATH_KEY]
  tmpDir = mkdtempSync(join(tmpdir(), 'web-cfg-'))
  process.env[PATH_KEY] = join(tmpDir, 'web.jsonc')
  _resetWebConfigForTests()
})

afterEach(() => {
  if (origPath === undefined) delete process.env[PATH_KEY]
  else process.env[PATH_KEY] = origPath
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  _resetWebConfigForTests()
})

function writeCfg(content: unknown): string {
  const p = process.env[PATH_KEY]!
  writeFileSync(p, JSON.stringify(content))
  return p
}

describe('WebConfigSchema', () => {
  test('empty object → all defaults', () => {
    const r = WebConfigSchema.parse({})
    expect(r).toEqual(DEFAULT_WEB_CONFIG)
  })

  test('partial overrides', () => {
    const r = WebConfigSchema.parse({ enabled: true, port: 8080 })
    expect(r.enabled).toBe(true)
    expect(r.port).toBe(8080)
    expect(r.bindHost).toBe('0.0.0.0')
    expect(r.autoStart).toBe(true)
  })

  test('rejects out-of-range port', () => {
    expect(() => WebConfigSchema.parse({ port: 0 })).toThrow()
    expect(() => WebConfigSchema.parse({ port: 70_000 })).toThrow()
  })

  test('rejects bad heartbeat', () => {
    expect(() => WebConfigSchema.parse({ heartbeatIntervalMs: 50 })).toThrow()
  })

  test('corsOrigins defaults []', () => {
    const r = WebConfigSchema.parse({})
    expect(r.corsOrigins).toEqual([])
  })
})

describe('loader', () => {
  test('missing file → DEFAULT_WEB_CONFIG (enabled=false)', async () => {
    const cfg = await loadWebConfigSnapshot()
    expect(cfg).toEqual(DEFAULT_WEB_CONFIG)
    expect(isWebEnabled()).toBe(false)
  })

  test('valid file → parsed', async () => {
    writeCfg({ enabled: true, port: 9091, bindHost: '127.0.0.1' })
    const cfg = await loadWebConfigSnapshot()
    expect(cfg.enabled).toBe(true)
    expect(cfg.port).toBe(9091)
    expect(cfg.bindHost).toBe('127.0.0.1')
    expect(isWebEnabled()).toBe(true)
  })

  test('invalid JSON → DEFAULT', async () => {
    writeFileSync(process.env[PATH_KEY]!, 'not json {{{')
    const cfg = await loadWebConfigSnapshot()
    expect(cfg).toEqual(DEFAULT_WEB_CONFIG)
  })

  test('schema fail → DEFAULT', async () => {
    writeCfg({ enabled: true, port: -1 })
    const cfg = await loadWebConfigSnapshot()
    expect(cfg).toEqual(DEFAULT_WEB_CONFIG)
  })

  test('JSONC with comments parses', async () => {
    const p = process.env[PATH_KEY]!
    writeFileSync(
      p,
      `{
        // this is enabled
        "enabled": true,
        "port": 9095,
      }`,
    )
    const cfg = await loadWebConfigSnapshot()
    expect(cfg.enabled).toBe(true)
    expect(cfg.port).toBe(9095)
  })

  test('cached after first load', async () => {
    writeCfg({ enabled: true })
    await loadWebConfigSnapshot()
    // 改檔；getWebConfigSnapshot 不會重讀（沒 mtime cache invalidation）
    writeCfg({ enabled: false })
    expect(getWebConfigSnapshot().enabled).toBe(true)
  })

  test('getWebConfigSnapshot before load reads sync', () => {
    writeCfg({ enabled: true, port: 9099 })
    // 不呼叫 load → 同步路徑 fallback
    const cfg = getWebConfigSnapshot()
    expect(cfg.enabled).toBe(true)
    expect(cfg.port).toBe(9099)
  })
})

describe('seed', () => {
  test('missing file → writes template + README', async () => {
    const cfgPath = process.env[PATH_KEY]!
    expect(existsSync(cfgPath)).toBe(false)
    await seedWebConfigIfMissing()
    expect(existsSync(cfgPath)).toBe(true)
    const readmePath = join(tmpDir, 'web.README.md')
    expect(existsSync(readmePath)).toBe(true)
    const text = readFileSync(cfgPath, 'utf-8')
    expect(text).toContain('"enabled": false')
    expect(text).toContain('// ====')
  })

  test('existing file → not overwritten', async () => {
    writeCfg({ enabled: true, port: 9999 })
    const before = readFileSync(process.env[PATH_KEY]!, 'utf-8')
    await seedWebConfigIfMissing()
    const after = readFileSync(process.env[PATH_KEY]!, 'utf-8')
    expect(after).toBe(before)
  })

  test('seeded file is parseable', async () => {
    await seedWebConfigIfMissing()
    _resetWebConfigForTests()
    const cfg = await loadWebConfigSnapshot()
    expect(cfg.enabled).toBe(false)
    expect(cfg.port).toBe(9090)
  })
})

describe('updateWebConfigField', () => {
  test('writes value + mutates cached snapshot', async () => {
    writeCfg({ enabled: false, port: 9090 })
    const cfg = await loadWebConfigSnapshot()
    expect(cfg.enabled).toBe(false)
    await updateWebConfigField('enabled', true)
    // cached snapshot reference 已 mutate
    expect(getWebConfigSnapshot().enabled).toBe(true)
    // 重 reset + reload 應仍讀到 true
    _resetWebConfigForTests()
    const cfg2 = await loadWebConfigSnapshot()
    expect(cfg2.enabled).toBe(true)
  })

  test('rejects invalid value', async () => {
    writeCfg({})
    await loadWebConfigSnapshot()
    await expect(updateWebConfigField('port', 0 as never)).rejects.toThrow(
      /web\.jsonc 更新失敗/,
    )
  })

  test('updates port + bindHost in sequence', async () => {
    writeCfg({})
    await loadWebConfigSnapshot()
    await updateWebConfigField('port', 9091)
    await updateWebConfigField('bindHost', '127.0.0.1')
    const final = getWebConfigSnapshot()
    expect(final.port).toBe(9091)
    expect(final.bindHost).toBe('127.0.0.1')
  })
})

describe('paths', () => {
  test('env override respected', () => {
    process.env[PATH_KEY] = '/custom/path/web.jsonc'
    expect(getWebConfigPath()).toBe('/custom/path/web.jsonc')
  })
})
