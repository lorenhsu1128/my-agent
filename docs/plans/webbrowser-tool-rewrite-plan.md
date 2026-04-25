# WebBrowserTool 重構計畫：應付 Google Maps 級別的 JS 重網站

## Context

目前的 `src/tools/WebBrowserTool/` 在操作 Google Maps 這類「重 JS / SPA / canvas」網站時成功率低。經調查（詳見下文），根因有三類：

1. **缺 wait 策略**：`click` / `type` / `navigate` 完成後立刻返回，不等 network idle、不等 DOM mutation，SPA 路由切換後 snapshot 抓到的是舊畫面或半成品
2. **a11y snapshot 盲區**：用 `interestingOnly: true` 漏掉動態注入的控制；canvas / WebGL（整張地圖）本來就沒 ARIA role；virtual ARIA node 常 throw `VirtualNodeError`
3. **缺純像素操作原語**：對 canvas 類內容（地圖、遊戲、自訂繪圖 UI）無法透過 ref 操作，現有 `vision` action 只回文字描述，沒有「vision 回座標 → 點擊該座標」的閉環

本計畫採 **增量擴充** 策略（對應使用者的 Scope 選擇 A+C + JS API prompt 教學），保留既有 13 個 action 與 ref 機制，新增 wait 層、shadow-DOM-aware snapshot、vision-coordinate 點擊、以及 Google Maps 這類具備全域 JS API 網站的 escape-hatch pattern。完全不換 browser 底座（維持 puppeteer-core，遵循 ADR-011）。

不做：Playwright MCP 外部 server 整合、Stagehand 風格 act/extract/observe NL 原語、vision-first 重寫。

## 檢視結論（現狀）

| 問題 | 位置 | 觀察 |
|---|---|---|
| navigate 只等 domcontentloaded | `actions.ts:68-71` | Maps tiles / service worker / 3P JS 未載入 |
| click 無 wait | `actions.ts:105,109` | `delay:10` 只是 mouse down/up 間隔 |
| type 無 wait | `actions.ts:131,143` | 輸入完立刻返回 |
| scroll 無等 lazy load | `actions.ts:150-155` | 無限捲動 + 懶載入 會漏 |
| back 只等 domcontentloaded | `actions.ts:157-161` | 同 navigate |
| snapshot 用 interestingOnly | `a11y.ts:76-78` | 漏動態注入 node |
| INTERACTIVE_ROLES 固定 11 個 | `a11y.ts:55-67` | menu / tree / slider / tabpanel 等不在 |
| 不穿 shadow DOM | `a11y.ts:76` | 內部 widget 看不到 |
| VirtualNodeError 沒 escape | `a11y.ts:138-149` | 只丟錯，無 bounding-box 座標備援 |
| 無 vision-click 閉環 | `actions.ts:207-224` | vision 只回文字 |

## 實作內容（分 4 個 commit，每個自成邏輯單元）

### Commit 1 — wait 原語層（A 核心）

**新檔**：`src/tools/WebBrowserTool/waits.ts`

匯出：

- `waitForSettle(page, opts?)` — 綜合等待：(a) `page.waitForNetworkIdle({ idleTime: 500, timeout })` 優先；(b) 若未達，退而求其次跑 `Promise.race([networkIdle, quietDomMutation])`
- `waitForSelector(page, selector, opts?)` — wrap `page.waitForSelector`，帶 hidden / visible / timeout
- `waitForFunction(page, expr, opts?)` — wrap `page.waitForFunction`，`evaluate` 的等待版（例 `() => !!window.google?.maps`）
- `waitForUrlChange(page, pattern, opts?)` — 等 URL 變化（history API SPA 路由）
- `quietDomMutation(page, opts?)` — 注入 MutationObserver，連續 N ms 無 mutation 視為 settle

所有原語：預設 `timeout: 10_000`，統一回傳 `{ waited: boolean, strategy: string, elapsedMs: number }`，超時回 `waited: false` 但**不 throw**（讓 LLM 決定要不要重試）。

**改 `actions.ts`**：

- `navigate`：`waitUntil` 改 `'load'`（比 domcontentloaded 再等一層 onload），之後 best-effort 跑 `waitForSettle({ timeout: 3_000 })`；失敗不阻擋，附 `settle_status` 回傳欄位讓 LLM 知道
- `click` / `type` / `press` / `scroll` / `back`：動作後 best-effort 跑 `waitForSettle({ timeout: 2_000 })`；同樣回 `settle_status`
- 每個 action 的 input schema 新增 optional `wait_for`：
  - `wait_for.selector?: string` + `wait_for.state?: 'visible' | 'hidden'`
  - `wait_for.function?: string`（evaluate 等待條件）
  - `wait_for.timeout_ms?: number`（預設 10000）
  - `wait_for.url_matches?: string`（regex）
