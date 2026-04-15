我要你分析 Hermes Agent 原始碼中的特定模組。

如果我沒有指定模組，請問我要審查哪個。常見模組：
- `provider` — Provider 系統（hermes_cli/auth.py、agent/auxiliary_client.py）
- `memory` — 記憶系統（hermes_state.py、memdir/）
- `tools` — 工具系統（model_tools.py、toolsets.py、tools/）
- `cron` — Cron 排程（cron/）
- `gateway` — 訊息閘道（gateway/）
- `skills` — 技能系統（agent/skill_commands.py、skills/）
- `agent` — 核心 agent 迴圈（run_agent.py、agent/）

一旦我指定了模組，執行以下步驟：

1. 從 `reference/hermes-agent/` 讀取相關檔案
2. 追蹤從進入點到執行的完整呼叫鏈
3. 辨識：
   - 核心資料結構和介面
   - 外部依賴（API、資料庫、服務）
   - 本質邏輯（它實際做了什麼，去除 Python 特定的模式）
   - 設定和狀態管理
4. 與 free-code 的既有等價物比較（如果有的話）：
   - free-code 已經有什麼涵蓋類似功能的？
   - 什麼是真正需要新建的？
   - 新程式碼應該放在 free-code 架構的哪裡？
5. 提供摘要，包含：
   - Hermes 的做法（Python 中如何運作）
   - 建議的 free-code 做法（如何用 TypeScript 實作）
   - 需要我決定的關鍵設計決策
   - 預估複雜度（小/中/大）

不要開始實作。這僅是分析和規劃 — 等我同意後再開始。
