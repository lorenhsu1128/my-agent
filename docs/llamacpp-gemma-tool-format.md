# Gemma 4 Native Tool Calling 格式參考

> M-LLAMACPP-GEMMA 里程碑的協議參考。my-agent 在偵測模型 alias 為 `gemopus*` / `gemma*` 時切到此格式雙向轉譯。
>
> 來源：
> - [Function calling with Gemma 4 — Google AI for Developers](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)
> - [Gemma 4 Prompt Formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)
> - 從本機 llama-server `/props` endpoint 抓的 gguf-bundled jinja chat_template
> - 已知缺陷追蹤：[ml-explore/mlx-lm#1096](https://github.com/ml-explore/mlx-lm/issues/1096)、[ggml-org/llama.cpp#21384](https://github.com/ggml-org/llama.cpp/issues/21384)

## 1. 為什麼需要這份適配

Gemopus-4-E4B 載入後，llama-server `/props` 顯示的 chat_template 對訊息序列**極為嚴格**：

```jinja
{%- if messages[0]['role'] == 'system' -%}
    {%- set first_user_prefix = messages[0]['content'] + '\n\n' -%}
    {%- set loop_messages = messages[1:] -%}
{%- else -%}
    {%- set first_user_prefix = "" -%}
    {%- set loop_messages = messages -%}
{%- endif -%}
{%- for message in loop_messages -%}
    {%- if (message['role'] == 'user') != (loop.index0 % 2 == 0) -%}
        {{ raise_exception("Conversation roles must alternate user/assistant/user/assistant/...") }}
    {%- endif -%}
    ...
{%- endfor -%}
```

實際限制：

1. system 訊息只支援單筆且固定在 index 0；其 content 會作為 `first_user_prefix` 併入第一個 user turn
2. 剩下的 message 必須**嚴格 user/assistant 交替**（不允許連續同 role、不允許 `tool` role）
3. assistant 在輸出層被改名為 `model`
4. content 接受 string 或 iterable（type ∈ {audio, image, video, text}）；**不處理 OpenAI 格式的 `tool_calls` 欄位**
5. llama.cpp 也**沒有對 Gemma 4 做 tool_call 響應端解析**，模型輸出的 `<|tool_call>...<tool_call|>` 不會被自動轉回 OpenAI 的 `tool_calls`

→ 因此必須在 my-agent 端做**雙向轉譯**：request 階段把 OpenAI tool 定義 / tool_calls / tool 結果打包成 Gemma token 嵌進 message content；response 階段把 model 輸出的 `<|tool_call>` 抽回 OpenAI `tool_calls` 欄位。

## 2. 特殊 Token 一覽

| Token | 用途 |
|------|------|
| `<\|turn>role` ... `<turn\|>` | turn 邊界（chat_template 自動處理，我們**不**直接寫） |
| `<\|tool>` ... `<tool\|>` | 包圍 **tool 定義**（放在 system 訊息內） |
| `<\|tool_call>` ... `<tool_call\|>` | 包圍 **assistant 發出的 tool call** |
| `<\|tool_response>` ... `<tool_response\|>` | 包圍 **tool 結果**（嵌進 model turn） |
| `<\|"\|>` | 字串值的左右分隔符（取代 `"`，避免引號逃逸） |

## 3. 值的序列化規則（gemmaStringify）

| 型態 | 編碼 |
|------|------|
| string | `<\|"\|>` + escape + `<\|"\|>` |
| number | bare（`15`、`-3.14`） |
| boolean | bare（`true` / `false`） |
| null | bare（`null`） |
| array | `[s(item),s(item),...]`（無空白） |
| object | `{key:s(val),key:s(val),...}`（key 不加引號；OpenAI tool args 的 key 都是 valid identifier） |

特殊字元 escape 策略（保守）：
- 字面值 `<|"|>` 出現在字串內部 → 用 `<|\"|>`（反斜線是普通字元；token 不會被誤觸發）
- 反斜線 `\` → 不額外轉義（避免 over-escape）
- 換行 / tab → 保留為原字元，模型對這類純文字寬容

## 4. 三種訊息片段渲染

### 4.1 Tool 定義（放 system 內）

OpenAI tool（JSON Schema）：

```json
{
  "name": "get_weather",
  "description": "Get current weather",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {"type": "string", "description": "City name"}
    },
    "required": ["location"]
  }
}
```

→ Gemma：

```
<|tool>declaration:get_weather{description:<|"|>Get current weather<|"|>,parameters:{properties:{location:{description:<|"|>City name<|"|>,type:<|"|>STRING<|"|>}},required:[<|"|>location<|"|>],type:<|"|>OBJECT<|"|>}}<tool|>
```

注意：JSON Schema type 字面值（`string` / `object` / `array` / `number` / `boolean` / `integer`）需轉大寫（Gemma 文件範例都用大寫）。

### 4.2 Assistant tool call

OpenAI：

```json
{"role": "assistant", "tool_calls": [{
  "id": "call_xyz",
  "function": {"name": "get_weather", "arguments": "{\"location\":\"Tokyo\"}"}
}]}
```

→ Gemma（嵌進 assistant content 文字流，不單獨成 message）：

```
<|tool_call>call:get_weather{location:<|"|>Tokyo<|"|>}<tool_call|>
```

OpenAI 的 `id` 在 Gemma 端不需要（model 不感知 ID）；響應端解析時**重新生成** `call_<uuid>`。

### 4.3 Tool response

OpenAI：

```json
{"role": "tool", "tool_call_id": "call_xyz", "content": "{\"temperature\":15,\"weather\":\"sunny\"}"}
```

→ Gemma（同樣嵌進 model turn 文字流）：

```
<|tool_response>response:get_weather{temperature:15,weather:<|"|>sunny<|"|>}<tool_response|>
```

> **重要**：tool response 並非新一個 turn — 它附加在發出 call 的同一個 model turn 內，後面接 model 的最終文字答覆。這也是為什麼 OpenAI 的 `[assistant{tool_calls}, tool, assistant{text}]` 三條 message 必須**併成 Gemma 的一條 assistant message**。

## 5. 完整多輪範例

```
<|turn>system
You are helpful.<|tool>declaration:get_weather{...}<tool|><turn|>
<|turn>user
Tokyo weather?<turn|>
<|turn>model
<|tool_call>call:get_weather{location:<|"|>Tokyo<|"|>}<tool_call|><|tool_response>response:get_weather{temperature:15,weather:<|"|>sunny<|"|>}<tool_response|>Tokyo is 15°C and sunny.<turn|>
```

## 6. my-agent 端轉譯規則摘要

### Request side（OpenAI → Gemma）

1. 把所有 `tools` 經 `renderToolDeclaration()` concat → append 到第一筆 system content 尾端 → request body **拿掉 `tools` 欄位**
2. 多筆 system 合併成一筆（`\n\n` 分隔）
3. **Packing window**：遇到 `assistant{tool_calls}` → 收集後續所有 `role:'tool'` + 後續可能的 `assistant{text only}`，全部併成一筆 assistant，content 為：
   ```
   <prev assistant text>
   <render(tool_calls)>...
   <render(tool_results)>...
   <next assistant text>
   ```
4. 首個非-system 是 assistant → prepend 空 user `{role:'user', content:'(continue)'}`
5. 殘留連續同 role → 合併
6. assistant content 為 null → 補空字串

### Response side（Gemma → OpenAI）

streaming SSE 收到 content delta 時：
- 維護 buffer 偵測 `<|tool_call>` 進入 tool_call mode
- 在 mode 內收到 `<tool_call|>` → 把 buffer 餵 `gemmaParse` → emit OpenAI `tool_calls` delta（id 自產 `call_<uuid>`）
- 偵測 `<|tool_response>` ... `<tool_response|>` → 略過（model 自己 echo 歷史，不該再傳給 client）
- 純文字穿插：照原樣 emit
- 異常未閉合 token → 超過 N tokens 沒 close 就把 buffer 當純文字 emit fallback

## 7. 偵測函式

```ts
export function isGemmaModel(model: string): boolean {
  return /^(gemopus|gemma)/i.test(model)
}
```

只在 `isGemmaModel(targetModel) === true` 時觸發本格式；其他模型維持原 OpenAI/Anthropic 路徑。

## 8. Vision 順序

Gemma 4 model card 建議：image / audio 部分放在 text **之前**。adapter 內 `translateMessagesToOpenAI` 對含圖訊息的 multipart content 順序改為 `[...images, text]`（同時影響其他 OpenAI 後端，但中性）。

## 9. 已知限制 / 後續

- Audio 輸入（mmproj 含 audio encoder）尚未串
- Vision token budget（70/140/280/560/1120）尚未暴露 API
- Sliding window 512 對長 context 的實際影響待觀察
- llama.cpp 上游若加入 native Gemma 4 tool parser → 響應端 parser 可移除
