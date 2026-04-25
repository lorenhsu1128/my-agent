/**
 * scheduled_tasks.json 寫回保留註解測試。
 *
 * 核心場景：使用者在 tasks 陣列外加檔頭註解，my-agent 因 markCronFiredBatch
 * 更新 lastFiredAt 寫回，註解仍在。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseJsonc } from '../../../src/utils/jsoncStore'
import { CRON_TASKS_JSONC_TEMPLATE } from '../../../src/utils/bundledCronTasksTemplate'
import {
  readCronTasks,
  writeCronTasks,
} from '../../../src/utils/cronTasks'

let testDir: string

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cron-jsonc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(join(testDir, '.my-agent'), { recursive: true })
})

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // ignore Windows lock
  }
})

describe('CRON_TASKS_JSONC_TEMPLATE', () => {
  test('模板是合法 JSONC 且有 tasks 陣列', () => {
    const parsed = parseJsonc(CRON_TASKS_JSONC_TEMPLATE) as { tasks: unknown }
    expect(Array.isArray(parsed.tasks)).toBe(true)
    expect(parsed.tasks).toEqual([])
  })

  test('模板含繁中 schema 說明註解', () => {
    expect(CRON_TASKS_JSONC_TEMPLATE).toContain('id:')
    expect(CRON_TASKS_JSONC_TEMPLATE).toContain('recurring:')
    expect(CRON_TASKS_JSONC_TEMPLATE).toContain('retry:')
    expect(CRON_TASKS_JSONC_TEMPLATE).toContain('cron:')
    // 繁體中文關鍵字
    expect(CRON_TASKS_JSONC_TEMPLATE).toContain('週期性')
  })
})

describe('writeCronTasks + readCronTasks JSONC 行為', () => {
  test('首次寫入（檔不存在）→ 使用 bundled 模板作為基底', async () => {
    await writeCronTasks(
      [
        {
          id: 'abc12345',
          cron: '0 * * * *',
          prompt: 'hello',
          createdAt: 1000,
          recurring: true,
        },
      ],
      testDir,
    )
    const filePath = join(testDir, '.my-agent', 'scheduled_tasks.json')
    expect(existsSync(filePath)).toBe(true)
    const text = readFileSync(filePath, 'utf-8')
    // 檔頭註解（模板帶的）應該留著
    expect(text).toContain('Cron 排程任務')
    expect(text).toContain('8 個工具')
    // 使用者的 task 也寫進去了
    expect(text).toContain('abc12345')
    expect(text).toContain('"prompt": "hello"')
  })

  test('讀回來能 round-trip 相同 task', async () => {
    const task = {
      id: 'def67890',
      cron: '*/5 * * * *',
      prompt: 'ping',
      createdAt: 2000,
      recurring: true,
    }
    await writeCronTasks([task], testDir)
    const tasks = await readCronTasks(testDir)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe('def67890')
    expect(tasks[0]!.cron).toBe('*/5 * * * *')
    expect(tasks[0]!.prompt).toBe('ping')
    expect(tasks[0]!.createdAt).toBe(2000)
    expect(tasks[0]!.recurring).toBe(true)
  })

  test('保留使用者手加的檔頭註解（模擬 fire 後寫回 lastFiredAt）', async () => {
    const filePath = join(testDir, '.my-agent', 'scheduled_tasks.json')
    // 使用者手寫的註解版本
    const userVersion = `{
  // 使用者加的備註：這些是我每天的例行任務
  // 不要亂動！
  "tasks": [
    {
      "id": "a1",
      "cron": "0 9 * * *",
      "prompt": "早晨檢查 email",
      "createdAt": 100,
      "recurring": true
    }
  ]
}`
    writeFileSync(filePath, userVersion, 'utf-8')

    // 模擬 fire 後 markCronFiredBatch 寫回 lastFiredAt
    await writeCronTasks(
      [
        {
          id: 'a1',
          cron: '0 9 * * *',
          prompt: '早晨檢查 email',
          createdAt: 100,
          recurring: true,
          lastFiredAt: 9999,
          lastStatus: 'ok',
        },
      ],
      testDir,
    )

    const after = readFileSync(filePath, 'utf-8')
    // 使用者註解仍在
    expect(after).toContain('使用者加的備註')
    expect(after).toContain('不要亂動')
    // lastFiredAt 已寫入
    expect(after).toContain('"lastFiredAt": 9999')
    expect(after).toContain('"lastStatus": "ok"')
  })

  test('相容既有 strict JSON 檔（parseJsonc fallback 成 safeParseJSON）', async () => {
    const filePath = join(testDir, '.my-agent', 'scheduled_tasks.json')
    // 舊的 strict JSON 格式（無註解）
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          tasks: [
            {
              id: 'x1',
              cron: '0 0 * * *',
              prompt: 'old',
              createdAt: 50,
              recurring: true,
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    )
    const tasks = await readCronTasks(testDir)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe('x1')
  })

  test('刪除所有 task → 檔仍寫出（watcher 需要看到變化）', async () => {
    await writeCronTasks(
      [
        {
          id: 'will-delete',
          cron: '0 0 * * *',
          prompt: 'bye',
          createdAt: 100,
          recurring: false,
        },
      ],
      testDir,
    )
    await writeCronTasks([], testDir)
    const filePath = join(testDir, '.my-agent', 'scheduled_tasks.json')
    expect(existsSync(filePath)).toBe(true)
    const tasks = await readCronTasks(testDir)
    expect(tasks).toEqual([])
  })
})
