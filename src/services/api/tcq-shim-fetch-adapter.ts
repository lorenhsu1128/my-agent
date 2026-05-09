// TCQ-shim Fetch Adapter（針對 vendor/node-llama-tcq 的 OpenAI-compat sidecar）
//
// 設計：薄包裝 createLlamaCppFetch，固定傳 binaryKind='tcq'，由共用 adapter 內部
// 跳過 XML / bare-pythonic leak fallback（TCQ-shim 已在 server 端 parse Qwen
// pythonic-XML → OpenAI tool_calls[]）。
//
// 入口路由：src/services/api/client.ts → getLlamaCppConfig() 讀 jsonc
// `server.binaryKind`，binaryKind='tcq' 時走這條（透過 createLlamaCppFetch 內
// 部 mode 旗標自動生效，client.ts 不需改）。
//
// 此檔保留為獨立 export，方便：
//   1. 測試直接 import createTcqShimFetch
//   2. 未來如果 TCQ-shim 路徑要進一步分化時不必再動 entry
//   3. 文件 / log 可以指名「TCQ-shim adapter」

import { createLlamaCppFetch, type LlamaCppConfig } from './llamacpp-fetch-adapter.js'

/**
 * 強制 binaryKind='tcq' 走 TCQ-shim 模式。其餘行為與 createLlamaCppFetch 一致。
 *
 * 內部實作：與 vanilla 共用整套 OpenAI ↔ Anthropic 翻譯、retry-nudge、watchdog、
 * context-overflow 翻譯；唯一差別是 streaming/non-streaming translator 內部
 * 的 `mode='tcq'` flag 跳過 XML / bare-pythonic leak fallback。
 */
export function createTcqShimFetch(
  config: Omit<LlamaCppConfig, 'binaryKind'>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return createLlamaCppFetch({ ...config, binaryKind: 'tcq' })
}
