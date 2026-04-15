# Hermes Agent 架構參考

## 說明
閱讀和理解 `reference/hermes-agent/` 中 Hermes Agent Python 原始碼的指南。當你需要在用 TypeScript 重新實作之前理解某個 Hermes 功能的運作方式時，載入此技能。

## 工具集
file

## 專案結構

```
reference/hermes-agent/
├── run_agent.py              # AIAgent 類別 — 核心對話迴圈
├── model_tools.py            # 工具調度、_discover_tools()、handle_function_call()
├── toolsets.py               # 工具集定義、_HERMES_CORE_TOOLS 清單
├── cli.py                    # HermesCLI 類別 — 互動式 CLI
├── hermes_state.py           # SessionDB — SQLite + FTS5 session 儲存
├── agent/
│   ├── prompt_builder.py     # 系統提示組裝
│   ├── context_compressor.py # 自動上下文壓縮
│   ├── auxiliary_client.py   # 輔助 LLM 客戶端（視覺、摘要）
│   ├── model_metadata.py     # 模型上下文長度、token 估算
│   ├── models_dev.py         # models.dev 註冊表整合
│   ├── skill_commands.py     # 技能 slash 指令
│   └── trajectory.py         # 軌跡儲存輔助函式
├── hermes_cli/
│   ├── main.py               # 進入點
│   ├── auth.py               # *** 關鍵：Provider 註冊表、ProviderConfig ***
│   └── ...
├── tools/                    # 個別工具實作
├── gateway/                  # 訊息閘道（Telegram/Discord/Slack）
├── skills/                   # 內建技能
├── cron/                     # Cron 排程
└── docker/                   # Docker 設定
```

## Provider 系統（M1 — 主要參考）

### 關鍵檔案：`hermes_cli/auth.py`

包含 `PROVIDER_REGISTRY` — 將 provider ID 對應到 `ProviderConfig` 的字典：

```python
ProviderConfig(
    id="openrouter",
    name="OpenRouter",
    auth_type="api_key",
    inference_base_url="https://openrouter.ai/api/v1",
    api_key_env_vars=("OPENROUTER_API_KEY",),
)
```

研究 Hermes 如何：
- 用一致的設定結構定義 30+ 個 provider
- 處理認證（API key、OAuth、device code flow）
- 依 provider 對應模型名稱
- 從環境變數自動偵測可用的 provider

### 關鍵檔案：`agent/auxiliary_client.py`

這是多 provider LLM 客戶端。研究它如何：
- 為不同 provider 建立 OpenAI 相容的客戶端
- 根據 provider 設定路由請求
- 處理 provider 特定的行為差異（速率限制、認證刷新）
- 在 provider 之間做 fallback

### 關鍵檔案：`agent/model_metadata.py`

9 層上下文長度解析鏈：
1. 設定覆寫 → 2. 自訂 provider → 3. 快取 → 4. /models API → 5. Anthropic API → 6. OpenRouter → 7. Nous Portal → 8. models.dev → 9. 預設回退值

研究此檔案以理解 Hermes 如何處理跨 provider 的模型上下文長度多樣性。

## 記憶系統（未來 — M2 參考）

### 關鍵檔案：
- `hermes_state.py` — SessionDB 類別、SQLite + FTS5
- `agent/prompt_builder.py` — 記憶如何注入到提示中

研究 Hermes 如何：
- 在 SQLite 中用 FTS5 全文索引儲存記憶
- 定期「提醒」agent 儲存重要資訊
- 跨 session 搜尋
- 老化和修剪舊記憶

## Cron 系統（未來 — M3 參考）

### 關鍵目錄：`cron/`

研究 Hermes 如何：
- 解析自然語言排程
- 管理任務生命週期（建立/暫停/恢復/刪除）
- 將結果傳送到通訊平台
- 持久化任務狀態

## 閘道系統（未來 — M4 參考）

### 關鍵目錄：`gateway/`

研究 Hermes 如何：
- 從 Telegram/Discord/Slack 接收訊息
- 將平台訊息轉譯為 agent 輸入
- 將 agent 回應路由回平台
- 處理語音備忘錄和附件

## 技能系統（未來 — M5 參考）

### 關鍵檔案：
- `agent/skill_commands.py`
- `skills/` 目錄

研究 Hermes 如何：
- 偵測已完成的任務是否應該成為技能
- 從對話軌跡生成 SKILL.md 檔案
- 根據使用回饋改進技能

## 如何閱讀 Hermes 程式碼

重新實作 Hermes 功能時：

1. **找到進入點** — 通常在 `run_agent.py` 或 `cli.py`
2. **追蹤呼叫鏈** — 跟著 import 理解完整流程
3. **辨識資料結構** — 什麼物件被傳遞
4. **注意外部依賴** — 它使用了什麼 API、資料庫或服務
5. **提取核心邏輯** — 把「它做了什麼」和「Python 怎麼做的」分開
6. **設計 TypeScript 等價物** — 對應到 free-code 的模式：
   - Python class → TypeScript class 或 module
   - Python dict → TypeScript interface + object
   - Python async/await → TypeScript 中相同
   - Python SQLite → better-sqlite3 或 bun:sqlite
   - Python subprocess → Bun shell 或 child_process
