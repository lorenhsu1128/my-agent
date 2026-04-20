/**
 * M-DISCORD-3c smoke：驗證 discord.js Client 能連上（login → ready → destroy）。
 *
 * 用法：
 *   DISCORD_BOT_TOKEN=<token> bun run scripts/poc/discord-connect-smoke.ts
 *
 * 行為：
 *   1. 讀 env DISCORD_BOT_TOKEN（為空 → 退出碼 2）
 *   2. createDiscordClient + connect；15s timeout
 *   3. Ready 後印 bot tag + 可見 guild 數 + DM partial 支援
 *   4. destroy 即退（退出碼 0）；失敗 1
 *
 * 不發任何訊息；只驗連線與 ready 事件路徑。
 */
import { createDiscordClient } from '../../src/discord/client.js'
import {
  getDiscordBotToken,
  loadDiscordConfigSnapshot,
} from '../../src/discordConfig/index.js'

const TIMEOUT_MS = 15_000

async function main(): Promise<number> {
  // Load snapshot first so getDiscordBotToken can fallback to config.botToken
  await loadDiscordConfigSnapshot()
  const token = getDiscordBotToken()
  if (!token) {
    // eslint-disable-next-line no-console
    console.error(
      'no token: set DISCORD_BOT_TOKEN env or discord.json "botToken"',
    )
    return 2
  }

  const client = createDiscordClient({
    token,
    onReady: info => {
      // eslint-disable-next-line no-console
      console.log(`[smoke] ready as ${info.botTag} (${info.botId})`)
    },
    onError: err => {
      // eslint-disable-next-line no-console
      console.error(
        `[smoke] error: ${err instanceof Error ? err.message : String(err)}`,
      )
    },
  })

  const timer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(`[smoke] connect timeout ${TIMEOUT_MS}ms`)
    process.exit(1)
  }, TIMEOUT_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()

  try {
    await client.connect()
    clearTimeout(timer)
    const guilds = client.raw.guilds?.cache?.size ?? 0
    // eslint-disable-next-line no-console
    console.log(`[smoke] guilds visible: ${guilds}`)
    // eslint-disable-next-line no-console
    console.log('[smoke] OK — destroying')
    await client.destroy()
    return 0
  } catch (e) {
    clearTimeout(timer)
    // eslint-disable-next-line no-console
    console.error(
      `[smoke] connect failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    try {
      await client.destroy()
    } catch {
      // ignore
    }
    return 1
  }
}

void main().then(code => process.exit(code))
