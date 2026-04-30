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

export async function daemonMain(args: string[]): Promise<void> {
  // daemon fast-path 跳過 setup.ts，需要自行載入 config snapshot
  await seedLlamaCppConfigIfMissing()
  await loadLlamaCppConfigSnapshot()
  await seedDiscordConfigIfMissing()
  await loadDiscordConfigSnapshot()
  await seedWebConfigIfMissing()
  await loadWebConfigSnapshot()

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
