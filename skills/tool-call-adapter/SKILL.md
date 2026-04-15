# 工具呼叫協議轉譯

## 說明
Anthropic 和 OpenAI 工具呼叫格式之間轉譯的技術參考。這是 provider 整合中最容易出錯的部分。處理 `toolCallTranslator.ts` 時載入此技能。

## 工具集
file

## 格式比較

### 出站：帶工具的請求

**Anthropic 格式**（free-code 發送的）：
```json
{
  "tools": [{
    "name": "Bash",
    "description": "執行 bash 指令...",
    "input_schema": {
      "type": "object",
      "properties": { "command": { "type": "string" } },
      "required": ["command"]
    }
  }]
}
```

**OpenAI 格式**（LiteLLM/Ollama 預期的）：
```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "Bash",
      "description": "執行 bash 指令...",
      "parameters": {
        "type": "object",
        "properties": { "command": { "type": "string" } },
        "required": ["command"]
      }
    }
  }]
}
```

**轉譯**：`input_schema` → `function.parameters`，外層包裹 `{type: "function", function: {...}}`

### 入站：帶工具呼叫的回應

**OpenAI 格式**（LiteLLM 回傳的）：
```json
{
  "choices": [{
    "message": {
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": { "name": "Bash", "arguments": "{\"command\":\"ls -la\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

**Anthropic 格式**（free-code 預期的）：
```json
{
  "content": [{
    "type": "tool_use",
    "id": "toolu_abc123",
    "name": "Bash",
    "input": {"command": "ls -la"}
  }],
  "stop_reason": "tool_use"
}
```

**轉譯要點**：
- `function.arguments`（JSON 字串）→ 解析 → `input`（物件）
- `finish_reason: "tool_calls"` → `stop_reason: "tool_use"`
- `content: null` → `content: []`（Anthropic 永遠不會有 null content）

### 對話歷史：工具結果

**Anthropic 格式**：
```json
{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_abc123", "content": "output..." }] }
```

**OpenAI 格式**：
```json
{ "role": "tool", "tool_call_id": "call_abc123", "content": "output..." }
```

### 串流轉譯

OpenAI 串流的工具呼叫參數是以增量字串片段發送的。你必須緩衝它們，只在有有效的 JSON 片段時才發出 Anthropic 格式的 `input_json_delta`。

**關鍵串流挑戰**：
1. 工具呼叫參數分散在多個 SSE chunk 中 — 需要緩衝直到完整
2. OpenAI 用 `index` 處理平行工具呼叫 — 對應到分開的 `content_block_start` 事件
3. OpenAI 用 `[DONE]` 結束 — 對應到 `message_stop`
4. 某些模型會發出初始的空 `{}` — 需要過濾掉

## 已知的模型特定行為

| 模型 | 行為 | 處理方式 |
|------|------|---------|
| Qwen 3.5 9B | 通常可靠。偶爾會在參數外多包一層 JSON | 檢測並解開多餘的包裝層 |
| Qwen 2.5 Coder 14B | 有時省略 tool call 的 `id` 欄位 | 生成合成 ID：`call_${Date.now()}_${index}` |
| Qwen3 14B | 支援 thinking 模式，可能在工具呼叫前發出 `<think>` 區塊 | 過濾 thinking 內容 |
| Gemma 4 E4B | 工具名稱大小寫可能與 schema 不同 | 不區分大小寫的工具名稱比對 |
| DeepSeek R1 蒸餾版 | 可能在常規內容中混入思考鏈 | 分離文字 content blocks 和 tool_use blocks |

## 測試清單

對每個 free-code 的 39 個工具，測試：
- [ ] 工具 schema 正確轉譯（出站）
- [ ] 工具呼叫回應正確轉譯（入站）
- [ ] 工具結果能在對話歷史中正確回傳
- [ ] 串流工具呼叫區塊正確組裝
- [ ] 單次回應中多個連續工具呼叫正常運作
- [ ] 工具的錯誤回應被正確處理
