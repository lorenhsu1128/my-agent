/**
 * M-DAEMON-AUTO-C：REPL slash command `/daemon on | off | status`
 *
 * - `/daemon on`：開啟 autostart config + 若目前無 daemon 立即 spawn
 * - `/daemon off`：關閉 autostart config + 若有活 daemon 送 `daemon stop`
 *   到 CLI 停掉它（保留原有的 attached/standalone 自動處理）
 * - `/daemon status`：顯示 autostart 設定 + 當前 daemon liveness
 *   （pid / port / mode）
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  isAutostartEnabled,
  setAutostartEnabled,
  spawnDetachedDaemon,
} from '../daemon/autostart.js'
import { isDaemonAliveSync, readPidFile } from '../daemon/pidFile.js'

const call: LocalCommandCall = async args => {
  const arg = args.trim().toLowerCase()
  if (arg === '' || arg === 'status') {
    const enabled = isAutostartEnabled()
    const alive = isDaemonAliveSync()
    const pid = await readPidFile()
    const lines: string[] = []
    lines.push(`autostart: ${enabled ? 'on' : 'off'}`)
    if (alive && pid) {
      lines.push(`daemon:    running (pid=${pid.pid} port=${pid.port})`)
    } else {
      lines.push(`daemon:    not running`)
    }
    lines.push(
      '',
      '用法：/daemon on | off | status',
      '  on     啟用 autostart + 立刻 spawn（若未跑）',
      '  off    關閉 autostart + 停目前活 daemon',
      '  status 顯示目前狀態（預設）',
    )
    return { type: 'text', value: lines.join('\n') }
  }

  if (arg === 'on') {
    setAutostartEnabled(true)
    const alive = isDaemonAliveSync()
    if (alive) {
      return {
        type: 'text',
        value:
          'autostart 已開啟。目前已有活 daemon，REPL 會自動 attach。',
      }
    }
    const r = spawnDetachedDaemon()
    if (!r.spawned) {
      return {
        type: 'text',
        value: `autostart 已開啟，但 daemon spawn 失敗：${r.error ?? 'unknown'}。可手動執行 \`my-agent daemon start\` 看錯誤。`,
      }
    }
    // 等最多 6 秒讓 daemon 寫 pid.json 並可用。spawn 樂觀回 true 但 child 可能
    // 因為 stale lock / port 衝突等 silently 死掉；polling 驗證才是真相。
    const deadline = Date.now() + 6_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250))
      if (isDaemonAliveSync()) {
        const p = await readPidFile()
        return {
          type: 'text',
          value: `autostart 已開啟。daemon 已啟動（pid=${p?.pid} port=${p?.port}）；REPL 幾秒內會 attach。`,
        }
      }
    }
    return {
      type: 'text',
      value:
        `autostart 已開啟，spawn 已送出但 6 秒內未觀察到 pid.json。child 可能 silently 死了。診斷：\n` +
        `  1. 手動跑 \`my-agent daemon start\` 看錯誤訊息\n` +
        `  2. 檢查 \`~/.my-agent/daemon.log\` 最後幾行\n` +
        `  3. 若是 stale .daemon.lock（EEXIST）：新版已自動清 dead pid；` +
        `若仍卡死可手動刪 \`<projectDir>/.daemon.lock\``,
    }
  }

  if (arg === 'off') {
    const prevEnabled = isAutostartEnabled()
    setAutostartEnabled(false)
    const alive = isDaemonAliveSync()
    if (!alive) {
      return {
        type: 'text',
        value: prevEnabled
          ? 'autostart 已關閉。目前無活 daemon。'
          : 'autostart 原本就關閉。目前無活 daemon。',
      }
    }
    // 送 SIGTERM 到 daemon pid
    const pid = await readPidFile()
    if (pid) {
      try {
        process.kill(pid.pid, 'SIGTERM')
        return {
          type: 'text',
          value: `autostart 已關閉。已送 SIGTERM 給 daemon pid=${pid.pid}；REPL 幾秒內會偵測到切回 standalone。`,
        }
      } catch (err) {
        return {
          type: 'text',
          value: `autostart 已關閉，但 daemon SIGTERM 失敗：${err instanceof Error ? err.message : String(err)}。可用 \`my-agent daemon stop\` 強制停。`,
        }
      }
    }
    return {
      type: 'text',
      value: 'autostart 已關閉。daemon 狀態無法確認。',
    }
  }

  return {
    type: 'text',
    value: `未知參數：${arg}。用法：/daemon on | off | status`,
  }
}

const daemonCommand = {
  type: 'local',
  name: 'daemon',
  description: 'Toggle daemon autostart / spawn / stop (on | off | status)',
  argumentHint: '[on|off|status]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default daemonCommand
