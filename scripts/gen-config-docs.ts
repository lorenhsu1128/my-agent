#!/usr/bin/env bun
/**
 * Schema → markdown 自動產生器（M-CONFIG-DOCS-ALIGN）。
 *
 * 用法：
 *   bun run scripts/gen-config-docs.ts          ← 寫入 docs/config-*.md
 *   bun run scripts/gen-config-docs.ts --check  ← 只比對，不寫（CI 用）
 *
 * 對每個 zod schema 檔：
 *   1. 用 TypeScript Compiler API 解析 AST
 *   2. 找 `export const XxxSchema = z.object({...})`
 *   3. 對每個 property 抽：key / JSDoc / zod type / default
 *   4. 輸出 markdown 表格到 docs/config-<module>.md（AUTO-GENERATED 區段）
 *
 * Env override 對照表手寫在本檔（schema 不認識 env，只能在這邊聲明）。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'

interface FieldInfo {
  name: string
  zodType: string
  defaultValue: string | null
  optional: boolean
  jsdoc: string
}

interface SchemaInfo {
  schemaName: string
  fields: FieldInfo[]
}

interface ConfigSpec {
  module: string
  title: string
  schemaFile: string
  schemaNames: string[] // 主 schema + 巢狀 sub-schema 順序
  envOverrides: Record<string, string> // env var → field path
  outputDoc: string
  intro: string // 手寫前言，會接在 AUTO-GENERATED 之上
}

const REPO_ROOT = process.cwd()

const CONFIGS: ConfigSpec[] = [
  {
    module: 'llamacpp',
    title: 'llamacpp.jsonc 欄位參考',
    schemaFile: 'src/llamacppConfig/schema.ts',
    schemaNames: [
      'LlamaCppServerVisionSchema',
      'LlamaCppServerSchema',
      'LlamaCppWatchdogInterChunkSchema',
      'LlamaCppWatchdogReasoningSchema',
      'LlamaCppWatchdogTokenCapSchema',
      'LlamaCppWatchdogSchema',
      'LlamaCppRemoteSchema',
      'LlamaCppRoutingSchema',
      'LlamaCppVisionSchema',
      'LlamaCppConfigSchema',
    ],
    envOverrides: {
      LLAMA_BASE_URL: 'baseUrl',
      LLAMA_MODEL: 'model',
      LLAMACPP_CTX_SIZE: 'contextSize',
      LLAMACPP_COMPACT_BUFFER: 'autoCompactBufferTokens',
      LLAMA_DEBUG: 'debug',
      LLAMACPP_CONFIG_PATH: '(整個檔案路徑)',
      LLAMACPP_WATCHDOG_ENABLE: 'watchdog.enabled (force on)',
      LLAMACPP_WATCHDOG_DISABLE: 'watchdog.enabled (force off, 優先)',
      LLAMA_HOST: 'server.host (shell 端)',
      LLAMA_PORT: 'server.port (shell 端)',
      LLAMA_CTX: 'server.ctxSize (shell 端)',
      LLAMA_NGL: 'server.gpuLayers (shell 端)',
      LLAMA_ALIAS: 'server.alias (shell 端)',
      LLAMA_MODEL_PATH: 'server.modelPath (shell 端)',
      LLAMA_BINARY: 'server.binaryPath (shell 端)',
    },
    outputDoc: 'docs/config-llamacpp.md',
    intro: `本檔是 my-agent TS 端與 \`scripts/llama/serve.sh\` shell 端**共用**的 llama.cpp 設定來源。

**來源優先序**（自上而下）：env var override → \`~/.my-agent/llamacpp.jsonc\` → schema default。
`,
  },
  {
    module: 'web',
    title: 'web.jsonc 欄位參考',
    schemaFile: 'src/webConfig/schema.ts',
    schemaNames: ['WebConfigSchema'],
    envOverrides: {
      MYAGENT_WEB_CONFIG_PATH: '(整個檔案路徑)',
    },
    outputDoc: 'docs/config-web.md',
    intro: `M-WEB Web UI 嵌入 daemon 的設定。

**來源優先序**：env var override → \`~/.my-agent/web.jsonc\` → schema default。
`,
  },
  {
    module: 'discord',
    title: 'discord.jsonc 欄位參考',
    schemaFile: 'src/discordConfig/schema.ts',
    schemaNames: ['DiscordProjectSchema', 'DiscordConfigSchema'],
    envOverrides: {
      DISCORD_BOT_TOKEN: 'botToken（建議用此 env，不要寫進 jsonc）',
      DISCORD_CONFIG_PATH: '(整個檔案路徑)',
    },
    outputDoc: 'docs/config-discord.md',
    intro: `M-DISCORD：Discord bot 嵌入 daemon 的設定。

**來源優先序**：env var override → \`~/.my-agent/discord.jsonc\` → schema default。
`,
  },
]

// ════════════════════════════════════════════════════════════════════
// AST parsing
// ════════════════════════════════════════════════════════════════════

function getJSDocText(node: ts.Node, source: ts.SourceFile): string {
  const fullText = source.getFullText()
  const start = node.getFullStart()
  const end = node.getStart(source)
  const leading = fullText.slice(start, end)
  // 取最後一個 /** ... */ 區塊
  const match = leading.match(/\/\*\*([\s\S]*?)\*\/[^\/]*$/)
  if (!match) return ''
  return match[1]!
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, '').trim())
    .filter(l => l.length > 0)
    .join(' ')
}

