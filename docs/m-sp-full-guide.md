# M-SP-FULL 使用手冊

> M-SP-FULL（2026-05-10 完成）三大新能力的操作手冊。
>
> 基礎觀念（M-SP 是什麼、29 個 section、優先序、變數插值）見 `docs/customizing-system-prompt.md`。本檔聚焦三件事：
> - **per-cwd snapshot**：daemon 多 project 場景每個 cwd 各自獨立的 snapshot
> - **`system-prompt-override.md` / `system-prompt-append.md`**：一檔換整個主 prompt 或在尾巴追加
> - **5 個 sub-LLM prompt**：`cron-parser` / `memory-selector` / `verification-agent` / `tool-use-summary` / `buddy-companion`

---

## 1. 一頁速覽

| 能力 | 一句話 | 你要動手嗎？ |
|------|--------|------------|
| Per-cwd snapshot | daemon 在不同 project attach 時各自載入該 cwd 的 system prompt 檔 | 不用，自動。原本壞掉的 per-project 覆蓋現在真的會 work |
| `system-prompt-override.md` | 整段替代 default 主 prompt（29 section 拼成的那一坨） | 想換整套人格時編這個檔 |
| `system-prompt-append.md` | 追加在最後（不蓋既有內容） | 想加團隊規範 / 安全守則 / 額外指令時建這個檔 |
| 5 sub-LLM prompts | cron / memory selector / verification / tool summary / buddy 子 LLM 系統提示 | 想改子系統口吻或行為時編 `~/.my-agent/system-prompt/subllm/<id>.md` |

> 三條通道**獨立**：override 蓋整段主 prompt，section 檔（29 個）蓋單段，append 純追加；同時存在會疊加。

---

## 2. Quickstart — 三個常見情境

每個情境給：**指令 → 預期效果 → 驗證 → 還原**。所有改動都需要**開新 session** 才生效（snapshot 在 session 啟動時凍結）。

### 情境 A：把預設人格整套換成「Linus 風格 reviewer」

第一次跑 my-agent 時，`~/.my-agent/system-prompt-override.md` 會自動 seed 成一份完整 default 拷貝（29 個 section 拼出來）— 直接編這個檔即可。

**bash / zsh：**

    # 1. 確認 seed 已建好（沒有就先跑一次冒煙）
    ls ~/.my-agent/system-prompt-override.md || ./cli -p "hi"

    # 2. 整段替換成你的人格
    cat > ~/.my-agent/system-prompt-override.md <<'EOF'
    You are a Linus Torvalds-style code reviewer.
    Your tone is blunt, surgical, and zero patience for sloppiness.
    When you spot a bug you say it directly. No sandwich feedback.

    Tools available follow the standard my-agent set.
    Output in 繁體中文 by default.
    EOF

    # 3. 重啟 session
    ./cli -p "review src/foo.ts"

**PowerShell：**

    if (-not (Test-Path "$env:USERPROFILE\.my-agent\system-prompt-override.md")) { .\cli.exe -p "hi" }
    @"
    You are a Linus Torvalds-style code reviewer.
    ...
    "@ | Set-Content -Path "$env:USERPROFILE\.my-agent\system-prompt-override.md" -Encoding utf8

**預期效果**：所有 29 個 section（intro / system / doing-tasks / actions / using-tools …）整段被你寫的內容取代。memory 注入、user-profile、env-info 等動態段仍會由程式注入。

**驗證**：

    bun scripts/dump-system-prompt.ts | head -50

dump 出來的 `intro` 段會看到你寫的字而不是 my-agent default。

> ⚠️ dump script 目前不會單獨印 override.md 內容（只印各 section）；要看 override 是否生效，看任一 section（如 `intro`）是否還是 default 即可判斷。

**還原**：刪掉檔案，下次啟動會重 seed 完整 default：

    rm ~/.my-agent/system-prompt-override.md
    ./cli -p "hi"   # 重 seed

> 空字串或純 HTML 註解（`<!-- ... -->`）都視為「未啟用」→ 走 default。所以你可以整檔註解掉暫時停用而不刪檔。

---

### 情境 B：在現有人格後追加一段團隊規範

