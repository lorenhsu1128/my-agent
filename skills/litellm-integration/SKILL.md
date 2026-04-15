# LiteLLM Proxy 整合

## 說明
如何設定、配置和使用 LiteLLM 作為 free-code 與本地/雲端 LLM provider 之間的 proxy 層。設定或除錯 LiteLLM 連接時載入此技能。

## 工具集
terminal, file

## 什麼是 LiteLLM

LiteLLM 是一個 Python proxy，提供 OpenAI 相容的 API 端點（`/v1/chat/completions`），將請求轉譯到 100+ 個 LLM provider。我們用它作為中間層，這樣 free-code 只需實作一種轉譯（Anthropic ↔ OpenAI），LiteLLM 處理其餘的。

## 設定

```bash
conda activate aiagent

# 安裝
pip install litellm

# 以 Ollama 啟動（最簡單）
litellm --model ollama/qwen3.5:9b --port 4000 --drop_params

# 以設定檔啟動（多模型）
litellm --config litellm_config.yaml --port 4000

# 驗證是否執行中
curl http://localhost:4000/v1/models
```

### litellm_config.yaml 範例

```yaml
model_list:
  - model_name: "qwen3.5:9b"
    litellm_params:
      model: "ollama/qwen3.5:9b"
      api_base: "http://localhost:11434"

  - model_name: "qwen2.5-coder:14b"
    litellm_params:
      model: "ollama/qwen2.5-coder:14b"
      api_base: "http://localhost:11434"

  - model_name: "claude-sonnet"
    litellm_params:
      model: "anthropic/claude-sonnet-4-6"
      api_key: "os.environ/ANTHROPIC_API_KEY"

litellm_settings:
  drop_params: true    # 丟棄不支援的參數而非報錯
  set_verbose: false
```

## LiteLLM API 行為

### `/v1/chat/completions`（主要端點）
請求格式：標準 OpenAI Chat Completions API
- `tools`：OpenAI function calling 格式
- `tool_choice`：`"auto"` | `"none"` | `{type: "function", function: {name: "..."}}`
- `stream`：布林值

### 關鍵行為：
1. **`--drop_params`**：靜默丟棄目標 provider 不支援的參數。永遠使用此旗標。
2. **工具呼叫支援因模型而異**：LiteLLM 傳遞 `tools` 但某些模型會忽略。LiteLLM 不會驗證模型是否實際支援工具呼叫。
3. **串流格式**：標準 OpenAI SSE 格式，`data: {json}\n\n` 行和 `data: [DONE]` 結束符。
4. **錯誤格式**：回傳 OpenAI 相容的錯誤物件。

## 測試連接

```bash
conda activate aiagent

# 基本聊天測試
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:9b","messages":[{"role":"user","content":"說你好"}],"max_tokens":50}'

# 工具呼叫測試
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:9b","messages":[{"role":"user","content":"列出 /tmp 的檔案"}],"tools":[{"type":"function","function":{"name":"Bash","description":"執行 bash 指令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],"tool_choice":"auto","max_tokens":500}'

# 串流測試
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:9b","messages":[{"role":"user","content":"數到 5"}],"stream":true,"max_tokens":100}'
```

## 疑難排解

| 症狀 | 原因 | 修復方式 |
|------|------|---------|
| 「連線被拒」 | LiteLLM 未執行 | 啟動：`litellm --model ollama/qwen3.5:9b --port 4000` |
| 「找不到模型」 | Ollama 沒有該模型 | 執行 `ollama pull qwen3.5:9b` |
| 空的 tool_calls | 模型不支援工具呼叫 | 換用不同模型（推薦 Qwen 2.5+） |
| 「context_length_exceeded」 | 提示太長 | 減少上下文或使用更大上下文的模型 |
| 串流亂碼 | 緩衝問題 | 檢查回應是否有正確的 `Transfer-Encoding: chunked` |

## Ollama 前置條件

```bash
conda activate aiagent

# 安裝 Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 拉取模型
ollama pull qwen3.5:9b

# 啟動 Ollama 伺服器
ollama serve

# 設定上下文長度（agent 使用時很重要）
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

## 效能參考

- LiteLLM proxy 延遲增加：每請求約 2-5ms（本地網路）
- 首次請求可能較慢（模型載入 GPU）
- Qwen 3.5 9B Q4 在 RTX 5070 上：預估 ~30-50 tok/s 生成速度
- 串流首 token 延遲：~500ms-2s（取決於提示長度）
