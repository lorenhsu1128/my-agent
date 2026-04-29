# M-PROMPT-CORRUPTION-HUNT

cli-dev compile binary 在 interactive TUI mode（PowerShell ConPTY）的 system prompt 在固定 byte offset **31350** 出現 4-byte → 8-9-byte corruption（含 NULL byte 或其他高 unicode），配 image multimodal 觸發 llama.cpp `Failed to tokenize prompt` 400 error。

> 狀態：**bandaid 已上 production**（adapter `deepSanitizeStrings` 剝 C0 控制字元）；root cause 未找到。本檔記錄完整調查過程，供後續接手。

## 症狀首發

**2026-04-29**，使用者把圖片拖進 cli-dev TUI 問「這張圖什麼內容」：

```
❯ [Image #1] 這張圖片的內容是甚麼?
  ⎿  [Image #1]
  ⎿  API Error: 400 {"type":"error","error":{"type":"api_error","message":"llama.cpp error (400):
     {\"error\":{\"code\":400,\"message\":\"Failed to tokenize prompt\",\"type\":\"invalid_request_error\"}}"}}
```

連 plain text `你好` 也壞 — 後來確認是 conversation history 帶有壞掉的 image turn 連坐。

## 調查時間軸

### Phase 1：誤判 vision flag closure

最初懷疑 `vision: cfg.vision.enabled` 在 adapter 啟動時烘進 closure（ADR-008 凍結 snapshot），重啟 session 後沒生效。寫了直接 adapter 測試證明 closure 路徑正確：

```ts
const llamaCfg = getLlamaCppConfig('qwen3.5-9b')
// llamaCfg.vision: true ✓
const adapterFetch = createLlamaCppFetch(llamaCfg)
// captured request multipart parts: ['text', 'image_url']
// PASS: image_url multipart sent
```

→ vision flag **沒問題**。

### Phase 2：誤判 daemon stale snapshot

接著懷疑 daemon process 比 jsonc 早起、snapshot 沒抓到新 vision=true。檢查 daemon 啟動時間 vs jsonc 最後 mtime 確實有重疊。kill daemon 後 user 改用 standalone bun run dev → vision 真的 work（粉紅色 3D 人偶被正確描述）。

但又開 daemon 後 vision 又壞 → 以為 daemon spawn 不帶 `--feature` flags 導致 feature 全 false。grep 發現 NATIVE_CLIPBOARD_IMAGE 是唯一 image 相關 feature，但只 gate macOS clipboard fast path（Windows 不走）。

→ feature flags **不是直接 cause**。

### Phase 3：發現 session JSONL 污染 + FTS db 連坐

session memory prefetch（M2 query-driven）會把舊 sessions 的 turn 拉進 new session 當 context。grep 5 個舊 session JSONL 都含 `assets/screenshot.png` 假路徑（之前 vision 沒 work 時模型 hallucinate 的），M2 prefetch 灌進 new session → 模型每次都「再次詢問」+ Read 假路徑。

清理：
- 5 個污染 JSONL 移到 `_quarantine_2026-04-29/`
- `session-index.db` + WAL 砍掉強制 rebuild
- Daemon pid 清理

→ memory 污染解決，但**核心 image bug 沒解** — fresh session 仍 fail。

### Phase 4：發現是 server tokenize fail，不是 my-agent 問題

server log 發現：
```
tokenize: error: number of bitmaps (1) does not match number of markers (0)
```

server 收到 1 張圖（bitmap），但 jinja 渲染後的 prompt 裡 0 個 image marker（`<|vision_start|><|image_pad|><|vision_end|>`）。

直接 curl 帶 image_url 給 server PASS（沒問題）。my-agent cli-dev 送的 request 卻 fail。差別在 **request shape**。

### Phase 5：Bisect request body

加 `LLAMA_DUMP_BODY` env-gated dump hook。User 重試後抓到實際送出的 body：
- 2 messages（system 31666 chars + user[text + image_url]）
- 12 tools

直接 replay 這個 body 給 server → FAIL 重現。Bisect：
- 移除 tools → 仍 FAIL（不是 tools 問題）
- 移除 system → 不同錯誤（不是 system 結構問題）
- 簡化 user content → FAIL/PASS 視 system 內容

最終 quartile bisect 縮到 system prompt **byte offset 31398-31399**（接近 31350）有觸發 byte。char-by-char 找到第 3399 byte 是 `\x00` NULL byte。