`system-prompt-append.md` **不會 seed**（沒這個需求拿 default 當起點），要自己建。

    cat > ~/.my-agent/system-prompt-append.md <<'EOF'
    ## 團隊規範
    - 修 bug 必須附 regression test
    - commit 訊息一律繁體中文
    - PR 描述要有「Test plan」章節
    EOF

**預期效果**：整段被附加在 default 主 prompt 末尾（在 user-profile / memory 等動態段**之前**）。Override 與 append **可同時存在**：先用 override 替整套人格，再用 append 補規範。

**驗證**：開新 session 問「你的工作守則有哪些？」應該會聽到團隊規範被引述。

**還原**：刪檔即可。

---

### 情境 C：把 buddy 桌寵的口吻改成貓奴語氣

5 個 sub-LLM prompt 在 `~/.my-agent/system-prompt/subllm/` 子目錄下，首次啟動會 seed 預設值。

    # 看一眼預設長什麼樣（保留變數佔位符）
    cat ~/.my-agent/system-prompt/subllm/buddy-companion.md

    # 改寫
    cat > ~/.my-agent/system-prompt/subllm/buddy-companion.md <<'EOF'
    # Companion

    A small {species} named {name} curls up next to the user's input box,
    occasionally meowing little observations in a speech bubble. You are NOT
    {name} — {name} is a separate watcher with its own thoughts.

    When the user addresses {name} by name, its bubble answers. Your job
    that turn: respond in ONE line or stay quiet entirely. Never narrate
    what {name} would say — the bubble handles that.

    Tone: 貓奴口吻，會用「喵～」「鏟屎官」之類的詞。
    EOF

`{name}` / `{species}` 會被當前 companion 物件代入。**不識別的變數原樣保留**（例如打成 `{Name}` 大小寫錯就不會代入）。

**預期效果**：buddy 介紹注入時的口吻變成貓奴；main agent 仍維持原人格。

**驗證**：用一隻孵化過的 companion 開新 session，跟它說話看 bubble 反應。

**還原**：刪檔，下次啟動補寫回預設（`seedSystemPromptDirIfMissing` 會補寫缺檔，已存在的尊重使用者）。

---

## 3. 解析優先序總圖

三條通道，每條獨立判斷：

    主 prompt：
      per-project override (~/.my-agent/projects/<slug>/system-prompt-override.md)
        > global override   (~/.my-agent/system-prompt-override.md)
        > [若兩者都無] default 拼接 29 section（每 section 各自走下方優先序）

    個別 section（在 default 拼接路徑被使用）：
      per-project section (~/.my-agent/projects/<slug>/system-prompt/<file>)
        > global section    (~/.my-agent/system-prompt/<file>)
        > bundled default

    Append（追加在主 prompt 末尾）：
      per-project append (~/.my-agent/projects/<slug>/system-prompt-append.md)
        > global append     (~/.my-agent/system-prompt-append.md)
        > [若兩者都無] 不追加

關鍵性質：

- **Override 啟用 → 個別 section 檔失效**。因為 override 是「整段替代主 prompt」，不會再走 default 拼接路徑。
- **Override + append 可同時生效**：append 是另一條獨立通道，疊加在主 prompt（不論主 prompt 來自 override 或 default）後面。
- **Sub-LLM 是另一個世界**：5 個 sub-LLM 的 .md 跟 main system prompt 沒關係，由各自 call site（cronNlParser / verificationAgent / buddy/prompt 等）獨立讀。Override main prompt **不會影響** sub-LLM。
- **CLI flag 凌駕一切**：`--system-prompt <path>` 會跳過 hardcoded prefix 並使用該檔；override 不會被讀。

---

## 4. 5 個 Sub-LLM 詳解

每條檔案：`~/.my-agent/system-prompt/subllm/<id>.md`。Per-project 覆蓋路徑：`~/.my-agent/projects/<slug>/system-prompt/subllm/<id>.md`。

優先序與一般 section 相同：per-project > global > bundled fallback。**檔不存在 / 純空 → bundled fallback**；**檔存在但空字串 → 注入空字串**（loader 規約，故意留的「停用」語意）。

