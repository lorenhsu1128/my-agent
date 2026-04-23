import React from 'react'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { Box, Text } from '../../ink.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION, INFORMIX_QUERY_TOOL_NAME } from './prompt.js'
import {
  getInformixConfigSnapshot,
  getConnectionConfig,
  getInformixConfigPath,
} from '../../informixConfig/index.js'

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('query'),
      sql: z.string().describe('SELECT SQL statement to execute'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe('Max rows to return (default 100)'),
      output_file: z
        .string()
        .optional()
        .describe('File path to save results as CSV'),
      connection: z
        .string()
        .optional()
        .describe('Connection name (default: "default")'),
    }),
    z.strictObject({
      action: z.literal('list_tables'),
      schema: z
        .string()
        .optional()
        .describe('Schema/owner name. Omit for default'),
      connection: z
        .string()
        .optional()
        .describe('Connection name (default: "default")'),
    }),
    z.strictObject({
      action: z.literal('describe_table'),
      table: z.string().describe('Table name to describe'),
      schema: z
        .string()
        .optional()
        .describe('Schema/owner name'),
      connection: z
        .string()
        .optional()
        .describe('Connection name (default: "default")'),
    }),
  ]),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
type Output = { action: string; result: string }

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string(),
    result: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

/**
 * 取得 bridge 腳本路徑
 * bridge 在 Node.js 下執行（非 bun），確保 ODBC native addon 相容
 */
function getBridgePath(): string {
  // 優先用編譯後的 dist
  const distPath = join(__dirname, 'bridge', 'dist', 'main.js')
  if (existsSync(distPath)) return distPath

  // 開發模式用 ts-node 或 tsx
  const srcPath = join(__dirname, 'bridge', 'src', 'main.ts')
  return srcPath
}

/**
 * 透過 subprocess 呼叫 bridge 執行查詢
 */
async function callBridge(request: Record<string, unknown>): Promise<string> {
  const config = getInformixConfigSnapshot()
  const timeout = config.queryTimeout * 1000

  return new Promise<string>((resolve, reject) => {
    const bridgePath = getBridgePath()
    const isTs = bridgePath.endsWith('.ts')

    // TS 檔用 npx tsx 執行；JS 檔用 node
    const cmd = isTs ? 'npx' : 'node'
    const args = isTs ? ['tsx', bridgePath] : [bridgePath]

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
      cwd: join(__dirname, 'bridge'),
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `Bridge process exited with code ${code}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
        if (!parsed.ok) {
          reject(new Error(parsed.error || 'Unknown bridge error'))
          return
        }
        resolve(stdout.trim())
      } catch {
        reject(new Error(`Invalid bridge response: ${stdout.slice(0, 200)}`))
      }
    })

    child.on('error', (err) => {
      reject(new Error(`Bridge spawn error: ${err.message}`))
    })

    // 寫入 request 到 stdin
    child.stdin.write(JSON.stringify(request))
    child.stdin.end()
  })
}

export const InformixQueryTool = buildTool({
  name: INFORMIX_QUERY_TOOL_NAME,
  searchHint: 'query Informix database SQL tables',
  maxResultSizeChars: 100_000,

  async description(input) {
    const i = input as Partial<Input>
    if (i?.action === 'query' && 'sql' in i) {
      const sql = (i.sql as string) ?? ''
      const preview = sql.length > 60 ? sql.slice(0, 57) + '...' : sql
      return `Querying Informix: ${preview}`
    }
    if (i?.action === 'list_tables') {
      return 'Listing Informix tables'
    }
    if (i?.action === 'describe_table' && 'table' in i) {
      return `Describing Informix table: ${i.table}`
    }
    return `Using Informix database (${i?.action ?? 'unknown'})`
  },

  userFacingName() {
    return 'Informix Query'
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  isConcurrencySafe() {
    return true // 每次 spawn 獨立 process
  },

  isReadOnly() {
    return true // 永遠唯讀（bridge 層也會擋寫入操作）
  },

  async checkPermissions(input, context) {
    // 檢查設定檔是否存在
    const configPath = getInformixConfigPath()
    if (!existsSync(configPath)) {
      return {
        behavior: 'deny' as const,
        message: `Informix config not found at ${configPath}. Run the agent once to auto-seed, then edit the config with your connection details.`,
        decisionReason: { type: 'prefix' as const, prefix: configPath },
      }
    }

    return {
      behavior: 'ask' as const,
      message: `InformixQuery wants to run: ${(input as { action?: string })?.action ?? 'unknown'}`,
      suggestions: [
        {
          type: 'addRules' as const,
          destination: 'localSettings' as const,
          rules: [
            {
              toolName: INFORMIX_QUERY_TOOL_NAME,
              ruleContent: INFORMIX_QUERY_TOOL_NAME,
            },
          ],
          behavior: 'allow' as const,
        },
      ],
    }
  },

  async prompt() {
    return DESCRIPTION
  },

  renderToolUseMessage(input) {
    const i = input as Partial<Input>
    if (i?.action === 'query' && 'sql' in i) {
      const sql = String(i.sql ?? '').slice(0, 80)
      return `InformixQuery: ${sql}`
    }
    if (i?.action === 'describe_table' && 'table' in i) {
      return `InformixQuery: describe ${i.table}`
    }
    return `InformixQuery: ${i?.action ?? ''}`
  },

  renderToolUseProgressMessage() {
    return React.createElement(
      Box,
      null,
      React.createElement(
        Text,
        { dimColor: true },
        'Querying Informix database…',
      ),
    )
  },

  renderToolResultMessage(content) {
    const c = content as Output
    return React.createElement(
      Box,
      null,
      React.createElement(Text, null, `InformixQuery.${c.action} ok`),
    )
  },

  async call(input) {
    const i = input as Input
    const connConfig = getConnectionConfig(
      'connection' in i ? (i as { connection?: string }).connection : undefined,
    )

    const request: Record<string, unknown> = {
      action: i.action,
      connection: connConfig,
    }

    if (i.action === 'query') {
      request.sql = i.sql
      request.limit = i.limit
      if (i.output_file) request.output_file = i.output_file
    } else if (i.action === 'list_tables') {
      if (i.schema) request.schema = i.schema
    } else if (i.action === 'describe_table') {
      request.table = i.table
      if (i.schema) request.schema = i.schema
    }

    const resultJson = await callBridge(request)
    return {
      data: { action: i.action, result: resultJson },
    }
  },

  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
