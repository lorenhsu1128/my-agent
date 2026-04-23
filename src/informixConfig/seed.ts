/**
 * 首次啟動種檔。
 *
 * ~/.my-agent/informix.json 不存在時，寫入 DEFAULT_INFORMIX_CONFIG
 * 加上 README 註解檔 informix.README.md。
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getInformixConfigPath } from './paths.js'
import { DEFAULT_INFORMIX_CONFIG } from './schema.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'informix.README.md'

const README_CONTENT = `# ~/.my-agent/informix.json

本檔為 my-agent InformixQueryTool 的連線設定。

## 設定範例

\`\`\`json
{
  "connections": {
    "default": {
      "dsn": "INFORMIX_DSN",
      "host": "192.168.1.100",
      "port": 9088,
      "database": "mydb",
      "server": "informix_server",
      "username": "readonly_user",
      "protocol": "onsoctcp"
    },
    "warehouse": {
      "dsn": "WAREHOUSE_DSN",
      "database": "warehouse_db"
    }
  },
  "defaultConnection": "default",
  "queryTimeout": 30,
  "maxRows": 1000
}
\`\`\`

## 密碼管理

密碼**不存在設定檔中**，透過環境變數設定：

| 連線名稱 | 環境變數 |
|---------|---------|
| default | \`INFORMIX_PASSWORD\` |
| 其他名稱 | \`INFORMIX_PASSWORD_<NAME>\`（大寫），fallback 到 \`INFORMIX_PASSWORD\` |

## ODBC Driver 安裝

### macOS

\`\`\`bash
brew install unixodbc
# 下載 IBM Informix Client SDK (CSDK) for macOS
# 設定 ~/.odbc.ini
\`\`\`

### Windows

1. 下載 IBM Informix Client SDK (CSDK) installer
2. 執行安裝並選擇 ODBC driver
3. 開啟 ODBC Data Source Administrator 設定 DSN

### 連線測試

\`\`\`bash
# macOS / Linux
isql INFORMIX_DSN username password

# Windows
odbcping -d INFORMIX_DSN -u username -p password
\`\`\`

## 注意事項

- 編輯後需**開新 session** 才生效（凍結快照語意）
- JSON 格式壞掉時 my-agent 會 stderr 警告並走內建預設
- 刪掉 \`informix.json\` → 下次啟動自動重新 seed
`

export async function seedInformixConfigIfMissing(): Promise<void> {
  const path = getInformixConfigPath()
  if (existsSync(path)) return
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify(DEFAULT_INFORMIX_CONFIG, null, 2) + '\n',
      'utf-8',
    )
    await writeFile(
      join(dirname(path), README_FILENAME),
      README_CONTENT,
      'utf-8',
    )
    logForDebugging(`[informix-config] seeded ${path}`)
  } catch (err) {
    logForDebugging(
      `[informix-config] seed 失敗，繼續走內建預設：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}
