/**
 * Daemon worker registry stub。
 *
 * `cli.tsx` 的 `--daemon-worker` fast-path import 此檔案。
 * Worker 機制尚未實作；此 stub 避免 import 失敗導致靜默 crash。
 */
export async function runDaemonWorker(
  kind: string | undefined,
): Promise<void> {
  process.stderr.write(
    `daemon worker "${kind ?? '(none)'}" not yet implemented\n`,
  )
  process.exit(1)
}
