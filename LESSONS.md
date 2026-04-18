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

### Anthropic SDK 內部 SSE parser 的 decodeUTF8 不帶 {stream: true} 切碎中文
- **發生什麼事**：TUI 跑 SessionSearch tool 時，qwen3.5-9b-neo 的 tool_call arguments 含中文「天氣預報」，adapter 串流翻譯 → SDK SSE parser → claude.ts 的 `input_json_delta` 累積 → 最終 `input={}` 空物件。debug log 在 **claude.ts 層**確認 `partial_json` 已是亂碼「憭拇除??」。
- **根本原因**：Anthropic SDK `src/internal/utils/bytes.ts:decodeUTF8()` 用 `decoder.decode(bytes)` **不帶 `{stream: true}`**。SDK 的 `LineDecoder` / `iterSSEChunks` 在 byte 層切割後每行用 `decodeUTF8()` 解碼，但 ReadableStream 的 chunk 邊界可能切到 multi-byte UTF-8（中文 3-byte）中間 → 解出 replacement char → JSON.parse 失敗 → `normalizeContentFromAPI` fallback 到 `{}`。
- **為什麼 standalone 測試通過但 TUI 失敗**：standalone 測試直接用 `.stream()` 走 `BetaMessageStream` 路徑（SDK 自己累積 input）；TUI 的 `claude.ts` 用 `.create({stream: true})` 走 raw stream 路徑 + 自訂累積。兩條路徑經過不同的 SDK 內部處理。
- **嘗試過但沒用的修法**：(1) 改 `iterOpenAISSELines` 用 `Buffer.concat` 取代 `TextDecoder({stream: true})`——實測 TextDecoder streaming 在 Bun 上其實是正確的，真正亂碼發生在更下游的 SDK；(2) 各種 FTS 查詢修正（OR/LIKE/ESCAPE）——這些有各自的 bug 但跟 `input={}` 無關。
- **正確做法**：**在 adapter 層累積完整 tool_call arguments 字串**，不逐 chunk yield `input_json_delta`。改成在 `content_block_stop` 之前一次 yield **單一** `input_json_delta`（含完整 JSON）。這樣 SDK 的 SSE parser 只收到一筆 delta，不需要跨 chunk 拼湊 UTF-8 → 問題從根消除。
- **具體改動**：`llamacpp-fetch-adapter.ts` 新增 `toolArgBuffers: Map<openaiIdx, string>`，streaming 階段 arguments 累積到 buffer，收尾階段「先 yield 完整 input_json_delta → 再 yield content_block_stop」。
- **影響範圍**：所有走 llamacpp adapter 的 tool call arguments 含非 ASCII 字元的情境。M1 純英文 tool call 不受影響但也無回歸。
- **日期**：2026-04-16

---

## 建構與設定相關

### Vendor SDK 後 Bun bundler 不走 tsconfig paths 解析 cross-package import
- **發生什麼事**：將 `@anthropic-ai/sdk` 從 node_modules vendor 到 `src/vendor/my-agent-ai/sdk/` 後，`bun run build` 報 `Could not resolve: "@anthropic-ai/sdk/client"` — 錯誤來自 vendored `bedrock-sdk/client.ts` 內部的 `import { BaseAnthropic } from '@anthropic-ai/sdk/client'`。
- **根本原因**：`bun run typecheck`（tsc）正確走 tsconfig paths 解析，但 `bun build --packages bundle` 對「看起來像 npm 套件名的 bare import」會優先查 node_modules，而非 tsconfig paths。vendored bedrock/vertex/foundry SDK 內部有 ~20 個 cross-package import 指向 `@anthropic-ai/sdk/...`，在 node_modules 已刪除的情況下全部 fail。
- **正確做法**：vendored SDK 之間的 cross-package import 改為相對路徑。例如 `bedrock-sdk/client.ts` 的 `from '@anthropic-ai/sdk/client'` 改成 `from '../sdk/client'`，`bedrock-sdk/core/error.ts` 的改成 `from '../../sdk/core/error'`。這只影響 vendor 目錄內的檔案（~20 處），不影響 `src/` 下既有的 121 個 import（它們的 bare import 被 tsconfig paths 正確處理）。
- **相關檔案**：`src/vendor/my-agent-ai/{bedrock,vertex,foundry}-sdk/` 內所有 `.ts` 檔
- **日期**：2026-04-16

### Vendor SDK 時 `.mjs` deep import 路徑需去掉副檔名
- **發生什麼事**：SDK 的 npm 發佈物有 `.mjs` 編譯檔，專案中 92 個檔案用 `@anthropic-ai/sdk/resources/index.mjs` 之類的 deep import 引用型別。vendor 後 tsconfig paths 映射 `@anthropic-ai/sdk/*` → `src/vendor/my-agent-ai/sdk/*`，但 vendor 目錄裡只有 `.ts` 原始碼，沒有 `.mjs`。
- **正確做法**：機械式 `sed -i "s|@anthropic-ai/sdk/\([^'\"]*\)\.mjs|@anthropic-ai/sdk/\1|g"` 去掉 92 個檔案的 `.mjs` 副檔名。Bun 的 `moduleResolution: "bundler"` 會自動解析無副檔名 import 到 `.ts` 檔。只有 5 個不同的 `.mjs` 路徑模式，全部是 type-only import。
- **相關檔案**：92 個 `src/` 下的 `.ts`/`.tsx` 檔案
- **日期**：2026-04-16

