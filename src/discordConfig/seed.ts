/**
 * 首次啟動 seed + 既有 strict JSON → JSONC migration。
 *
 * 行為：
 *   - 檔案不存在 → 寫入 DISCORD_JSONC_TEMPLATE（含繁中註解）
 *   - 檔案存在且 strict JSON → 重寫為 JSONC 模板格式，保留使用者既有值
 *   - 檔案存在且已是 JSONC → 不動
 *   - README sidecar（discord.README.md）僅在不存在時 seed；保留為跨檔深度資訊
 */
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import { getDiscordConfigPath } from './paths.js'
import { DiscordConfigSchema } from './schema.js'
import { DISCORD_JSONC_TEMPLATE } from './bundledTemplate.js'
import {
  parseJsonc,
  writeJsoncPreservingComments,
  forceRewriteJsoncFile,
} from '../utils/jsoncStore.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'discord.README.md'

const README_CONTENT = `# ~/.my-agent/discord.json

Discord gateway 設定（M-DISCORD）。預設 \`enabled: false\`；編輯完填妥
token / whitelist / projects 再改 \`true\` 才會生效。

每個欄位的繁體中文說明已內嵌在 \`discord.json\` 內（JSONC 格式，支援 // 與 /* */ 註解）。
本 README 保留跨檔資訊：啟動流程、路由規則、安全提醒。

## 啟動流程

1. 在 Discord Developer Portal 建 application → bot → 拿 Bot Token
2. Token 寫進 \`botToken\` 欄位 **或** env var \`DISCORD_BOT_TOKEN\`（env 優先）
   - 推薦 env var：重啟 shell / 不小心分享檔案時風險較低
   - 也可直接寫 \`botToken\`：方便 daemon 每次啟動自動帶 — 但 \`~/.my-agent/discord.json\` 檔案權限請保持 0600，不要丟進 git / 聊天室 / 公開備份
3. 邀請 bot 進你的私人 guild（Developer Portal → OAuth2 → URL Generator → scope: bot + applications.commands，permissions 至少：Read Messages / Send Messages / Add Reactions / Attach Files）
4. 填 \`whitelistUserIds\` = [你的 Discord user id]（右鍵 → Copy User ID，需開啟開發者模式）
5. 編輯 \`projects\` 列出要讓 Discord 聊的 cwd；至少一個
6. 設定 \`defaultProjectPath\` 指向其中一個 project（DM 沒前綴時 fallback）
7. （可選）\`channelBindings\` 把特定 channel id 綁固定 project；bot 只回應綁定的 channel
8. 改 \`enabled: true\`、重啟 daemon（\`my-agent daemon restart\`）

## 路由規則

- DM：\`#<projectId|alias> <訊息>\` 指定 project；沒前綴用 \`defaultProjectPath\`
- Channel：必須在 \`channelBindings\` 裡；沒綁就忽略

## 安全提醒

- **白名單**：個人使用請只放自己的 user id。bot 被拉進公開 guild 也不會回應陌生人。
- **Token 保護**：
  - \`~/.my-agent/discord.json\` **不要 commit 進 git**（家目錄預設不會，但注意別手動把它複製到 repo）
  - 檔案權限建議 \`chmod 600 ~/.my-agent/discord.json\`（Windows 可改為只有本人可讀）
  - Token 外洩 → Developer Portal → Bot → Reset Token
- **Permission mode**：從 Discord \`/mode default\` 等 slash command 可切 permission mode，會雙向同步到 REPL。

## JSONC 格式

本檔從 v2026-04-25 起採用 JSONC（JSON with Comments），支援 \`//\`、\`/* */\`、
尾部逗號。my-agent 寫回此檔（\`/discord-bind\` / 白名單變更等）時會保留使用者加的註解。
`

function isStrictJson(text: string): boolean {
  const stripped = text.replace(/^﻿/, '').trim()
  if (!stripped) return false
  try {
    JSON.parse(stripped)
    return true
  } catch {
    return false
  }
}

async function migrateStrictJsonToJsonc(
  path: string,
  originalText: string,
): Promise<void> {
  let userValue: unknown
  try {
    userValue = JSON.parse(originalText.replace(/^﻿/, ''))
  } catch (err) {
    logForDebugging(
      `[discord-config] migration skip：JSON parse 失敗（${err instanceof Error ? err.message : String(err)}）`,
      { level: 'warn' },
    )
    return
  }
  // 先 schema 驗證，失敗就不動（使用者手動修）
  const validated = DiscordConfigSchema.safeParse(userValue)
  if (!validated.success) {
    logForDebugging(
      `[discord-config] migration skip：schema 驗證失敗（${validated.error.message}），保留原檔`,
      { level: 'warn' },
    )
    return
  }
  // 模板 + 使用者值套回 → 保留模板註解
  const { newText } = await writeJsoncPreservingComments(
    path,
    DISCORD_JSONC_TEMPLATE,
    validated.data,
  )
  await forceRewriteJsoncFile(path, newText)
  logForDebugging(
    `[discord-config] migrated strict JSON → JSONC with comments：${path}`,
  )
}

export async function seedDiscordConfigIfMissing(): Promise<void> {
  const path = getDiscordConfigPath()
  try {
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, DISCORD_JSONC_TEMPLATE, 'utf-8')
      const readmePath = join(dirname(path), README_FILENAME)
      if (!existsSync(readmePath)) {
        await writeFile(readmePath, README_CONTENT, 'utf-8')
      }
      logForDebugging(`[discord-config] seeded ${path} (JSONC)`)
      return
    }

    const existingText = await readFile(path, 'utf-8')
    if (isStrictJson(existingText)) {
      await migrateStrictJsonToJsonc(path, existingText)
    }
  } catch (e) {
    logForDebugging(
      `[discord-config] seed failed: ${e instanceof Error ? e.message : String(e)}`,
      { level: 'warn' },
    )
  }
}

// 保留未使用但供外部 import 的值（parseJsonc / writeJsoncPreservingComments
// 只在 migration 內部用；DiscordConfigSchema 已 import above）
void parseJsonc
