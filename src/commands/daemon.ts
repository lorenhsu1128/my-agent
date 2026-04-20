/**
 * REPL slash command `/daemon <on|off|attach|detach|status>`
 *
 * - `on` / `off`：durable autostart config 操作（on=開 autostart + 立即 spawn、
 *   off=關 autostart + SIGTERM daemon）。
 * - `attach`：把當前 REPL thin-client 從 standalone 切到 attached；daemon 沒跑
 *   就 spawn。**不動** autostart config。
 * - `detach`：把當前 REPL 切回 standalone。若三條件皆成立則順手關 daemon：
 *     1. detach 後 daemon 沒有其他 REPL client
 *     2. daemon 沒跑 Discord gateway
 *     3. autostart 是 off
 *   否則 daemon 留著並回傳原因。**不動** autostart config。
 * - `status`：顯示 autostart / daemon online-offline / 當前 REPL mode。
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  isAutostartEnabled,
  setAutostartEnabled,
  spawnDetachedDaemon,
} from '../daemon/autostart.js'
import { isDaemonAliveSync, readPidFile } from '../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../hooks/useDaemonMode.js'

const call: LocalCommandCall = async args => {
  const arg = args.trim().toLowerCase()
  if (arg === '' || arg === 'status') {
    const enabled = isAutostartEnabled()
    const alive = isDaemonAliveSync()
    const pid = await readPidFile()
    const mgr = getCurrentDaemonManager()
    const mode = mgr?.state.mode ?? 'standalone'
    const lines: string[] = []
    lines.push(`autostart: ${enabled ? 'on' : 'off'}`)
    if (alive && pid) {
      lines.push(`daemon:    online (pid=${pid.pid} port=${pid.port})`)
    } else {
      lines.push(`daemon:    offline`)
    }
    lines.push(`mode:      ${mode}`)
    lines.push(
      '',
      '用法：/daemon on | off | attach | detach | status',
      '  on      啟用 autostart + 立刻 spawn（若未跑）',
      '  off     關閉 autostart + 停目前活 daemon',
      '  attach  把本 REPL 連上 daemon（未跑則 spawn），不動 autostart',
      '  detach  本 REPL 切回 standalone；若為最後一個且無 discord、autostart=off 則關 daemon',
      '  status  顯示目前狀態（預設）',
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

  if (arg === 'attach') {
    const mgr = getCurrentDaemonManager()
    if (!mgr) {
      return {
        type: 'text',
        value: 'daemon manager 未就緒（useDaemonMode 未掛載？）',
      }
    }
    // daemon 沒跑就 spawn（不動 autostart config）
    if (!isDaemonAliveSync()) {
      const r = spawnDetachedDaemon()
      if (!r.spawned) {
        return {
          type: 'text',
          value: `daemon spawn 失敗：${r.error ?? 'unknown'}。可手動跑 \`my-agent daemon start\` 看錯誤。`,
        }
      }
      const deadline = Date.now() + 6_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250))
        if (isDaemonAliveSync()) break
      }
      if (!isDaemonAliveSync()) {
        return {
          type: 'text',
          value:
            `spawn 已送出但 6 秒內未觀察到 pid.json。診斷：\n` +
            `  1. 手動跑 \`my-agent daemon start\` 看錯誤訊息\n` +
            `  2. 檢查 \`~/.my-agent/daemon.log\`\n` +
            `  3. 檢查 \`<projectDir>/.daemon.lock\`（stale 可手動刪）`,
        }
      }
    }
    const res = await mgr.forceAttach()
    if (!res.ok) {
      return {
        type: 'text',
        value: `attach 失敗：${res.reason}`,
      }
    }
    const p = await readPidFile()
    return {
      type: 'text',
      value: p
        ? `已 attach 到 daemon（pid=${p.pid} port=${p.port}）。autostart 設定未變更。`
        : '已 attach 到 daemon。autostart 設定未變更。',
    }
  }

  if (arg === 'detach') {
    const mgr = getCurrentDaemonManager()
    if (!mgr) {
      return {
        type: 'text',
        value: 'daemon manager 未就緒（useDaemonMode 未掛載？）',
      }
    }
    if (mgr.state.mode !== 'attached') {
      return {
        type: 'text',
        value: `目前非 attached（mode=${mgr.state.mode}），無需 detach。`,
      }
    }
    // Detach 前查 daemon 狀態，拿到 replCount（包含自己）和 discordEnabled
    const status = await mgr.queryDaemonStatus(2_000)
    const autostart = isAutostartEnabled()
    const daemonPid = (await readPidFile())?.pid
    // 實際切 standalone + 抑制 auto-reattach
    await mgr.forceDetach()

    // Shutdown 三條件：replCount after detach == 0 && !discord && !autostart
    // status.replCount 是 detach 前的值（含自己）；detach 後 = status.replCount - 1
    const replAfter =
      status && typeof status.replCount === 'number'
        ? status.replCount - 1
        : null
    const canShutdown =
      status !== null && replAfter === 0 && !status.discordEnabled && !autostart

    if (canShutdown && daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM')
        return {
          type: 'text',
          value: `已 detach。這是最後一個 REPL client 且無 Discord / autostart 關閉 → 已送 SIGTERM 給 daemon pid=${daemonPid}。`,
        }
      } catch (err) {
        return {
          type: 'text',
          value: `已 detach；daemon shutdown 失敗：${err instanceof Error ? err.message : String(err)}。`,
        }
      }
    }

    // 說明為何 daemon 沒關
    const reasons: string[] = []
    if (status === null) reasons.push('無法查詢 daemon 狀態（timeout）')
    else {
      if (replAfter !== null && replAfter > 0)
        reasons.push(`還有 ${replAfter} 個 REPL attached`)
      if (status.discordEnabled) reasons.push('Discord gateway 仍在運作')
    }
    if (autostart) reasons.push('autostart=on')
    const reasonStr = reasons.length > 0 ? reasons.join('、') : '（未知）'
    return {
      type: 'text',
      value: `已 detach（daemon 仍 online，原因：${reasonStr}）。autostart 設定未變更。`,
    }
  }

  return {
    type: 'text',
    value: `未知參數：${arg}。用法：/daemon on | off | attach | detach | status`,
  }
}

const daemonCommand = {
  type: 'local',
  name: 'daemon',
  description:
    'Daemon lifecycle + attach/detach (on | off | attach | detach | status)',
  argumentHint: '[on|off|attach|detach|status]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default daemonCommand
