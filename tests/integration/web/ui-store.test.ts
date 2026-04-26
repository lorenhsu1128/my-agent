/**
 * M-WEB-SLASH-C1：useUiStore 純函式測試。
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { useUiStore } from '../../../web/src/store/uiStore'

beforeEach(() => {
  useUiStore.setState({ rightTab: 'overview' })
})

describe('useUiStore', () => {
  test('預設 rightTab=overview', () => {
    expect(useUiStore.getState().rightTab).toBe('overview')
  })

  test('setRightTab 正確切換', () => {
    useUiStore.getState().setRightTab('cron')
    expect(useUiStore.getState().rightTab).toBe('cron')
    useUiStore.getState().setRightTab('memory')
    expect(useUiStore.getState().rightTab).toBe('memory')
    useUiStore.getState().setRightTab('llamacpp')
    expect(useUiStore.getState().rightTab).toBe('llamacpp')
    useUiStore.getState().setRightTab('discord')
    expect(useUiStore.getState().rightTab).toBe('discord')
  })

  test('4 個 redirect target tab 全部合法', () => {
    const targets = ['cron', 'memory', 'llamacpp', 'discord'] as const
    for (const t of targets) {
      useUiStore.getState().setRightTab(t)
      expect(useUiStore.getState().rightTab).toBe(t)
    }
  })
})
