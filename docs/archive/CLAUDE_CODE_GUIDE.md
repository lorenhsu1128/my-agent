# CLAUDE_CODE_GUIDE.md — FreeHermes 開發工作流程使用指南

## 這份文件是什麼

這是給**人類開發者（你）**閱讀的操作手冊。它說明如何使用 Claude Code 作為開發工具，搭配本專案預先設計的規範體系（CLAUDE.md、TODO.md、LESSONS.md、skills、hooks、commands、agents），來逐步開發 FreeHermes 專案。

Claude Code 不需要讀這份文件 — 它讀的是 CLAUDE.md。

---

## 目錄

1. [初次設定](#初次設定)
2. [每日開發流程](#每日開發流程)
3. [自訂指令速查表](#自訂指令速查表)
4. [Agents 使用方式](#agents-使用方式)
5. [自動化機制說明](#自動化機制說明)
6. [檔案體系說明](#檔案體系說明)
7. [常見情境操作](#常見情境操作)
8. [疑難排解](#疑難排解)

---

## 初次設定

### 步驟一：準備 my-agent 專案

```bash
# 複製 my-agent 倉庫
git clone https://github.com/paoloanzn/my-agent.git
cd my-agent
bun install

# 驗證可以建構
bun run build
./cli -p "hello"    # 需要 ANTHROPIC_API_KEY
```

### 步驟二：複製 Hermes Agent 作為參考

```bash
# 在 my-agent 目錄內
mkdir reference
git clone https://github.com/NousResearch/hermes-agent.git reference/hermes-agent

# 加入 .gitignore 避免提交
echo "reference/" >> .gitignore
```

### 步驟三：放入規範檔案

```bash
# 解壓規範包
unzip freehermes-spec.zip

# 複製所有檔案到專案根目錄
cp freehermes-spec/CLAUDE.md .
cp freehermes-spec/TODO.md .
cp freehermes-spec/LESSONS.md .
cp -r freehermes-spec/skills .
cp -r freehermes-spec/.claude .

# 確保 hooks 可執行
chmod +x .claude/hooks/*.sh
```

### 步驟四：準備本地模型環境

```bash
conda activate aiagent

# 安裝 Ollama（如果還沒有）
curl -fsSL https://ollama.com/install.sh | sh

# 拉取測試用模型
ollama pull qwen3.5:9b

# 啟動 Ollama
ollama serve &

# 安裝 LiteLLM proxy
pip install litellm

# 啟動 LiteLLM（開發時需要持續運行）
litellm --model ollama/qwen3.5:9b --port 4000 --drop_params &
```

### 步驟五：初始提交

```bash
git add CLAUDE.md TODO.md LESSONS.md skills/ .claude/ .gitignore
git commit -m "docs: 加入 FreeHermes 專案規範、skills、hooks、commands、agents"
```

### 步驟六：驗證一切就緒

```bash
# 啟動 Claude Code
claude

# 在 Claude Code 中執行
/project-status
```

你應該會看到：TODO 進度、git 狀態、typecheck 結果、Ollama 和 LiteLLM 的連線狀態。如果一切正常，你就準備好開始開發了。

---

## 每日開發流程

### 開始一天的工作

```bash
# 1. 啟動必要的背景服務
conda activate aiagent
ollama serve &                    # 如果還沒啟動
litellm --model ollama/qwen3.5:9b --port 4000 --drop_params &  # 如果還沒啟動

# 2. 進入專案目錄，啟動 Claude Code
cd /path/to/my-agent
claude
```

### 讓 Claude Code 開始工作

最簡單的方式 — 一個指令就好：

```
/project-next
```

Claude Code 會自動：
1. 讀取 CLAUDE.md（理解專案規則）
2. 讀取 LESSONS.md（了解過去的教訓）
3. 讀取 TODO.md（找到下一個未完成的任務）
4. 載入相關的 skill
5. 開始執行任務
6. 遇到架構決策時停下來問你
7. 完成後 commit 並更新 TODO.md
8. 階段結束時評估是否需要建立新 skill

### 你需要做的事

在 Claude Code 自己跑的過程中，你主要做三件事：

1. **回答架構決策問題** — Claude Code 會提出 2-3 個方案，你選一個
2. **確認 skill 建立提案** — Claude Code 建議建立新 skill 時，你說好或不好
3. **在階段結束時審查** — Claude Code 完成一個階段後會請你 review

### 結束一天的工作

不需要特別操作。Claude Code 的 session 結束時，notification hook 會自動在 TODO.md 記錄 session 摘要。下次啟動時，Claude Code 會從 TODO.md 和 git log 接續進度。

---

## 自訂指令速查表

| 指令 | 何時使用 | Claude Code 會做什麼 |
|------|---------|-------------------|
| `/project-next` | 開始工作或繼續工作 | 找下一個任務 → 讀教訓 → 載入 skill → 執行 → 測試 → commit |
| `/project-status` | 想看現在進度 | 報告 TODO 完成率、最近 commit、typecheck、服務狀態 |
| `/project-test` | 想跑完整測試 | typecheck → 單元測試 → 整合測試 → 建構檢查 |
| `/project-review-hermes` | 想了解 Hermes 某個功能 | 分析 Hermes 原始碼 → 比對 my-agent → 提出實作方案 |
| `/project-create-skill` | 想手動建立 skill | 在 skills/ 下建立新的 SKILL.md |

### 使用範例

```
# 最常用 — 就讓它自己跑
/project-next

# 想看看現在整體狀況
/project-status

# 想在開始 M2 之前先了解 Hermes 的記憶系統
/project-review-hermes
> 我要看 memory 模組

# 跑完一輪開發後想驗證
/project-test

# 把剛才學到的知識記錄下來
/project-create-skill
> 建立一個關於 Bun SSE 串流解析的 skill
```

---

## Subagents — 不是手動 slash command

`.claude/agents/` 下的 subagent（`reviewer`、`tester`）**不是** 使用者手動喚起的 slash command。它們由 Claude Code 依任務情境自動調度，或在主 agent 認為需要時透過 Task tool 明確指定 `subagent_type` 啟動。

使用者需要做的只是**告訴 Claude Code 你的意圖**，例如：
- 「這階段做完了，幫我審查一下」→ Claude Code 會啟動 `reviewer`
- 「幫我測試一下這個功能的邊界情況」→ Claude Code 會啟動 `tester`

### reviewer 的職責

適合的觸發時機：
- 完成一個階段後審查所有變更
- 合併前的最後檢查
- 對某段程式碼品質有疑慮

reviewer 的流程：
- 先讀 LESSONS.md 確認沒有重犯舊錯
- 跑 git diff、typecheck、測試
- 逐項檢查架構合規、程式碼品質、整合安全、測試覆蓋
- 給出 APPROVE / REQUEST CHANGES / NEEDS DISCUSSION 的結論

### tester 的職責

適合的觸發時機：
- 一個功能剛完成、想徹底測試
- 整合測試需要獨立驗證的部分
- 想測試邊界情況與錯誤處理

tester 的流程：
- 先讀 LESSONS.md 了解已知問題
- 檢查環境（Bun、llama.cpp）
- 系統性地測試功能、回歸、邊界情況
- 輸出結構化的測試報告

### 切換回一般模式

結束 agent 後，開一個新 session 或直接給一般指令，Claude Code 就會回到預設模式。

---

## 自動化機制說明

### Hooks — 在背景自動運行

你不需要做任何事情來觸發這些 — 它們是自動的。

| Hook | 做了什麼 | 你會看到什麼 |
|------|---------|------------|
| **conda 環境檢查** | 每次 Claude Code 要執行 shell 指令前，檢查 conda aiagent 是否啟用 | 如果沒啟用，你會看到錯誤訊息，指令會被阻擋 |
| **自動 typecheck** | 每次 Claude Code 編輯 .ts/.tsx 檔案後，自動執行 `bun run typecheck` | 你會在輸出中看到 ✅ 或 ❌ |
| **Session 結束通知** | Session 結束時自動記錄進度到 TODO.md | TODO.md 底部會多一行 session 記錄。如果你的系統支援，你會收到桌面通知 |

### 權限 — 什麼不需要確認、什麼會被擋

**自動放行**（Claude Code 可以直接做，不問你）：
- 讀取任何檔案
- 在 `src/services/providers/`、`tests/`、`skills/` 寫入和編輯
- 修改 TODO.md、LESSONS.md
- 執行 conda、bun、git、curl、ollama、litellm 等指令

**會被拒絕**（Claude Code 做不了）：
- `rm -rf`、`sudo`、`chmod`
- 直接修改 `src/QueryEngine.ts` 或 `src/Tool.ts`
- 寫入 `reference/` 目錄

**需要你確認**（不在上述清單中的操作）：
- 修改 CLAUDE.md 本身
- 在 `src/` 的其他目錄寫入新檔案
- 執行不在預核准清單中的 shell 指令

---

## 檔案體系說明

### 你需要手動維護的檔案

| 檔案 | 你要做什麼 |
|------|----------|
| `CLAUDE.md` | 更新架構決策（ADR）、修改黃金規則（如有需要） |
| `TODO.md` | 定義新的里程碑結構、規劃未來的階段 |
| `LESSONS.md` | 補充你自己觀察到的教訓（Claude Code 也會自動寫入） |

### Claude Code 自動維護的檔案

| 檔案 | Claude Code 做什麼 |
|------|-----------------|
| `CLAUDE.md` 開發日誌區 | 附加 session 摘要 |
| `TODO.md` 任務狀態 | 勾選已完成的任務 |
| `TODO.md` session 日誌 | 附加 session 記錄 |
| `LESSONS.md` | 附加新發現的教訓 |
| `skills/` | 建立新的 skill（你確認後） |

### 你不需要碰的檔案

| 檔案 | 說明 |
|------|------|
| `.claude/settings.json` | 權限和 hooks 設定，初始設好後通常不需改 |
| `.claude/hooks/*.sh` | 自動化腳本，除非有 bug 否則不需要碰 |
| `.claude/commands/*.md` | 自訂指令定義，除非要修改指令行為 |
| `.claude/agents/*.md` | Agent 定義，除非要修改審查/測試標準 |

---

## 常見情境操作

### 情境 1：「我剛開始，完全不知道從哪裡下手」

```bash
claude
```
```
/project-next
```

就這樣。Claude Code 會從 TODO.md 的第一個任務開始。

### 情境 2：「Claude Code 跑一半我想中斷」

直接按 `Ctrl+C`，或輸入新的訊息。Claude Code 會停下當前工作。進度已經在 git 和 TODO.md 中，下次 `/project-next` 會接續。

### 情境 3：「我覺得 Claude Code 的某個決定不對」

告訴它：
```
停下來。你剛才在 toolCallTranslator.ts 中的做法有問題，
因為 [你的理由]。請改用 [你想要的方式]。
```

它會修改。如果修改涉及架構變更，它會再次提出方案讓你確認。

### 情境 4：「我想跳過目前的任務，先做後面的」

直接告訴它：
```
跳過目前的任務，先處理階段三的串流整合。
```

它會去 TODO.md 找到那個任務開始做。記得之後回來把跳過的任務補完。

### 情境 5：「我想手動寫一些程式碼」

完全可以。你直接在編輯器中改程式碼，然後下次啟動 Claude Code 時它會從 git diff 看到你的變更。你可以說：
```
我剛才手動修改了 src/services/providers/litellm.ts，
幫我檢查有沒有問題，然後繼續下一個任務。
```

### 情境 6：「我想加入一個 TODO.md 裡沒有的新功能」

兩種方式：

**方式 A：你自己加到 TODO.md**
打開 TODO.md，在適當的階段下加入 `- [ ] 你的新任務`，然後 `/project-next`。

**方式 B：直接告訴 Claude Code**
```
我想在 provider 系統中加入 OpenRouter 支援。
幫我在 TODO.md 中加入相關任務，然後開始做。
```

### 情境 7：「我想讓 Claude Code 分析 Hermes 的某個功能，但還不要實作」

```
/project-review-hermes
```
然後指定模組（provider、memory、tools、cron、gateway、skills、agent）。

Claude Code 會分析完後提出實作方案，等你確認才會動手。

### 情境 8：「LiteLLM 或 Ollama 掛了」

```
/project-status
```

會顯示服務狀態。然後在另一個終端重啟：

```bash
# 重啟 Ollama
ollama serve &

# 重啟 LiteLLM
litellm --model ollama/qwen3.5:9b --port 4000 --drop_params &
```

回到 Claude Code 繼續工作。

### 情境 9：「我想看 Claude Code 過去犯了什麼錯」

直接打開 `LESSONS.md`。所有教訓都按分類記錄在那裡。

或者在 Claude Code 中問：
```
讀取 LESSONS.md，告訴我目前記錄了哪些教訓，
以及哪些是最重要的。
```

### 情境 10：「我想在新電腦上繼續開發」

```bash
git clone [你的 repo]
cd my-agent
bun install

# 重新 clone Hermes 參考
mkdir reference
git clone https://github.com/NousResearch/hermes-agent.git reference/hermes-agent

# 安裝本地模型環境
conda activate aiagent
ollama pull qwen3.5:9b

# 啟動 Claude Code
claude
/project-status    # 確認狀態
/project-next      # 繼續開發
```

所有進度都在 git 中（CLAUDE.md 開發日誌、TODO.md 任務狀態、LESSONS.md 教訓、skills/）。

---

## 疑難排解

### Claude Code 啟動時沒有讀取 CLAUDE.md

確認 `CLAUDE.md` 在專案根目錄（`my-agent/CLAUDE.md`），且你是在這個目錄中啟動 `claude` 的。

### Hooks 沒有觸發

```bash
# 確認 hooks 有執行權限
chmod +x .claude/hooks/*.sh

# 確認 settings.json 格式正確
cat .claude/settings.json | python3 -m json.tool
```

### `/project-next` 說找不到任務

打開 TODO.md 確認有 `- [ ]` 開頭的行。如果全部都勾完了，你需要定義下一個里程碑的任務。

### typecheck 一直失敗

```bash
conda activate aiagent
bun run typecheck 2>&1 | head -30
```

看具體的錯誤訊息。常見原因：
- 新檔案的 import 路徑錯誤
- 型別定義不完整
- 依賴沒有安裝（`bun install`）

### Claude Code 修改了不該改的核心檔案

`settings.json` 的 deny 規則應該會阻擋。如果它繞過了：
```bash
git diff src/QueryEngine.ts   # 檢查是否被改
git checkout src/QueryEngine.ts   # 回退
```

然後在 LESSONS.md 記錄這個事件，並強化 CLAUDE.md 的規則。

### conda 環境問題

```bash
# 確認環境存在
conda env list

# 如果不存在，建立它
conda create -n aiagent python=3.11
conda activate aiagent
pip install litellm
```

---

## 附錄：完整檔案清單

```
my-agent/
├── CLAUDE.md                              # 專案規範（Claude Code 讀取）
├── CLAUDE_CODE_GUIDE.md                   # 本使用指南（你讀取）
├── TODO.md                                # 任務追蹤
├── LESSONS.md                             # 教訓記錄
├── .claude/
│   ├── settings.json                      # 權限與 hooks 設定
│   ├── commands/
│   │   ├── project-next.md                # /project-next
│   │   ├── project-status.md              # /project-status
│   │   ├── project-test.md                # /project-test
│   │   ├── project-review-hermes.md       # /project-review-hermes
│   │   └── project-create-skill.md        # /project-create-skill
│   ├── agents/
│   │   ├── reviewer.md                    # subagent: reviewer（由 Claude Code 自動調度）
│   │   └── tester.md                      # subagent: tester（由 Claude Code 自動調度）
│   └── hooks/
│       ├── pre-tool-use-conda.sh          # 自動 conda 檢查
│       ├── post-tool-use-typecheck.sh     # 自動 typecheck
│       └── notification-session-end.sh    # Session 結束通知
├── skills/
│   ├── freecode-architecture/SKILL.md     # my-agent 架構導覽
│   ├── hermes-architecture/SKILL.md       # Hermes 架構參考
│   ├── provider-system/SKILL.md           # Provider 系統設計
│   ├── tool-call-adapter/SKILL.md         # 工具呼叫轉譯
│   ├── litellm-integration/SKILL.md       # LiteLLM 整合
│   ├── testing-guide/SKILL.md             # 測試指南
│   └── (Claude Code 會在此自動建立新 skills)
├── reference/
│   └── hermes-agent/                      # Hermes 原始碼（唯讀、.gitignore）
├── src/                                   # my-agent 原始碼
└── tests/                                 # 測試
```
