# Informix 資料庫查詢工具 使用者指南

> 對應 InformixQueryTool 交付
>
> 最後更新：2026-04-23

my-agent 的 **InformixQueryTool** 讓你用自然語言查詢 IBM Informix 12.x 資料庫。
Agent 會自動探索 schema、撰寫 SQL、執行查詢、分析結果，也可以匯出 CSV 供進一步處理。

工具為**唯讀設計** — 只允許 SELECT 查詢，任何資料修改操作（INSERT / UPDATE / DELETE / DDL）
都會被 bridge 安全層攔截。

---

## 快速上手

### 1. 安裝 ODBC Driver

InformixQueryTool 透過 ODBC 連接資料庫，需要先安裝 IBM Informix ODBC driver。

**macOS：**

```bash
# 安裝 unixODBC manager
brew install unixodbc

# 下載 IBM Informix Client SDK (CSDK) for macOS
# https://www.ibm.com/products/informix/developer-tools
# 安裝後會在 /opt/IBM/Informix_Client-SDK/ 或自訂路徑下

# 設定 ODBC DSN
cat >> ~/.odbc.ini << 'EOF'
[INFORMIX_DSN]
Driver      = /opt/IBM/Informix_Client-SDK/lib/cli/libifcli.so
Server      = your_server_name
Database    = your_database
Host        = 192.168.1.100
Service     = 9088
Protocol    = onsoctcp
EOF
```

**Windows：**

1. 下載 IBM Informix Client SDK (CSDK) installer
2. 執行安裝，勾選 ODBC driver 元件
3. 開啟「ODBC 資料來源管理員」（64 位元版）
4. 「系統 DSN」→「新增」→ 選「IBM INFORMIX ODBC DRIVER」
5. 填入連線資訊（Server、Host、Service=9088、Database、Protocol=onsoctcp）

### 2. 驗證 ODBC 連線

```bash
# macOS / Linux
isql INFORMIX_DSN your_username your_password

# Windows（PowerShell）
odbcping -d INFORMIX_DSN -u your_username -p your_password
```

看到 `Connected!` 或查詢結果代表 ODBC 設定正確。

### 3. 安裝 Bridge 依賴

```bash
cd src/tools/InformixQueryTool/bridge
npm install
npm run build
```

### 4. 設定連線

首次啟動 my-agent 後會自動在 `~/.my-agent/` 下生成預設設定檔。
編輯 `~/.my-agent/informix.json` 填入你的連線資訊：

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
    }
  },
  "defaultConnection": "default",
  "queryTimeout": 30,
  "maxRows": 1000
}
```

### 5. 設定密碼

密碼**不存在設定檔中**，透過環境變數傳入：

```bash
# 寫入 shell profile（~/.zshrc 或 ~/.bashrc）
export INFORMIX_PASSWORD="your_password"

