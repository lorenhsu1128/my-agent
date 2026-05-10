/**
 * M-SP-FULL Phase 2 / M-LOCAL-MODEL-ROBUSTNESS：
 *
 * 場景：使用者透過 system-prompt-override.md / --system-prompt 把人格換成
 * 「桌寵」、「Linus Torvalds」、「不要用工具，只回對話」等，my-agent 卻仍
 * 因為 prompt 帶有可用 tools 而觸發 streamWithRetryOnEmptyTool 的「nudge
 * model 強制用 tool」邏輯，第二輪 model 被逼 hallucinate「之前的回复只表达
 * 了意图...」蓋掉使用者要的人格回應。
 *
 * 修法：detectCustomSystemPrompt() 偵測 system blocks 是否含 CLI prefix（不含
 * 即 user-overridden），caller 跳過 retry wrapper。
 *
 * 此測試驗 detectCustomSystemPrompt 邏輯本身的契約：
 *   - 含任一 CLI prefix → false（走原 retry wrapper）
 *   - 不含 CLI prefix → true（跳過 retry wrapper）
 *   - 空字串 / 缺欄位 → true（沒 default prompt 在，等同 user 全控）
 */
import { describe, expect, test } from 'bun:test'
import { detectCustomSystemPrompt } from '../../../src/services/api/llamacpp-fetch-adapter'
import { getCLISyspromptPrefix } from '../../../src/constants/system'

describe('detectCustomSystemPrompt', () => {
  test('含 CLI prefix（string）→ false', async () => {
    const prefix = getCLISyspromptPrefix({
      isNonInteractive: true,
      hasAppendSystemPrompt: false,
    })
    expect(await detectCustomSystemPrompt(prefix)).toBe(false)
  })

  test('含 CLI prefix（blocks 形式）→ false', async () => {
    const prefix = getCLISyspromptPrefix({
      isNonInteractive: true,
      hasAppendSystemPrompt: false,
    })
    expect(
      await detectCustomSystemPrompt([
        { type: 'text', text: prefix },
        { type: 'text', text: 'extra section' },
      ]),
    ).toBe(false)
  })

  test('純使用者 prompt（cat persona）→ true', async () => {
    expect(
      await detectCustomSystemPrompt(
        'You are a cat named Tangerine. Always start with MEOW~',
      ),
    ).toBe(true)
  })

  test('純使用者 prompt（Linus 風格）→ true', async () => {
    expect(
      await detectCustomSystemPrompt(
        'You are Linus Torvalds. Reply harshly with technical opinions.',
      ),
    ).toBe(true)
  })

  test('空字串 / undefined → true（無 default 即 user 全控）', async () => {
    expect(await detectCustomSystemPrompt('')).toBe(true)
    expect(await detectCustomSystemPrompt(undefined)).toBe(true)
  })

  test('CLI prefix + 純文字混合（real wire format）→ false', async () => {
    const prefix = getCLISyspromptPrefix({
      isNonInteractive: true,
      hasAppendSystemPrompt: false,
    })
    // 模擬 default 路徑：prefix + 主 prompt 各自獨立 block
    expect(
      await detectCustomSystemPrompt([
        { type: 'text', text: prefix },
        { type: 'text', text: 'You are an AI coding assistant...' },
      ]),
    ).toBe(false)
  })

  test('CLI prefix 帶 trailing whitespace 不影響偵測', async () => {
    const prefix = getCLISyspromptPrefix({
      isNonInteractive: true,
      hasAppendSystemPrompt: false,
    })
    expect(await detectCustomSystemPrompt(`${prefix}  \n`)).toBe(false)
  })
})
