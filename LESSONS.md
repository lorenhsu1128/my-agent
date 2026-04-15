# LESSONS.md — 教訓與踩坑記錄

> 此檔案記錄開發過程中犯過的錯誤、踩過的坑、以及學到的教訓。
> Claude Code 和人類都可以寫入此檔案。
>
> **Claude Code**：每次你修復一個 bug、回退一個錯誤的做法、或發現一個「早知道就不該這樣做」的情況時，在對應的分類下附加一條記錄。
>
> **人類**：你可以隨時手動新增、編輯或刪除記錄。
>
> **格式規範**：
> ```
> ### [簡短標題]
> - **發生什麼事**：具體描述出了什麼錯
> - **根本原因**：為什麼會發生
> - **正確做法**：以後應該怎麼做
> - **相關檔案**：涉及哪些檔案
> - **日期**：YYYY-MM-DD
> ```

---

## 工具呼叫轉譯相關

（尚無記錄）

---

## Provider 整合相關

（尚無記錄）

---

## 串流處理相關

（尚無記錄）

---

## 建構與設定相關

（尚無記錄）

---

## 型別與編譯相關

### Typecheck 綠燈基線（2026-04-15 建立）
- **基線狀態**：`bun run typecheck` 回 exit 0，輸出唯一一行：`tsconfig.json(10,5): error TS5101: Option 'baseUrl' is deprecated ...`（TypeScript 6.0 的 deprecation warning，非實際 code 錯誤）。
- **怎麼來的**：M1 階段一最後一項任務（commit 見 git log）在 commit `fbacb96` 之後的 main 上實測。
- **含義**：往後任何改動後 typecheck 輸出應該**完全等於此基線**（除非刻意新增 / 修改檔案引入新 warning）。多出任何行都是迴歸，必須處理。
- **注意**：`package.json` 原本**沒有** `typecheck` script（CLAUDE.md 文件假設有）— 已補上 `"typecheck": "tsc --noEmit"`。CLAUDE.md 的「TypeScript 變更後執行 `bun run typecheck`」這條指令此前實際上跑不了。
- **baseUrl deprecation 的處理**：暫不修 `tsconfig.json`。TS 7.0 才會真的移除，屆時動路徑解析可能連鎖影響整份 tsconfig；留著作為「提醒未來升 TS 時要處理」的訊號比現在修更有價值。
- **日期**：2026-04-15

---

## 測試相關

（尚無記錄）

---

## free-code 既有程式碼的陷阱

> 這個分類記錄 free-code 原始碼中發現的「不明顯的行為」或「容易誤解的設計」，
> 不一定是 bug，但如果不知道就容易踩坑。

（尚無記錄）

---

## Hermes 程式碼閱讀中的誤解

> 這個分類記錄閱讀 Hermes Agent 原始碼時產生的誤解，
> 以及實際運作方式與第一印象不同的地方。

（尚無記錄）

---

## 環境與工具鏈相關

### Git Bash 傳中文到 curl `-d` 會 mangle UTF-8
- **發生什麼事**：在 verify.sh 用 `curl -d '{"content":"2+2=? 只回答數字。"}'` 發 JSON，server 回 `parse_error: ill-formed UTF-8 byte`，顯然中文被切壞。
- **根本原因**：Git Bash 把 `-d` 的參數交給 Windows CreateProcess 時走 ACP（Big5/CP950），到 curl.exe 時已不是 UTF-8。
- **正確做法**：用 heredoc 或 `cat >` 寫到暫存 .json 檔，然後 `curl --data-binary "@$file"`。純 ASCII prompt 也可以繞過，但有中文的 test fixture 一律走檔案。
- **相關檔案**：scripts/llama/verify.sh
- **日期**：2026-04-15

### Qwen3.5-Neo 把思維鏈放在 `reasoning_content`，答案在 `content`
- **發生什麼事**：煙測 `max_tokens: 64` 時 `content=""`、`finish_reason=length`；模型把思考過程全寫進 `reasoning_content`，token 預算耗盡才要寫答案。
- **根本原因**：Neo 的 prompt template 預設帶 `<think>` CoT，llama-server 把 `<think>...</think>` 塊解析到 `reasoning_content`，實際答案留給 `content`。短 max_tokens 只夠塞思維鏈。
- **正確做法**：(1) 測試/實際用途給足 `max_tokens`（≥512）；(2) 驗證邏輯要同時接受 `content` 或 `reasoning_content` 中的答案；(3) 不想要 CoT 就在 prompt 加 `/no_think` 或切 template。
- **相關檔案**：scripts/llama/verify.sh
- **日期**：2026-04-15

### llama.cpp b8457 `--log-colors` 需要參數值
- **發生什麼事**：serve.sh 啟動 llama-server 時報 `error while handling argument "--log-colors": expected value for argument`，server 立即退出。
- **根本原因**：b8457 版把 `--log-colors` 從 flag 改成必須帶 `on|off|auto` 的選項；舊文件/範例還把它當 flag 用。
- **正確做法**：直接移除該參數（預設 `auto` 就會在 TTY 上色）；若非要指定就寫 `--log-colors auto`。
- **相關檔案**：scripts/llama/serve.sh
- **日期**：2026-04-15

---
