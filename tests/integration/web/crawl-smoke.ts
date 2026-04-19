/**
 * 冒煙測：直接呼叫 crawler 打 example.com，不走 LLM agent 迴圈。
 * 驗證 HTTP + SSRF + cheerio + secretScan 整條 pipeline 在真實網路下可用。
 *
 * Run: bun run tests/integration/web/crawl-smoke.ts
 */
import { crawl } from '../../../src/tools/WebCrawlTool/crawler'

async function main() {
  console.log('[smoke] WebCrawl against https://example.com ...')
  const result = await crawl({
    url: 'https://example.com',
    maxDepth: 0,
    maxPages: 1,
    sameOrigin: true,
  })

  console.log(`  pagesCrawled: ${result.pagesCrawled}`)
  console.log(`  durationMs:   ${result.durationMs}`)
  console.log(`  skipped:      ${result.skipped.length}`)
  if (result.pages[0]) {
    const p = result.pages[0]
    console.log(`  title:        ${p.title}`)
    console.log(`  text length:  ${p.text.length}`)
    console.log(`  redacted:     ${p.redacted}`)
    console.log(`  text preview: ${p.text.slice(0, 120).replace(/\n/g, ' ')}...`)
  }

  if (result.pagesCrawled !== 1) {
    console.error('\n[smoke] FAIL: expected 1 page crawled')
    console.error('skipped:', result.skipped)
    process.exit(1)
  }

  if (!result.pages[0]!.text.toLowerCase().includes('example domain')) {
    console.error('\n[smoke] FAIL: expected "example domain" in body text')
    process.exit(1)
  }

  console.log('\n[smoke] PASS')
}

main().catch(err => {
  console.error('[smoke] ERROR:', err)
  process.exit(1)
})
