/**
 * M-WEB-SLASH-A3：filterCommandsForAutocomplete 純函式測試。
 * 不啟動 zustand store —— 直接測排序邏輯。
 */
import { describe, expect, test } from 'bun:test'
import { filterCommandsForAutocomplete } from '../../../web/src/store/slashCommandStore'
import type { WebSlashCommandMetadata } from '../../../web/src/api/client'

function mk(
  name: string,
  over: Partial<WebSlashCommandMetadata> = {},
): WebSlashCommandMetadata {
  return {
    name,
    userFacingName: name,
    description: `desc of ${name}`,
    type: 'local',
    webKind: 'runnable',
    ...over,
  }
}

const ALL: WebSlashCommandMetadata[] = [
  mk('cron'),
  mk('config'),
  mk('cost'),
  mk('clear', { aliases: ['c'] }),
  mk('help', { aliases: ['h', '?'], description: 'show command help' }),
  mk('memory-debug', { isHidden: true }),
  mk('compact'),
]

describe('filterCommandsForAutocomplete', () => {
  test('空 query 回所有 visible（過濾 isHidden）', () => {
    const result = filterCommandsForAutocomplete(ALL, '')
    expect(result.map(c => c.name)).not.toContain('memory-debug')
    expect(result.length).toBe(ALL.length - 1)
  })

  test('includeHidden=true 也含隱藏命令', () => {
    const result = filterCommandsForAutocomplete(ALL, '', {
      includeHidden: true,
    })
    expect(result.map(c => c.name)).toContain('memory-debug')
  })

  test('prefix "co" 命中 config / cost / compact 並按字典序', () => {
    const result = filterCommandsForAutocomplete(ALL, 'co')
    expect(result.map(c => c.name)).toEqual(['compact', 'config', 'cost'])
  })

  test('exact name match 排第一（"cron" 前置於 prefix-match）', () => {
    const result = filterCommandsForAutocomplete(ALL, 'cron')
    expect(result[0].name).toBe('cron')
  })

  test('alias exact match 排在 prefix match 前面', () => {
    const result = filterCommandsForAutocomplete(ALL, 'h')
    // 'h' 是 help 的 alias exact match (rank 0)；help startsWith 'h' (rank 1)
    expect(result[0].name).toBe('help')
  })

  test('description 不參與比對（避免雜訊）', () => {
    // help.description = 'show command help' — 不應被 'show' 命中
    const result = filterCommandsForAutocomplete(ALL, 'show')
    expect(result).toEqual([])
  })

  test('開頭斜線會被忽略', () => {
    const result = filterCommandsForAutocomplete(ALL, '/co')
    expect(result.map(c => c.name)).toEqual(['compact', 'config', 'cost'])
  })

  test('完全不命中回空陣列', () => {
    const result = filterCommandsForAutocomplete(ALL, 'xyznoexist')
    expect(result).toEqual([])
  })
})
