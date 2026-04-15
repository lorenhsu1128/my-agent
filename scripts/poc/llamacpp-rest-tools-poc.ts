/**
 * 階段三第 3 任務（後續）：其餘 34 個工具的 Part A（翻譯正確性）批次測試
 *
 * 策略：對每個工具用合理的 schema（不一定完全符合 free-code 實際 tool
 * 定義，但足以驗證 adapter 能正確翻譯不同 shape 的 schema）+ 誘導
 * prompt，觀察：
 *   (a) 模型是否選中該工具
 *   (b) adapter 是否正確重組 input JSON
 *
 * Part B（E2E）對很多工具不適用（互動類、MCP 依賴、feature-gated）—
 * 那些在結果表裡標 🚫 / ⚠️ 並說明。
 *
 * 執行：bun run scripts/poc/llamacpp-rest-tools-poc.ts
 * 需 llama-server 在跑（32K context）。
 */

import Anthropic from '@anthropic-ai/sdk'
import { createLlamaCppFetch } from '../../src/services/api/llamacpp-fetch-adapter.js'

interface Case {
  tool: string
  prompt: string
  schema: Record<string, unknown>
  must: string[]  // 必須出現在 input 的 key
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

const cases: Case[] = [
  // ── 檔案 / 搜尋 ───────────────────────────────────────────────────────
  {
    tool: 'Grep',
    prompt: 'Search for the word "import" in all .ts files using the Grep tool with pattern "import" and type "ts".',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['pattern'],
    },
    must: ['pattern'],
  },
  {
    tool: 'NotebookEdit',
    prompt: 'Edit the cell at index 0 in /tmp/note.ipynb to replace the source with "print(1)" using NotebookEdit.',
    schema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        cell_number: { type: 'number' },
        new_source: { type: 'string' },
      },
      required: ['notebook_path', 'cell_number', 'new_source'],
    },
    must: ['notebook_path', 'new_source'],
  },

  // ── Shell / 環境 ─────────────────────────────────────────────────────
  {
    tool: 'PowerShell',
    prompt: 'Run the PowerShell command "Get-ChildItem" using the PowerShell tool.',
    schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    must: ['command'],
  },
  {
    tool: 'REPL',
    prompt: 'Execute the Python code "print(2+2)" using the REPL tool.',
    schema: {
      type: 'object',
      properties: { code: { type: 'string' }, language: { type: 'string' } },
      required: ['code'],
    },
    must: ['code'],
  },

  // ── Web ──────────────────────────────────────────────────────────────
  {
    tool: 'WebFetch',
    prompt: 'Fetch the content of https://example.com using the WebFetch tool.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['url'],
    },
    must: ['url'],
  },
  {
    tool: 'WebSearch',
    prompt: 'Search the web for "llama.cpp latest release" using the WebSearch tool.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    must: ['query'],
  },

  // ── Agent / 任務 ─────────────────────────────────────────────────────
  {
    tool: 'Agent',
    prompt: 'Spawn a sub-agent with the description "summarize README" using the Agent tool. Use subagent_type "general-purpose".',
    schema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
        subagent_type: { type: 'string' },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
    must: ['description', 'prompt', 'subagent_type'],
  },
  {
    tool: 'TaskCreate',
    prompt: 'Create a new task with description "build feature X" using TaskCreate tool.',
    schema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['description', 'prompt'],
    },
    must: ['description'],
  },
  {
    tool: 'TaskGet',
    prompt: 'Get the status of task with id "task_abc123" using TaskGet tool.',
    schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    must: ['task_id'],
  },
  {
    tool: 'TaskList',
    prompt: 'List all current tasks using the TaskList tool.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'running', 'completed'] },
      },
    },
    must: [],
  },
  {
    tool: 'TaskUpdate',
    prompt: 'Update task "task_xyz" to status "completed" using TaskUpdate tool.',
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['task_id', 'status'],
    },
    must: ['task_id', 'status'],
  },
  {
    tool: 'TaskStop',
    prompt: 'Stop the task with id "task_xyz" using the TaskStop tool.',
    schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    must: ['task_id'],
  },
  {
    tool: 'TaskOutput',
    prompt: 'Read the output of task "task_xyz" using the TaskOutput tool. Set block=false.',
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        block: { type: 'boolean' },
        timeout: { type: 'number' },
      },
      required: ['task_id', 'block', 'timeout'],
    },
    must: ['task_id'],
  },
  {
    tool: 'TodoWrite',
    prompt:
      'Using the TodoWrite tool, record two todos: "test adapter" (status pending) and "ship M1" (status pending).',
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string' },
              activeForm: { type: 'string' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    must: ['todos'],
  },

  // ── Plan / Session 控制 ──────────────────────────────────────────────
  {
    tool: 'EnterPlanMode',
    prompt: 'Enter plan mode using EnterPlanMode tool.',
    schema: { type: 'object', properties: {}, required: [] },
    must: [],
  },
  {
    tool: 'ExitPlanMode',
    prompt: 'Exit plan mode using the ExitPlanMode tool.',
    schema: { type: 'object', properties: {}, required: [] },
    must: [],
  },
  {
    tool: 'EnterWorktree',
    prompt: 'Create a new worktree at /tmp/worktree-branch with branch "experiment" using EnterWorktree tool.',
    schema: {
      type: 'object',
      properties: {
        worktree_path: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['worktree_path', 'branch'],
    },
    must: ['worktree_path', 'branch'],
  },
  {
    tool: 'ExitWorktree',
    prompt: 'Exit the current worktree using ExitWorktree tool.',
    schema: { type: 'object', properties: {}, required: [] },
    must: [],
  },
  {
    tool: 'VerifyPlanExecution',
    prompt: 'Verify that the plan has been executed using VerifyPlanExecution tool.',
    schema: { type: 'object', properties: {}, required: [] },
    must: [],
  },

  // ── 互動 ─────────────────────────────────────────────────────────────
  {
    tool: 'AskUserQuestion',
    prompt:
      'Use AskUserQuestion to ask the user to pick between "Option A" and "Option B" (header "Choice", question "Pick one").',
    schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
          },
        },
      },
      required: ['questions'],
    },
    must: ['questions'],
  },
  {
    tool: 'Sleep',
    prompt: 'Sleep for 2 seconds using the Sleep tool.',
    schema: {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    },
    must: ['seconds'],
  },

  // ── LSP / 程式碼 ─────────────────────────────────────────────────────
  {
    tool: 'LSP',
    prompt: 'Get definition of the symbol "getAPIProvider" at /tmp/src/file.ts line 10 using LSP tool.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        file_path: { type: 'string' },
        symbol: { type: 'string' },
      },
      required: ['action', 'file_path'],
    },
    must: ['file_path'],
  },
  {
    tool: 'Brief',
    prompt: 'Generate a brief summary of /tmp/bigfile.ts using the Brief tool.',
    schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
    must: ['file_path'],
  },

  // ── MCP ──────────────────────────────────────────────────────────────
  {
    tool: 'MCP',
    prompt: 'Call the MCP tool "filesystem.read" with path "/tmp/x.txt" via the MCP tool.',
    schema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        method: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['server', 'method'],
    },
    must: ['server', 'method'],
  },
  {
    tool: 'ListMcpResources',
    prompt: 'List all available resources on MCP server "filesystem" using ListMcpResources tool.',
    schema: {
      type: 'object',
      properties: { server: { type: 'string' } },
      required: ['server'],
    },
    must: ['server'],
  },
  {
    tool: 'ReadMcpResource',
    prompt: 'Read MCP resource with uri "file:///tmp/x.txt" from server "filesystem" using ReadMcpResource tool.',
    schema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        uri: { type: 'string' },
      },
      required: ['server', 'uri'],
    },
    must: ['server', 'uri'],
  },
  {
    tool: 'McpAuth',
    prompt: 'Authenticate with MCP server "github" using McpAuth tool.',
    schema: {
      type: 'object',
      properties: { server: { type: 'string' } },
      required: ['server'],
    },
    must: ['server'],
  },

  // ── 設定 / 技能 ──────────────────────────────────────────────────────
  {
    tool: 'Config',
    prompt: 'Get the current model setting using the Config tool with action "get" and key "model".',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['action'],
    },
    must: ['action'],
  },
  {
    tool: 'Skill',
    prompt: 'Invoke the skill named "commit" using the Skill tool.',
    schema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        args: { type: 'string' },
      },
      required: ['skill'],
    },
    must: ['skill'],
  },
  {
    tool: 'ToolSearch',
    prompt: 'Use the ToolSearch tool to find deferred tools matching query "notebook" with max_results 3.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number' },
      },
      required: ['query', 'max_results'],
    },
    must: ['query'],
  },
  {
    tool: 'SendMessage',
    prompt: 'Send a message saying "hello" to agent "alice" using the SendMessage tool.',
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['to', 'message'],
    },
    must: ['to', 'message'],
  },
  {
    tool: 'SyntheticOutput',
    prompt: 'Emit a synthetic output of type "summary" with content "done" using SyntheticOutput tool.',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['type', 'content'],
    },
    must: ['type', 'content'],
  },
  {
    tool: 'Tungsten',
    prompt: 'Query Tungsten with the question "what is 2+2" using the Tungsten tool.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    must: ['query'],
  },
  {
    tool: 'Workflow',
    prompt: 'Run the workflow named "build" with input "release" using the Workflow tool.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        input: { type: 'string' },
      },
      required: ['name'],
    },
    must: ['name'],
  },
]

