# 測試指南

## 說明
如何測試 provider 整合 — 單元測試、整合測試和手動冒煙測試。撰寫或執行測試時載入此技能。

## 工具集
terminal, file

## 測試結構

```
tests/
├── unit/
│   ├── toolCallTranslator.test.ts    # 格式轉譯測試
│   └── providerRegistry.test.ts      # Provider 選擇測試
├── integration/
│   ├── litellm-basic.test.ts         # 透過 LiteLLM 的基本聊天
│   ├── litellm-streaming.test.ts     # 透過 LiteLLM 的串流
│   ├── litellm-tools.test.ts         # 透過 LiteLLM 的工具呼叫
│   └── TOOL_TEST_RESULTS.md          # 逐工具的測試結果日誌
└── smoke/
    └── M1_checklist.md               # 手動驗證清單
```

## 單元測試

在隔離環境下測試轉譯器，不需要網路：

```typescript
// tests/unit/toolCallTranslator.test.ts
import { describe, expect, test } from 'bun:test'
import { ToolCallTranslator } from '../../src/services/providers/toolCallTranslator'

describe('ToolCallTranslator', () => {
  describe('工具 schema 轉譯', () => {
    test('將 Anthropic 工具 schema 轉譯為 OpenAI 格式', () => {
      const anthropicTool = {
        name: 'Bash',
        description: '執行 bash 指令',
        input_schema: {
          type: 'object' as const,
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }
      const openaiTool = ToolCallTranslator.toolToOpenAI(anthropicTool)
      expect(openaiTool.type).toBe('function')
      expect(openaiTool.function.name).toBe('Bash')
      expect(openaiTool.function.parameters).toEqual(anthropicTool.input_schema)
    })
  })

  describe('工具呼叫回應轉譯', () => {
    test('將 OpenAI 工具呼叫轉譯為 Anthropic 格式', () => {
      const openaiToolCall = {
        id: 'call_123',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"ls -la"}' },
      }
      const anthropicBlock = ToolCallTranslator.toolCallToAnthropic(openaiToolCall)
      expect(anthropicBlock.type).toBe('tool_use')
      expect(anthropicBlock.name).toBe('Bash')
      expect(anthropicBlock.input).toEqual({ command: 'ls -la' })
    })

    test('處理 arguments 中的格式錯誤 JSON', () => {
      const openaiToolCall = {
        id: 'call_123',
        type: 'function',
        function: { name: 'Bash', arguments: '{格式錯誤的 json}' },
      }
      // 不應拋出例外，應回傳錯誤內容
      const result = ToolCallTranslator.toolCallToAnthropic(openaiToolCall)
      expect(result.type).toBe('tool_use')
    })
  })
})
```

執行：`conda activate aiagent && bun test tests/unit/`

## 整合測試

需要 LiteLLM + Ollama 執行中。用環境檢查做防護：

```typescript
// tests/integration/litellm-basic.test.ts
import { describe, expect, test, beforeAll } from 'bun:test'

const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:4000'
const TEST_MODEL = process.env.TEST_MODEL || 'qwen3.5:9b'

describe('LiteLLM 基本整合', () => {
  beforeAll(async () => {
    try {
      await fetch(`${LITELLM_URL}/v1/models`)
    } catch {
      console.log('⚠️  LiteLLM 未執行，跳過整合測試')
      process.exit(0)
    }
  })

  test('能發送基本訊息並收到回應', async () => {
    const response = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: '請說：你好世界' }],
        max_tokens: 50,
      }),
    })
    expect(response.ok).toBe(true)
    const data = await response.json()
    expect(data.choices[0].message.content).toBeTruthy()
  })
})
```

執行：`conda activate aiagent && LITELLM_URL=http://localhost:4000 bun test tests/integration/`

## 工具測試結果文件

建立 `tests/integration/TOOL_TEST_RESULTS.md` 以追蹤每個工具：

```markdown
# 工具呼叫測試結果

模型：Qwen 3.5 9B（Q4_K_M）via Ollama
日期：YYYY-MM-DD
LiteLLM 版本：X.Y.Z

| # | 工具 | Schema 正確 | 呼叫正確 | 串流正確 | 備註 |
|---|------|-----------|---------|---------|------|
| 1 | BashTool | ✅ | ✅ | ✅ | |
| 2 | FileReadTool | ✅ | ✅ | ✅ | |
| 3 | FileWriteTool | ✅ | ⚠️ | ✅ | 模型有時省略路徑 |
| ... | ... | ... | ... | ... | ... |
| 39 | WebSearchTool | ✅ | ❌ | N/A | 模型忽略工具，直接生成文字 |
```

## 冒煙測試清單（M1）

儲存為 `tests/smoke/M1_checklist.md`：

```markdown
# M1 冒煙測試清單

## 前置條件
- [ ] Ollama 執行中且已拉取 qwen3.5:9b
- [ ] LiteLLM 在 port 4000 執行中
- [ ] my-agent 已建構並包含 provider 支援

## 基本功能
- [ ] `./cli --model qwen3.5:9b` 啟動無錯誤
- [ ] 啟動橫幅顯示 "qwen3.5:9b" 作為模型
- [ ] 基本聊天可用：輸入「你好」→ 收到回應
- [ ] 串流：回應逐字出現，非一次全部顯示
- [ ] `/model` 指令顯示可用模型

## 工具呼叫
- [ ] 「列出當前目錄的檔案」→ BashTool 觸發 → 顯示輸出
- [ ] 「讀取 CLAUDE.md 的內容」→ FileReadTool 觸發 → 顯示內容
- [ ] 「建立一個名為 test.txt 內容為 hello 的檔案」→ FileWriteTool 觸發 → 檔案已建立
- [ ] 「在此專案中搜尋 TODO」→ GrepTool 觸發 → 顯示結果
- [ ] 多工具：「找到所有 .ts 檔案並計算數量」→ Glob + Bash → 正確數量

## 錯誤處理
- [ ] 停止 LiteLLM → 顯示清楚的錯誤訊息
- [ ] 錯誤的模型名稱 → 顯示 Ollama 的錯誤
- [ ] 生成過程中 Ctrl+C → 乾淨中斷

## 向後相容性
- [ ] 不帶 --model 的 `./cli` → 像之前一樣使用 Anthropic
- [ ] `ANTHROPIC_API_KEY=sk-ant-... ./cli` → 完全如之前運作
- [ ] 所有既有功能不受影響
```

## 測試執行慣例

```bash
# 永遠先啟動環境
conda activate aiagent

# 僅型別檢查（快速，不執行）
bun run typecheck

# 僅單元測試
bun test tests/unit/

# 整合測試（需要 LiteLLM + Ollama）
LITELLM_URL=http://localhost:4000 TEST_MODEL=qwen3.5:9b bun test tests/integration/

# 單一測試檔
bun test tests/unit/toolCallTranslator.test.ts

# 所有測試
bun test
```

## 該測試 vs 不該測試

**該測試**：
- 工具呼叫格式轉譯（單元測試 — 最重要）
- Provider 選擇邏輯（單元測試）
- LiteLLM 連通性（整合測試）
- 串流事件格式（整合測試）
- 每個工具的 schema 轉譯（自動化整合測試）
- 每個工具透過本地模型的實際呼叫（手動測試，記錄結果）

**不該測試**：
- LiteLLM 的內部行為（那是他們的責任）
- Ollama 的推論品質（那是模型的能力）
- my-agent 既有的工具實作（已有測試）
- 本地模型是否做出好的決策（不在範圍內）
