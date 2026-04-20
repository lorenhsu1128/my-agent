/**
 * M-DISCORD-1.2：Project singleton → multi-map。驗證同 process 內兩個 cwd
 * 拿到不同 Project instance，各自 currentSessionTitle / sessionFile 不串。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _getProjectForCwdForTesting,
  _getProjectKeysForTesting,
  resetProjectForTesting,
  setSessionFileForTesting,
} from '../../../src/utils/sessionStorage'
import {
  getOriginalCwd,
  setOriginalCwd,
} from '../../../src/bootstrap/state'

let baseCwd = ''

beforeEach(() => {
  baseCwd = getOriginalCwd()
  resetProjectForTesting()
})
afterEach(() => {
  setOriginalCwd(baseCwd)
  resetProjectForTesting()
})

describe('Project multi-map', () => {
  test('different cwd → different Project instance', () => {
    const pA = _getProjectForCwdForTesting('/tmp/proj-A')
    const pB = _getProjectForCwdForTesting('/tmp/proj-B')
    expect(pA).not.toBe(pB)
    expect(_getProjectKeysForTesting()).toContain('/tmp/proj-A')
    expect(_getProjectKeysForTesting()).toContain('/tmp/proj-B')
  })

  test('same cwd → same Project instance', () => {
    const p1 = _getProjectForCwdForTesting('/tmp/proj-C')
    const p2 = _getProjectForCwdForTesting('/tmp/proj-C')
    expect(p1).toBe(p2)
  })

  test('currentSessionTitle isolated per project', () => {
    const pA = _getProjectForCwdForTesting('/tmp/proj-D')
    const pB = _getProjectForCwdForTesting('/tmp/proj-E')
    pA.currentSessionTitle = 'title-A'
    pB.currentSessionTitle = 'title-B'
    expect(pA.currentSessionTitle).toBe('title-A')
    expect(pB.currentSessionTitle).toBe('title-B')
  })

  test('sessionFile per project via setSessionFileForTesting + originalCwd swap', () => {
    setOriginalCwd('/tmp/proj-F')
    setSessionFileForTesting('/tmp/proj-F/session.jsonl')
    setOriginalCwd('/tmp/proj-G')
    setSessionFileForTesting('/tmp/proj-G/session.jsonl')

    const pF = _getProjectForCwdForTesting('/tmp/proj-F')
    const pG = _getProjectForCwdForTesting('/tmp/proj-G')
    expect(pF.sessionFile).toBe('/tmp/proj-F/session.jsonl')
    expect(pG.sessionFile).toBe('/tmp/proj-G/session.jsonl')
  })

  test('resetProjectForTesting clears the map', () => {
    _getProjectForCwdForTesting('/tmp/proj-H')
    _getProjectForCwdForTesting('/tmp/proj-I')
    expect(_getProjectKeysForTesting().length).toBeGreaterThanOrEqual(2)
    resetProjectForTesting()
    expect(_getProjectKeysForTesting()).toEqual([])
  })

  test('default getProject() (no arg) uses getOriginalCwd()', () => {
    setOriginalCwd('/tmp/proj-J')
    setSessionFileForTesting('/tmp/proj-J/s.jsonl') // goes via getProject()
    const keys = _getProjectKeysForTesting()
    expect(keys).toContain('/tmp/proj-J')
  })
})
