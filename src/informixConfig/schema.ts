/**
 * Informix 連線設定 Zod schema。
 *
 * 設定檔：~/.my-agent/informix.json
 * 密碼不存設定檔，走環境變數 INFORMIX_PASSWORD / INFORMIX_PASSWORD_<name>
 */
import { z } from 'zod/v4'

export const InformixConnectionSchema = z.object({
  dsn: z.string().optional().describe('ODBC DSN 名稱（優先於 host/port 組成的 DSN-less 連線）'),
  host: z.string().optional().describe('Informix server 主機位址'),
  port: z.number().int().positive().optional().describe('Informix server 連接埠（通常 9088/9089）'),
  database: z.string().optional().describe('資料庫名稱'),
  server: z.string().optional().describe('Informix server 名稱（INFORMIXSERVER）'),
  username: z.string().optional().describe('連線使用者名稱'),
  protocol: z.string().optional().describe('連線協定（通常 onsoctcp）'),
}).default({})

export const InformixConfigSchema = z.object({
  connections: z.record(z.string(), InformixConnectionSchema).default({
    default: InformixConnectionSchema.parse({}),
  }),
  defaultConnection: z.string().default('default'),
  queryTimeout: z.number().int().positive().default(30).describe('查詢逾時（秒）'),
  maxRows: z.number().int().positive().default(1000).describe('單次查詢最大回傳列數'),
}).default({})

export type InformixConnection = z.infer<typeof InformixConnectionSchema>
export type InformixConfig = z.infer<typeof InformixConfigSchema>

export const DEFAULT_INFORMIX_CONFIG: InformixConfig = InformixConfigSchema.parse({})
