/**
 * Gemma 4 / Gemopus native tool calling 格式 helper（M-LLAMACPP-GEMMA）
 *
 * 規格、來源、設計理由見 `docs/llamacpp-gemma-tool-format.md`。
 *
 * 本模組為純函式無外部依賴，可獨立單測。所有 helper 不檢查模型，
 * 是否套用由 caller（llamacpp-fetch-adapter.ts）以 `isGemmaModel()` 判斷。
 */

// ── Token 常數（與 gguf jinja 模板對齊）────────────────────────────────────

export const GEMMA_TOK = {
  STR_DELIM: '<|"|>',
  TOOL_OPEN: '<|tool>',
  TOOL_CLOSE: '<tool|>',
  CALL_OPEN: '<|tool_call>',
  CALL_CLOSE: '<tool_call|>',
  RESP_OPEN: '<|tool_response>',
  RESP_CLOSE: '<tool_response|>',
} as const

// ── 模型偵測 ─────────────────────────────────────────────────────────────

/**
 * 偵測 alias 是否為 Gemma 系列（Gemopus / Gemma 衍生品全部適用）。
 * 嚴格 prefix match 避免誤判（如 `gemmini-9b`）。
 */
export function isGemmaModel(model: string | undefined | null): boolean {
  if (typeof model !== 'string' || model.length === 0) return false
  return /^(gemopus|gemma)/i.test(model)
}

// ── Stringify ────────────────────────────────────────────────────────────

/**
 * 把 JS 值序列化成 Gemma pseudo-JSON 格式。
 *
 * 規則：
 *  - string  → `<|"|>` + escape + `<|"|>`
 *  - number  → bare（NaN / Infinity 退化成 null，避免無效 token）
 *  - boolean → bare
 *  - null / undefined → `null`
 *  - array   → `[s,s,...]`（無空白）
 *  - object  → `{key:s,key:s,...}`（key 不加引號）
 *
 * 字串 escape：字面值 `<|"|>` 出現時插入 `\`（變 `<|\"|>`）— 因為 token 解析器
 * 比對的是完整 5-char sequence `<|"|>`，中間插一個 `\` 就不會匹配。
 */
export function gemmaStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null'
    return String(value)
  }
  if (typeof value === 'string') {
    return GEMMA_TOK.STR_DELIM + escapeGemmaString(value) + GEMMA_TOK.STR_DELIM
  }
  if (Array.isArray(value)) {
    return '[' + value.map(gemmaStringify).join(',') + ']'
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      '{' +
      entries.map(([k, v]) => `${k}:${gemmaStringify(v)}`).join(',') +
      '}'
    )
  }
  // function / symbol / bigint → 字串化退路
  return GEMMA_TOK.STR_DELIM + escapeGemmaString(String(value)) + GEMMA_TOK.STR_DELIM
}

function escapeGemmaString(s: string): string {
  // 把 `<|"|>` 拆成 `<|\"|>`；模型對 `\` 寬容，token parser 不會誤觸發
  return s.split(GEMMA_TOK.STR_DELIM).join('<|\\"|>')
}

// ── Parse（best-effort，給響應端 stream parser 用）────────────────────────

export interface GemmaParseResult {
  /** 解析出的 JS 物件 / 陣列 */
  value: unknown
  /** 在輸入字串中消耗到的位置（不含結尾的 `}` / `]`） */
  endIndex: number
}

/**
 * 從位置 `start` 開始解析一個 Gemma value。回傳值 + 消耗位置。
 *
 * 失敗時 throw — caller 應 catch 並 fallback 為 `__raw__: text`。
 */
export function gemmaParseValue(text: string, start = 0): GemmaParseResult {
  let i = skipSpace(text, start)
  if (i >= text.length) throw new Error('gemmaParse: empty input')

  // 字串：以 STR_DELIM 開頭 + 結尾
  if (text.startsWith(GEMMA_TOK.STR_DELIM, i)) {
    return parseString(text, i)
  }
  // 物件
  if (text[i] === '{') return parseObject(text, i)
  // 陣列
  if (text[i] === '[') return parseArray(text, i)
  // 數字 / true / false / null
  return parseScalar(text, i)
}

/**
 * 解析整個 text 為單一值（call/response payload 用）。
 * 如 `call:get_weather{location:<|"|>Tokyo<|"|>}` 應傳入 `{...}` 部分。
 */
export function gemmaParse(text: string): unknown {
  const { value } = gemmaParseValue(text, 0)
  return value
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i++
  return i
}

function parseString(text: string, start: number): GemmaParseResult {
  const open = start + GEMMA_TOK.STR_DELIM.length
  const close = text.indexOf(GEMMA_TOK.STR_DELIM, open)
  if (close < 0) throw new Error('gemmaParse: unterminated string')
  // 反向處理 escape：`<|\"|>` → `<|"|>`
  const raw = text.slice(open, close)
  const unescaped = raw.split('<|\\"|>').join(GEMMA_TOK.STR_DELIM)
  return { value: unescaped, endIndex: close + GEMMA_TOK.STR_DELIM.length }
}

