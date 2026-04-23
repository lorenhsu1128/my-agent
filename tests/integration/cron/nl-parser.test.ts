import { describe, expect, test } from 'bun:test'
import {
  CronNLParseError,
  parseScheduleNL,
} from '../../../src/utils/cronNlParser'

// Build a fake queryHaiku that returns whatever text we want.
function fakeQuery(textFn: () => string) {
  return async () =>
    ({
      message: {
        content: [{ type: 'text', text: textFn() }],
      },
    }) as unknown as Awaited<ReturnType<typeof import('../../../src/services/api/claude').queryHaiku>>
}

describe('cronNlParser — parseScheduleNL', () => {
  test('parses well-formed JSON response', async () => {
    const r = await parseScheduleNL('每週一早上 9 點', {
      signal: new AbortController().signal,
      query: fakeQuery(() =>
        JSON.stringify({
          cron: '0 9 * * 1',
          recurring: true,
          humanReadable: 'Every Monday at 9am',
        }),
      ) as never,
    })
    expect(r.cron).toBe('0 9 * * 1')
    expect(r.recurring).toBe(true)
    expect(r.humanReadable).toBe('Every Monday at 9am')
  })

  test('extracts JSON from prose-wrapped response', async () => {
    const r = await parseScheduleNL('every 5 minutes', {
      signal: new AbortController().signal,
      query: fakeQuery(
        () =>
          'Sure! Here is the JSON:\n```json\n{"cron": "*/5 * * * *", "recurring": true, "humanReadable": "every 5 min"}\n```',
      ) as never,
    })
    expect(r.cron).toBe('*/5 * * * *')
    expect(r.recurring).toBe(true)
  })

  test('throws on missing JSON', async () => {
    await expect(
      parseScheduleNL('foo', {
        signal: new AbortController().signal,
        query: fakeQuery(() => 'I cannot help with this') as never,
      }),
    ).rejects.toBeInstanceOf(CronNLParseError)
  })

  test('throws on invalid JSON', async () => {
    await expect(
      parseScheduleNL('foo', {
        signal: new AbortController().signal,
        query: fakeQuery(() => '{not real json}') as never,
      }),
    ).rejects.toBeInstanceOf(CronNLParseError)
  })

  test('throws when model says INVALID', async () => {
    await expect(
      parseScheduleNL('gibberish', {
        signal: new AbortController().signal,
        query: fakeQuery(() =>
          JSON.stringify({
            cron: 'INVALID',
            recurring: false,
            humanReadable: 'cannot parse',
          }),
        ) as never,
      }),
    ).rejects.toBeInstanceOf(CronNLParseError)
  })

  test('throws when cron string fails parseCronExpression', async () => {
    await expect(
      parseScheduleNL('foo', {
        signal: new AbortController().signal,
        query: fakeQuery(() =>
          JSON.stringify({
            cron: 'not five fields',
            recurring: true,
            humanReadable: 'broken',
          }),
        ) as never,
      }),
    ).rejects.toBeInstanceOf(CronNLParseError)
  })

  test('retries once on transient failure', async () => {
    let calls = 0
    const r = await parseScheduleNL('每天 8 點', {
      signal: new AbortController().signal,
      query: (async () => {
        calls++
        if (calls === 1) throw new Error('transient network')
        return {
          message: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cron: '0 8 * * *',
                  recurring: true,
                  humanReadable: 'daily 8am',
                }),
              },
            ],
          },
        } as unknown as Awaited<
          ReturnType<typeof import('../../../src/services/api/claude').queryHaiku>
        >
      }) as never,
    })
    expect(calls).toBe(2)
    expect(r.cron).toBe('0 8 * * *')
  })

  test('throws CronNLParseError on empty input', async () => {
    await expect(
      parseScheduleNL('   ', {
        signal: new AbortController().signal,
        query: fakeQuery(() => '{}') as never,
      }),
    ).rejects.toBeInstanceOf(CronNLParseError)
  })

  test('humanReadable defaults to cron string when missing', async () => {
    const r = await parseScheduleNL('每週日午夜', {
      signal: new AbortController().signal,
      query: fakeQuery(() =>
        JSON.stringify({ cron: '0 0 * * 0', recurring: true }),
      ) as never,
    })
    expect(r.humanReadable).toBe('0 0 * * 0')
  })
})
