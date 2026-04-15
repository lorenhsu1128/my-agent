# Provider 系統設計

## 說明
`src/services/providers/` 中多 provider 抽象層的設計模式和實作指南。處理 provider 相關程式碼時載入此技能。

## 工具集
file, terminal

## 設計原則

Provider 層位於 QueryEngine 和實際 API 端點之間。它將 free-code 內部的 Anthropic 格式訊息轉譯為目標 provider 預期的格式，並將回應轉譯回來。

```
QueryEngine.ts
  → 內部使用 Anthropic Messages API 格式（messages[]、tools[]、system）
  → 呼叫 Provider.sendMessageStream()

Provider 介面
  ├── AnthropicAdapter → 既有的 src/services/api/（零修改）
  └── LiteLLMProvider → HTTP 到 LiteLLM proxy → Ollama/OpenRouter/等

LiteLLMProvider
  → 將 Anthropic 格式 → 轉譯為 OpenAI 格式（透過 ToolCallTranslator）
  → HTTP POST 到 LiteLLM proxy
  → 接收 OpenAI 格式的串流回應
  → 轉譯回 → Anthropic 格式
  → 回傳給 QueryEngine
```

## Provider 介面（`types.ts`）

```typescript
export interface Provider {
  readonly name: string
  readonly isLocal: boolean

  sendMessage(params: MessageParams): Promise<MessageResponse>
  sendMessageStream(params: MessageParams): AsyncIterable<StreamEvent>
  listModels(): Promise<ModelInfo[]>
  validateConnection(): Promise<boolean>
}

export interface MessageParams {
  model: string
  messages: AnthropicMessage[]
  system?: string
  tools?: AnthropicTool[]
  max_tokens: number
  temperature?: number
  stream: boolean
}

// StreamEvent 應符合 free-code 既有的內部事件型別
// 研讀 src/services/tools/StreamingToolExecutor.ts 以了解預期格式
export type StreamEvent =
  | { type: 'content_block_start'; content_block: ContentBlock }
  | { type: 'content_block_delta'; delta: ContentDelta }
  | { type: 'content_block_stop' }
  | { type: 'message_start'; message: MessageStart }
  | { type: 'message_delta'; delta: MessageDelta }
  | { type: 'message_stop' }
```

## 與既有程式碼的整合點

### 對既有程式碼的最小修改：

1. **`src/QueryEngine.ts`** — 目前直接呼叫 `src/services/api/claude.ts`。加入 provider 解析步驟：如果已設定 LiteLLM，使用 LiteLLMProvider；否則使用 AnthropicAdapter（封裝既有程式碼路徑，不做任何改變）。

2. **`src/bootstrap/state.ts`** — 在應用程式啟動時加入 provider 初始化。讀取設定以決定使用哪個 provider。

3. **`src/commands/model/`** — 擴充模型選擇以包含 LiteLLM 代理的模型。

4. **`src/utils/model/`** — 加入 LiteLLM 模型名稱辨識。

### 不要修改的檔案：
- `src/services/api/client.ts` — 保持原狀作為 Anthropic 原生路徑
- `src/services/api/claude.ts` — 保持原狀
- `src/Tool.ts` — 工具不需要知道 provider
- `src/tools.ts` — 工具註冊表保持不變
- `src/services/tools/*` — 工具執行管線保持不變

## 設定方式

使用者如何選擇 provider。有幾種做法需要評估：

**做法 A：環境變數（類似既有的 Bedrock/Vertex）**
```bash
export LITELLM_PROXY_URL=http://localhost:4000
export LITELLM_MODEL=qwen3.5:9b
./cli
```

**做法 B：CLI 旗標**
```bash
./cli --provider litellm --model qwen3.5:9b --proxy-url http://localhost:4000
```

**做法 C：設定檔**
```json
// ~/.claude/settings.json
{
  "provider": "litellm",
  "litellm": {
    "proxyUrl": "http://localhost:4000",
    "defaultModel": "qwen3.5:9b"
  }
}
```

在實作之前，將這些選項提交給人類決定。

## 錯誤情境

1. **LiteLLM proxy 未執行** → 清楚的錯誤訊息：「無法連接到 {url} 的 LiteLLM proxy。是否已啟動？」
2. **Ollama 中找不到模型** → 傳遞 Ollama 的錯誤：「找不到模型 {name}」
3. **工具呼叫轉譯失敗** → 記錄失敗的轉譯，回傳錯誤給 LLM 讓它重試
4. **串流中斷** → 與既有 Anthropic 串流中斷相同的行為
5. **認證失敗** → 本地模型不適用（不需要認證）
