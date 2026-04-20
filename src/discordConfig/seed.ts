/**
 * 首次啟動種檔：~/.my-agent/discord.json 不存在時寫入預設停用版本 + README。
 * 已存在則完全不動。
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getDiscordConfigPath } from './paths.js'
import { DEFAULT_DISCORD_CONFIG } from './schema.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'discord.README.md'

const README_CONTENT = `# ~/.my-agent/discord.json

Discord gateway 設定（M-DISCORD）。預設 \`enabled: false\`；編輯完填妥
token / whitelist / projects 再改 \`true\` 才會生效。

## 啟動流程

1. 在 Discord Developer Portal 建 application → bot → 拿 Bot Token
2. 把 token 放在環境變數 \`DISCORD_BOT_TOKEN\`（不要寫進 config 檔避免 secret 進 git）
3. 邀請 bot 進你的私人 guild（scope: bot，最少 permissions: Read Messages / Send Messages / Add Reactions / Attach Files）
4. 填 \`whitelistUserIds\` = [你的 Discord user id]（右鍵 → Copy User ID，需開啟開發者模式）
5. 編輯 \`projects\` 列出要讓 Discord 聊的 cwd；至少一個
6. 設定 \`defaultProjectPath\` 指向其中一個 project（DM 沒前綴時 fallback）
7. （可選）\`channelBindings\` 把特定 channel id 綁固定 project；bot 只回應綁定的 channel
8. 改 \`enabled: true\`、重啟 daemon（\`my-agent daemon restart\`）

## 路由規則

- DM：\`#<projectId|alias> <訊息>\` 指定 project；沒前綴用 \`defaultProjectPath\`
- Channel：必須在 \`channelBindings\` 裡；沒綁就忽略

## 欄位說明

| 欄位 | 用途 |
|------|------|
| \`enabled\` | 總開關；false 時 daemon 跳過整個 Discord gateway |
| \`whitelistUserIds\` | 僅這些 user 的訊息被處理；空陣列 = 全擋 |
| \`defaultProjectPath\` | DM 沒前綴時的預設 project（須在 \`projects[].path\` 中） |
| \`projects[].id\` | 路由 key（DM 前綴用） |
| \`projects[].name\` | UI 顯示名 |
| \`projects[].path\` | 實際 cwd 絕對路徑 |
| \`projects[].aliases\` | 備用前綴（e.g. \`"ma"\`） |
| \`channelBindings\` | \`{ channelId: projectPath }\` 映射 |
| \`homeChannelId\` | cron / 長任務完成通知 post 至此 channel |
| \`streamStrategy\` | \`turn-end\`（一次送）或 \`edit\`（模擬 streaming） |
| \`replyMode\` | \`first\`（只首段 reply）/ \`all\` / \`off\` |

## 範例

\`\`\`json
{
  "enabled": true,
  "whitelistUserIds": ["123456789012345678"],
  "defaultProjectPath": "C:/Users/me/projects/my-agent",
  "projects": [
    { "id": "my-agent", "name": "My Agent", "path": "C:/Users/me/projects/my-agent", "aliases": ["ma", "agent"] },
    { "id": "blog", "name": "Blog", "path": "C:/Users/me/projects/blog", "aliases": [] }
  ],
  "channelBindings": {
    "987654321098765432": "C:/Users/me/projects/my-agent"
  },
  "homeChannelId": "987654321098765433",
  "streamStrategy": "turn-end",
  "replyMode": "first"
}
\`\`\`

## 安全提醒

- **白名單**：個人使用請只放自己的 user id。bot 被拉進公開 guild 也不會回應陌生人。
- **Token 不進檔**：token 只走 \`DISCORD_BOT_TOKEN\` env var；這份 \`discord.json\` 可安全 commit 進 repo（若不含 path/id 等機敏資訊）。
- **Permission mode**：從 Discord \`/mode default\` 等 slash command 可切 permission mode，會雙向同步到 REPL。預設 \`default\`（destructive 會請求授權）。
`

/**
 * 若 ~/.my-agent/discord.json 不存在，寫入 DEFAULT_DISCORD_CONFIG（enabled=false）
 * + discord.README.md。已存在則不動。
 */
export async function seedDiscordConfigIfMissing(): Promise<void> {
  const path = getDiscordConfigPath()
  try {
    if (existsSync(path)) return
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify(DEFAULT_DISCORD_CONFIG, null, 2) + '\n',
      'utf-8',
    )
    const readmePath = join(dirname(path), README_FILENAME)
    if (!existsSync(readmePath)) {
      await writeFile(readmePath, README_CONTENT, 'utf-8')
    }
    logForDebugging(`[discord-config] seeded ${path}`)
  } catch (e) {
    logForDebugging(
      `[discord-config] seed failed: ${e instanceof Error ? e.message : String(e)}`,
      { level: 'warn' },
    )
  }
}
