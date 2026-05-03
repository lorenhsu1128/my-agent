// M-DISCORD-TUI：discordManagerLogic 純函式單元測試（無 Ink harness）。

import { describe, expect, test } from 'bun:test'
import {
  buildBindings,
  findProjectByKey,
  isValidSnowflake,
  truncate,
} from '../../../src/commands/discord/discordManagerLogic.js'
import { DEFAULT_DISCORD_CONFIG } from '../../../src/discordConfig/schema.js'
import { normalizeProjectPath } from '../../../src/discordConfig/pathNormalize.js'

function cfg(over: Partial<typeof DEFAULT_DISCORD_CONFIG>) {
  return { ...DEFAULT_DISCORD_CONFIG, ...over }
}

describe('isValidSnowflake', () => {
  test('17–20 位純數字 → true', () => {
    expect(isValidSnowflake('123456789012345678')).toBe(true)
    expect(isValidSnowflake('12345')).toBe(true)
  })
  test('非數字 / 太短 / 太長 → false', () => {
    expect(isValidSnowflake('abc')).toBe(false)
    expect(isValidSnowflake('1234')).toBe(false)
    expect(isValidSnowflake('1'.repeat(26))).toBe(false)
    expect(isValidSnowflake('123-456')).toBe(false)
    expect(isValidSnowflake('')).toBe(false)
  })
})

describe('truncate', () => {
  test('短字串原樣回', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })
  test('超長加 …', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…')
  })
})

describe('findProjectByKey', () => {
  const projects = [
    { id: 'my-agent', path: '/p/my-agent', aliases: ['ma'] },
    { id: 'OtherProj', path: '/p/other', aliases: [] },
  ]
  test('依 id 找（case-insensitive）', () => {
    expect(findProjectByKey(projects, 'MY-AGENT')?.id).toBe('my-agent')
    expect(findProjectByKey(projects, 'otherproj')?.id).toBe('OtherProj')
  })
  test('依 alias 找', () => {
    expect(findProjectByKey(projects, 'ma')?.id).toBe('my-agent')
    expect(findProjectByKey(projects, 'MA')?.id).toBe('my-agent')
  })
  test('找不到回 null', () => {
    expect(findProjectByKey(projects, 'nope')).toBeNull()
  })
})

describe('buildBindings', () => {
  test('空 bindings 回空陣列', () => {
    const rows = buildBindings(cfg({}), '/p/my-agent')
    expect(rows).toEqual([])
  })

  test('cwd 對應的 binding 排第一', () => {
    const cwdNorm = normalizeProjectPath('/p/my-agent')
    const otherNorm = normalizeProjectPath('/p/other')
    const c = cfg({
      projects: [
        { id: 'a', name: 'A', path: cwdNorm, aliases: [] },
        { id: 'b', name: 'B', path: otherNorm, aliases: [] },
      ],
      channelBindings: {
        '111': otherNorm,
        '222': cwdNorm,
      },
    })
    const rows = buildBindings(c, cwdNorm)
    expect(rows[0]?.channelId).toBe('222')
    expect(rows[0]?.isCwd).toBe(true)
    expect(rows[1]?.channelId).toBe('111')
    expect(rows[1]?.isCwd).toBe(false)
  })

  test('orphan binding（projectPath 不在 projects[]）標記正確且排在最後', () => {
    const cwdNorm = normalizeProjectPath('/p/cwd')
    const otherNorm = normalizeProjectPath('/p/known')
    const orphanNorm = normalizeProjectPath('/p/ghost')
    const c = cfg({
      projects: [
        { id: 'cwd', name: 'cwd', path: cwdNorm, aliases: [] },
        { id: 'known', name: 'known', path: otherNorm, aliases: [] },
      ],
      channelBindings: {
        '111': orphanNorm,
        '222': otherNorm,
        '333': cwdNorm,
      },
    })
    const rows = buildBindings(c, cwdNorm)
    expect(rows[0]?.channelId).toBe('333') // cwd 排第一
    expect(rows[0]?.isCwd).toBe(true)
    expect(rows[0]?.orphan).toBe(false)
    expect(rows[1]?.channelId).toBe('222') // 有 project 排第二
    expect(rows[1]?.orphan).toBe(false)
    expect(rows[2]?.channelId).toBe('111') // orphan 排最後
    expect(rows[2]?.orphan).toBe(true)
    expect(rows[2]?.projectId).toBeNull()
  })

  test('projectId / projectName 從 projects[] 對應寫入', () => {
    const projNorm = normalizeProjectPath('/p/x')
    const c = cfg({
      projects: [{ id: 'xId', name: 'X Display', path: projNorm, aliases: [] }],
      channelBindings: { '999': projNorm },
    })
    const rows = buildBindings(c, '/elsewhere')
    expect(rows[0]?.projectId).toBe('xId')
    expect(rows[0]?.projectName).toBe('X Display')
    expect(rows[0]?.isCwd).toBe(false)
  })

  test('cwd 未 normalize 也能對上（buildBindings 內部 normalize）', () => {
    const projNorm = normalizeProjectPath('/p/case')
    const c = cfg({
      projects: [{ id: 'c', name: 'c', path: projNorm, aliases: [] }],
      channelBindings: { '888': projNorm },
    })
    // 故意給未 normalize 的 cwd（含尾斜線 / 反斜線視平台）
    const rows = buildBindings(c, '/p/case/')
    expect(rows[0]?.isCwd).toBe(true)
  })
})