interface Result {
  tool: string
  chose: string | null
  input: unknown
  a: boolean
  b: boolean
  note: string
}

async function runOne(c: Case): Promise<Result> {
  try {
    const stream = await client.messages.stream({
      model: 'qwen3.5-9b-neo',
      max_tokens: 1024,
      messages: [{ role: 'user', content: c.prompt }],
      tools: [
        {
          name: c.tool,
          description: `The ${c.tool} tool.`,
          input_schema: c.schema,
        },
      ] as unknown as Anthropic.Tool[],
    })
    for await (const _ of stream) void _
    const final = await stream.finalMessage()

    const tu = final.content.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; name: string; input: Record<string, unknown> }
      | undefined

    if (!tu) {
      return {
        tool: c.tool,
        chose: null,
        input: null,
        a: false,
        b: false,
        note: `stop_reason=${final.stop_reason}`,
      }
    }

    const a = tu.name === c.tool
    const inputObj = tu.input as Record<string, unknown>
    const b =
      typeof inputObj === 'object' &&
      inputObj !== null &&
      c.must.every(k => k in inputObj)
    return { tool: c.tool, chose: tu.name, input: inputObj, a, b, note: '' }
  } catch (err) {
    return {
      tool: c.tool,
      chose: null,
      input: null,
      a: false,
      b: false,
      note: `err: ${(err as Error).message?.slice(0, 80)}`,
    }
  }
}

