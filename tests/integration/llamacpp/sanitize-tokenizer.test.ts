/**
 * M-PROMPT-CORRUPTION-HUNT regression test：
 *
 * cli-dev compile binary 在 interactive TUI mode 下 system prompt 會在固定
 * byte offset 被 corrupt（4 bytes 變 8-9 bytes 含 NULL byte 或其他 C0 控制字元），
 * 配 image multimodal 觸發 llama.cpp tokenize fail。
 *
 * 短期 bandaid：adapter 在送 request 前對整個 body 做 deepSanitizeStrings，
 * 剝 [\x00-\x08\x0B\x0C\x0E-\x1F\x7F]，跳過 image_url.url 不動 base64。
 *
 * 本 test 確保 sanitize 邏輯不 regress：
 *   - NULL byte / C0 控制字元被剝
 *   - 合法 \t \n \r 保留
 *   - CJK / emoji / 高 unicode 保留
 *   - image_url.url 不被改（避免破壞 base64）
 *   - 觀察到的 corruption pattern（U+2820 U+3281 U+0295 NUL）剝除後與 clean 等價
 */
import { describe, expect, test } from 'bun:test'
import {
  sanitizeForTokenizer,
  deepSanitizeStrings,
} from '../../../src/services/api/llamacpp-fetch-adapter'

describe('sanitizeForTokenizer', () => {
  test('剝 NULL byte', () => {
    expect(sanitizeForTokenizer('hello\x00world')).toBe('helloworld')
  })

  test('剝 C0 控制字元（除了 tab / newline / CR）', () => {
    const ctrl = '\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F'
    expect(sanitizeForTokenizer(`a${ctrl}b`)).toBe('ab')
  })

  test('剝 DEL (0x7F)', () => {
    expect(sanitizeForTokenizer('a\x7Fb')).toBe('ab')
  })

  test('保留 \\t \\n \\r', () => {
    expect(sanitizeForTokenizer('a\t\n\rb')).toBe('a\t\n\rb')
  })

  test('保留 CJK 字元', () => {
    expect(sanitizeForTokenizer('加入 buun-llama-cpp 作為 git submodule')).toBe(
      '加入 buun-llama-cpp 作為 git submodule',
    )
  })

  test('保留 emoji 與高 unicode', () => {
    expect(sanitizeForTokenizer('hello 🎉 ⠠ ㊁ ʕ world')).toBe(
      'hello 🎉 ⠠ ㊁ ʕ world',
    )
  })

  test('reproduce 觀察到的 corruption pattern (variant A: U+2820 U+3281 U+0295 NUL)', () => {
    // 原本是 "buun-llama-cpp"，cli-dev interactive 時 corrupt 為 "bu⠠㊁ʕ\x00lama-cpp"
    // sanitize 應該剝 NULL byte，留下高 unicode 字元（雖然語意已壞但至少 tokenizer 不會 fail）
    const corrupt = 'bu⠠㊁ʕ\x00lama-cpp'
    const sanitized = sanitizeForTokenizer(corrupt)
    expect(sanitized).toBe('bu⠠㊁ʕlama-cpp')
    expect(sanitized.includes('\x00')).toBe(false)
  })

  test('reproduce variant B: U+29A0 U+5881 U+027A (no NUL but still tokenize-failing combo with image)', () => {
    const corrupt = 'bu⦠墁ɺlama-cpp'
    // 沒 NUL byte 所以 sanitize 不變動；但 sanitize 函式對純高 unicode 不剝（保守）
    expect(sanitizeForTokenizer(corrupt)).toBe(corrupt)
  })
})

describe('deepSanitizeStrings', () => {
  test('遞迴掃 nested object 的 string 欄位', () => {
    const body: any = {
      messages: [
        { role: 'system', content: 'has\x00null' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'also\x01here' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo\x00' } },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'tool\x02', description: 'desc\x03' } }],
    }
    deepSanitizeStrings(body)
    expect(body.messages[0].content).toBe('hasnull')
    expect(body.messages[1].content[0].text).toBe('alsohere')
    // image_url.url 跳過 — 保留原樣（即使有 NUL byte）
    expect(body.messages[1].content[1].image_url.url).toBe(
      'data:image/png;base64,iVBORw0KGgo\x00',
    )
    expect(body.tools[0].function.name).toBe('tool')
    expect(body.tools[0].function.description).toBe('desc')
  })

  test('空 / null / 數字 不會 throw', () => {
    expect(() => deepSanitizeStrings(null)).not.toThrow()
    expect(() => deepSanitizeStrings(undefined)).not.toThrow()
    expect(() => deepSanitizeStrings(42)).not.toThrow()
    expect(() => deepSanitizeStrings({})).not.toThrow()
    expect(() => deepSanitizeStrings([])).not.toThrow()
  })

  test('長 system prompt 含 corruption — 模擬 cli-dev 真實 case', () => {
    // 模擬 31KB+ system prompt 在 byte 31350 含 corruption
    const filler = 'x'.repeat(31000)
    const corruptSection = 'd72e111 chore: 加入 bu⠠㊁ʕ\x00lama-cpp 作為 git submodule'
    const body = {
      messages: [
        { role: 'system', content: filler + '\nRecent commits:\n' + corruptSection },
        {
          role: 'user',
          content: [
            { type: 'text', text: '?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ],
        },
      ],
    }
    deepSanitizeStrings(body)
    expect(body.messages[0].content.includes('\x00')).toBe(false)
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/png;base64,abc')
  })
})
