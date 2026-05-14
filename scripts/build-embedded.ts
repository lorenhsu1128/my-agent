/**
 * 內嵌 library build：產出 `dist-embedded/index.js` (ESM, target=node)
 * 給 virtual-assistant-desktop（Electron Node runtime）`import` 使用。
 *
 * 與既有 scripts/build.ts 的差異：
 * - **target=node**（不是 --compile / 不是 target=bun）
 * - **entry=src/embedded/index.ts**（不是 cli.tsx）
 * - external native modules（node-llama-tcq / better-sqlite3 等）
 * - 同時保留 fullExperimentalFeatures（feature() macro 替換為 true）
 * - 用 Bun.build 程式化 API（plugin alias `bun:sqlite` 到 stub）
 *
 * 注意（Phase 3 範圍）：
 * - 此腳本只產出 bundle 檔。執行期相容由 Phase 4 處理（Bun.serve →
 *   Node ws+http、Bun.file → fs.promises、bun:ffi → guard 等）。
 * - 若你現在 `node dist-embedded/index.js` 跑命中尚未 patch 的 Bun.* 呼叫，
 *   會 `ReferenceError: Bun is not defined` — 那是預期行為，Phase 4 補完。
 *
 * @see scripts/build.ts — CLI 模式對照（target=bun, --compile）
 * @see scripts/experimentalFeatures.ts — feature flag 共用清單
 * @see scripts/stubs/bun-sqlite-stub.ts — bun:sqlite Node stub
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { BunPlugin } from 'bun'
import { fullExperimentalFeatures } from './experimentalFeatures.ts'

const pkg = await Bun.file(
  new URL('../package.json', import.meta.url),
).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const skipDts = args.includes('--skip-dts')
const verbose = args.includes('--verbose')

const entry = './src/embedded/index.ts'
const outfile = './dist-embedded/index.js'
const outDir = dirname(outfile)

// 清理舊產物
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true })
}
mkdirSync(outDir, { recursive: true })

const buildTime = new Date().toISOString()
const version = pkg.version

// External：執行期需要由 host process（桌寵 Electron）自行提供的套件
// - native 模組（含 .node 二進位）— 不能 bundle
// - Bun 專屬模組 — target node 讀不到，明確 external 提示 bundler
//
// 不外部化 src/* 自家程式碼或一般 node_modules deps — 一律 bundle 進來，
// 桌寵端 npm install 時不必再裝 my-agent 的 transitive 依賴。
const externals = [
  // Native（含 .node binary，bundle 會壞）
  'node-llama-tcq',
  'better-sqlite3',
  'tree-sitter',
  'tree-sitter-*',
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
  'uiohook-napi',
  // ws（Phase 4 才用，transport 抽象完成才考慮 bundle）
  'ws',
  // 大型多媒體（puppeteer 等）— 動態 import，bundle 風險高
  'puppeteer-core',
  'sharp',
  // bun:ffi / bun:bundle / bun:test 仍 external（dev / Linux 才會碰到）；
  // bun:sqlite 用 plugin alias 成 stub（target node 不能 external，
  // 否則 ESM loader 看到 'bun:' scheme 拒絕載入整個 bundle）
  'bun:ffi',
  'bun:bundle',
  'bun:test',
]

/**
 * Bun.build 插件：把 `bun:sqlite` import 路徑改指到 stub 檔案，
 * 讓 Node 環境也能 load bundle（runtime 真實用到時才 throw）。
 */
const bunSqliteStubPlugin: BunPlugin = {
  name: 'bun-sqlite-stub',
  setup(build) {
    const stubPath = resolve(import.meta.dir, 'stubs/bun-sqlite-stub.ts')
    build.onResolve({ filter: /^bun:sqlite$/ }, () => ({
      path: stubPath,
    }))
  },
}

/**
 * Bun.build 插件：把 `jsonc-parser` 強制導向 ESM 版本（`lib/esm/main.js`）。
 * 預設下某些 transitive 依賴用 CJS require() 拉 UMD 版本，UMD wrapper 內部
 * `require('./impl/format')` 在 Node ESM 環境會 throw。
 */
const jsoncParserEsmPlugin: BunPlugin = {
  name: 'jsonc-parser-esm',
  setup(build) {
    const esmPath = resolve(
      process.cwd(),
      'node_modules/jsonc-parser/lib/esm/main.js',
    )
    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: esmPath,
    }))
  },
}

const defines: Record<string, string> = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.MY_AGENT_FORCE_FULL_LOGO': JSON.stringify('false'),
  'process.env.MY_AGENT_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('false'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'Embedded library build for virtual-assistant-desktop integration.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify('embedded build'),
}

if (verbose) {
  console.log(
    '[build-embedded] target=node format=esm features=' +
      fullExperimentalFeatures.length +
      ' externals=' +
      externals.length,
  )
}

console.log(`[build-embedded] bundling ${entry} → ${outfile}`)
const t0 = Date.now()

const result = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  naming: 'index.js',
  target: 'node',
  format: 'esm',
  packages: 'bundle',
  // `import` 在前，讓 ESM-優先套件（jsonc-parser 等）走 module 欄位而非 UMD main
  conditions: ['import', 'node', 'default'],
  external: externals,
  features: [...fullExperimentalFeatures],
  define: defines,
  plugins: [bunSqliteStubPlugin, jsoncParserEsmPlugin],
  // 不 minify — 桌寵 dev 環境要看得到原檔；release 階段可再加 --minify flag
})

const elapsed = ((Date.now() - t0) / 1000).toFixed(2)

if (!result.success) {
  console.error(`[build-embedded] FAILED in ${elapsed}s`)
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

const size = statSync(outfile).size
const sizeMb = (size / 1024 / 1024).toFixed(2)
console.log(
  `[build-embedded] bundle done in ${elapsed}s; size=${sizeMb} MiB → ${outfile}`,
)

// .d.ts 產出（透過 tsconfig.embedded.json 指定 include / outDir）
if (!skipDts) {
  console.log(
    '[build-embedded] generating .d.ts via tsc --project tsconfig.embedded.json',
  )
  const tscProc = Bun.spawnSync({
    cmd: ['bunx', 'tsc', '--project', 'tsconfig.embedded.json'],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (tscProc.exitCode !== 0) {
    console.warn(
      `[build-embedded] .d.ts emit exit ${tscProc.exitCode} ` +
        '(vendor SDK 殘餘 TS error，不影響 embedded 模組 dts 產出)',
    )
  }
  // 即便 tsc 整體退出非零，embedded 模組的 dts 通常已產出 — 寫 re-export entry
  const typesEntry = join(outDir, 'types/embedded/index.d.ts')
  if (existsSync(typesEntry)) {
    const targetDts = join(outDir, 'index.d.ts')
    const reexport = `export * from './types/embedded/index.js'\n`
    await Bun.write(targetDts, reexport)
    console.log(
      `[build-embedded] .d.ts entry: ${targetDts} (re-exports types/embedded/index)`,
    )
  } else {
    console.warn('[build-embedded] expected types entry not found:', typesEntry)
  }
}

console.log('[build-embedded] done')
