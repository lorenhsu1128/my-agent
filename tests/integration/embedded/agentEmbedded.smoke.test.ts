/**
 * AgentEmbedded smoke test — 驗證 Phase 1 library entry 基本契約：
 * - create() 可順利 bootstrap（skipMcp）
 * - createSession 回傳 EventEmitter 並 emit 'hello' frame
 * - registerTool / unregisterTool 不 throw
 * - shutdown 正常釋放（不掛在 process）
 *
 * 不在 Phase 1 範圍內：實際 LLM 推論、Frame schema 完整斷言（Phase 2 補 sessionAdapter 完整測試）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { AgentEmbedded } from '../../../src/embedded/index.js'
import type { Frame } from '../../../src/embedded/types.js'

let testDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `agent-embedded-smoke-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('AgentEmbedded — Phase 1 smoke', () => {
  test('create() returns instance with bootstrap + ready phase', async () => {
    const phases: string[] = []
    const agent = await AgentEmbedded.create({
      cwd: testDir,
      configDir: testDir,
      skipMcp: true,
      onPreloadProgress: p => phases.push(p.phase),
    })

    expect(agent).toBeDefined()
    expect(phases).toContain('configDir')
    expect(phases).toContain('bootstrapContext')
    expect(phases).toContain('ready')

    await agent.shutdown()
  })

  test('createSession() emits hello frame asynchronously', async () => {
    const agent = await AgentEmbedded.create({
      cwd: testDir,
      configDir: testDir,
      skipMcp: true,
    })
    const session = agent.createSession({ source: 'mascot' })

    const frame = await new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hello frame')), 1000)
      session.once('frame', (f: Frame) => {
        clearTimeout(timer)
        resolve(f)
      })
    })

    expect(frame.type).toBe('hello')
    if (frame.type === 'hello') {
      expect(typeof frame.sessionId).toBe('string')
      expect(frame.state).toBe('IDLE')
    }

    await session.close()
    await agent.shutdown()
  })

  test('registerTool / unregisterTool tracks extra tools', async () => {
    const agent = await AgentEmbedded.create({
      cwd: testDir,
      configDir: testDir,
      skipMcp: true,
    })

    expect(agent.getExtraTools()).toHaveLength(0)

    // 用最小 stub 假裝是 Tool（runtime 不會被執行，僅檢查 name 比對）
    const stubTool = { name: 'mascot__test_tool' } as unknown as Parameters<
      typeof agent.registerTool
    >[0]
    agent.registerTool(stubTool)
    expect(agent.getExtraTools()).toHaveLength(1)
    expect(agent.getExtraTools()[0].name).toBe('mascot__test_tool')

    // 重複 register 同名 tool 不會重複加入
    agent.registerTool(stubTool)
    expect(agent.getExtraTools()).toHaveLength(1)

    agent.unregisterTool('mascot__test_tool')
    expect(agent.getExtraTools()).toHaveLength(0)

    await agent.shutdown()
  })

  test('shutdown is idempotent + prevents new sessions', async () => {
    const agent = await AgentEmbedded.create({
      cwd: testDir,
      configDir: testDir,
      skipMcp: true,
    })

    await agent.shutdown()
    await agent.shutdown() // 第二次 noop，不應 throw

    expect(() => agent.createSession()).toThrow(/shut down/)
  })

  test('configDir 注入 CLAUDE_CONFIG_DIR env var', async () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    const agent = await AgentEmbedded.create({
      cwd: testDir,
      configDir: testDir,
      skipMcp: true,
    })
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(testDir)
    await agent.shutdown()
  })
})
