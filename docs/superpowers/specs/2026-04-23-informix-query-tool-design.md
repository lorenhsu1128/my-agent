# InformixQueryTool 設計規格

> 日期：2026-04-23
> 狀態：Draft
> 分支：erp

## 動機與目標

讓 my-agent 能直接查詢 IBM Informix 12.x 資料庫，作為日常查詢助手。使用者可以用自然語言描述需求，agent 自動探索 schema、撰寫 SQL、執行查詢、分析結果並產出報表。

**核心需求：**
- 唯讀（SELECT only）— 不允許任何資料修改
- 內網直連 Informix 12.x
- 跨平台（macOS + Windows）
- 支援跨表 JOIN 查詢
- 查詢結果可匯出 CSV，再由其他工具轉 Excel / 圖表
- 與 my-agent 既有功能解耦，bridge 子模組未來可獨立抽離

## 架構概覽

```
┌─────────────────────────────────────────────────┐
│  my-agent (bun)                                 │
│                                                 │
│  InformixQueryTool                              │
│  ├── call() ──spawn──> bridge (node)            │
│  │              stdin:  { action, sql, dsn }    │
│  │              stdout: { ok, columns, rows }   │
│  ├── prompt.ts  (本地模型優化)                    │
│  └── UI.tsx     (表格渲染)                       │
│                                                 │
└───────────────────────┬─────────────────────────┘
                        │ subprocess (Node.js)
┌───────────────────────▼─────────────────────────┐
│  bridge/                                        │
│  ├── main.ts        stdin/stdout JSON 入口       │
│  ├── connection.ts  ODBC 連線管理                │
│  ├── executor.ts    SQL 執行 + 結果序列化         │
│  └── safety.ts      SELECT-only 強制 + auto LIMIT│
│                                                 │
└───────────────────────┬─────────────────────────┘
                        │ ODBC
                   ┌────▼────┐
                   │ Informix│
                   │  12.x   │
                   └─────────┘
```

**選擇 Built-in Tool + bridge 而非 MCP Server 的理由：**
- 本地模型（qwen3.5-9b）工具呼叫準確度隨工具數量增加顯著下降；Built-in 只加 1 個工具（vs MCP 加 3 個）
- Prompt 完全可控，可針對本地模型和 Informix 語法差異精細調整
- Bridge 子目錄零 my-agent 依賴，未來抽離成 MCP Server 成本低

## 目錄結構

```
src/tools/InformixQueryTool/
├── InformixQueryTool.ts    # my-agent Tool 定義
├── prompt.ts               # TOOL_NAME + DESCRIPTION
├── UI.tsx                  # 查詢結果表格渲染
└── bridge/                 # 純 Node.js，零 my-agent 依賴
    ├── package.json        # 獨立依賴（odbc）
    ├── tsconfig.json       # target: Node.js
    ├── src/
    │   ├── main.ts         # stdin/stdout JSON 入口
    │   ├── connection.ts   # ODBC 連線管理
    │   ├── executor.ts     # SQL 執行 + 結果序列化 + CSV 匯出
    │   └── safety.ts       # SQL 解析 + SELECT-only 強制
    └── README.md           # ODBC driver 安裝指南（macOS + Windows）
```

## Input Schema（Actions）

Tool 採 `discriminatedUnion('action', [...])` 模式（同 WebBrowserTool），模型只需記住一個工具名 `InformixQuery`。

### action: `query`

執行 SELECT 查詢。

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `sql` | string | ✓ | SELECT SQL 語句 |
| `limit` | number | ✗ | 回傳列數上限（預設 100，最大 1000） |
| `output_file` | string | ✗ | 存 CSV 的檔案路徑 |
| `connection` | string | ✗ | 連線名稱（預設 "default"） |

回傳：`{ columns: string[], rows: any[][], rowCount: number, elapsed: number }`

### action: `list_tables`

列出所有 table 和 view。

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `schema` | string | ✗ | Schema/owner 名稱（預設 = 連線帳號） |
| `connection` | string | ✗ | 連線名稱 |

回傳：`{ tables: { name: string, type: 'TABLE' | 'VIEW', owner: string }[] }`

### action: `describe_table`

查看 table 的欄位結構、外鍵、索引。

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `table` | string | ✓ | Table 名稱 |
| `schema` | string | ✗ | Schema/owner 名稱 |
| `connection` | string | ✗ | 連線名稱 |

回傳：
```json
{
  "columns": [
    { "name": "col1", "type": "VARCHAR(50)", "nullable": false, "primaryKey": true },
    { "name": "col2", "type": "INTEGER", "nullable": true, "foreignKey": { "table": "other_table", "column": "id" } }
  ],
  "indexes": [
    { "name": "idx_col1", "columns": ["col1"], "unique": true }
  ]
}
```

## Bridge 通訊協議

每次 Tool call spawn 一個 bridge process（查詢頻率不高，不需常駐）。

```
InformixQueryTool.call()
  → spawn('node', ['bridge/dist/main.js'])
  → stdin:  JSON { action, ...params, connectionConfig }
  → stdout: JSON { ok: true, ...result }
         or JSON { ok: false, error: string }
  → process exit
```

- Timeout：30 秒（可在設定檔調整）
- Bridge 執行完即退出

## 連線設定

**檔案：** `~/.my-agent/informix.json`

沿用專案慣例（llamacpp.json / discord.json 同模式），Zod schema 驗證。