function parseObject(text: string, start: number): GemmaParseResult {
  if (text[start] !== '{') throw new Error('gemmaParse: expected {')
  let i = start + 1
  const out: Record<string, unknown> = {}
  i = skipSpace(text, i)
  if (text[i] === '}') return { value: out, endIndex: i + 1 }
  while (i < text.length) {
    i = skipSpace(text, i)
    // key（裸 identifier 或 quoted string）
    let key: string
    if (text.startsWith(GEMMA_TOK.STR_DELIM, i)) {
      const k = parseString(text, i)
      key = k.value as string
      i = k.endIndex
    } else {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i))
      if (!m) throw new Error(`gemmaParse: invalid object key at ${i}`)
      key = m[0]
      i += m[0].length
    }
    i = skipSpace(text, i)
    if (text[i] !== ':') throw new Error(`gemmaParse: expected : at ${i}`)
    i++
    const v = gemmaParseValue(text, i)
    out[key] = v.value
    i = skipSpace(text, v.endIndex)
    if (text[i] === ',') { i++; continue }
    if (text[i] === '}') return { value: out, endIndex: i + 1 }
    throw new Error(`gemmaParse: expected , or } at ${i}`)
  }
  throw new Error('gemmaParse: unterminated object')
}

function parseArray(text: string, start: number): GemmaParseResult {
  if (text[start] !== '[') throw new Error('gemmaParse: expected [')
  let i = start + 1
  const out: unknown[] = []
  i = skipSpace(text, i)
  if (text[i] === ']') return { value: out, endIndex: i + 1 }
  while (i < text.length) {
    const v = gemmaParseValue(text, i)
    out.push(v.value)
    i = skipSpace(text, v.endIndex)
    if (text[i] === ',') { i++; continue }
    if (text[i] === ']') return { value: out, endIndex: i + 1 }
    throw new Error(`gemmaParse: expected , or ] at ${i}`)
  }
  throw new Error('gemmaParse: unterminated array')
}

function parseScalar(text: string, start: number): GemmaParseResult {
  const rest = text.slice(start)
  // 關鍵字
  if (rest.startsWith('true')) return { value: true, endIndex: start + 4 }
  if (rest.startsWith('false')) return { value: false, endIndex: start + 5 }
  if (rest.startsWith('null')) return { value: null, endIndex: start + 4 }
  // 數字（注意：要嚴格匹配，避免吃進 path 的開頭數字）
  const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[,}\]\s]|$)/.exec(rest)
  if (numMatch) return { value: Number(numMatch[0]), endIndex: start + numMatch[0].length }
  // **容忍 fallback**：模型有時會 emit bare-string（沒用 STR_DELIM 包），
  // 例如 `{file_path:C:\Users\foo\bar.txt}`。為保留 tool call 不掉訊息，
  // 把後續直到下一個 `,` / `}` / `]`（同 nesting depth）的內容當字串收。
  // 注意：不支援值內含上述符號 — 罕見且模型一旦走偏就無法 100% 還原。
  let i = start
  let depth = 0
  while (i < text.length) {
    const ch = text[i]
    if (depth === 0 && (ch === ',' || ch === '}' || ch === ']')) break
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    i++
  }
  if (i === start) throw new Error(`gemmaParse: empty scalar at ${start}`)
  return { value: text.slice(start, i).trim(), endIndex: i }
}

// ── Render：tool 定義 / call / response ────────────────────────────────────

/** OpenAI tool 定義（與 fetch-adapter 內定義保持結構相容） */
export interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

/**
 * 把單一 OpenAI tool 渲染成 `<|tool>declaration:NAME{...}<tool|>`。
 *
 * JSON Schema 內的 type 字面值（string/object/array/...）轉大寫，因為
 * Gemma 4 文件範例都用大寫（STRING / OBJECT / ARRAY / NUMBER / BOOLEAN / INTEGER）。
 */
export function renderToolDeclaration(tool: OpenAIToolDef): string {
  const { name, description, parameters } = tool.function
  const decl: Record<string, unknown> = {}
  if (description) decl.description = description
  if (parameters && typeof parameters === 'object') {
    decl.parameters = upperCaseSchemaTypes(parameters)
  }
  return `${GEMMA_TOK.TOOL_OPEN}declaration:${name}${gemmaStringify(decl)}${GEMMA_TOK.TOOL_CLOSE}`
}

function upperCaseSchemaTypes(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(upperCaseSchemaTypes)
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'type' && typeof v === 'string') {
        out[k] = v.toUpperCase()
      } else {
        out[k] = upperCaseSchemaTypes(v)
      }
    }
    return out
  }
  return schema
}

/**
 * 渲染單一 assistant tool call：`<|tool_call>call:NAME{args}<tool_call|>`。
 *
 * `args` 可以是物件或已序列化的 JSON 字串（OpenAI 的 tool_calls.function.arguments）。
 */
export function renderToolCall(name: string, args: unknown): string {
  let argsObj: unknown = args
  if (typeof args === 'string') {
    try { argsObj = JSON.parse(args || '{}') } catch { argsObj = { __raw__: args } }
  }
  const argsStr = gemmaStringify(argsObj ?? {})
  return `${GEMMA_TOK.CALL_OPEN}call:${name}${argsStr}${GEMMA_TOK.CALL_CLOSE}`
}

/**
 * 渲染單一 tool response：`<|tool_response>response:NAME{result}<tool_response|>`。
 *
 * `result` 接受任意型態（OpenAI tool message content 通常是 JSON 字串或純字串）。
 * 純字串 result 會被包成 `{result:<|"|>...<|"|>}` 維持物件 wrap 一致性。
 */
export function renderToolResponse(name: string, result: unknown): string {
  let resultObj: unknown = result
  if (typeof result === 'string') {
    // 嘗試先 parse 成 JSON；失敗就包一層 `{result:"..."}`
    try {
      const parsed = JSON.parse(result)
      resultObj = parsed
    } catch {
      resultObj = { result }
    }
  }
  const resultStr = gemmaStringify(resultObj ?? {})
  return `${GEMMA_TOK.RESP_OPEN}response:${name}${resultStr}${GEMMA_TOK.RESP_CLOSE}`
}
