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

### 新增 APIProvider enum 值時必須補全所有「provider-aware lookup」fallback
- **發生什麼事**：M1 新增 `'llamacpp'` 到 `APIProvider` 聯集後，沒下 `--model` 的情境下 CLI bootstrap 在 `WebSearchTool.isEnabled()` 卡死約 600ms 後。FREECODE_TRACE 逐層追蹤到：`getMainLoopModel()` → `getDefaultMainLoopModel()` → `getDefaultSonnetModel()` → `getModelStrings().sonnet45` → `undefined` → `parseUserSpecifiedModel(undefined)` 進入死迴圈。
- **根本原因**：`src/utils/model/modelStrings.ts:25-31` 的 `getBuiltinModelStrings(provider)` 用 `ALL_MODEL_CONFIGS[key][provider]` 查表，但 `ALL_MODEL_CONFIGS`（`configs.ts`）每個 key 只有 `firstParty / bedrock / vertex / foundry / openai / codex` 的欄位，**沒有 `llamacpp`**。lookup 全 undefined → `sonnet45` / `opus46` / 等全 undefined → 預設模型解析路徑壞掉。
- **為何隱藏**：`--model qwen3.5-9b-neo` 會讓 `getUserSpecifiedModelSetting()` 直接回傳 flag 值，**完全繞過** `getDefaultMainLoopModel()`。之前所有 M1 的 `./cli -p --model qwen...` 測試都沒踩到。真正進 TUI 互動模式（`bun run dev`、沒 `--model`）才會踩。
- **正確做法**：
  1. 短期修法（已實施）：`src/utils/model/model.ts` 的 `getDefaultMainLoopModelSetting()` 頂端加 `if (getAPIProvider() === 'llamacpp') return DEFAULT_LLAMACPP_MODEL` 短路。不污染 `ALL_MODEL_CONFIGS`、不改 `parseUserSpecifiedModel`（核心檔案）。
  2. 長期提醒：**新增 APIProvider enum 值時（未來 vLLM、sglang 等），先 grep 所有 `ALL_MODEL_CONFIGS[key][provider]` 類的 provider-aware lookup**，每個都要補 fallback（短路或新增欄位）。
- **相關檔案**：`src/utils/model/model.ts`（修法位置）、`src/utils/model/modelStrings.ts:25-31`（lookup 根源）、`src/utils/model/configs.ts`（`ALL_MODEL_CONFIGS` 資料結構）、`src/utils/model/providers.ts`（APIProvider enum）。
- **日期**：2026-04-15

### `ANTHROPIC_API_KEY=dummy` 會讓 free-code bootstrap 無限阻塞
- **發生什麼事**：V4 測試時設 `ANTHROPIC_API_KEY=dummy CLAUDE_CODE_USE_LLAMACPP=true ./cli -p "hi"`，CLI 掛住 60 秒 + 無任何 stdout/stderr，連 `getAnthropicClient()` 都沒被呼叫。把 `ANTHROPIC_API_KEY=dummy` 拿掉（只保留 `CLAUDE_CODE_USE_LLAMACPP=true`）馬上解開。
- **根本原因**：free-code 的 bootstrap（`src/bootstrap/state.ts` + `src/main.tsx` 初始化鏈）偵測到 `ANTHROPIC_API_KEY` 存在時會觸發同步 / 網路驗證，dummy key 讓這步卡住。具體哪一步目前未追到，但行為可重現。
- **正確做法**：llamacpp 路徑完全不需要 Anthropic key。**不要**設 `ANTHROPIC_API_KEY`（即使設成假值也不行）。只設 `CLAUDE_CODE_USE_LLAMACPP=true` + 可選的 `LLAMA_BASE_URL` / `LLAMA_MODEL`。
- **相關檔案**：`src/services/api/client.ts`（getAnthropicClient 的 llamacpp 分支已放最前面，但上游還有別的阻塞）；`scripts/llama/DEPLOYMENT_PLAN.md` 與 `scripts/llama/README.md` 的範例指令需移除 `ANTHROPIC_API_KEY=dummy`。
- **日期**：2026-04-15

### Windows Git Bash `/tmp/...` 不能直接給 Bun/Node fs API
- **發生什麼事**：Part B 端到端測試用 `TESTDIR="${TMPDIR:-/tmp}/..."`，透過 `./cli` 把 `$TESTDIR/foo.txt` 形式的路徑塞進 FileRead/Write/Edit 工具時全部 ENOENT，但 bash 本身 `cat "$TESTDIR/foo.txt"` 能讀到。
- **根本原因**：Git Bash 的 `/tmp/...` 是虛擬 mount 到 `C:\Users\<user>\AppData\Local\Temp`。bash 自己的 IO 認這個虛擬路徑；但 Bun on Windows 的 `fs` / `path` API 只認真實 Windows 路徑（`C:\...` 或 `C:/...`）。CLI 把 prompt 裡的路徑字串直接當 arg 傳給工具的 `fs.readFile` 之類呼叫，所以 ENOENT。
- **正確做法**：測試腳本在塞給 CLI 之前用 `cygpath -m "$path"` 轉成 forward-slash Windows 形式（`C:/Users/.../Temp/...`）。bash 自己讀寫仍用 `/tmp/...`（cygpath -u 或原路徑），只有 CLI 的 prompt 與後續斷言需要 Windows 格式。範例見 `scripts/poc/llamacpp-core-tools-e2e.sh`。
- **相關檔案**：所有會跟 `./cli` + 檔案路徑互動的測試腳本
- **日期**：2026-04-15

