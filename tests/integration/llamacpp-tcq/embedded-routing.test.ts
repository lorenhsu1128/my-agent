/**
 * Layer 4 — my-agent 端 embedded adapter routing 測試。
 *
 * 範圍：
 *   - decideEmbeddedRouting 純邏輯：env / modelConfig flag 優先序
 *   - createLlamaCppEmbeddedFetch 接受 OpenAI request，呼叫 mock state，
 *     回 SSE stream 格式正確
 *
 * **不啟動 my-agent runtime**（CLI / daemon / web / discord 全不碰）
 * **不真的載 node-llama-tcq 的 .node**（透過 overrideEnsureState 注入替身）
 */
import {beforeEach, describe, expect, test} from 'bun:test'

import {decideEmbeddedRouting} from '../../../src/utils/model/embeddedRouting.js'
import {
  createLlamaCppEmbeddedFetch,
  _resetEmbeddedAdapterCache,
} from '../../../src/services/api/llamacpp-embedded-adapter.js'

beforeEach(() => {
  delete process.env.MY_AGENT_LLAMACPP_EMBEDDED
  _resetEmbeddedAdapterCache()
})

describe('decideEmbeddedRouting', () => {
  test('預設走 fetch 路徑', () => {
    const d = decideEmbeddedRouting({})
    expect(d.useEmbedded).toBe(false)
    expect(d.reason).toBe('default fetch path')
  })

  test('useEmbedded=true 但無 modelPath → 拒絕', () => {
    const d = decideEmbeddedRouting({useEmbedded: true})
    expect(d.useEmbedded).toBe(false)
    expect(d.reason).toMatch(/modelPath missing/)
  })

  test('useEmbedded=true + modelPath → 走 embedded', () => {
    const d = decideEmbeddedRouting({
      useEmbedded: true,
      modelPath: 'C:/test/model.gguf',
    })
    expect(d.useEmbedded).toBe(true)
    expect(d.reason).toBe('modelConfig.useEmbedded=true')
    expect(d.config?.modelPath).toBe('C:/test/model.gguf')
    expect(d.config?.gpu).toBe('cuda') // 預設 cuda
    expect(d.config?.contextSize).toBe(4096)
  })

  test('env MY_AGENT_LLAMACPP_EMBEDDED=1 + modelPath → 走 embedded', () => {
    process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'
    const d = decideEmbeddedRouting({modelPath: 'C:/m.gguf'})
    expect(d.useEmbedded).toBe(true)
    expect(d.reason).toBe('MY_AGENT_LLAMACPP_EMBEDDED=1')
  })

  test('useEmbedded=false 顯式關閉壓過 env', () => {
    process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'
    const d = decideEmbeddedRouting({useEmbedded: false, modelPath: 'C:/m.gguf'})
    expect(d.useEmbedded).toBe(false)
  })

  test('embeddedConfig 透傳 kvCacheType / contextSize / TURBO4 預設', () => {
    const d = decideEmbeddedRouting({
      useEmbedded: true,
      modelPath: 'C:/m.gguf',
      embeddedConfig: {
        kvCacheType: 'TURBO4_0',
        contextSize: 8192,
        applyTCQCodebooks: false,
      },
    })
    expect(d.config?.kvCacheType).toBe('TURBO4_0')
    expect(d.config?.contextSize).toBe(8192)
    expect(d.config?.applyTCQCodebooks).toBe(false)
  })
})

