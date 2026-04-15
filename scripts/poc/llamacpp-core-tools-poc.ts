/**
 * Part A：前 5 核心工具翻譯正確性測試
 *
 * 依序對 Bash / FileRead / FileWrite / FileEdit / Glob 五個工具各發一個
 * 誘導 prompt，驗證：
 *   (a) 模型選對工具 — tool_use.name === expected
 *   (b) 翻譯正確   — tool_use.input 是合法 JSON、包含必要欄位
 *
 * 維度 (c) 執行 / (d) 顯示 由 Part B（./cli 端到端）驗證。
 *
 * 不走 ./cli，直接用 SDK + adapter。每個 case 獨立請求，互不干擾。
 */

import Anthropic from '@anthropic-ai/sdk'
import { createLlamaCppFetch } from '../../src/services/api/llamacpp-fetch-adapter.js'

interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface TestCase {
  name: string
  prompt: string
  tool: ToolDef
  requiredInputKeys: string[]  // 至少要有這些 key 才算翻譯正確
}

const client = new Anthropic({
  apiKey: 'llamacpp-placeholder',
  baseURL: 'http://fake.anthropic.local',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch: createLlamaCppFetch({
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3.5-9b-neo',
  }) as any,
})

const cases: TestCase[] = [
  {
    name: 'BashTool',
    prompt: 'List the files in the current directory by calling the Bash tool. Use command "ls -la".',
    tool: {
      name: 'Bash',
      description: 'Execute a bash command',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'shell command to run' },
        },
        required: ['command'],
      },
    },
    requiredInputKeys: ['command'],
  },
  {
    name: 'FileReadTool',
    prompt: 'Read the contents of the file at path "/tmp/hello.txt" by calling the Read tool.',
    tool: {
      name: 'Read',
      description: 'Read a file from disk',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'absolute path' },
        },
        required: ['file_path'],
      },
    },
    requiredInputKeys: ['file_path'],
  },
  {
    name: 'FileWriteTool',
    prompt: 'Create a file at "/tmp/greeting.txt" with content "hello world" by calling the Write tool.',
    tool: {
      name: 'Write',
      description: 'Write content to a file',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
    },
    requiredInputKeys: ['file_path', 'content'],
  },
  {
    name: 'FileEditTool',
    prompt:
      'In the file "/tmp/greeting.txt", replace "hello" with "goodbye" by calling the Edit tool.',
    tool: {
      name: 'Edit',
      description: 'Edit a file by replacing exact strings',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    requiredInputKeys: ['file_path', 'old_string', 'new_string'],
  },
  {
    name: 'GlobTool',
    prompt: 'Find all Markdown files (*.md) in the current directory by calling the Glob tool.',
    tool: {
      name: 'Glob',
      description: 'Find files matching a glob pattern',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob pattern like *.md' },
        },
        required: ['pattern'],
      },
    },
    requiredInputKeys: ['pattern'],
  },
]

interface Result {
  case: string
  expectedTool: string
  modelChose: string | null
  input: Record<string, unknown> | null
  aSelection: boolean
  bTranslation: boolean
  note: string
}

async function runOne(tc: TestCase): Promise<Result> {
  const stream = await client.messages.stream({
    model: 'qwen3.5-9b-neo',
    max_tokens: 1024,
    messages: [{ role: 'user', content: tc.prompt }],
    tools: [tc.tool] as unknown as Anthropic.Tool[],
  })

  // drain stream
  for await (const _ of stream) {
    void _
  }
  const final = await stream.finalMessage()

  const toolBlock = final.content.find(b => b.type === 'tool_use') as
    | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    | undefined

  if (!toolBlock) {
    return {
      case: tc.name,
      expectedTool: tc.tool.name,
      modelChose: null,
      input: null,
      aSelection: false,
      bTranslation: false,
      note: `模型沒呼叫工具（可能走文字回答）；stop_reason=${final.stop_reason}`,
    }
  }

  const aSelection = toolBlock.name === tc.tool.name
  const bTranslation =
    typeof toolBlock.input === 'object' &&
    toolBlock.input !== null &&
    tc.requiredInputKeys.every(k => k in toolBlock.input && typeof (toolBlock.input as Record<string, unknown>)[k] === 'string')

  return {
    case: tc.name,
    expectedTool: tc.tool.name,
    modelChose: toolBlock.name,
    input: toolBlock.input,
    aSelection,
    bTranslation,
    note: aSelection && bTranslation ? '' : '檢查 input keys / tool name',
  }
}

async function main() {
  console.log('=== Part A：前 5 核心工具翻譯正確性測試 ===\n')
  const results: Result[] = []

  for (const tc of cases) {
    process.stdout.write(`[${tc.name}] `)
    try {
      const r = await runOne(tc)
      results.push(r)
      console.log(
        `(a)=${r.aSelection ? '✓' : '✗'} (b)=${r.bTranslation ? '✓' : '✗'}` +
          ` modelChose=${r.modelChose} input=${JSON.stringify(r.input)?.slice(0, 120) ?? 'null'}`,
      )
    } catch (err) {
      console.log(`✗ error: ${(err as Error).message}`)
      results.push({
        case: tc.name,
        expectedTool: tc.tool.name,
        modelChose: null,
        input: null,
        aSelection: false,
        bTranslation: false,
        note: `exception: ${(err as Error).message}`,
      })
    }
  }

  console.log('\n=== 結果摘要 ===')
  const aPass = results.filter(r => r.aSelection).length
  const bPass = results.filter(r => r.bTranslation).length
  console.log(`(a) 模型選對工具: ${aPass}/${results.length}`)
  console.log(`(b) 翻譯正確:     ${bPass}/${results.length}`)
  for (const r of results) {
    console.log(
      `  ${r.case.padEnd(16)} a=${r.aSelection ? '✓' : '✗'} b=${r.bTranslation ? '✓' : '✗'}` +
        (r.note ? ` — ${r.note}` : ''),
    )
  }

  if (bPass < results.length) {
    process.exit(1)
  }
  console.log('\n✓ Part A 通過：五個核心工具的 adapter 翻譯全部正確')
}

main().catch(err => {
  console.error('\n✗ Part A 整體失敗:', (err as Error).message ?? err)
  process.exit(10)
})
