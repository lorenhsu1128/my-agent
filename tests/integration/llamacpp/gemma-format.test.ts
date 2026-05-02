// M-LLAMACPP-GEMMA：gemma format helper 單元測試
// 覆蓋 stringify / parse round-trip / tool 渲染 / 模型偵測。

import { describe, expect, test } from 'bun:test'
import {
  GEMMA_TOK,
  gemmaParse,
  gemmaParseValue,
  gemmaStringify,
  isGemmaModel,
  renderToolCall,
  renderToolDeclaration,
  renderToolResponse,
  type OpenAIToolDef,
} from '../../../src/services/api/llamacpp-gemma-format.js'

const Q = GEMMA_TOK.STR_DELIM // <|"|>

describe('gemmaStringify scalar', () => {
  test('null / undefined → null', () => {
    expect(gemmaStringify(null)).toBe('null')
    expect(gemmaStringify(undefined)).toBe('null')
  })
  test('boolean', () => {
    expect(gemmaStringify(true)).toBe('true')
    expect(gemmaStringify(false)).toBe('false')
  })
  test('integer / float', () => {
    expect(gemmaStringify(15)).toBe('15')
    expect(gemmaStringify(-3.14)).toBe('-3.14')
    expect(gemmaStringify(0)).toBe('0')
  })
  test('NaN / Infinity → null', () => {
    expect(gemmaStringify(NaN)).toBe('null')
    expect(gemmaStringify(Infinity)).toBe('null')
    expect(gemmaStringify(-Infinity)).toBe('null')
  })
  test('plain string wrapped with STR_DELIM', () => {
    expect(gemmaStringify('Tokyo')).toBe(`${Q}Tokyo${Q}`)
  })
  test('empty string', () => {
    expect(gemmaStringify('')).toBe(`${Q}${Q}`)
  })
})

describe('gemmaStringify collection', () => {
  test('empty array / object', () => {
    expect(gemmaStringify([])).toBe('[]')
    expect(gemmaStringify({})).toBe('{}')
  })
  test('array of mixed types', () => {
    expect(gemmaStringify([1, 'a', true, null])).toBe(`[1,${Q}a${Q},true,null]`)
  })
  test('object with identifier keys', () => {
    expect(gemmaStringify({ location: 'Tokyo', count: 3 })).toBe(
      `{location:${Q}Tokyo${Q},count:3}`,
    )
  })
  test('nested object', () => {
    const v = { outer: { inner: ['a', 'b'] }, n: 5 }
    expect(gemmaStringify(v)).toBe(
      `{outer:{inner:[${Q}a${Q},${Q}b${Q}]},n:5}`,
    )
  })
})

describe('gemmaStringify escape', () => {
  test('字串內含 STR_DELIM 會被插入反斜線避免 token 誤觸發', () => {
    const out = gemmaStringify(`hello ${Q} world`)
    // token parser 比對 5-char `<|"|>`，中間插 \ 變 `<|\"|>` 就不匹配
    expect(out).toBe(`${Q}hello <|\\"|> world${Q}`)
    // round-trip 應還原原字串
    expect(gemmaParse(out)).toBe(`hello ${Q} world`)
  })
  test('字串含換行與 tab 原樣保留', () => {
    expect(gemmaStringify('a\nb\tc')).toBe(`${Q}a\nb\tc${Q}`)
  })
})

describe('gemmaParse round-trip', () => {
  const roundTrip = (v: unknown) => gemmaParse(gemmaStringify(v))

  test('scalar', () => {
    expect(roundTrip(null)).toBe(null)
    expect(roundTrip(true)).toBe(true)
    expect(roundTrip(42)).toBe(42)
    expect(roundTrip('hello')).toBe('hello')
  })
  test('array', () => {
    expect(roundTrip([1, 2, 'three', false])).toEqual([1, 2, 'three', false])
  })
  test('object', () => {
    expect(roundTrip({ a: 1, b: 'two', c: [3, 4] })).toEqual({
      a: 1,
      b: 'two',
      c: [3, 4],
    })
  })
  test('nested', () => {
    const v = {
      tools: [
        { name: 'Bash', args: { cmd: 'ls -la', cwd: '/tmp' } },
        { name: 'Read', args: { path: '/etc/hosts' } },
      ],
      n: 2,
    }
    expect(roundTrip(v)).toEqual(v)
  })
  test('empty containers', () => {
    expect(roundTrip([])).toEqual([])
    expect(roundTrip({})).toEqual({})
  })
})

describe('gemmaParse 容忍 bare-string fallback（model 偏離規格時）', () => {
  test('bare 字串值（沒用 STR_DELIM 包）被當字串收', () => {
    const v = gemmaParse('{file_path:hello}')
    expect(v).toEqual({ file_path: 'hello' })
  })
  test('bare 字串含反斜線 Windows path', () => {
    const v = gemmaParse('{path:C:\\Users\\foo\\bar.txt}')
    expect(v).toEqual({ path: 'C:\\Users\\foo\\bar.txt' })
  })
  test('bare 字串接續其他 key', () => {
    const v = gemmaParse('{p:abc,n:5}')
    expect(v).toEqual({ p: 'abc', n: 5 })
  })
  test('bare 含內部嵌套 {} 仍能正確抓 boundary', () => {
    const v = gemmaParse('{outer:{inner:value}}')
    expect(v).toEqual({ outer: { inner: 'value' } })
  })
})