### `bun install --force` 不會清理 orphan 套件目錄
- **發生什麼事**：從 `package.json` 移除 7 個 `@anthropic-ai` 依賴後，`bun install` 顯示 "Removed: 7"，`bun.lock` 也確認沒有 anthropic 參考。但 `node_modules/@anthropic-ai/` 目錄（3934 個檔案、~66MB）仍然殘留。即使 `bun install --force` 重裝也一樣。
- **根本原因**：Bun 的 install 只管新增/更新 lockfile 裡的套件，不主動清理 node_modules 裡不在 lockfile 的 orphan 目錄。
- **正確做法**：手動 `find node_modules/@anthropic-ai -delete` 或 `rm -rf node_modules/@anthropic-ai/` 清理。
- **相關檔案**：node_modules/
- **日期**：2026-04-16

---

## 型別與編譯相關

### Bun 1.3.6 "switch on corrupt value" TUI panic（Windows）— 已修
- **發生什麼事**：`bun run dev` 跑 TUI 互動模式約 2-3 分鐘後 Bun panic：`panic(main thread): switch on corrupt value`。compiled `cli.exe` 也有同樣問題。
- **根本原因**：Bun 1.3.6 的 Windows 版有多個 ReadableStream / async iterator 相關 bug。
- **解法**：**升級到 Bun 1.3.12**。`v1.3.10` 的 release note 明確修了此 panic（提到影響 Claude Code 使用者）；`v1.3.12` 額外修了大量 ReadableStream 穩定性問題。
- **驗證**：`npm install -g bun@1.3.12` → `bun --version` 確認 1.3.12 → typecheck 基線不變。
- **日期**：2026-04-16（原記錄 2026-04-15，升級修復 2026-04-16）

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

## 工具定義相關

### `checkPermissions()` 的 `updatedInput` 會覆蓋 tool input — 不需要就不要覆寫
- **發生什麼事**：SessionSearchTool 在 TUI 執行時 `call()` 收到的 `input.query` 為 `undefined`，工具完全無法運作。前後修了 7+ 次 commit（FTS query、LIKE fallback、UTF-8、輸出格式…），全部治標不治本。
- **根本原因**：自訂 `checkPermissions()` 回傳 `{ behavior: 'allow', updatedInput: {} as never }`。`toolExecution.ts:1130` 檢查 `updatedInput !== undefined`，`{}` 不是 `undefined`，所以把原本的 `processedInput`（含 `query`）**整個覆寫成空物件**。
- **正確做法**：
  1. 如果工具不需要自訂權限檢查 → **不要覆寫 `checkPermissions`**。`TOOL_DEFAULTS` 的預設實作會 `{ behavior: 'allow', updatedInput: input }` 原封傳回
  2. 如果必須覆寫 → 確保 `updatedInput` 是**原始 input 或其修改版**，不是空物件
  3. 如果想回 allow 不改 input → 用 `{ behavior: 'allow', updatedInput: undefined }` 或完全不設 `updatedInput`（`toolExecution.ts` 會跳過 `undefined`）
- **教訓**：tool input 在 `call()` 拿到之前經過一長串管線（Zod parse → backfill → hook → checkPermissions → …），任何一步回傳 `updatedInput` 都可能覆蓋 input。新工具不需要自訂權限時，不要多寫一個空的 `checkPermissions`。
- **相關檔案**：`src/services/tools/toolExecution.ts`（L1130-1131 覆寫邏輯）、`src/Tool.ts`（L757-769 `TOOL_DEFAULTS`）
- **日期**：2026-04-16

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

### FTS5 trigram 對中文無空格長句 phrase match 幾乎不可能命中
- **發生什麼事**：M2-22 手動驗證時，使用者在第二個 session 問「你上次說了甚麼笑話」，prefetch 的 FTS 搜尋沒找到第一個 session 的笑話內容，模型直接編了新笑話。
- **根本原因**：`sanitizeFtsQuery` 把中文無空格句子整段包成 phrase literal `"你上次說了甚麼笑話"`。FTS5 trigram 做精確 phrase matching（需要所有 trigram 按順序連續出現），但 query 的 trigram（你上次/上次說/…）和 content 的 trigram（說個笑/個笑話/…）完全沒交集。語義相關 ≠ 詞彙相同。
- **正確做法**：
  1. 中文長字串拆成 3-char sliding window trigrams 用 OR 連接（不是 phrase match）
  2. FTS 搜不到時加 LIKE fallback 搜 `sessions.first_user_message`
  3. 從 query 提取 2-char CJK 關鍵詞（從尾端取，通常是名詞/動詞核心）做 LIKE
  4. 以上三策略已在 `ftsSearch.ts` 的 `sanitizeFtsQuery` + `searchSessionHistory` 實作
- **相關檔案**：`src/services/memoryPrefetch/ftsSearch.ts`
- **日期**：2026-04-16

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

## Git / 工作流程

### `git stash -u` + checkout 失敗會讓已刪除檔案復活

- **症狀**：執行 `git stash -u` 後嘗試 `git checkout <old-sha>` 失敗（tmp/ 權限阻擋），再 `git stash pop` 時把已經在先前 commit 刪除的檔案當成 **new file** 加回工作目錄
- **根因**：checkout 失敗過程中 git 可能已經部分把工作樹切到舊 sha；stash pop 還原的混雜了舊 sha 的檔案
- **修法**：`git reset HEAD <paths>` unstage，再 `rm -f <files>` 手動刪。`git clean -fd` 在 Windows 可能因為目錄權限失敗，但檔案層級 `rm` 通常可行
- **預防**：在有大量 `git rm` 刪除的分支上，避免用 `git stash -u` + `git checkout` 切到歷史 commit 比對；改用 `git worktree add` 或 `git show <sha>:<path>`
- **相關事件**：M15 Phase 3 (voice 移除) 期間，嘗試比對 pre-M15 的 CLI 行為時觸發
- **日期**：2026-04-18

---
