/**
 * Bridge 入口 — stdin/stdout JSON 通訊
 * 使用方式：echo '{"action":"query","sql":"SELECT ...","connection":{...}}' | node main.js
 */
import { executeQuery, listTables, describeTable } from './executor.js'
import type { ConnectionConfig } from './connection.js'

interface BridgeRequest {
  action: 'query' | 'list_tables' | 'describe_table'
  sql?: string
  limit?: number
  output_file?: string
  table?: string
  schema?: string
  connection: ConnectionConfig
}

interface BridgeResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

async function main(): Promise<void> {
  let input = ''

  // 從 stdin 讀取完整 JSON
  for await (const chunk of process.stdin) {
    input += chunk
  }

  if (!input.trim()) {
    writeError('No input received on stdin')
    process.exit(1)
  }

  let request: BridgeRequest
  try {
    request = JSON.parse(input)
  } catch {
    writeError('Invalid JSON input')
    process.exit(1)
  }

  try {
    const result = await dispatch(request)
    writeResult({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    writeError(message)
    process.exit(1)
  }
}

async function dispatch(req: BridgeRequest): Promise<Record<string, unknown>> {
  switch (req.action) {
    case 'query': {
      if (!req.sql) throw new Error('Missing required field: sql')
      const result = await executeQuery(
        req.connection,
        req.sql,
        req.limit ?? 100,
        req.output_file,
      )
      return result as unknown as Record<string, unknown>
    }

    case 'list_tables': {
      const result = await listTables(req.connection, req.schema)
      return result as unknown as Record<string, unknown>
    }

    case 'describe_table': {
      if (!req.table) throw new Error('Missing required field: table')
      const result = await describeTable(req.connection, req.table, req.schema)
      return result as unknown as Record<string, unknown>
    }

    default:
      throw new Error(`Unknown action: ${req.action}`)
  }
}

function writeResult(data: BridgeResponse): void {
  process.stdout.write(JSON.stringify(data) + '\n')
}

function writeError(message: string): void {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
}

main().catch((err) => {
  writeError(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
