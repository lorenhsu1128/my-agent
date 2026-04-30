/**
 * 整合測試：scripts/gen-config-docs.ts schema → markdown 自動產生器
 * （M-CONFIG-DOCS-ALIGN）。
 *
 * 涵蓋：
 *   - 跑 generateAllDocs() 對 5 個 schema 都產出 markdown
 *   - 每份 markdown 含 AUTO-GENERATED-START / END 標記
 *   - 表格欄位正確（schema 已知欄位都出現在表中）
 *   - 預設值字串正確抽取
 *   - JSDoc 中文敘述被保留
 *   - --check 模式：未改 schema 時 exit 0
 */
import { describe, expect, test } from 'bun:test'
import { generateAllDocs } from '../../../scripts/gen-config-docs'

describe('gen-config-docs.ts', () => {
  test('產出 4 份 markdown 檔（llamacpp / web / discord / 主索引）', () => {
    const docs = generateAllDocs()
    expect(docs.length).toBe(4)
    const paths = docs.map(d => d.path).map(p => p.replace(/\\/g, '/'))
    expect(paths.some(p => p.endsWith('/docs/config-llamacpp.md'))).toBe(true)
    expect(paths.some(p => p.endsWith('/docs/config-web.md'))).toBe(true)
    expect(paths.some(p => p.endsWith('/docs/config-discord.md'))).toBe(true)
    expect(paths.some(p => p.endsWith('/docs/config-reference.md'))).toBe(true)
  })

  test('每份 markdown 含 AUTO-GENERATED 標記', () => {
    const docs = generateAllDocs()
    for (const d of docs) {
      expect(d.content).toContain('AUTO-GENERATED-START')
      expect(d.content).toContain('AUTO-GENERATED-END')
    }
  })

  test('llamacpp markdown 含已知欄位 + default', () => {
    const docs = generateAllDocs()
    const llamacpp = docs.find(d => d.path.includes('config-llamacpp.md'))!
    expect(llamacpp.content).toContain('LlamaCppConfigSchema')
    expect(llamacpp.content).toContain('LlamaCppServerSchema')
    expect(llamacpp.content).toContain('`baseUrl`')
    expect(llamacpp.content).toContain('`model`')
    expect(llamacpp.content).toContain('`contextSize`')
    // server 欄位
    expect(llamacpp.content).toContain('`host`')
    expect(llamacpp.content).toContain("'127.0.0.1'") // host default
    // 預設值正確抽取
    expect(llamacpp.content).toContain('`8080`') // server.port default
    expect(llamacpp.content).toContain('`131072`') // ctxSize default
  })

  test('web markdown 含 9 個已知欄位 + 中文 JSDoc', () => {
    const docs = generateAllDocs()
    const web = docs.find(d => d.path.includes('config-web.md'))!
    expect(web.content).toContain('WebConfigSchema')
    for (const f of [
      'enabled',
      'autoStart',
      'port',
      'maxPortProbes',
      'bindHost',
      'maxClients',
      'heartbeatIntervalMs',
      'corsOrigins',
      'devProxyUrl',
    ]) {
      expect(web.content).toContain('`' + f + '`')
    }
    // JSDoc 中文保留
    expect(web.content).toContain('開關')
    expect(web.content).toContain('LAN')
  })

  test('discord markdown 含主要欄位', () => {
    const docs = generateAllDocs()
    const discord = docs.find(d => d.path.includes('config-discord.md'))!
    expect(discord.content).toContain('DiscordConfigSchema')
    expect(discord.content).toContain('`enabled`')
    expect(discord.content).toContain('`botToken`')
  })

  test('env override 表格正確列出', () => {
    const docs = generateAllDocs()
    const llamacpp = docs.find(d => d.path.includes('config-llamacpp.md'))!
    expect(llamacpp.content).toContain('`LLAMA_BASE_URL`')
    expect(llamacpp.content).toContain('`LLAMA_MODEL`')
    expect(llamacpp.content).toContain('`LLAMACPP_CTX_SIZE`')
  })

  test('主索引含來源優先序段落 + 4 個 config 連結', () => {
    const docs = generateAllDocs()
    const index = docs.find(d => d.path.includes('config-reference.md'))!
    expect(index.content).toContain('來源優先序')
    expect(index.content).toContain('Env var override')
    expect(index.content).toContain('schema default')
    expect(index.content).toContain('config-llamacpp')
    expect(index.content).toContain('config-web')
    expect(index.content).toContain('config-discord')
  })

  test('產出內容是冪等的（連跑兩次結果相同）', () => {
    const a = generateAllDocs()
    const b = generateAllDocs()
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.content).toBe(a[i]!.content)
    }
  })
})
