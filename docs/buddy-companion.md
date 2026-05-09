# Buddy Companion（伴侶精靈）

> 對應 slash command：`/buddy`
> 對應目錄：`src/buddy/`
> Feature flag：`BUDDY`（`bun:bundle` `feature()` gate）

REPL 輸入框旁的小精靈 — 用 `userId` 哈希種子決定外觀（rarity / species / eye / hat），第一次孵化（hatch）時會由 LLM 生成 soul（name + personality）並寫入 global config。整個機制離線可玩、不送外部請求（除生 soul 那一次）。

## 觸發與顯示

- `/buddy` slash command — 進孵化流程，產生 `Companion` 寫入 `~/.my-agent/config.json` 的 `companion` 欄位。
- 若已孵化：`CompanionSprite`（`src/buddy/CompanionSprite.tsx`）出現在 REPL 右側，5 行高、12 columns 寬。
- 若未孵化且在 teaser 視窗（2026-04-01 ~ 04-07，本地時區）：notification 區會閃爍彩虹 `/buddy` 提示（`useBuddyNotification`，`useBuddyNotification.tsx:43`）。
- `companionMuted=true` 時跳過 intro attachment 注入。

## 資料結構

```ts
type Companion = CompanionBones & CompanionSoul & { hatchedAt: number }

type CompanionBones = {     // 由 hash(userId) deterministic 重算，不持久化
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
  species: Species          // 18 種：duck / goose / blob / cat / dragon / ... / chonk
  eye: '·' | '✦' | '×' | '◉' | '@' | '°'
  hat: 'none' | 'crown' | 'tophat' | 'propeller' | 'halo' | 'wizard' | 'beanie' | 'tinyduck'
  shiny: boolean            // 1% 機率
  stats: Record<'DEBUGGING' | 'PATIENCE' | 'CHAOS' | 'WISDOM' | 'SNARK', number>
}

type StoredCompanion = CompanionSoul & { hatchedAt: number }   // 真正持久化的部分
```

`bones` 每次讀都從 `hash(userId + SALT)` 重算（`companion.ts:107`）— 因此：

- 不能靠改 config 偽造 legendary。
- `SPECIES` 陣列順序變更 / species 重命名都不會打壞已孵化精靈。
- 同一 userId 永遠拿到同一隻。

## Rarity 機率與屬性

```
common 60% / uncommon 25% / rare 10% / epic 4% / legendary 1%
```

`rollStats()`（`companion.ts:62`）：每個 rarity 給定 floor（5/15/25/35/50），隨機挑一個 stat 為 peak（floor+50+rand(30)，封頂 100）、一個為 dump（floor−10+rand(15)，下限 1）、其他散落 floor 到 floor+40。

## 與對話的整合

當 companion 已孵化且未 muted，下一輪會自動注入 `companion_intro` attachment（`prompt.ts:9`）：

```
# Companion
A small <species> named <name> sits beside the user's input box and occasionally
comments in a speech bubble. You're not <name> — it's a separate watcher.

When the user addresses <name> directly (by name), its bubble will answer. Your
job in that moment is to stay out of the way: respond in ONE line or less, or
just answer any part of the message meant for you.
```

也就是 main agent 知道精靈存在但**不扮演**它；精靈的反應由獨立 observer（`src/buddy/observer.ts` — 若存在）餵 reaction 進 `AppStateStore.companionReaction`，由 `CompanionFloatingBubble` 顯示。

## 物件路徑

| 檔案 | 內容 |
|---|---|
| `src/buddy/companion.ts` | `roll()` / `getCompanion()` / `companionUserId()` |
| `src/buddy/types.ts` | `RARITIES` / `SPECIES` / `EYES` / `HATS` / `STAT_NAMES` 常數與 type |
| `src/buddy/sprites.ts` | 18 種 species × 3 frame 的 ASCII art `BODIES` |
| `src/buddy/CompanionSprite.tsx` | Ink 元件 + `companionReservedColumns()` helper |
| `src/buddy/useBuddyNotification.tsx` | teaser notification + `findBuddyTriggerPositions()` |
| `src/buddy/prompt.ts` | `companionIntroText()` + `getCompanionIntroAttachment()` |
| `src/commands/buddy/index.js` | `/buddy` slash command 實作（lazy require） |
| `src/utils/config.ts:289` | `companion?: StoredCompanion` 欄位定義 |
| `src/state/AppStateStore.ts:187` | `companionReaction` runtime 狀態 |

## 設計重點

- **Bones 不持久化**：避免使用者編輯 config 偽造稀有度，也避免 schema 變動破壞舊存檔。
- **Mulberry32 PRNG + Bun.hash fallback**：跨平台 deterministic（`companion.ts:16`）。
- **三個熱路徑共用 cache**（500ms sprite tick / per-keystroke PromptInput / per-turn observer）：`companion.ts:106` 的 `rollCache` 避免重複算。
- **Species 名以 `String.fromCharCode` 動態組**（`types.ts:14`）— 跟 `excluded-strings.txt` 中某 model codename canary 撞名，保留 build-time check 的同時不讓 literal 進 bundle。