function describeZodType(node: ts.Node, source: ts.SourceFile): {
  zodType: string
  defaultValue: string | null
  optional: boolean
} {
  // 走 expression chain，例：z.string().min(1).default('x')
  const text = node.getText(source)
  // 抽 default value
  let defaultValue: string | null = null
  const defaultMatch = text.match(/\.default\(([\s\S]*)\)\s*$/m)
  if (defaultMatch) {
    let raw = defaultMatch[1]!.trim()
    // 移除括號平衡到第一層（避免抓太多）
    let depth = 0
    let end = -1
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) {
          end = i
          break
        }
        depth--
      }
    }
    if (end > 0) raw = raw.slice(0, end)
    defaultValue = raw.trim().replace(/\s+/g, ' ')
    if (defaultValue.length > 80) defaultValue = defaultValue.slice(0, 77) + '...'
  }

  // 抽主 zod type — 找第一個 z.XXX(...)（容錯多行縮排）
  let zodType = '?'
  const typeMatch = text.match(/z\s*\.\s*([a-zA-Z]+)\s*\(/)
  if (typeMatch) zodType = typeMatch[1]!
  // 含 .array / .object 嵌套
  if (zodType === 'array') {
    const inner = text.match(/z\s*\.\s*array\s*\(\s*z\s*\.\s*([a-zA-Z]+)\s*\(/)
    if (inner) zodType = `array<${inner[1]}>`
  }
  // 引用其他 schema：xxxSchema.default(...)
  if (zodType === '?' && /^[A-Za-z][\w]*Schema\b/.test(text)) {
    const m = text.match(/^([A-Za-z][\w]*Schema)/)
    if (m) zodType = m[1]!
  }

  const optional = /\.optional\(\)/.test(text)
  return { zodType, defaultValue, optional }
}

function parseSchemaFile(absPath: string): SchemaInfo[] {
  const text = readFileSync(absPath, 'utf-8')
  const source = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const results: SchemaInfo[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (
          !ts.isIdentifier(decl.name) ||
          !decl.name.text.endsWith('Schema')
        ) {
          continue
        }
        if (
          !decl.initializer ||
          !ts.isCallExpression(decl.initializer)
        ) {
          continue
        }
        // z.object({...}) 形式
        const call = decl.initializer
        if (
          !ts.isPropertyAccessExpression(call.expression) ||
          call.expression.name.text !== 'object'
        ) {
          continue
        }
        const arg = call.arguments[0]
        if (!arg || !ts.isObjectLiteralExpression(arg)) continue

        const fields: FieldInfo[] = []
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue
          if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) {
            continue
          }
          const name = ts.isIdentifier(prop.name)
            ? prop.name.text
            : prop.name.text
          const jsdoc = getJSDocText(prop, source)
          const { zodType, defaultValue, optional } = describeZodType(
            prop.initializer,
            source,
          )
          fields.push({ name, zodType, defaultValue, optional, jsdoc })
        }
        results.push({ schemaName: decl.name.text, fields })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return results
}

// ════════════════════════════════════════════════════════════════════
// Markdown rendering
// ════════════════════════════════════════════════════════════════════

function escapeMd(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
}

function fmtDefault(d: string | null, optional: boolean): string {
  if (d == null) {
    return optional ? '_(undefined)_' : '_(無)_'
  }
  return '`' + escapeMd(d) + '`'
}

function renderSchema(info: SchemaInfo, envOverrides: Record<string, string>): string {
  const lines: string[] = []
  lines.push(`### \`${info.schemaName}\``)
  lines.push('')
  if (info.fields.length === 0) {
    lines.push('_(此 schema 為空 / 不是 z.object)_')
    lines.push('')
    return lines.join('\n')
  }
  lines.push('| 欄位 | 型別 | Default | Env override | 說明 |')
  lines.push('|---|---|---|---|---|')
  for (const f of info.fields) {
    const env = Object.entries(envOverrides)
      .filter(([, fld]) => fld === f.name || fld.startsWith(f.name + '.'))
      .map(([e]) => '`' + e + '`')
      .join('<br>')
    const opt = f.optional ? ' _(optional)_' : ''
    lines.push(
      `| \`${f.name}\` | \`${f.zodType}\`${opt} | ${fmtDefault(
        f.defaultValue,
        f.optional,
      )} | ${env || '—'} | ${escapeMd(f.jsdoc) || '_(無)_'} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

const AUTO_GEN_START = '<!-- AUTO-GENERATED-START — 跑 `bun run docs:gen` 重新產生 -->'
const AUTO_GEN_END = '<!-- AUTO-GENERATED-END -->'

function renderConfigDoc(spec: ConfigSpec, schemas: SchemaInfo[]): string {
  const lines: string[] = []
  lines.push(`# ${spec.title}`)
  lines.push('')
  lines.push('> 本檔由 `bun run docs:gen` 從 zod schema 自動產生表格部分。')
  lines.push('> 表格區段以外的敘述請手寫在 AUTO-GENERATED 段落之外。')
  lines.push('')
  lines.push('## 概覽')
  lines.push('')
  lines.push(spec.intro)
  lines.push('')
  // Env table
  if (Object.keys(spec.envOverrides).length > 0) {
    lines.push('## Env 變數一覽')
    lines.push('')
    lines.push('| Env | 覆蓋欄位 |')
    lines.push('|---|---|')
    for (const [env, field] of Object.entries(spec.envOverrides)) {
      lines.push(`| \`${env}\` | ${escapeMd(field)} |`)
    }
    lines.push('')
  }

  lines.push('## Schema 欄位')
  lines.push('')
  lines.push(AUTO_GEN_START)
  lines.push('')
  for (const s of schemas) {
    lines.push(renderSchema(s, spec.envOverrides))
  }
  lines.push(AUTO_GEN_END)
  lines.push('')
  return lines.join('\n')
}

function renderIndex(): string {
  const lines: string[] = []
  lines.push('# Config 設定檔總索引')
  lines.push('')
  lines.push('> 本檔由 `bun run docs:gen` 自動產生連結表格。')
  lines.push('')
  lines.push('## 來源優先序（所有 my-agent config 一致）')
  lines.push('')
  lines.push('1. **Env var override**（最高）— 對應 env 存在且非空字串時')
  lines.push('2. **`~/.my-agent/<config>.jsonc`** 檔案值')
  lines.push('3. **Schema default**（最低）')
  lines.push('')
  lines.push('讀檔 / parse / schema validation 任一失敗 → fallback 到 schema default 並 stderr warn 一次。')
  lines.push('')
  lines.push(AUTO_GEN_START)
  lines.push('')
  lines.push('## Config 一覽')
  lines.push('')
  lines.push('| Config | 路徑 | 詳細欄位 |')
  lines.push('|---|---|---|')
  for (const c of CONFIGS) {
    lines.push(
      `| ${c.module} | \`~/.my-agent/${c.module}.jsonc\` | [${c.outputDoc}](${
        c.outputDoc.replace(/^docs\//, '')
      }) |`,
    )
  }
  lines.push(
    '| global | `~/.my-agent/.my-agent.jsonc` | _(無 zod schema，請見 `src/utils/config.ts:184` GlobalConfig type)_ |',
  )
  lines.push(
    '| system-prompt | `~/.my-agent/system-prompt/` | _(純 markdown 文本，無 schema；外部化 sections 在 `src/systemPromptFiles/sections.ts`)_ |',
  )
  lines.push('')
  lines.push(AUTO_GEN_END)
  lines.push('')
  return lines.join('\n')
}

// ════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════

interface GenResult {
  path: string
  content: string
}

export function generateAllDocs(): GenResult[] {
  const results: GenResult[] = []
  for (const spec of CONFIGS) {
    const allSchemas = parseSchemaFile(join(REPO_ROOT, spec.schemaFile))
    // 依使用者指定順序排列，未列出者放最後
    const ordered: SchemaInfo[] = []
    for (const name of spec.schemaNames) {
      const found = allSchemas.find(s => s.schemaName === name)
      if (found) ordered.push(found)
    }
    for (const s of allSchemas) {
      if (!ordered.includes(s)) ordered.push(s)
    }
    const md = renderConfigDoc(spec, ordered)
    results.push({ path: join(REPO_ROOT, spec.outputDoc), content: md })
  }
  results.push({
    path: join(REPO_ROOT, 'docs/config-reference.md'),
    content: renderIndex(),
  })
  return results
}

if (import.meta.main) {
  const checkMode = process.argv.includes('--check')
  const docs = generateAllDocs()

  let drift = 0
  for (const d of docs) {
    if (checkMode) {
      const existing = existsSync(d.path) ? readFileSync(d.path, 'utf-8') : ''
      // 標準化換行
      if (existing.replace(/\r\n/g, '\n') !== d.content.replace(/\r\n/g, '\n')) {
        console.error(`[docs:gen] DRIFT — ${d.path}`)
        drift++
      }
    } else {
      writeFileSync(d.path, d.content, 'utf-8')
      console.log(`[docs:gen] wrote ${d.path}`)
    }
  }
  if (checkMode) {
    if (drift > 0) {
      console.error(
        `\n[docs:gen] ${drift} 份文件與 schema 不一致。跑 \`bun run docs:gen\` 更新後 commit。`,
      )
      process.exit(1)
    }
    console.log('[docs:gen] 全部一致')
  }
}
