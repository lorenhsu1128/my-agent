/**
 * M-WEB-SLASH-D1：useCommandDispatcherStore 純函式測試。
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { useCommandDispatcherStore } from '../../../web/src/store/commandDispatcherStore'
import type { WebSlashCommandMetadata } from '../../../web/src/api/client'

const META: WebSlashCommandMetadata = {
  name: 'config',
  userFacingName: 'config',
  description: 'configure',
  type: 'local-jsx',
  webKind: 'jsx-handoff',
  handoffKey: 'config',
}

beforeEach(() => {
  useCommandDispatcherStore.setState({ current: null })
})

describe('useCommandDispatcherStore', () => {
  test('預設 current=null', () => {
    expect(useCommandDispatcherStore.getState().current).toBeNull()
  })

  test('open 寫入 metadata + args + receivedAt', () => {
    useCommandDispatcherStore.getState().open(META, 'verbose')
    const c = useCommandDispatcherStore.getState().current
    expect(c).not.toBeNull()
    expect(c!.metadata).toEqual(META)
    expect(c!.args).toBe('verbose')
    expect(c!.receivedAt).toBeGreaterThan(0)
  })

  test('close 清空 current', () => {
    useCommandDispatcherStore.getState().open(META, '')
    useCommandDispatcherStore.getState().close()
    expect(useCommandDispatcherStore.getState().current).toBeNull()
  })

  test('連續 open 覆蓋上一次', () => {
    useCommandDispatcherStore.getState().open(META, 'a')
    useCommandDispatcherStore
      .getState()
      .open({ ...META, name: 'plan' }, 'b')
    expect(useCommandDispatcherStore.getState().current!.metadata.name).toBe(
      'plan',
    )
    expect(useCommandDispatcherStore.getState().current!.args).toBe('b')
  })
})