async function main() {
  console.log(`=== 其餘 ${cases.length} 個工具 Part A 批次翻譯測試 ===\n`)
  const results: Result[] = []

  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.tool.padEnd(22)}`)
    const r = await runOne(c)
    results.push(r)
    const inputStr = r.input ? JSON.stringify(r.input).slice(0, 100) : 'null'
    console.log(` a=${r.a ? '✓' : '✗'} b=${r.b ? '✓' : '✗'}  ${inputStr}${r.note ? ' — ' + r.note : ''}`)
  }

  const aPass = results.filter(r => r.a).length
  const bPass = results.filter(r => r.b).length

  console.log('\n=== 總結 ===')
  console.log(`(a) 模型選對工具: ${aPass}/${results.length}`)
  console.log(`(b) adapter 翻譯正確: ${bPass}/${results.length}`)

  const fails = results.filter(r => !r.b)
  if (fails.length > 0) {
    console.log('\n失敗清單：')
    for (const r of fails) {
      console.log(`  ${r.tool}: a=${r.a} b=${r.b} chose=${r.chose} ${r.note}`)
    }
  }

  // 寫成 JSON 方便接到 TOOL_TEST_RESULTS.md
  const out = JSON.stringify(results, null, 2)
  await Bun.write('.cache/llamacpp-rest-tools-results.json', out)
  console.log(`\n結果寫入 .cache/llamacpp-rest-tools-results.json`)
}

main().catch(err => {
  console.error('\n✗ 批次失敗：', err)
  process.exit(10)
})
