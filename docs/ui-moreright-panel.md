# UI MoreRight Panel（外部 build stub）

> 對應目錄：`src/moreright/`
> 狀態：**外部 build stub** — 真實實作為 internal-only

`useMoreRight` 是 REPL 注入點 hook（`src/screens/REPL.tsx:1661` 呼叫），原本給 internal Anthropic build 在 prompt 框右側塞額外 UI。**外部 my-agent build 中是 stub**，全部 callback 回 noop / `null`，不影響 REPL 行為。

## API surface（stub 簽名）

```ts
useMoreRight(args: {
  enabled: boolean
  setMessages: (action: M[] | ((prev: M[]) => M[])) => void
  inputValue: string
  setInputValue: (s: string) => void
  setToolJSX: (args: M) => void
}): {
  onBeforeQuery: (input: string, all: M[], n: number) => Promise<boolean>
  onTurnComplete: (all: M[], aborted: boolean) => Promise<void>
  render: () => null
}
```

| 欄位 | Stub 行為 | Internal 預期用途 |
|---|---|---|
| `onBeforeQuery` | 回 `true` | turn 開始前 hook，可改 input、攔截送出 |
| `onTurnComplete` | noop | turn 結束後 hook，可分析 message、寫 telemetry |
| `render` | 回 `null` | 在 REPL prompt 區外側 render Ink JSX |

## 為什麼留 stub

Build process 用 `scripts/external-stubs/` 在 typecheck/bundle 階段 overlay 替換真實檔。Stub 必須：

- 簽名與 internal 版本一致（不然 REPL.tsx 編不過）
- 完全 self-contained（**不能 import 任何相對路徑** — 註解說明：typecheck 看 `scripts/external-stubs/src/moreright/` 在 overlay 之前，`../types/` 會解到不存在的位置）
- 行為等同「沒裝這個 hook」

## REPL 整合點

`src/screens/REPL.tsx:70`：

```ts
import { useMoreRight } from '../moreright/useMoreRight.js'
```

`REPL.tsx:1661`：

```ts
const { onBeforeQuery, onTurnComplete, render: renderMoreRight } = useMoreRight({
  enabled: ...,
  setMessages,
  inputValue,
  setInputValue,
  setToolJSX,
})
```

於 `onBeforeQuery` return false 時 REPL 會跳過送出（internal build 可實作攔截邏輯）；`onTurnComplete` 被 turn 結束時呼叫；`renderMoreRight()` 嵌在 prompt 旁。

## 物件路徑

| 檔案 | 內容 |
|---|---|
| `src/moreright/useMoreRight.tsx` | Stub 實作（外部 build 看到的） |
| `src/screens/REPL.tsx` | 唯一呼叫點（line 70 import、line 1661 使用） |

## 是否該替換

外部開發者可以**直接改 stub** 加自己的 right-side panel — 簽名不變即可。但要記住：

- 改完不要 import 相對路徑的 my-agent 內部 module（會打壞 external-stubs overlay 機制）。
- 如果想完整重做，建議放在另一個目錄、改 `REPL.tsx` 的 import 路徑，避免動到 stub 機制。