### Phase 6：找到 corruption 位置

```
'd72e111 chore: 加入 bu⠠㊁ʕ\x00lama-cpp 作為 git submodule'
```

原本應該是 `加入 buun-llama-cpp`，cli-dev 收到的是 `加入 bu⠠㊁ʕ\x00lama-cpp`。`un-l` (4 bytes ASCII) 變成 9 bytes 高 unicode + NULL。

NULL byte 進 server 純文字 turn 不會 fail（J 測試證實），但搭配 image multimodal 就 trigger marker counter mismatch。

### Phase 7：上 bandaid

adapter 在送 request 前 `deepSanitizeStrings` 整個 body，剝 `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`，跳過 `image_url.url` 與 `data` 欄位（base64 不該動）。重 build cli-dev，user 確認 image work。

第一次 commit：`43f0836`。

### Phase 8：深挖 root cause

#### 確認 corruption 來源

直接 `git log --oneline -n 5`：bytes 完全乾淨 `buun-llama-cpp` 沒問題。

Node `child_process.execFileSync` + execa 直接呼 git → 也乾淨。

raw `bun run` source → my-agent 的 `getGitStatus()` 呼出來 → 也乾淨。

cli-dev compile binary `-p` headless 模式 → system prompt 乾淨（dump bytes [31345..31370] = `'d72e111 chore: 加入 buu'`，buun-llama-cpp 完整）。

cli-dev compile binary stdin-piped 非 TTY 模式 → 也乾淨。

cli-dev compile binary **interactive TUI 模式（PowerShell ConPTY）** → corrupt at byte 31350。

#### 多次 dump 比對

- byte offset 100% 一致（31350）
- 同個 binary 多次 run 產生**相同**破壞 bytes（22:23-22:25 連續 4 個 dump 都是 `e2 a6 a0 e5 a2 81 c9 ba`）
- 不同 binary build 產生**不同**破壞 bytes（22:06 build 是 `e2 a0 a0 e3 8a 81 ca 95 00` 含 NUL，22:23+ build 是無 NUL 版本）

#### 排除 baked-in

grep cli-dev.exe 二進位內：
- ASCII `buun-llama-cpp`：0 hits
- ASCII `un-l`：29 hits（全是 `bun-logo` 之類無關字串）
- UTF-16LE / UTF-16BE 編碼版：0 hits
- 兩種 corruption byte sequence：**0 hits**
- `d72e111`：54 hits（全是版本號 `sha + d72e111 + 9` 拼出來，不是 changelog）

→ corruption bytes **不是 baked-in**，是 runtime 生成。

#### 排除 bun --compile 通用 bug

寫 minimal test：

```ts
// _corr-min.ts
import { execa } from 'execa'
const r = await execa('git', ['--no-optional-locks', 'log', '--oneline', '-n', '5'])
const log = r.stdout
const i = log.indexOf('chore: ')
console.log('hex:', Buffer.from(log.slice(i, i+50), 'utf-8').toString('hex'))
```

`bun build --compile --minify` → 跑出來：
```
chore: 加入 buun-llama-cpp 作為 git submodule
hex: 63686f72653a20e58aa0e585a5206275756e2d6c6c616d612d63707020e4bd9c...
```

完全乾淨。所以 bug **不是** `bun build --compile` 通用問題，需要 my-agent 完整 module set + interactive mode 才復現。

## 已知 facts

| Fact | 證據 |
|---|---|
| Corruption byte offset 固定 31350 | 多 dump 比對 |
| 4 ASCII bytes (`un-l`) → 8-9 bytes 高 unicode + (有時) NUL | dump hex |
| 同 binary deterministic | 連續 4 次 run 相同 bytes |
| 不同 binary 不同 bytes | 22:06 vs 22:23 build 出來不同 |
| 只 interactive TUI mode 復現 | 所有 headless / piped 模式都乾淨 |
| Git source 乾淨 | xxd 直接 git log 確認 |
| execa / Node 直接讀也乾淨 | 多版本驗證 |
| Corruption 不在 baked binary | hex grep 0 hits |
| 不是 bun --compile 通用 bug | minimal compile 乾淨 |

## 嫌疑分類（M-CORR-4 待驗）

排除掉「bun --compile 通用 bug」後，剩下：