### free-code 的 CLI system prompt 遠大於 16K token
- **發生什麼事**：第一次跑 V4 時 llama-server 回 `request (18485 tokens) exceeds the available context size (16384 tokens)`。實測 free-code 光系統 prompt 就 18K+，加 user prompt 更大。
- **根本原因**：`scripts/llama/serve.sh` 預設 `LLAMA_CTX=16384` 是給一般對話準備的，對 Claude Code 類的 agent 系統 prompt 太小。
- **正確做法**：`serve.sh` 預設改成 `LLAMA_CTX=32768`。RTX 5070 12GB VRAM + Q5_K_M 模型（6.85GB）仍有約 5GB 給 KV cache，32K context 綽綽有餘。若使用者 OOM 再往下降。
- **相關檔案**：`scripts/llama/serve.sh`
- **日期**：2026-04-15

---

## 串流處理相關

（尚無記錄）

---

## 建構與設定相關

（尚無記錄）

---

## 型別與編譯相關

### Bun 1.3.6 single-file-executable + Ink React TUI panic（Windows）
- **發生什麼事**：使用者在 PowerShell 跑 `.\cli.exe --allow-dangerously-skip-permissions`（無 `-p`，進 TUI 互動），跑約 110 秒後 Bun 內部 panic：`panic(main thread): switch on corrupt value / oh no: Bun has crashed. This indicates a bug in Bun, not your code.` 然後實測去掉 `--minify` 的 `bun run build:dev` 出來的 `.\cli-dev.exe` 也不 panic 但對話無反應（卡住），繼續走 compiled 路徑都不行。
- **根本原因**：Bun 1.3.6 的 `--compile`（single-file-executable）+ Ink React TUI 組合有 runtime bug；`--minify` 不是主因（dev build 也出問題，只是失敗方式不同）。非我方 code 缺陷。
- **正確做法**：
  - **互動模式一律用 `bun run dev`**（源碼跑，不 bundle 不 compile），實測 UI 正常、對話順暢。
  - **非互動 `-p "..."` 仍可用 compiled `.\cli.exe`**（不進 TUI，不受此 bug 影響）。
  - 等 Bun 更新修好再恢復 compiled TUI；追 Bun changelog 的 single-executable / TUI 相關修正。
- **相關檔案**：`scripts/build.ts`（保留現有設定，只是 compiled 產物別拿去跑 TUI）；測試指南要區分互動 vs 非互動路徑。
- **日期**：2026-04-15

### Bun 1.3.6+ `--bytecode` 與 ESM 互斥
- **發生什麼事**：`bun run build` 報 `format must be 'cjs' when bytecode is true. Eventually we'll add esm support as well.` 無法產出 `./cli`。
- **根本原因**：Bun 1.3.6（當前 runtime 版本）的 bytecode 編譯只支援 CJS format。而本專案 `package.json` 是 `"type": "module"`、原始碼用 ESM import，`scripts/build.ts` 原本同時傳 `--format esm` 和 `--bytecode`，衝突。
- **正確做法**：移除 `--bytecode` flag（啟動時間增加數百毫秒，可接受），保留 `--format esm`。未來 Bun 支援 ESM bytecode 時可加回。**不要**改成 `--format cjs` — `--packages bundle` 後還是可能踩到 ESM-only 套件的坑。
- **副作用**：`./cli` 二進位檔（Windows 上叫 `cli.exe`）比有 bytecode 時稍大 / 啟動稍慢，但功能完整。實測 `./cli -p "What is 2+2?"` → `2 + 2 = 4`，~20 秒（含 llama.cpp 推理）。
- **相關檔案**：scripts/build.ts
- **日期**：2026-04-15

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

### FTS5 trigram tokenizer 的最小查詢長度 = 3
- **發生什麼事**：M2-01 的 smoke 測試用 `MATCH 'KV'` 和 `MATCH '討論'` 預期命中 — 結果兩者都 0 筆。內容明明有這些字串。
- **根本原因**：SQLite FTS5 的 `tokenize='trigram'` 會把內容切成 3-char sliding window（"cache" → cac/ach/che），查詢字串也走相同規則。**查詢字串 <3 字元就產生不出任何 trigram**，等於沒有搜尋條件可比對，自動回 0 筆。
- **正確做法**：
  1. `SessionSearchTool`（M2-05）必須在上層驗證：query 長度 <3 時要嘛拒絕、要嘛自動擴展（加空白上下文字元、或切回其他策略）
  2. 中文短詞查詢（「記憶」「討論」這類 2-char 常用詞）必須想辦法處理 — 考慮：查不到就 fallback 到 `sessions.first_user_message` / `sessions.title` 的 LIKE 匹配
  3. 不要把 trigram 換成 `unicode61` — 它對中文反而更差（整段 CJK 被當一個 token，「我們討論了」變成一個 token，「討論」查不到）
- **相關檔案**：`src/services/sessionIndex/schema.ts`（註釋已標記）、`scripts/poc/session-index-smoke.ts`（驗證測試）
- **日期**：2026-04-15

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
