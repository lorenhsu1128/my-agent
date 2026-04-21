/**
 * pathNormalize — cross-platform 路徑 normalize 單元測試
 */
import { describe, expect, test } from 'bun:test'
import { normalizeProjectPath } from '../../../src/discordConfig/pathNormalize'

describe('normalizeProjectPath', () => {
  test('forward slash stays forward slash', () => {
    const r = normalizeProjectPath('/var/log/foo')
    expect(r).toContain('/var/log/foo')
  })

  test('backslash becomes forward slash', () => {
    const r = normalizeProjectPath('C:\\Users\\me\\proj')
    expect(r).not.toContain('\\')
  })

  test('idempotent', () => {
    const once = normalizeProjectPath('C:\\Users\\me\\proj')
    const twice = normalizeProjectPath(once)
    expect(twice).toBe(once)
  })

  test('Windows: two separator styles produce same normalized path', () => {
    if (process.platform !== 'win32') return
    const a = normalizeProjectPath('C:\\Users\\me\\proj')
    const b = normalizeProjectPath('C:/Users/me/proj')
    expect(a).toBe(b)
  })

  test('Windows: drive letter lowercased', () => {
    if (process.platform !== 'win32') return
    const r = normalizeProjectPath('C:\\proj')
    expect(r.startsWith('c:')).toBe(true)
  })

  test('empty string returned as-is', () => {
    expect(normalizeProjectPath('')).toBe('')
  })
})