# 或在啟動 my-agent 時臨時設定
INFORMIX_PASSWORD=secret my-agent
```

### 6. 開始查詢

```bash
my-agent
# 然後用自然語言提問：
# > 列出所有 table
# > 查一下 customers 表的結構
# > 幫我查最近 30 天的訂單總金額
```

---

## 設定檔詳解

### 檔案位置

| 項目 | 路徑 |
|------|------|
| 設定檔 | `~/.my-agent/informix.json` |
| 說明文件 | `~/.my-agent/informix.README.md`（自動生成） |
| env override | `INFORMIX_CONFIG_PATH=/custom/path/informix.json` |

### 欄位說明

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `connections` | object | `{}` | 具名連線設定的 map |
| `defaultConnection` | string | `"default"` | 未指定連線名時使用的預設連線 |
| `queryTimeout` | number | `30` | 查詢逾時（秒），bridge process 超時會被終止 |
| `maxRows` | number | `1000` | 單次查詢最大回傳列數 |

### 連線參數

每個連線可設定以下參數（全部選填）：

| 參數 | 說明 | 範例 |
|------|------|------|
| `dsn` | ODBC DSN 名稱（優先於其他參數組成的 DSN-less 連線） | `"INFORMIX_DSN"` |
| `host` | Informix server 主機位址 | `"192.168.1.100"` |
| `port` | 連接埠（通常 9088 或 9089） | `9088` |
| `database` | 資料庫名稱 | `"mydb"` |
| `server` | Informix server 名稱（對應 INFORMIXSERVER 環境變數） | `"ifx_server"` |
| `username` | 連線使用者名稱 | `"readonly_user"` |
| `protocol` | 連線協定 | `"onsoctcp"` |

### 多連線設定

你可以設定多個具名連線，agent 查詢時可指定要用哪一個：

```json
{
  "connections": {
    "default": {
      "dsn": "PROD_DSN",
      "database": "production_db",
      "username": "readonly"
    },
    "warehouse": {
      "dsn": "WH_DSN",
      "database": "warehouse_db",
      "username": "analyst"
    },
    "test": {
      "dsn": "TEST_DSN",
      "database": "test_db"
    }
  },
  "defaultConnection": "default"
}
```

**密碼環境變數對應：**

| 連線名稱 | 環境變數 | 備註 |
|---------|---------|------|
| `default` | `INFORMIX_PASSWORD` | — |
| `warehouse` | `INFORMIX_PASSWORD_WAREHOUSE` | 名稱轉大寫 |
| `test` | `INFORMIX_PASSWORD_TEST` | 名稱轉大寫 |
| （任何名稱） | `INFORMIX_PASSWORD` | fallback — 若專用變數不存在，退回通用密碼 |

---

## 工具行為

### 三個 Action

InformixQueryTool 對 agent 來說是**一個工具、三個動作**：

| Action | 用途 | 典型場景 |
|--------|------|---------|
| `list_tables` | 列出所有 table 和 view | Agent 探索 schema 的第一步 |
| `describe_table` | 查看欄位結構、型別、外鍵、索引 | Agent 了解表關聯，準備寫 JOIN |
| `query` | 執行 SELECT 查詢 | 實際查資料 |

### 工作流

Agent 被教導遵循以下順序（在 prompt 中定義為 HARD RULES）：

```
1. list_tables    → 看有哪些表
2. describe_table → 看表結構和外鍵
3. query          → 寫 SQL 查資料
```

這確保 agent 不會猜測 table 或 column 名稱。

### 安全機制

| 機制 | 說明 |
|------|------|
| **SELECT-only** | 只允許 `SELECT` 和 `WITH ... SELECT`。INSERT / UPDATE / DELETE / DDL / EXECUTE 等全部被 bridge 安全層攔截 |
| **多語句封鎖** | 禁止分號分隔的多語句（防止 `SELECT 1; DROP TABLE ...`） |
| **INTO TEMP/EXTERNAL 封鎖** | 禁止 `SELECT INTO TEMP` 和 `SELECT INTO EXTERNAL`（防止透過 SELECT 寫檔） |
| **自動 LIMIT** | 若 SQL 沒有 `FIRST` 子句，bridge 自動加 `FIRST {limit}`（預設 100，最大 1000），防止拉全表 |
| **查詢逾時** | 超過 `queryTimeout` 秒的查詢會被終止 |
| **密碼不落檔** | 密碼只透過環境變數傳入，不存在設定檔或程式碼中 |

### CSV 匯出

Agent 可以將查詢結果匯出為 CSV 檔案：

```
> 查最近一個月的銷售資料，存成 CSV
```

Agent 會在 `query` action 中設定 `output_file` 參數，bridge 直接寫 CSV。
之後 agent 可以用其他工具（BashTool + Python、xlsx skill）將 CSV 轉成 Excel 或圖表。

---

## Informix SQL 注意事項

本地模型（qwen3.5-9b 等）的 SQL 知識偏向 MySQL / PostgreSQL。
以下是 Informix 特有語法（已寫入 agent prompt，但手動下 SQL 時也要注意）：

| 操作 | Informix 語法 | MySQL/PostgreSQL 語法 |
|------|-------------|---------------------|
| 行數限制 | `SELECT FIRST 10 * FROM t` | `SELECT * FROM t LIMIT 10` |
| 字串串接 | `col1 \|\| col2` | `CONCAT(col1, col2)` |
| 當前日期 | `TODAY` | `CURDATE()` / `CURRENT_DATE` |
| 當前時間 | `CURRENT HOUR TO SECOND` | `NOW()` / `CURRENT_TIMESTAMP` |
| 子字串 | `SUBSTR(col, start, len)` | `SUBSTRING(col, start, len)` |
| NULL 替代 | `NVL(col, default)` | `IFNULL()` / `COALESCE()` |
| 外部連接 | `LEFT OUTER JOIN t2 ON ...` | 相同（ANSI 語法） |

---

## 架構概覽

```
┌──────────────────────────────────────────┐
│  my-agent (bun)                          │
│                                          │
│  InformixQueryTool                       │
│  ├── call()  → spawn Node.js subprocess  │
│  ├── prompt.ts（Informix 語法提示）       │
│  └── UI.tsx（查詢結果表格渲染）           │
│                                          │
└──────────────────┬───────────────────────┘
                   │ stdin/stdout JSON
┌──────────────────▼───────────────────────┐
│  bridge/  (Node.js + odbc)               │
│  ├── safety.ts  SELECT-only 強制         │
│  ├── connection.ts  ODBC 連線            │
│  ├── executor.ts  SQL 執行 + CSV 匯出    │
│  └── main.ts  JSON-RPC 入口              │
└──────────────────┬───────────────────────┘
                   │ ODBC
              ┌────▼────┐
              │ Informix │
              │  12.x    │
              └──────────┘
