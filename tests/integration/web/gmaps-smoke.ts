/**
 * 冒煙：對 Google Maps 跑 navigate → wait_for(window.google.maps) → snapshot →
 * evaluate(JS API 判定) → close 流程。
 *
 * 目的：驗證本次重構關鍵路徑（settle / wait_for / interestingOnly:false /
 * shadow DOM / summary），而不觸發 vision API（避免 token 成本）。
 *
 * Run: bun run tests/integration/web/gmaps-smoke.ts
 */
import {
  closeBrowser,
  evaluate,
  navigate,
  snapshot,
} from '../../../src/tools/WebBrowserTool/actions'

type NavResult = {
  url: string
  status: number | null
  title: string
  settle: { waited: boolean; strategy: string; elapsedMs: number }
  wait_for?: { waited: boolean; strategy: string; elapsedMs: number; error?: string }
}

type SnapResult = {
  url: string
  title: string
  generation: number
  ref_count: number
  summary: {
    interactive_count: number
    form_count: number
    has_dialog: boolean
    has_shadow: boolean
  }
  refs: { ref: string; role: string; name: string }[]
  tree_preview: string
  tree_truncated: boolean
  tree_chars: number
}

async function main(): Promise<void> {
  const url = 'https://www.google.com/maps'
  console.log(`[gmaps-smoke] navigate → ${url}`)

  try {
    const nav = (await navigate(url, {
      function: '() => !!window.google && !!window.google.maps',
      timeout_ms: 15_000,
    })) as NavResult
    console.log(
      `  nav: status=${nav.status} title="${nav.title}" settle=${nav.settle.strategy}/${nav.settle.waited} wait_for=${nav.wait_for?.strategy}/${nav.wait_for?.waited}`,
    )
    if (nav.status !== null && nav.status >= 400) {
      console.error('[gmaps-smoke] FAIL: HTTP error')
      process.exit(1)
    }

    const snap = (await snapshot()) as SnapResult
    console.log(
      `  snapshot: refs=${snap.ref_count} interactive=${snap.summary.interactive_count} forms=${snap.summary.form_count} dialog=${snap.summary.has_dialog} shadow=${snap.summary.has_shadow}`,
    )
    if (snap.ref_count < 1) {
      console.error('[gmaps-smoke] FAIL: no refs from snapshot')
      console.error(snap.tree_preview.slice(0, 600))
      process.exit(1)
    }
    console.log(
      `  tree_chars=${snap.tree_chars} truncated=${snap.tree_truncated} preview_len=${snap.tree_preview.length}`,
    )

    // 探測：列出非底層的 window 全域，確認能從中找到 Maps 相關結構
    const evalRes = (await evaluate(
      'JSON.stringify({google_type: typeof window.google, google_maps_type: typeof (window.google && window.google.maps), has_APP_OPTIONS: typeof window.APP_OPTIONS, custom_globals: Object.keys(window).filter(k => !k.startsWith("_") && typeof window[k] === "object" && window[k] !== null).filter(k => !["document","navigator","history","screen","location","parent","top","self","window","performance","console","crypto","caches","indexedDB","localStorage","sessionStorage","customElements","visualViewport","speechSynthesis"].includes(k)).slice(0,30)})',
    )) as { result: string }
    console.log(`  globals: ${evalRes.result}`)

    // 驗 snapshot 有搜尋框（Google Maps 主要入口）
    if (snap.summary.form_count < 1) {
      console.error('[gmaps-smoke] FAIL: expected at least 1 form element (search box)')
      process.exit(1)
    }

    console.log('\n[gmaps-smoke] PASS')
  } catch (err) {
    console.error('[gmaps-smoke] ERROR:', err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    await closeBrowser()
  }
}

await main()