describe('gemmaParse error / edge', () => {
  test('未閉合字串 throws', () => {
    expect(() => gemmaParse(`${Q}foo`)).toThrow()
  })
  test('未閉合物件 throws', () => {
    expect(() => gemmaParse(`{a:1,b:2`)).toThrow()
  })
  test('parseValue 回傳 endIndex 正確', () => {
    const text = `${Q}hi${Q}xtail`
    const r = gemmaParseValue(text, 0)
    expect(r.value).toBe('hi')
    // delim(5) + 'hi'(2) + delim(5) = 12
    expect(r.endIndex).toBe(12)
  })
  test('包含字串 escape 解析還原', () => {
    const text = `${Q}foo<|\\"|>bar${Q}`
    expect(gemmaParse(text)).toBe(`foo${Q}bar`)
  })
})

describe('renderToolDeclaration', () => {
  test('帶 description + parameters', () => {
    const tool: OpenAIToolDef = {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City' },
          },
          required: ['location'],
        },
      },
    }
    const out = renderToolDeclaration(tool)
    expect(out.startsWith(GEMMA_TOK.TOOL_OPEN + 'declaration:get_weather')).toBe(true)
    expect(out.endsWith(GEMMA_TOK.TOOL_CLOSE)).toBe(true)
    // type 字面值大寫
    expect(out).toContain(`${Q}STRING${Q}`)
    expect(out).toContain(`${Q}OBJECT${Q}`)
    // description 與 required
    expect(out).toContain(`description:${Q}Get current weather${Q}`)
    expect(out).toContain(`required:[${Q}location${Q}]`)
  })
  test('無 description 仍能渲染', () => {
    const tool: OpenAIToolDef = {
      type: 'function',
      function: {
        name: 'noop',
        parameters: { type: 'object', properties: {} },
      },
    }
    const out = renderToolDeclaration(tool)
    expect(out).toContain('declaration:noop')
    expect(out).not.toContain('description:')
  })
})

describe('renderToolCall', () => {
  test('args 為物件', () => {
    const out = renderToolCall('Bash', { command: 'ls', timeout: 5000 })
    expect(out.startsWith(GEMMA_TOK.CALL_OPEN + 'call:Bash')).toBe(true)
    expect(out.endsWith(GEMMA_TOK.CALL_CLOSE)).toBe(true)
    expect(out).toContain(`command:${Q}ls${Q}`)
    expect(out).toContain('timeout:5000')
  })
  test('args 為 JSON 字串自動 parse', () => {
    const out = renderToolCall('Read', '{"path":"/tmp/x"}')
    expect(out).toContain(`path:${Q}/tmp/x${Q}`)
  })
  test('無效 JSON 字串走 __raw__ 退路', () => {
    const out = renderToolCall('X', '{not json}')
    expect(out).toContain('__raw__')
  })
})

describe('renderToolResponse', () => {
  test('JSON 字串 result 自動 parse', () => {
    const out = renderToolResponse('get_weather', '{"temp":15}')
    expect(out.startsWith(GEMMA_TOK.RESP_OPEN + 'response:get_weather')).toBe(true)
    expect(out.endsWith(GEMMA_TOK.RESP_CLOSE)).toBe(true)
    expect(out).toContain('temp:15')
  })
  test('純字串 result 包成 {result:"..."}', () => {
    const out = renderToolResponse('Bash', 'OK\nfile1.txt')
    expect(out).toContain(`result:${Q}OK\nfile1.txt${Q}`)
  })
  test('物件 result 直接序列化', () => {
    const out = renderToolResponse('search', { count: 3, items: ['a'] })
    expect(out).toContain('count:3')
    expect(out).toContain(`items:[${Q}a${Q}]`)
  })
})

describe('isGemmaModel', () => {
  test('gemopus 命中', () => {
    expect(isGemmaModel('gemopus-4-e4b')).toBe(true)
    expect(isGemmaModel('Gemopus-4-E4B')).toBe(true)
    expect(isGemmaModel('GEMOPUS')).toBe(true)
  })
  test('gemma 命中', () => {
    expect(isGemmaModel('gemma-3-9b')).toBe(true)
    expect(isGemmaModel('gemma4-27b')).toBe(true)
  })
  test('其他 model 不命中', () => {
    expect(isGemmaModel('qwen3.5-9b')).toBe(false)
    expect(isGemmaModel('qwen3.5-9b-neo')).toBe(false)
    expect(isGemmaModel('llama-3-70b')).toBe(false)
    expect(isGemmaModel('claude-opus-4-7')).toBe(false)
  })
  test('邊界：相似前綴但不是 gemma/gemopus', () => {
    expect(isGemmaModel('gemmini-9b')).toBe(false)
    expect(isGemmaModel('gemstone-x')).toBe(false)
    expect(isGemmaModel('gem-7b')).toBe(false)
  })
  test('空 / undefined / null → false', () => {
    expect(isGemmaModel('')).toBe(false)
    expect(isGemmaModel(undefined)).toBe(false)
    expect(isGemmaModel(null)).toBe(false)
  })
})

describe('文件範例對齊', () => {
  test('docs/llamacpp-gemma-tool-format.md 4.2 範例', () => {
    const out = renderToolCall('get_weather', { location: 'Tokyo' })
    expect(out).toBe(
      `${GEMMA_TOK.CALL_OPEN}call:get_weather{location:${Q}Tokyo${Q}}${GEMMA_TOK.CALL_CLOSE}`,
    )
  })
  test('docs/llamacpp-gemma-tool-format.md 4.3 範例', () => {
    const out = renderToolResponse('get_weather', '{"temperature":15,"weather":"sunny"}')
    expect(out).toBe(
      `${GEMMA_TOK.RESP_OPEN}response:get_weather{temperature:15,weather:${Q}sunny${Q}}${GEMMA_TOK.RESP_CLOSE}`,
    )
  })
})