```json
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
```

**密碼管理：** 不存設定檔。走環境變數：
- `INFORMIX_PASSWORD` — 預設連線密碼
- `INFORMIX_PASSWORD_<name>` — 具名連線密碼（如 `INFORMIX_PASSWORD_WAREHOUSE`）

**設定模組：** `src/informixConfig/`（schema / paths / loader / seed / index），沿用 llamacppConfig 模式：
- Zod schema 驗證
- 首次啟動 seed 預設設定 + README
- Session 啟動凍結 snapshot

## 安全層

### SELECT-only 強制（bridge/safety.ts）

```
SQL 輸入 → 正規化（去註解、trim）→ 關鍵字檢查 → 通過/拒絕
```

**拒絕清單：**
- DDL：`CREATE`、`ALTER`、`DROP`、`TRUNCATE`、`RENAME`
- DML：`INSERT`、`UPDATE`、`DELETE`、`MERGE`
- 其他：`EXECUTE`、`CALL`、`GRANT`、`REVOKE`、`INTO TEMP`、`INTO EXTERNAL`
- 多語句：包含 `;`（分號）的輸入

**自動 LIMIT：** 若 SQL 不含 `FIRST` 子句，自動在 `SELECT` 後加 `FIRST {limit}`（Informix 語法）。

**Timeout：** ODBC 層設 `queryTimeout`，防止慢查詢卡死 bridge process。

**結果大小限制：** 單次回傳不超過 `maxRows`。

## Prompt 設計（針對本地模型）

```markdown
Query an IBM Informix 12.x database. Read-only — SELECT queries only.

## HARD RULES
1. ALWAYS explore schema first: list_tables → describe_table → query
2. NEVER guess table or column names — Informix names are case-sensitive
3. Use FIRST N instead of LIMIT N (Informix syntax)
4. For date ranges use: WHERE col BETWEEN '2024-01-01' AND '2024-12-31'
5. For CSV export: set output_file parameter

## Workflow
1. action="list_tables" — see available tables
2. action="describe_table", table="xxx" — check columns, types, FKs
3. action="query", sql="SELECT ..." — run the actual query
4. For cross-table queries: describe ALL relevant tables FIRST

## Informix SQL quick reference (vs MySQL/PostgreSQL)
- Row limit: SELECT FIRST 10 * FROM t  (not LIMIT 10)
- String concat: col1 || col2  (not CONCAT())
- Current date: TODAY (date) / CURRENT (datetime)
- Substring: SUBSTR(col, start, len)
- Null handling: NVL(col, default)  (COALESCE also works in 12.x)
- OUTER join: ANSI syntax — LEFT OUTER JOIN ... ON ...

## Output
- query: { columns, rows, rowCount, elapsed }
- list_tables: table names with types (TABLE/VIEW)
- describe_table: columns with types, nullable, FK, indexes
```

**設計理由：**
- 本地模型 SQL 知識偏向 MySQL/PostgreSQL，需明確提示 Informix 差異
- 硬性規則放最前，防模型跳過探索直接猜 table 名
- 工作流線性，減少決策分支

## 跨平台策略

### ODBC 環境

| 項目 | macOS | Windows |
|------|-------|---------|
| ODBC Manager | unixODBC (`brew install unixodbc`) | Windows 內建 |
| Informix Driver | IBM CSDK for macOS | IBM CSDK for Windows |
| DSN 設定 | `~/.odbc.ini` | ODBC Administrator |
| 測試指令 | `isql DSN_NAME user pass` | `odbcping` |

### Bridge 跨平台

- 路徑：`path.join(__dirname, 'bridge', 'dist', 'main.js')` — 自動處理分隔符
- 執行：`spawn('node', [...])` — Node.js 跨平台一致
- 設定檔路徑：用 `os.homedir()` + `path.join` 取得 `~/.my-agent/`

### ODBC Driver 安裝指南

在 `bridge/README.md` 提供 macOS 和 Windows 的逐步安裝說明，包含：
- IBM CSDK 下載連結與版本建議
- ODBC DSN 設定範例（odbc.ini / ODBC Administrator）
- 連線測試方法

## 工具權限

| 方法 | 行為 |
|------|------|
| `isReadOnly()` | 永遠 `true` |
| `isDestructive()` | 永遠 `false` |
| `isConcurrencySafe()` | `true`（每次 spawn 獨立 process） |
| `checkPermissions()` | 首次使用時確認連線設定存在 |

## 驗證計畫

1. **Bridge 單元測試** — safety.ts 的 SQL 過濾（SELECT 通過、INSERT 拒絕、auto LIMIT 附加等）
2. **Tool 單元測試** — schema 驗證、action routing、subprocess spawn/timeout
3. **整合測試** — 對實際 Informix 12.x 執行 list_tables → describe_table → query 流程
4. **跨平台驗證** — macOS 和 Windows 各跑一輪完整流程
5. **本地模型 E2E** — 用 qwen3.5-9b 發出自然語言查詢，驗證工具呼叫成功率和 SQL 正確性

## 不含（明確排除）

- 寫入操作（INSERT/UPDATE/DELETE）
- Stored Procedure 呼叫
- 即時 schema 變更監控
- 查詢歷史記錄 / 審計日誌
- Bridge 常駐模式（連線池）— 未來有需要再加
- MCP Server 封裝 — 未來抽離時再做
