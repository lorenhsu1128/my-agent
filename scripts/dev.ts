// Dev shim: spawn `bun run --feature=... src/entrypoints/cli.tsx`
//
// Why: `feature()` is a build-time macro. `bun run` on raw source without
// flags substitutes every `feature('X')` with `false`, silently disabling
// scheduler / cron tools / cached microcompact / token budget / ultrathink /
// ... etc. Running via this shim mirrors what `scripts/build.ts` does for
// the compiled binary path, so dev iteration matches production behavior.
//
// Usage: `bun run dev [extra args]`  (argv passes through to the CLI).

import { fullExperimentalFeatures } from './experimentalFeatures.ts'

const featureFlags = fullExperimentalFeatures.flatMap(f => [`--feature=${f}`])
const passthroughArgs = process.argv.slice(2)

const proc = Bun.spawnSync({
  cmd: [
    'bun',
    'run',
    ...featureFlags,
    './src/entrypoints/cli.tsx',
    ...passthroughArgs,
  ],
  cwd: process.cwd(),
  stdio: ['inherit', 'inherit', 'inherit'],
})

process.exit(proc.exitCode ?? 0)
