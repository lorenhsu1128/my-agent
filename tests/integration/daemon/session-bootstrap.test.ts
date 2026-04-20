/**
 * M-DAEMON-4a：sessionBootstrap 單元/整合測試。
 *
 * 驗證 bootstrap 出來的 context 滿足 `ask()` 需要的最小契約：
 * - commands 非空（至少有 headless-safe 的 slash/local commands）
 * - buildTools() 回 non-empty、包含核心 tools
 * - getAppState/setAppState 可讀寫
 * - readFileCache 可 get/set
 */
import { describe, expect, test } from 'bun:test'
import { bootstrapDaemonContext } from '../../../src/daemon/sessionBootstrap'
import {
  createFileStateCacheWithSizeLimit,
  FileStateCache,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../../src/utils/fileStateCache'

describe('bootstrapDaemonContext', () => {
  test('returns a context with core fields', async () => {
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    expect(ctx.cwd).toBe(process.cwd())
    expect(ctx.commands).toBeInstanceOf(Array)
    // Agent 先空陣列。
    expect(ctx.agents).toEqual([])
    // mcpClients 因 skipMcp 應該是空。
    expect(ctx.mcpClients).toEqual([])
    await ctx.dispose()
  })

  test('buildTools returns a non-empty tool list including core tools', async () => {
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    const tools = ctx.buildTools()
    expect(tools.length).toBeGreaterThan(0)
    const names = tools.map(t => t.name)
    // 這些是 always-on 的核心 tools（無論 permission mode）。
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    await ctx.dispose()
  })

  test('setAppState mutations are visible to subsequent buildTools', async () => {
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    const before = ctx.buildTools().length
    // 插入一個假 MCP tool，確認 buildTools 會看見。
    ctx.setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [
          ...prev.mcp.tools,
          {
            name: 'mcp__fake__echo',
            description: async () => 'fake',
            inputSchema: { type: 'object' },
            inputJSONSchema: { type: 'object' },
            isReadOnly: () => true,
            isEnabled: async () => true,
            userFacingName: () => 'fake echo',
            prompt: async () => '',
            mcpInfo: {
              toolName: 'echo',
              serverName: 'fake',
              serverTitle: 'fake',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ],
      },
    }))
    const after = ctx.buildTools().length
    expect(after).toBeGreaterThanOrEqual(before + 1)
    await ctx.dispose()
  })

  test('readFileCache getter/setter roundtrip', async () => {
    const ctx = await bootstrapDaemonContext({
      cwd: process.cwd(),
      skipMcp: true,
    })
    const cache1 = ctx.getReadFileCache()
    expect(cache1).toBeInstanceOf(FileStateCache)
    const cache2 = createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    )
    ctx.setReadFileCache(cache2)
    expect(ctx.getReadFileCache()).toBe(cache2)
    await ctx.dispose()
  })
})
