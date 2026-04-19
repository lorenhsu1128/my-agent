#!/usr/bin/env bun
/**
 * M-VISION 單元測試 — translateMessagesToOpenAI 的 vision 分支。
 *
 * 用法：bun run tests/integration/llamacpp/vision-adapter-smoke.ts
 *
 * 驗證：
 *   1. vision:false（預設）+ image block → 舊行為：`[Image attachment]` 字串佔位符
 *   2. vision:true + base64 image → 多部分 content，含 `type:"image_url"` + data URL
 *   3. vision:true + url image → 多部分 content，`image_url.url` pass-through
 *   4. vision:true + text + image 混合 → text part + image part 都在 content 陣列
 *   5. vision:true 但只有 text → 仍回傳 string content（不做成不必要的 array）
 */
import {
  translateMessagesToOpenAI,
  imageBlockToOpenAIPart,
} from '../../../src/services/api/llamacpp-fetch-adapter.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

function section(name: string): void {
  console.log(`\n— ${name}`)
}

// ── Case 1: vision:false + image → 佔位符 ─────────────────────────────
section('Case 1: vision:false + image block → [Image attachment] fallback')

{
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  ]
  const out = translateMessagesToOpenAI(messages, { vision: false })
  assert(out.length === 1, 'produces 1 user message')
  assert(typeof out[0].content === 'string', 'content is string (not array)')
  const content = out[0].content as string
  assert(content.includes('hello'), 'text preserved')
  assert(
    content.includes('[Image attachment]'),
    'image becomes [Image attachment] placeholder',
  )
}

// ── Case 2: vision:true + base64 ─────────────────────────────────────
section('Case 2: vision:true + base64 image → multi-part with data URL')

{
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what color is this?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: b64 },
        },
      ],
    },
  ]
  const out = translateMessagesToOpenAI(messages, { vision: true })
  assert(out.length === 1, 'produces 1 user message')
  assert(Array.isArray(out[0].content), 'content is array (multi-part)')
  const parts = out[0].content as Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }>
  assert(parts.length === 2, 'has exactly 2 parts (text + image)')
  assert(parts[0].type === 'text', 'first part is text')
  assert(parts[0].text === 'what color is this?', 'text matches')
  assert(parts[1].type === 'image_url', 'second part is image_url')
  assert(
    parts[1].image_url?.url.startsWith('data:image/png;base64,'),
    'image_url is data URL with correct media type',
  )
  assert(
    parts[1].image_url?.url.endsWith(b64),
    'image_url contains original base64 data',
  )
}

// ── Case 3: vision:true + URL image ──────────────────────────────────
section('Case 3: vision:true + URL image → pass-through URL')

{
  const testUrl = 'https://example.com/pic.jpg'
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'url', url: testUrl } },
      ],
    },
  ]
  const out = translateMessagesToOpenAI(messages, { vision: true })
  const parts = out[0].content as Array<{
    type: string
    image_url?: { url: string }
  }>
  assert(parts.length === 2, 'has 2 parts')
  assert(
    parts[1].image_url?.url === testUrl,
    'URL source passed through unchanged',
  )
}

// ── Case 4: vision:true + 只有 text → string content ────────────────
section('Case 4: vision:true but text-only → string content (no array)')

{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'plain text' }] },
  ]
  const out = translateMessagesToOpenAI(messages, { vision: true })
  assert(out.length === 1, '1 message')
  assert(
    typeof out[0].content === 'string',
    'content stays string when no image',
  )
  assert(out[0].content === 'plain text', 'text matches')
}

// ── Case 5: helper imageBlockToOpenAIPart 直接測試 ────────────────────
section('Case 5: imageBlockToOpenAIPart helper')

{
  // base64
  const base64Part = imageBlockToOpenAIPart({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: 'XXX' },
  })
  assert(base64Part !== null, 'base64 block returns non-null')
  assert(
    base64Part?.type === 'image_url' &&
      base64Part.image_url.url === 'data:image/jpeg;base64,XXX',
    'base64 → data URL with jpeg media type',
  )

  // default media_type fallback when media_type missing
  const noMedia = imageBlockToOpenAIPart({
    type: 'image',
    source: { type: 'base64', data: 'YYY' },
  })
  assert(
    noMedia?.image_url.url === 'data:image/png;base64,YYY',
    'missing media_type → image/png default',
  )

  // url
  const urlPart = imageBlockToOpenAIPart({
    type: 'image',
    source: { type: 'url', url: 'https://x.test/y.png' },
  })
  assert(
    urlPart?.image_url.url === 'https://x.test/y.png',
    'url source pass-through',
  )

  // invalid source
  const bogus = imageBlockToOpenAIPart({
    type: 'image',
    source: { type: 'something-else' },
  })
  assert(bogus === null, 'unknown source type returns null')

  const noSource = imageBlockToOpenAIPart({ type: 'image' })
  assert(noSource === null, 'missing source returns null')
}

// ── Case 6: 連續多張圖 ────────────────────────────────────────────────
section('Case 6: vision:true with multiple images')

{
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'compare these' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'A' },
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'B' },
        },
      ],
    },
  ]
  const out = translateMessagesToOpenAI(messages, { vision: true })
  const parts = out[0].content as Array<{ type: string }>
  assert(parts.length === 3, '3 parts: text + 2 images')
  assert(parts[0].type === 'text', 'part[0] = text')
  assert(parts[1].type === 'image_url', 'part[1] = image_url')
  assert(parts[2].type === 'image_url', 'part[2] = image_url')
}

// ── 報告 ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
