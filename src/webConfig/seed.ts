/**
 * 首次啟動 seed + strict JSON → JSONC migration（與 llamacpp / discord 對齊）。
 *
 * 行為：
 *   - web.jsonc 不存在 → 寫入 WEB_JSONC_TEMPLATE
 *   - 檔案存在且是 strict JSON（無 JSONC 註解）→ 重寫為 JSONC（保留使用者值，備份原檔）
 *   - 檔案存在且已是 JSONC → 完全不動
 *   - README sidecar（web.README.md）僅在不存在時 seed
 *   - 失敗 graceful：warn 後繼續，不阻擋 boot
 */
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import { getWebConfigPath } from './paths.js'
import { WEB_JSONC_TEMPLATE } from './bundledTemplate.js'
import { WebConfigSchema } from './schema.js'
import {
  parseJsonc,
  writeJsoncPreservingComments,
  forceRewriteJsoncFile,
} from '../utils/jsoncStore.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'web.README.md'

const README_CONTENT = `# ~/.my-agent/web.jsonc

Web UI（M-WEB）設定。把 \`enabled\` 改 true 後重啟 daemon 即可從瀏覽器使用 my-agent。

每個欄位的繁中說明已內嵌在 \`web.jsonc\` 內（JSONC，支援 // 與 /* */ 註解）。
本 README 保留跨檔資訊：啟動流程、安全提醒、常見問題。

## 啟動流程

1. 改 \`web.jsonc\` 的 \`enabled\` 為 \`true\`
2. \`my-agent daemon restart\` 或在 REPL 內跑 \`/web start\`
3. 瀏覽器開 \`http://<本機LAN-IP>:9090\`
   - 不確定 IP 可在 REPL 跑 \`/web status\` 看 daemon 印的清單
4. 想關掉就 \`/web stop\` 或把 \`enabled\` 改回 false

## 與 daemon 的關係（F3）

Web server 嵌在 daemon process 內共用一個 ProjectRegistry / sessionBroker /
permissionRouter — 所以 TUI、Discord、Web 三端訊息會自動同步。daemon 死掉
時 web 也跟著死，這是 F3 設計取捨（換來零 IPC + broker reference 共用）。

## 安全提醒

- 預設 \`bindHost: "0.0.0.0"\`：LAN 內任何人知道你的 IP 就能控制 my-agent，**沒有認證**
- 想限本機才能連 → 改成 \`"127.0.0.1"\`
- 將來想開遠端 + 認證 → 等 M-WEB-AUTH milestone

## Port 衝突

預設 9090；被占用會自動往上找（9091、9092 ...），最多 \`maxPortProbes\` 次（預設 10）。
\`/web status\` 顯示實際綁的 port。

## Dev mode 反向 proxy

開發時 \`bun run dev:web\` 起 Vite dev server（HMR）。在 \`web.jsonc\` 裡設：

  "devProxyUrl": "http://127.0.0.1:5173"

daemon 就會把 \`GET /\` 轉發到 Vite，\`/api\` 與 \`/ws\` 仍由 daemon 處理。
正式 build（\`bun run build:web\`）後刪 \`devProxyUrl\` 切回 serve dist。

## 復原

刪掉 \`web.jsonc\` → 下次啟動 daemon / REPL 自動重新 seed。
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
      `[web-config] migration skip：JSON parse 失敗（${err instanceof Error ? err.message : String(err)}）`,
      { level: 'warn' },
    )
    return
  }
  const validated = WebConfigSchema.safeParse(userValue)
  if (!validated.success) {
    logForDebugging(
      `[web-config] migration skip：schema 驗證失敗（${validated.error.message}），保留原檔`,
      { level: 'warn' },
    )
    return
  }
  const templateParsed = parseJsonc(WEB_JSONC_TEMPLATE)
  void templateParsed
  const { newText } = await writeJsoncPreservingComments(
    path,
    WEB_JSONC_TEMPLATE,
    validated.data,
  )
  await forceRewriteJsoncFile(path, newText)
  logForDebugging(
    `[web-config] migrated strict JSON → JSONC with comments：${path}`,
  )
}

export async function seedWebConfigIfMissing(): Promise<void> {
  const path = getWebConfigPath()
  try {
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, WEB_JSONC_TEMPLATE, 'utf-8')
      const readmePath = join(dirname(path), README_FILENAME)
      if (!existsSync(readmePath)) {
        await writeFile(readmePath, README_CONTENT, 'utf-8')
      }
      logForDebugging(`[web-config] seeded ${path} (JSONC)`)
      return
    }
    const existingText = await readFile(path, 'utf-8')
    if (isStrictJson(existingText)) {
      await migrateStrictJsonToJsonc(path, existingText)
    }
    // 已是 JSONC → 不動
  } catch (e) {
    logForDebugging(
      `[web-config] seed failed: ${e instanceof Error ? e.message : String(e)}`,
      { level: 'warn' },
    )
  }
}
