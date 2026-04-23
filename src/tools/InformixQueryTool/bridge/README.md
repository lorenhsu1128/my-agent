# Informix Query Bridge

Node.js subprocess，透過 ODBC 連接 IBM Informix 12.x 資料庫。
由 my-agent 的 InformixQueryTool spawn，經 stdin/stdout JSON 通訊。

## 前置條件

### macOS

```bash
# 1. 安裝 unixODBC
brew install unixodbc

# 2. 下載 IBM Informix Client SDK (CSDK) for macOS
#    https://www.ibm.com/products/informix/developer-tools

# 3. 設定 ODBC DSN（~/.odbc.ini）
cat >> ~/.odbc.ini << 'EOF'
[INFORMIX_DSN]
Driver = /path/to/libifcli.so
Server = your_server_name
Database = your_database
Host = 192.168.1.100
Service = 9088
Protocol = onsoctcp
EOF

# 4. 測試連線
isql INFORMIX_DSN your_username your_password
```

### Windows

1. 下載 IBM Informix Client SDK (CSDK) installer
2. 執行安裝，選擇包含 ODBC driver
3. 開啟「ODBC 資料來源管理員」（64 位元）
4. 新增「系統 DSN」→ 選擇「IBM INFORMIX ODBC DRIVER」
5. 填入連線資訊（Server、Host、Service、Database、Protocol）

```powershell
# 測試連線
odbcping -d INFORMIX_DSN -u your_username -p your_password
```

## Bridge 安裝

```bash
cd src/tools/InformixQueryTool/bridge
npm install
npm run build
```

## 手動測試

```bash
echo '{"action":"list_tables","connection":{"dsn":"INFORMIX_DSN","username":"user","password":"pass"}}' | node dist/main.js
```

## 通訊協議

### Request（stdin JSON）

```json
{
  "action": "query | list_tables | describe_table",
  "sql": "SELECT ...",
  "limit": 100,
  "output_file": "/path/to/output.csv",
  "table": "table_name",
  "schema": "owner_name",
  "connection": {
    "dsn": "INFORMIX_DSN",
    "host": "192.168.1.100",
    "port": 9088,
    "database": "mydb",
    "server": "ifx_server",
    "username": "readonly_user",
    "password": "secret",
    "protocol": "onsoctcp"
  }
}
```

### Response（stdout JSON）

成功：
```json
{ "ok": true, "columns": [...], "rows": [...], "rowCount": 5, "elapsed": 120 }
```

失敗：
```json
{ "ok": false, "error": "Error message" }
```
