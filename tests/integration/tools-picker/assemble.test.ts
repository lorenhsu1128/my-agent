/**
 * M-TOOLS-PICKER — assembleToolPool 的 disabledTools pass-through 驗證。
 * 這是 useMergedTools hook 走的路徑；確保 filter 有正確往下傳到 getTools。
 */
import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../src/Tool'
import { assembleToolPool } from '../../../src/tools'

const permCtx = {
  ...getEmptyToolPermissionContext(),
  mode: 'default' as const,
}

describe('assembleToolPool + disabledTools', () => {
  test('no opts → has WebBrowser', () => {
    const pool = assembleToolPool(permCtx, [])
    expect(pool.some(t => t.name === 'WebBrowser')).toBe(true)
  })

  test('disabledTools removes the named tool from the built-in pool', () => {
    const pool = assembleToolPool(permCtx, [], {
      disabledTools: new Set(['WebBrowser', 'WebCrawl']),
    })
    expect(pool.some(t => t.name === 'WebBrowser')).toBe(false)
    expect(pool.some(t => t.name === 'WebCrawl')).toBe(false)
  })

  test('core tool listed in disabledTools is preserved', () => {
    const pool = assembleToolPool(permCtx, [], {
      disabledTools: new Set(['Read', 'Bash']),
    })
    expect(pool.some(t => t.name === 'Read')).toBe(true)
    expect(pool.some(t => t.name === 'Bash')).toBe(true)
  })

  test('MCP tools (passed in separately) are NOT affected by disabledTools', () => {
    // disabledTools 只過濾 built-in tools；MCP 有自己的管理
    const fakeMcpTool = {
      name: 'mcp__some_server__some_tool',
      description: 'fake mcp tool for test',
      inputSchema: { type: 'object' as const },
      inputJSONSchema: { type: 'object' as const },
      outputSchema: undefined,
      toAutoClassifierInput: () => '',
      mapToolResultToToolResultBlockParam: () => ({
        tool_use_id: '',
        type: 'tool_result' as const,
        content: '',
      }),
      isEnabled: () => true,
      isReadOnly: () => true,
      isReplSafe: () => false,
      isConcurrencySafe: () => true,
      needsPermissions: () => false,
      userFacingName: () => 'mcp-fake',
      renderToolUseMessage: () => '',
      async *call() {},
      async prompt() {
        return ''
      },
    }
    const pool = assembleToolPool(permCtx, [fakeMcpTool as never], {
      // 把 MCP tool 名稱也放進 disabled 嘗試 — 應該仍在 pool 裡（MCP 不受 filter 影響）
      disabledTools: new Set(['mcp__some_server__some_tool']),
    })
    expect(pool.some(t => t.name === 'mcp__some_server__some_tool')).toBe(true)
  })
})
