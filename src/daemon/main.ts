/**
 * Daemon fast-path 入口。
 *
 * `cli.tsx` 的 `args[0] === 'daemon'` 分支 import 此檔案，
 * 將 sub-command 分派到 daemonCli.ts 的各函式。
 */
import {
  runDaemonStart,
  runDaemonStop,
  runDaemonStatus,
  runDaemonLogs,
  runDaemonRestart,
  runDaemonAutostart,
  type DaemonCliContext,
} from './daemonCli.js'
import {
  seedLlamaCppConfigIfMissing,
  loadLlamaCppConfigSnapshot,
} from '../llamacppConfig/index.js'
import {
  seedDiscordConfigIfMissing,
  loadDiscordConfigSnapshot,
} from '../discordConfig/index.js'
import {
  seedWebConfigIfMissing,
  loadWebConfigSnapshot,
} from '../webConfig/index.js'
import { runConfigDoctor, hasErrors, hasWarnings } from '../configDoctor/index.js'

export async function daemonMain(args: string[]): Promise<void> {
  // daemon fast-path 跳過 setup.ts，需要自行載入 config snapshot
  await seedLlamaCppConfigIfMissing()
  await loadLlamaCppConfigSnapshot()
  await seedDiscordConfigIfMissing()
  await loadDiscordConfigSnapshot()
  await seedWebConfigIfMissing()
  await loadWebConfigSnapshot()

  // Session start 自動 config doctor check（M-CONFIG-DOCTOR）。
  // 純讀，發現問題只 stderr warn，不阻擋 daemon 啟動。
  try {
    const r = await runConfigDoctor({ mode: 'check' })
    if (hasErrors(r) || hasWarnings(r)) {
      const errCount = r.issues.filter(i => i.severity === 'error').length
      const warnCount = r.issues.filter(i => i.severity === 'warning').length
      // biome-ignore lint/suspicious/noConsole: startup diagnostics
      console.warn(
        `[config-doctor] 偵測到設定問題：${errCount} error / ${warnCount} warning。` +
          `跑 \`my-agent config doctor\` 看詳情，或 \`my-agent config doctor fix\` 嘗試修復。`,
      )
    }
  } catch {
    // best-effort，doctor 失敗不阻擋
  }

  const sub = args[0]
  const ctx: DaemonCliContext = {
    agentVersion:
      (globalThis as Record<string, unknown>).MACRO &&
      typeof ((globalThis as Record<string, unknown>).MACRO as Record<string, unknown>).VERSION === 'string'
        ? ((globalThis as Record<string, unknown>).MACRO as Record<string, string>).VERSION
        : 'dev',
  }

  switch (sub) {
    case 'start': {
      const port = flagValue(args, '--port')
      const host = flagValue(args, '--host')
      await runDaemonStart(ctx, {
        port: port ? Number(port) : undefined,
        host: host ?? undefined,
        blockUntilStopped: true,
        enableQueryEngine: true,
      })
      break
    }
    case 'stop':
      await runDaemonStop(ctx)
      break
    case 'status':
      await runDaemonStatus(ctx)
      break
    case 'logs':
      await runDaemonLogs(ctx, {
        follow: args.includes('-f') || args.includes('--follow'),
      })
      break
    case 'restart': {
      const port = flagValue(args, '--port')
      const host = flagValue(args, '--host')
      await runDaemonRestart(ctx, {
        port: port ? Number(port) : undefined,
        host: host ?? undefined,
        blockUntilStopped: true,
        enableQueryEngine: true,
      })
      break
    }
    case 'autostart':
      await runDaemonAutostart(ctx, args[1])
      break
    default:
      process.stderr.write(
        `Unknown daemon subcommand: ${sub ?? '(none)'}\n` +
          'Usage: my-agent daemon <start|stop|status|logs|restart|autostart>\n',
      )
      process.exit(1)
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}
