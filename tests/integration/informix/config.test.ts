/**
 * informixConfig 模組單元測試
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  InformixConfigSchema,
  InformixConnectionSchema,
  DEFAULT_INFORMIX_CONFIG,
  _resetInformixConfigForTests,
} from '../../../src/informixConfig/index.js'

describe('InformixConfigSchema', () => {
  test('空物件解析為預設值', () => {
    const config = InformixConfigSchema.parse({})
    expect(config.defaultConnection).toBe('default')
    expect(config.queryTimeout).toBe(30)
    expect(config.maxRows).toBe(1000)
    expect(config.connections).toBeDefined()
  })

  test('完整設定解析成功', () => {
    const config = InformixConfigSchema.parse({
      connections: {
        default: {
          dsn: 'MY_DSN',
          host: '192.168.1.100',
          port: 9088,
          database: 'mydb',
          server: 'ifx_server',
          username: 'readonly',
          protocol: 'onsoctcp',
        },
        warehouse: {
          dsn: 'WH_DSN',
          database: 'warehouse',
        },
      },
      defaultConnection: 'default',
      queryTimeout: 60,
      maxRows: 500,
    })

    expect(config.connections.default?.dsn).toBe('MY_DSN')
    expect(config.connections.default?.host).toBe('192.168.1.100')
    expect(config.connections.default?.port).toBe(9088)
    expect(config.connections.warehouse?.database).toBe('warehouse')
    expect(config.queryTimeout).toBe(60)
    expect(config.maxRows).toBe(500)
  })

  test('部分設定 + 預設值填充', () => {
    const config = InformixConfigSchema.parse({
      connections: {
        prod: { dsn: 'PROD_DSN' },
      },
      defaultConnection: 'prod',
    })

    expect(config.defaultConnection).toBe('prod')
    expect(config.queryTimeout).toBe(30) // 預設
    expect(config.maxRows).toBe(1000) // 預設
  })

  test('非法 queryTimeout 拒絕', () => {
    const result = InformixConfigSchema.safeParse({
      queryTimeout: -1,
    })
    expect(result.success).toBe(false)
  })

  test('非法 maxRows 拒絕', () => {
    const result = InformixConfigSchema.safeParse({
      maxRows: 0,
    })
    expect(result.success).toBe(false)
  })
})

describe('InformixConnectionSchema', () => {
  test('空物件有效', () => {
    const conn = InformixConnectionSchema.parse({})
    expect(conn).toBeDefined()
  })

  test('只有 DSN 有效', () => {
    const conn = InformixConnectionSchema.parse({ dsn: 'TEST_DSN' })
    expect(conn.dsn).toBe('TEST_DSN')
  })

  test('完整連線參數', () => {
    const conn = InformixConnectionSchema.parse({
      dsn: 'MY_DSN',
      host: '10.0.0.1',
      port: 9088,
      database: 'testdb',
      server: 'ifx01',
      username: 'admin',
      protocol: 'onsoctcp',
    })
    expect(conn.port).toBe(9088)
    expect(conn.protocol).toBe('onsoctcp')
  })
})

describe('DEFAULT_INFORMIX_CONFIG', () => {
  test('有效且完整', () => {
    expect(DEFAULT_INFORMIX_CONFIG.defaultConnection).toBe('default')
    expect(DEFAULT_INFORMIX_CONFIG.queryTimeout).toBe(30)
    expect(DEFAULT_INFORMIX_CONFIG.maxRows).toBe(1000)
  })
})