```

**為什麼 bridge 用 Node.js 而非 bun？**

`odbc` npm 套件是 C++ native addon（N-API）。bun 的 N-API 支援還不完整，
用 Node.js 確保 ODBC binding 100% 相容。bridge 是獨立的 subprocess，
不影響 my-agent 主程序的 bun runtime。

---

## 跨平台支援

| 項目 | macOS | Windows |
|------|-------|---------|
| ODBC Manager | unixODBC（`brew install unixodbc`） | Windows 內建 |
| Informix Driver | IBM CSDK for macOS | IBM CSDK for Windows |
| DSN 設定 | `~/.odbc.ini` 手動編輯 | ODBC Administrator GUI |
| Bridge 執行 | `node bridge/dist/main.js` | `node bridge\dist\main.js` |
| 路徑分隔符 | 自動處理（`path.join`） | 自動處理 |

---

## 故障排除

### ODBC 連線失敗

**症狀：** `ODBC connection failed` 或 `Data source name not found`

**檢查步驟：**

```bash
# 1. 確認 DSN 存在
# macOS
cat ~/.odbc.ini
odbcinst -q -s

# Windows：開啟 ODBC 資料來源管理員 → 系統 DSN 清單

# 2. 手動測試連線
isql INFORMIX_DSN username password    # macOS
odbcping -d INFORMIX_DSN -u user -p pw  # Windows

# 3. 確認 Informix server 可達
telnet 192.168.1.100 9088
```

### 設定檔找不到

**症狀：** `Informix config not found at ~/.my-agent/informix.json`

**解法：** 啟動一次 my-agent 讓它自動 seed 預設設定檔，然後編輯填入連線資訊。

```bash
my-agent -p "hi"    # 觸發 seed
cat ~/.my-agent/informix.json
# 編輯填入你的連線資訊
```

### 密碼未設定

**症狀：** `ODBC connection failed: Authentication failed` 或類似錯誤

**解法：** 確認環境變數已設定：

```bash
echo $INFORMIX_PASSWORD    # macOS
echo %INFORMIX_PASSWORD%   # Windows CMD
$env:INFORMIX_PASSWORD     # Windows PowerShell
```

### Bridge 找不到 Node.js

**症狀：** `Bridge spawn error: ENOENT`

**解法：** 確認 `node` 在 PATH 中：

```bash
which node      # macOS
where node      # Windows
node --version  # 應為 v18+
```

### 查詢逾時

**症狀：** `Bridge process exited with code null`（被 timeout kill）

**解法：** 增加 `queryTimeout`（`~/.my-agent/informix.json`），或優化 SQL 加索引。

### Agent 寫出錯誤的 Informix SQL

**症狀：** Agent 寫出 `LIMIT 10` 而非 `FIRST 10`，或用了 `CONCAT()` 而非 `||`

**解法：** 這通常發生在本地模型對 Informix 語法不熟悉時。prompt 已包含語法對照表，
但可以在對話中明確告知 agent「這是 Informix 資料庫，用 FIRST 不是 LIMIT」加強引導。
注意 bridge 的 auto LIMIT 機制會自動在沒有 `FIRST` 的 SELECT 後面加上 `FIRST {limit}`，
所以即使 agent 忘了加也不會拉全表。

---

## 環境變數一覽

| 環境變數 | 用途 | 預設 |
|---------|------|------|
| `INFORMIX_PASSWORD` | 預設連線密碼 | （必填） |
| `INFORMIX_PASSWORD_<NAME>` | 具名連線密碼（大寫） | fallback 到 `INFORMIX_PASSWORD` |
| `INFORMIX_CONFIG_PATH` | 覆蓋設定檔路徑 | `~/.my-agent/informix.json` |

---

## 相關檔案

| 檔案 | 說明 |
|------|------|
| `src/tools/InformixQueryTool/InformixQueryTool.ts` | Tool 定義（buildTool） |
| `src/tools/InformixQueryTool/prompt.ts` | Agent prompt（Informix 語法提示） |
| `src/tools/InformixQueryTool/bridge/` | Node.js ODBC bridge（獨立子專案） |
| `src/informixConfig/` | 設定模組（schema / loader / seed） |
| `~/.my-agent/informix.json` | 使用者設定檔 |
| `~/.my-agent/informix.README.md` | 設定檔說明（自動生成） |
| `tests/integration/informix/` | 單元測試（safety + config） |
| `docs/superpowers/specs/2026-04-23-informix-query-tool-design.md` | 設計規格 |