1. **某個 native module 在 interactive 才載入，寫超 buffer**
   - 候選：`modifiers-napi`（marked external，runtime require）、`image-processor-napi`、`url-handler-napi`、`audio-capture-napi`
   - 但 `modifiers-napi` 只 macOS prewarm；`image-processor-napi` 只 darwin 走 fast path
   - 仍可能：linker / loader 層面有 side effect
2. **Ink/React TUI render 過程的 string handling**
   - Interactive mode 才掛 React 元件樹
   - 某條 render path 可能用 unsafe string concat 或 buffer copy
3. **PowerShell ConPTY 特有的 stream interaction**
   - User 是 PowerShell 啟動 cli-dev，TTY 走 ConPTY
   - 走 mintty / Git Bash 是否復現未測（可能有差）
4. **Bun runtime 在 interactive (有 stdin 等候) 與 headless (一次性 stdin) 行為差異**
   - V8 string interning / heap allocation pattern 可能不同
   - 但這層通常不該外洩到使用者程式碼

## 已加診斷工具（adapter env-gated dump hooks）

留在 `src/services/api/llamacpp-fetch-adapter.ts`，預設不啟動：

```bash
# Dump 翻譯後 OpenAI body（base64 截短）— sanity check 工具呼叫 / 結構
LLAMA_DUMP_BODY=<dir>

# Dump pre-sanitize OpenAI body（含原始 byte，未過濾 C0）— 看 corruption 是否在 sanitize 前
LLAMA_DUMP_PRESANITIZE=<dir>

# Dump 入 adapter 的 raw HTTP body bytes + system array 元素分別
LLAMA_DUMP_RAWBODY=<dir>
```

## 已加 regression test

`tests/integration/llamacpp/sanitize-tokenizer.test.ts` — 11 個 case：
- NULL byte 剝
- C0 控制字元剝（除 `\t\n\r`）
- DEL 剝
- CJK / emoji / 高 unicode 保留
- 觀察到的 corruption pattern A/B 處理
- `image_url.url` 跳過
- `data`（base64 image source）跳過
- 31KB+ system prompt 含 corruption 整體 sanitize

## 還沒做的 root-cause 步驟

1. **觸發 interactive TUI 模式並開 dump**
   - User 端最直接（PowerShell + cli-dev + drag image + `LLAMA_DUMP_RAWBODY` env）
   - 自動化用 `winpty` 在當前環境 ASSERT 炸掉，待研究替代方案（mintty / `script` POSIX）
2. **取得 interactive 模式下 raw body dump**，比對 stdin-piped 模式 dump 找 differential
3. **若 raw body 已含 corruption** → 在 SDK 入口前加 instrumentation 抓 caller stack
4. **若 raw body 乾淨** → 問題在 adapter 之後，但目前 adapter 已 sanitize 不該再壞
5. **嫌疑 (1) native module**：寫 minimal interactive Ink TUI（不含 my-agent 邏輯，只 import 同樣的 napi modules）+ 同樣 31KB 字串 → 看是否復現
6. **嫌疑 (2) Ink/React**：嘗試 `MY_AGENT_NO_TUI=1` 或類似 flag 跑 interactive but 不掛 Ink → 看是否復現

## 完成標準（暫未達成）

- [ ] 不需 `deepSanitizeStrings` 的 cli-dev 也能正確處理含 image 的 turn
- [ ] dump body 在 byte 31350 看到的就是 git log 原始 bytes（buun-llama-cpp 完整）
- [ ] 在 LESSONS.md 該條補上 root cause + 修法
- [x] 寫 regression test：`tests/integration/llamacpp/sanitize-tokenizer.test.ts`

## Commit 記錄

| Hash | 內容 |
|---|---|
| `43f0836` | 初版 bandaid + LLAMA_DUMP_BODY 工具 + LESSONS / TODO 記錄 |
| `d83d171` | sanitize key-skip 修正 + LLAMA_DUMP_PRESANITIZE / RAWBODY 工具 + 11 unit test + TODO 進度 |
| 本 commit | 完整調查過程文件化 |

## 相關檔案

- `src/services/api/llamacpp-fetch-adapter.ts` — bandaid + 診斷工具實作
- `tests/integration/llamacpp/sanitize-tokenizer.test.ts` — regression test
- `LESSONS.md` 「cli-dev compile binary 在 system prompt 固定 byte offset 31350 corrupt 4 bytes」條目
- `TODO.md` 「待挖：M-PROMPT-CORRUPTION-HUNT」段落