- 若 LLM 傳 `wait_for`，在 `waitForSettle` 之後再跑該條件

### Commit 2 — a11y snapshot 升級

**改 `a11y.ts`**：

- `takeSnapshot`：
  - 改用 `interestingOnly: false` **並**新增 `root` 選項支援局部快照（未來可對 shadow host 遞迴）
  - 擴增 `INTERACTIVE_ROLES`：加 `menu`、`menuitemcheckbox`、`menuitemradio`、`slider`、`spinbutton`、`treeitem`、`tab` 已有、`tabpanel`、`dialog`、`listbox`
  - 新增 `disabled` / `expanded` / `selected` / `pressed` state 到輸出，並反映在 ref 可用性（disabled 的不給 ref，省 context）
  - 新增 shadow DOM 穿透：先跑 `page.accessibility.snapshot()`，再用 `page.evaluate` 收集所有 shadowRoot host，對每個 host 再跑一次 `page.accessibility.snapshot({ root: hostHandle })` 並 inline 進樹狀輸出。Reference：puppeteer `accessibility.snapshot({ root })` 已支援；shadow host 枚舉可用 `document.querySelectorAll('*')` 過濾 `el.shadowRoot !== null` 再 dedupe open shadow
  - 回傳新增 `summary`：`{ interactive_count, form_count, has_dialog, has_shadow }` 供 LLM 快速判斷
- `refToElement` fallback 鏈末端：VirtualNodeError 改成 **先試 `boundingBox`**（有些 virtual node 還是回得到 box），有 box 就回 `{ handle: null, box, strategy: 'aria+coord' }`，**只有真的連 box 都拿不到才 throw**。配合現有 `click` / `type` 的 box fallback 路徑即可用

### Commit 3 — vision 座標閉環 + 原始座標操作（C 核心）

**改 `actions.ts` + schema**：

- 新 action `click_at`：
  - 輸入：`{ x: number, y: number, button?: 'left'|'right'|'middle', click_count?: number }`
  - 直接 `page.mouse.click(x, y, ...)`，無 ref 依賴
  - 動作後 best-effort settle
  - 用途：canvas / map 上的點擊、vision 回傳座標後的下一步
- 新 action `mouse_move`：`{ x, y }` → `page.mouse.move`（hover 觸發 tooltip / hover menu）
- 新 action `mouse_drag`：`{ from: {x,y}, to: {x,y}, steps?: number }` → 地圖拖曳、slider、自訂元件
- 新 action `wheel`：`{ x, y, delta_x, delta_y }` → canvas 區內捲動（地圖縮放）
- **升級 `vision` action**：
  - 輸入新增 `return_coordinates?: boolean`（預設 false 維持相容）
  - 當 `return_coordinates=true`：system prompt 改要求 vision model 回 `{ description, targets: [{ label, x, y, confidence }] }` JSON（以現有截圖的 viewport 像素座標）
  - `VisionClient` interface 新增 `locate(bytes, question): Promise<{ targets: Locate[] }>`，在 `AnthropicVisionClient.ts` 實作（Claude 3.5+ 對截圖 + bounding box 已夠用）
  - 輸出 `targets` 欄位可直接餵給下一步 `click_at`

**注意**：座標系要統一。puppeteer `page.screenshot()` 預設 viewport 1280×800，`page.mouse.click` 用的是 CSS 像素（與 viewport 相同，忽略 devicePixelRatio），兩者一致。文件要寫清楚 full_page screenshot 的座標與 viewport-only 不同（捲動過的部分需要先 scroll）。

### Commit 4 — prompt 更新 + JS API escape hatch 文件

**改 `src/tools/WebBrowserTool/prompt.ts`**：

新增段落「Handling JavaScript-heavy sites (Google Maps, Gmail, Notion, ...)」：

1. **先試 snapshot，看有沒有 ARIA ref** — 大部分 toolbar / search box / list 項即使在 SPA 也有 ref
2. **沒 ref、但有結構區域（canvas, map）** — 用 `screenshot` + `vision(return_coordinates=true)` → `click_at(x, y)`
3. **重要**：若網站暴露全域 JS API（`window.google.maps` / `window.app` / `window.__NEXT_DATA__`），優先用 `evaluate` 呼叫 API 而非點 UI：
   - 範例：`evaluate("map.setCenter({lat: 25.03, lng: 121.56}); map.setZoom(15)")` 比點放大鈕穩太多
   - 判定：navigate 後跑 `evaluate("Object.keys(window).filter(k => !k.startsWith('_') && !['chrome','document',...].includes(k)).slice(0,50)")` 嗅探全域變數