describe('createLlamaCppEmbeddedFetch', () => {
  test('non-stream request 回 OpenAI ChatCompletion JSON', async () => {
    const mockState = {
      config: {enabled: true, modelPath: 'fake.gguf'},
      llama: null,
      model: null,
      context: null,
      session: {prompt: async (_msg: string) => 'mock reply'},
    }

    const fetchFn = createLlamaCppEmbeddedFetch({
      config: {enabled: true, modelPath: 'fake.gguf', gpu: 'cuda'},
      overrideEnsureState: async () => mockState as never,
    })

    const res = await fetchFn('http://embedded/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen3.5-9b',
        messages: [{role: 'user', content: 'hi'}],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      object: string
      choices: Array<{message: {content: string}}>
    }
    expect(json.object).toBe('chat.completion')
    expect(json.choices[0]!.message.content).toBe('mock reply')
  })

  test('streaming request 逐 chunk 吐 SSE + [DONE]（onTextChunk 多次呼叫）', async () => {
    const mockState = {
      config: {enabled: true, modelPath: 'fake.gguf'},
      llama: null,
      model: null,
      context: null,
      mtmdCtx: null,
      session: {
        prompt: async (
          _msg: string,
          opts?: {onTextChunk?: (s: string) => void},
        ) => {
          // 模擬真實 LlamaChatSession 逐 token 推 onTextChunk
          const pieces = ['He', 'llo', ' world']
          for (const p of pieces) opts?.onTextChunk?.(p)
          return pieces.join('')
        },
      },
    }

    const fetchFn = createLlamaCppEmbeddedFetch({
      config: {enabled: true, modelPath: 'fake.gguf', gpu: 'cuda'},
      overrideEnsureState: async () => mockState as never,
    })

    const res = await fetchFn('http://embedded/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen3.5-9b',
        messages: [{role: 'user', content: 'hi'}],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    const reader = res.body!.getReader()
    let txt = ''
    while (true) {
      const {value, done} = await reader.read()
      if (done) break
      txt += new TextDecoder().decode(value)
    }
    // 逐 chunk 都應該 emit；至少看到三段 delta 內容
    expect(txt).toContain('"He"')
    expect(txt).toContain('"llo"')
    expect(txt).toContain('" world"')
    expect(txt).toContain('[DONE]')

    // 應有 ≥3 個 data: chunk（每個 token 一個 + final DONE）
    const dataChunks = txt.match(/data: /g) ?? []
    expect(dataChunks.length).toBeGreaterThanOrEqual(3)
  })

  test('多訊息只取最後 user', async () => {
    let captured = ''
    const mockState = {
      config: {enabled: true, modelPath: 'fake.gguf'},
      llama: null,
      model: null,
      context: null,
      mtmdCtx: null,
      session: {
        prompt: async (msg: string) => {
          captured = msg
          return 'ok'
        },
      },
    }

    const fetchFn = createLlamaCppEmbeddedFetch({
      config: {enabled: true, modelPath: 'fake.gguf', gpu: 'cuda'},
      overrideEnsureState: async () => mockState as never,
    })

    await fetchFn('http://embedded/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {role: 'system', content: 'sys'},
          {role: 'user', content: 'first'},
          {role: 'assistant', content: 'mid'},
          {role: 'user', content: 'last user'},
        ],
        stream: false,
      }),
    })

    expect(captured).toBe('last user')
  })

  test('vision content 走 mtmd 路徑（mtmdCtx 存在時）', async () => {
    let mtmdCalled = false
    let chatCalled = false
    let capturedImages: string[] = []
    let capturedPrompt = ''

    const mockState = {
      config: {enabled: true, modelPath: 'fake.gguf'},
      llama: null,
      model: {_llama: {_bindings: {AddonSampler: class {
        applyConfig() {} dispose() {}
      }}}, _model: null},
      context: {getSequence: () => ({sequenceId: 0})},
      session: {
        prompt: async () => {
          chatCalled = true
          return 'should-not-call'
        },
      },
      mtmdCtx: {
        defaultMarker: '<__media__>',
        tokenize: async (opts: {text: string; images?: Array<{type: string; data: string}>}) => {
          mtmdCalled = true
          capturedPrompt = opts.text
          capturedImages = (opts.images ?? []).map(i => i.data)
          return {dispose: () => undefined}
        },
        evalChunks: async () => 100,
        generate: async () => ({tokens: [], nPast: 100, text: 'mock vision reply'}),
      },
    }

    const fetchFn = createLlamaCppEmbeddedFetch({
      config: {enabled: true, modelPath: 'fake.gguf', mmprojPath: 'fake-mmproj.gguf', gpu: 'cuda'},
      overrideEnsureState: async () => mockState as never,
    })

    const res = await fetchFn('http://embedded/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {type: 'text', text: 'What is this?'},
              {type: 'image_url', image_url: {url: 'file:///tmp/test.png'}},
            ],
          },
        ],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {choices: Array<{message: {content: string}}>}
    expect(json.choices[0]!.message.content).toBe('mock vision reply')
    expect(mtmdCalled).toBe(true)
    expect(chatCalled).toBe(false)
    expect(capturedImages).toEqual(['/tmp/test.png'])
    expect(capturedPrompt).toContain('<__media__>')
    expect(capturedPrompt).toContain('What is this?')
  })

  test('純文字 content（即使含 image_url 但無 mtmdCtx）走 chat 路徑', async () => {
    let chatCalled = false

    const mockState = {
      config: {enabled: true, modelPath: 'fake.gguf'},
      llama: null,
      model: null,
      context: null,
      mtmdCtx: null, // 無 mmproj 載入
      session: {
        prompt: async () => {
          chatCalled = true
          return 'text-only fallback'
        },
      },
    }

    const fetchFn = createLlamaCppEmbeddedFetch({
      config: {enabled: true, modelPath: 'fake.gguf', gpu: 'cuda'},
      overrideEnsureState: async () => mockState as never,
    })

    const res = await fetchFn('http://embedded/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {type: 'text', text: 'describe this'},
              {type: 'image_url', image_url: {url: 'file:///tmp/test.png'}},
            ],
          },
        ],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(chatCalled).toBe(true)
  })
})
