/**
 * 冒煙測：直接用 Playwright 走 navigate → snapshot → close 流程。
 * 不需要 LLM agent 迴圈，驗證整條 WebBrowserTool pipeline。
 *
 * Run: bun run tests/integration/web/browser-smoke.ts
 */
import {
  navigate,
  snapshot,
  closeBrowser,
  scroll,
} from '../../../src/tools/WebBrowserTool/actions'

async function main() {
  const url = 'https://github.com/lorenhsu1128'
  console.log(`[smoke] WebBrowser navigate → snapshot against ${url} ...`)

  try {
    const navResult = (await navigate(url)) as {
      url: string
      status: number | null
      title: string
    }
    console.log(`  navigate: status=${navResult.status} title="${navResult.title}"`)
    if (navResult.status !== null && navResult.status >= 400) {
      console.error(`\n[smoke] FAIL: HTTP ${navResult.status}`)
      process.exit(1)
    }
    if (!navResult.title.toLowerCase().includes('lorenhsu1128')) {
      console.error(
        `\n[smoke] FAIL: expected "lorenhsu1128" in title, got "${navResult.title}"`,
      )
      process.exit(1)
    }

    const snap = (await snapshot()) as {
      url: string
      title: string
      generation: number
      ref_count: number
      refs: { ref: string; role: string; name: string }[]
      tree_preview: string
      tree_truncated: boolean
      tree_chars: number
    }
    console.log(
      `  snapshot: gen=${snap.generation} refs=${snap.ref_count} tree_chars=${snap.tree_chars} truncated=${snap.tree_truncated} preview_len=${snap.tree_preview.length}`,
    )
    if (snap.ref_count < 1 || snap.refs.length < 1) {
      console.error('\n[smoke] FAIL: expected at least 1 ref in snapshot')
      console.error('tree preview:', snap.tree_preview.slice(0, 500))
      process.exit(1)
    }
    console.log(
      `  first 3 refs: ${snap.refs
        .slice(0, 3)
        .map(r => `${r.ref}/${r.role}/"${r.name.slice(0, 30)}"`)
        .join(', ')}`,
    )

    const scrollRes = await scroll('down')
    console.log(`  scroll: ${JSON.stringify(scrollRes)}`)

    console.log('\n[smoke] PASS')
  } finally {
    await closeBrowser()
  }
}

main().catch(err => {
  console.error('[smoke] ERROR:', err)
  closeBrowser()
    .catch(() => void 0)
    .finally(() => process.exit(1))
})