### 4.1 `cron-parser.md`

- **Call site**：`src/services/cron/cronNlParser.ts:30`
- **何時觸發**：使用者用 `/cron`、Discord cron、或自然語言時間描述要排程時，my-agent 會 spawn sub-LLM 把 NL 翻成 5-field cron。
- **預設行為**：要求 sub-LLM 輸出 `{cron, recurring, humanReadable}` 純 JSON，遵守 5-field 規則、避開 :00 / :30 整點。
- **變數**：無
- **改壞會怎樣**：sub-LLM 沒回 JSON → cron 解析失敗 → my-agent 報錯（不會 silent crash）。回到預設 → 刪檔重啟。
- **改寫範例**（簡化只保留 5-field cron 規格、刪 humanReadable 欄位 — 注意這需要同步改 call site 解析，故**不建議結構性改動**，僅改語氣 / 加範例可以）：

        You are a schedule parser. Convert NL → 5-field cron.

        Output ONLY this JSON: {"cron": "<5 fields>", "recurring": <bool>, "humanReadable": "<≤60 chars>"}

        Examples:
        - "every Tuesday at 9am" → {"cron": "0 9 * * 2", "recurring": true, ...}
        - "tomorrow 3pm" → fill dom/month with that date, recurring: false

### 4.2 `memory-selector.md`

- **Call site**：`src/utils/memdir/findRelevantMemories.ts:69`
- **何時觸發**：每次 user query 進來，sub-LLM 從可用 memory 檔列表中挑相關的（最多 `{maxFiles}` 個）。
- **預設行為**：保守挑選 — 不確定就不選；近期用過的工具的 API doc 不選，但對應的 warnings/gotchas 要選。
- **變數**：`{maxFiles}`（程式注入，通常為 5-10）
- **改壞會怎樣**：選太多 → context 爆 / cache miss；選太少 → relevant memory 沒進 context，agent 表現變差。
- **改寫場景**：想讓 agent 在某 project 更積極載入 memory（覆寫到 per-project 路徑，把「保守」改成「積極」）。

### 4.3 `verification-agent.md`

- **Call site**：`src/services/verification/verificationAgent.ts:10`
- **何時觸發**：verification subagent 啟動時（reviewer / tester 類 workflow）。
- **預設行為**：~70 行的 verification specialist prompt — 強調 try to break it、不可改 project、要做 adversarial probe。
- **變數**：`{BASH_TOOL_NAME}` `{WEB_FETCH_TOOL_NAME}`（程式注入工具實際名稱，目前是 `Bash` / `WebFetch`）
- **改壞會怎樣**：移除「DO NOT MODIFY THE PROJECT」段落 → verification subagent 可能直接動程式碼造成意外 commit。**改這檔最危險，建議只調語氣不動限制**。
- **改寫場景**：團隊有自己的 verification SOP，把預設換成內部 checklist。

### 4.4 `tool-use-summary.md`

- **Call site**：`toolUseSummary` 子 LLM（產生 mobile app 顯示的單行摘要）
- **何時觸發**：每組 tool calls 結束後，產生 ≤30 字 git-commit-subject 風格摘要。
- **預設行為**：過去式動詞 + 最具辨識性名詞，drop articles。
- **變數**：無
- **改壞會怎樣**：摘要過長被截斷 / 風格不一致；不影響功能。
- **改寫場景**：想要中文摘要，把 "Searched in auth/" 改成「搜尋 auth/」風格範例。

### 4.5 `buddy-companion.md`

- **Call site**：`src/buddy/prompt.ts:7`
- **何時觸發**：companion 已孵化且未 muted 時，main agent 每輪會收到這段 attachment 知道 buddy 存在但**不扮演**它。
- **預設行為**：說明 buddy 是獨立 watcher、user 直接喊名字時 main agent 應 step out 一行內回應、不要 narrate buddy 會說什麼。
- **變數**：`{name}` `{species}`（從當前 Companion 物件代入）
- **改壞會怎樣**：main agent 開始扮演 buddy（如果你刪掉「You're not {name}」那句）。
- **改寫場景**：見情境 C；或在桌寵專案 cwd 下放專屬版本（per-project 覆寫）。