4. **等待規則**：
   - navigate 後如果頁面還在載入，用 `wait_for.function` 等關鍵全域變數（例 `() => !!window.google?.maps`）
   - 點擊觸發路由後，用 `wait_for.url_matches` 等 URL 變
   - 觸發懶載入後，用 `wait_for.selector` 等目標元素
5. **cookie / consent overlay**：navigate 後第一次 snapshot，若看到 dialog role，先處理它

**新檔**：`src/tools/WebBrowserTool/README.md` 補 `click_at` / `mouse_drag` / `wait_for` 範例，包含一個 Google Maps 完整範例（search "Taipei 101" → 看結果 → 點 directions）。

### 依賴 / 架構

- **無新 npm 依賴**（puppeteer-core 已支援所有需要的 API）
- 不改 `src/tools/WebBrowserTool/session.ts`（lifecycle 不變）
- 不改 `src/tools/WebBrowserTool/providers/`（3 provider 行為不變）
- 不改 `src/QueryEngine.ts` / `src/Tool.ts`（core 鎖）
- 不碰 `src/utils/vision/VisionClient.ts` 的抽象，僅擴 interface 加 `locate()`

## 關鍵檔案（以修改為主）

| 檔案 | 動作 | 主要改動 |
|---|---|---|
| `src/tools/WebBrowserTool/waits.ts` | 新建 | 5 個 wait 原語 |
| `src/tools/WebBrowserTool/actions.ts` | 改 | 所有 action 加 settle；新增 click_at / mouse_move / mouse_drag / wheel；vision 擴增 coordinates |
| `src/tools/WebBrowserTool/a11y.ts` | 改 | interestingOnly:false；shadow DOM；box fallback；擴 roles + state |
| `src/tools/WebBrowserTool/WebBrowserTool.ts` | 改 | discriminated union 新增 4 個 action；每個 action 加 `wait_for` optional |
| `src/tools/WebBrowserTool/prompt.ts` | 改 | 新增 SPA / Maps / JS API 段落 |
| `src/tools/WebBrowserTool/README.md` | 改 | 範例與座標系說明 |
| `src/utils/vision/VisionClient.ts` | 改 | 加 `locate()` |
| `src/utils/vision/AnthropicVisionClient.ts`（或實際檔名） | 改 | 實作 `locate()` |
| `tests/integration/web/...` | 新增 | wait / shadow-DOM / click_at 單測 |

## 驗證（Verification）

1. **typecheck**：`conda activate aiagent && bun run typecheck` 全綠
2. **單測**：`bun test tests/integration/web/` — 對 wait、shadow DOM snapshot、refToElement box fallback、click_at coordinate、vision locate 各加測試
3. **煙霧 1（SPA 路由）**：`./cli` 跑 prompt「開 github.com/lorenhsu1128，點 Repositories tab，回報第一個 repo 名」— 驗 wait_for.url_matches 路徑
4. **煙霧 2（Shadow DOM）**：對 YouTube 首頁 snapshot，確認 ytd-masthead 內側控制有 ref
5. **煙霧 3（Google Maps 關鍵任務）**：
   - A. `./cli` prompt「開 Google Maps，搜尋台北 101，截圖並告訴我座標」— 驗 navigate+wait+search+vision pipeline
   - B. prompt「用 google.maps JS API 把地圖中心設到日本東京」— 驗 evaluate escape hatch
   - C. prompt「在地圖上從台北往南拖 200 像素」— 驗 mouse_drag
6. **煙霧 4（canvas click）**：隨便挑一個 HTML5 canvas 小遊戲（例 excalidraw.com），prompt「畫一個方框」— 驗 screenshot + vision locate + click_at + mouse_drag 閉環
7. **regression**：對本 repo issue tracker 跑既有 snapshot/click/type 流程確認沒退步
8. **手動跨平台**：macOS 側自行跑煙霧 1+2；Windows 側由本人跑 1+2+3A+3B（跨平台要求 — 黃金規則 10）

完工條件：typecheck 綠、所有 4 個煙霧 prompt 在 Windows 下一次內完成（允許 LLM 多輪 tool call，但不得卡在同一個 VirtualNodeError 或 hang）。
