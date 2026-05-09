// node-llama-tcq Phase G2/G3：純文字 speculative decoding
//
// 提供 generateWithSpec(llamaCtx, sampler, opts) 把 buun 的 common_speculative
// 推論迴圈包成一個 AsyncWorker，回 {tokens, nPast, nDrafted, nAccepted}。
//
// 限制：上游 llama.cpp 在 server 三處明示 speculative + multimodal 不相容
// （tools/server/server-context.cpp:909/1698/2310），本 API 預期僅用於純
// 文字路徑，不要與 LlamaMtmdContext 的 KV state 共用 sequence。
#pragma once

#include "napi.h"

Napi::Value AddonGenerateWithSpec(const Napi::CallbackInfo& info);