---

## 5. 桌寵 / 多人格實戰

把上面三大能力組合起來實作「換 cwd → 換 persona」。

### 5.1 規劃

- 桌寵走 daemon mode（`./cli daemon`）
- 桌寵專屬 cwd 用獨立工作目錄（不要跟程式專案共用，避免 git root 污染）
- 在該 cwd 對應的 `~/.my-agent/projects/<slug>/` 下放 override.md + sub-LLM 覆寫

### 5.2 算 per-project slug

Slug 算法（`src/systemPromptFiles/paths.ts:77`）：

    slug = sanitizePath(findCanonicalGitRoot(cwd) ?? cwd)

也就是：

1. 找 cwd 上溯到的 canonical git root
2. 沒有 git → 直接用 cwd
3. 把 path 的 `\` `/` `:` 等 sanitize 成 `-`

兩個典型範例（**有 git**）：

    cwd = C:\Users\LOREN\Documents\_projects\my-agent
    git root = 同上
    slug = C--Users-LOREN-Documents--projects-my-agent

（**沒 git**，例如桌寵獨立 workspace）：

    cwd = C:\Users\LOREN\.my-agent\mascot-workspace
    git root = null
    slug = C--Users-LOREN--my-agent-mascot-workspace

實際算的最快方式 — 先建 `~/.my-agent/mascot-workspace`，跑一次 `./cli -p "hi"`，然後看 `~/.my-agent/projects/` 底下多出哪個目錄就是 slug：

**bash：**

    mkdir -p ~/.my-agent/mascot-workspace
    cd ~/.my-agent/mascot-workspace && ~/Documents/_projects/my-agent/cli -p "hi"
    ls -1 ~/.my-agent/projects/ | grep mascot

**PowerShell：**

    New-Item -ItemType Directory -Force "$env:USERPROFILE\.my-agent\mascot-workspace"
    Push-Location "$env:USERPROFILE\.my-agent\mascot-workspace"
    & "C:\Users\LOREN\Documents\_projects\my-agent\cli.exe" -p "hi"
    Pop-Location
    Get-ChildItem "$env:USERPROFILE\.my-agent\projects" | Where-Object Name -like "*mascot*"

### 5.3 寫桌寵 override.md

假設算出來的 slug 是 `C--Users-LOREN--my-agent-mascot-workspace`：

    SLUG="C--Users-LOREN--my-agent-mascot-workspace"
    DIR="$HOME/.my-agent/projects/$SLUG"
    mkdir -p "$DIR"

    cat > "$DIR/system-prompt-override.md" <<'EOF'
    你是「小橘」，一隻棲息在使用者桌面的橘貓助理。

    語氣：會在句末加「喵～」，遇到無聊任務會懶懶地敷衍；遇到有趣的程式碼會
    興奮起來。對使用者稱呼「鏟屎官」。

    工具集：標準 my-agent。可以讀檔、改檔、查 web、跑 Bash。
    安全：不可逆操作（rm / git push --force / drop database）必須先問一次。
    回覆語言：繁體中文預設。

    當下指令清楚時直接做，做完用一兩句報告。模糊時反問。
    EOF

### 5.4 桌寵專屬 buddy 覆寫

桌寵自己就是 mascot，buddy 是另一層（REPL 旁的小精靈）。如果你在桌寵 cwd 也想要小精靈走貓奴語氣：

    cat > "$DIR/system-prompt/subllm/buddy-companion.md" <<'EOF'
    # Companion

    A small {species} named {name} curls up beside the user, occasionally
    chirping in a speech bubble. You are NOT {name}.

    When user addresses {name} by name: respond in ONE line or stay silent.
    Tone: 貓奴口吻，會用喵 / 鏟屎官。
    EOF

> Per-project sub-LLM 覆寫**目錄結構與 global 一致** — `system-prompt/subllm/<id>.md`，不是 sibling 檔。

### 5.5 啟動 daemon 並 attach

daemon 怎麼啟動見 `docs/daemon-mode.md`。關鍵：daemon attach 時要把該 project 的 cwd 傳進去（M-SP-FULL Phase 1 的 `bootstrapDaemonContext(opts.cwd)` 會用它載對 snapshot）。桌寵 Electron 端的 `AgentSessionClient` 在 session 握手時就會帶 cwd。

### 5.6 同時跑 REPL 驗證隔離

開兩個 shell：

    # Shell A：桌寵 cwd
    cd ~/.my-agent/mascot-workspace
    ~/Documents/_projects/my-agent/cli -p "你好"
    # 預期：小橘語氣

    # Shell B：你的程式專案 cwd
    cd ~/Documents/_projects/my-agent
    ./cli -p "你好"
    # 預期：default my-agent 行為（除非該 project 也放了 override）

兩個 cwd 各自獨立的 snapshot — 桌寵 override 不會污染 REPL。

### 5.7 在桌寵人格後再追加安全規範

    cat > "$DIR/system-prompt-append.md" <<'EOF'
    ## 桌寵專屬安全
    - 不能執行 rm -rf、format、shutdown
    - 不能寄信、推 git 到遠端 — 先確認鏟屎官同意
    EOF

Override（小橘人格）+ append（安全規範）會疊加。

---

## 6. 驗證工具：`scripts/dump-system-prompt.ts`

兩種跑法（**目前不支援 `--cwd` flag**，使用 process cwd）：

    bun scripts/dump-system-prompt.ts                    # live：讀 snapshot（含 seed + 個別 section 檔）
    bun scripts/dump-system-prompt.ts --no-external      # bundled only（看 my-agent 內建預設原樣）

腳本會**逐個 section 印出當前生效的內容**。判讀技巧：

- 看 `intro` 等基本 section — 內容是 my-agent 預設 → 沒套到 override / 沒改個別檔
- 看 `intro` 等 section — 內容跟你改的個別 section 檔一致 → section 覆寫生效
- **看 override.md 是否生效**：`dump` 不直接印 override 的 raw 內容，但若 override 啟用，主 prompt 拼接路徑會被跳過 → dump 仍會印 default section（dump 是 best-effort，繞過 `getSystemPrompt()` 動態組裝）。要驗 override 是否真進入 LLM，看 daemon log 或開 session 直接問

要對比 default vs 你的覆寫差異：

    bun scripts/dump-system-prompt.ts --no-external > /tmp/default.txt
    bun scripts/dump-system-prompt.ts > /tmp/live.txt
    diff /tmp/default.txt /tmp/live.txt

> 想驗 per-project cwd 對應的 snapshot：目前要從該 cwd 啟動 my-agent，dump 會用 process cwd 算。完整 cross-cwd dump 是後續 enhancement，未在 M-SP-FULL 範圍。

---

## 7. 疑難排解

### Q1：改完 override.md 沒生效？

檢查清單：

1. **開新 session** — snapshot 在 session 啟動時凍結，REPL 改檔不影響當前對話
2. **檔案不是空 / 純註解** — 純空白或只剩 HTML 註解視為「未啟用」（`overrides.ts:64`）
3. **沒被 CLI flag 蓋掉** — `--system-prompt <path>` 比 override.md 優先
4. **daemon 路徑下 cwd 對齊** — `bootstrapDaemonContext()` 拿的是 `opts.cwd`，從桌寵 / SDK 端傳進來的；錯 cwd → 套錯 snapshot
5. **per-project vs global 路徑寫對** — per-project 是 `~/.my-agent/projects/<slug>/system-prompt-override.md`（注意 `system-prompt-` 前綴是檔名，**不是子目錄**）

### Q2：append.md 改了沒效果？

- **預設不 seed** — 第一次用要自己 `touch` + 寫
- 同樣空字串 / 純註解視為未啟用
- Append 加在主 prompt 後、user-profile / memory 等動態段**前**

### Q3：5 sub-LLM 改了沒效果？

- **路徑要在 `subllm/` 子目錄裡** — 不是 sibling
- 檔名要對：`cron-parser.md` / `memory-selector.md` / `verification-agent.md` / `tool-use-summary.md` / `buddy-companion.md`
- **變數用單花括號 `{x}`**；雙花括號 `{{x}}` 不識別會原樣保留
- **不識別的變數名也原樣保留**（例如打成 `{maxfiles}` 小寫不會代入）
- 該 sub-LLM 必須真的被觸發 — 例如 `cron-parser.md` 改了但你沒下 cron 指令，當然看不到效果

### Q4：升級 my-agent 後 default 改了，我的 override 怎麼跟？

**不會自動跟進**。設計上 override.md 是「使用者完全擁有」，升級不會 silently 改使用者檔。

要拿最新 default：

    cp ~/.my-agent/system-prompt-override.md ~/.my-agent/system-prompt-override.md.bak
    rm ~/.my-agent/system-prompt-override.md
    ./cli -p "hi"   # 重 seed
    diff ~/.my-agent/system-prompt-override.md.bak ~/.my-agent/system-prompt-override.md
    # 手動把你的客製化 merge 回新 default

個別 section 同理 — 刪檔重啟 → seed 補回最新預設。

### Q5：override 跟個別 section 檔同時存在？

Override 啟用 → 整段主 prompt 被 override 取代 → 29 個個別 section 檔（不論 global 或 per-project）**全部失效**。

要保留某些 section 客製：

- 方案 A：把 section 內容直接寫進 override.md（簡單但要自己維護）
- 方案 B：拿掉 override.md（刪 / 改空 / 改純註解），改用個別 section 檔

### Q6：怎麼知道 daemon 套到了哪份 override？

最直接：開 session 跟它說「請覆述你的系統提示前 200 字」。

或檢查 daemon log（`~/.my-agent/daemon.log`）— `[systemPromptFiles]` 前綴的訊息會記錄 seed / load 過程。

### Q7：per-project slug 算錯了怎麼辦？

最簡單：跑一次 `./cli -p "hi"` 從該 cwd，看 `~/.my-agent/projects/` 多出哪個目錄就是。或對該 cwd 跑：

    bun -e "import('./src/systemPromptFiles/paths.js').then(m => console.log(m.getProjectSlugForCwd(process.cwd())))"

---

## 8. 進階：與 CLI flag / SDK 鉤子的關係

### `--system-prompt <path>` CLI flag

- 比 override.md 優先
- 啟用時 hardcoded CLI prefix（「You are a my-agent agent...」）會被自動跳過（M-SP-FULL Phase 2 配套修正，commit cbb0160 / 9ae5796）
- llamacpp adapter 的 `streamWithRetryOnEmptyTool` retry nudge 也會跳過（commit 4f5de5a），避免人格被預設 retry 行為蓋過

### SDK / daemon 鉤子

`projectRuntimeFactory.ts:89` 在建 runner 時會：

1. `loadProjectPromptOverrides(opts.cwd)` 讀 override / append
2. 注入到 runner 的 `customSystemPrompt` / `appendSystemPrompt`
3. 對應 ask() API 的兩個鉤子

這就是為什麼 daemon 多 project 場景現在能 work — 鉤子真的接上了（Phase 0 的 bug #2 修復）。

### per-cwd snapshot 細節

- `snapshot.ts` 的 `cachedSnapshot` 從 module-level singleton 改成 `Map<projectKey, snapshot>`（commit cbb0160）
- `queryContext.ts:fetchSystemPromptParts()` 用 AsyncLocalStorage 把當前 cwd 注入呼叫鏈
- `getExternalSection()` 從 ALS 讀 cwd，所以**所有 sub-LLM call site 不用改簽名**也能拿到正確 cwd 的 section
- REPL 路徑（無 cwd 參數）走 process cwd，跟舊行為一致

---

## 9. 相關文件

- `docs/customizing-system-prompt.md` — M-SP 基礎、29 個 section 表、變數插值清單、例外條件
- `docs/plans/M-SP-FULL.md` — M-SP-FULL plan 全文
- `docs/adr.md` — ADR-008-A（per-cwd snapshot 設計決策）
- `docs/prompt-inventory.md` — 全 prompt 索引（標註各條外部化狀態）
- `~/.my-agent/system-prompt/README.md` — seed 自動寫入的速查指引

---

最後更新：2026-05-10（M-SP-FULL 完成當天）
