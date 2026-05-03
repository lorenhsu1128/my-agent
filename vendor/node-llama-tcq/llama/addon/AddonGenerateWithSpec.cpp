// node-llama-tcq Phase G2/G3：純文字 speculative decoding
// 實作 common_speculative_init → 迴圈 (draft → batch → decode → verify) → 累積 token
//
// 模型訊號：buun fork 在 common/speculative.cpp 提供統一 common_speculative API：
//   - common_speculative_init(params, ctx_tgt, ctx_dft_shared)
//   - common_speculative_set_seq_id(spec, seq_id)
//   - common_speculative_draft(spec, params, tokens_so_far, last_sampled)
//   - common_speculative_free(spec)
//
// 對 model-free 類型（COPYSPEC / NGRAM_* / SUFFIX / RECYCLE）ctx_dft 可為
// nullptr；對 DFLASH 需要 drafter ctx（用 common_speculative_create_ctx_dft
// 從 params.mparams_dft 建）。

#include "AddonGenerateWithSpec.h"
#include "AddonContext.h"
#include "AddonModel.h"
#include "AddonSampler.h"
#include "addonGlobals.h"

#include "speculative.h"
#include "common.h"
#include "llama.h"

#include <vector>
#include <string>
#include <cstring>

namespace {

// Map JS string → common_speculative_type
static common_speculative_type spec_type_from_string(const std::string& name) {
    return common_speculative_type_from_name(name);
}

// 從 logits 在指定 batch slot sample 一個 token
static llama_token sample_logits_at_slot(
    llama_context* ctx, AddonSampler* samplerWrap, int batch_slot, int32_t n_vocab
) {
    const float* logits = llama_get_logits_ith(ctx, batch_slot);
    auto& cands = samplerWrap->tokenCandidates;
    for (llama_token t = 0; t < n_vocab; ++t) {
        cands[t] = llama_token_data{t, logits[t], 0.0f};
    }
    llama_token_data_array cur_p = {cands.data(), cands.size(), -1, false};
    llama_sampler_apply(samplerWrap->chain, &cur_p);
    if (cur_p.selected < 0 || cur_p.selected >= (int32_t)cur_p.size) return -1;
    return cur_p.data[cur_p.selected].id;
}

class GenerateWithSpecWorker : public Napi::AsyncWorker {
public:
    GenerateWithSpecWorker(
        Napi::Promise::Deferred def,
        AddonContext* ctxWrap, AddonSampler* samplerWrap,
        std::vector<llama_token>&& promptTokens, llama_pos nPast,
        int32_t maxTokens, llama_seq_id seqId,
        common_params_speculative&& specParams
    ) : Napi::AsyncWorker(def.Env()),
        deferred(def), ctxWrap(ctxWrap), samplerWrap(samplerWrap),
        prompt(std::move(promptTokens)), nPast(nPast),
        maxTokens(maxTokens), seqId(seqId),
        specParams(std::move(specParams)) {
        ctxWrap->Ref();
        samplerWrap->Ref();
    }
    ~GenerateWithSpecWorker() {
        ctxWrap->Unref();
        samplerWrap->Unref();
    }

    void Execute() override {
        llama_context* ctx = ctxWrap->ctx;
        const llama_model* model = ctxWrap->model->model;
        const llama_vocab* vocab = llama_model_get_vocab(model);
        const int32_t n_vocab = llama_vocab_n_tokens(vocab);

        samplerWrap->rebuildChainIfNeeded();

        // Init speculative state（model-free 類型 ctx_dft = nullptr）
        common_speculative* spec = common_speculative_init(specParams, ctx, nullptr);
        if (!spec) {
            SetError("common_speculative_init failed (check spec type & params)");
            return;
        }
        common_speculative_set_seq_id(spec, seqId);

        // 初始 token：若 prompt 給了就用最後一個；否則須先 sample 一次（使用者已
        // 跑過 evalChunks 之後 logits 在 ctx 內）
        std::vector<llama_token> tokens_so_far = prompt;
        llama_token token_last;
        if (!tokens_so_far.empty()) {
            token_last = tokens_so_far.back();
        } else {
            token_last = sample_logits_at_slot(ctx, samplerWrap, -1, n_vocab);
            if (token_last < 0) {
                SetError("initial sampler produced no token");
                common_speculative_free(spec);
                return;
            }
            generated.push_back(token_last);
            llama_sampler_accept(samplerWrap->chain, token_last);
        }

        const int n_max_draft = std::max(1, std::min(specParams.n_max, 32));
        llama_batch batch = llama_batch_init(1 + n_max_draft, 0, 1);

        while ((int32_t)generated.size() < maxTokens) {
            // 1. draft
            llama_tokens drafts = common_speculative_draft(
                spec, specParams, tokens_so_far, token_last
            );
            if ((int32_t)drafts.size() > n_max_draft) drafts.resize(n_max_draft);
            n_drafted += (int32_t)drafts.size();

            // 2. build batch [token_last, drafts...]
            llama_batch_clear(batch);
            common_batch_add(batch, token_last, nPast, {seqId}, true);
            for (size_t i = 0; i < drafts.size(); ++i) {
                common_batch_add(batch, drafts[i], nPast + 1 + (llama_pos)i, {seqId}, true);
            }

            // 3. decode
            int rc = llama_decode(ctx, batch);
            if (rc != 0) {
                SetError("llama_decode rc=" + std::to_string(rc));
                break;
            }

            // 4. verify：sample at each slot, 比對 drafts，接受 prefix
            std::vector<llama_token> step_tokens;  // 本步驟接受的 token（含 mismatch 後的 target choice）
            int matched = 0;  // drafts[0..matched-1] 匹配
            for (size_t slot = 0; slot <= drafts.size(); ++slot) {
                llama_token sampled = sample_logits_at_slot(ctx, samplerWrap, (int)slot, n_vocab);
                if (sampled < 0) {
                    SetError("sampler at slot " + std::to_string(slot) + " produced no token");
                    goto cleanup;
                }
                step_tokens.push_back(sampled);
                llama_sampler_accept(samplerWrap->chain, sampled);

                if (slot == drafts.size()) break;       // 已超過 drafts 範圍 → 多 sample 一個結束本回合
                if (sampled != drafts[slot]) break;     // 第一個 mismatch → target 選 sampled，丟棄之後 drafts
                ++matched;
            }
            n_accepted += matched;

            // 5. KV cache 修剪：batch 用了 (1 + drafts.size()) 個位置，
            //    保留 (1 + matched) 個（last + matched drafts），其餘 rm
            // sample 出的 step_tokens 數 = matched + 1（除非 EOS 提早結束）
            // 已寫入 KV 的位置數 = step_tokens.size() + (drafts.size() - matched)
            // 真正要保留的 = step_tokens.size()
            // 但實際上 step_tokens.size() = matched + 1 一定成立（除 EOS）
            llama_pos kept = (llama_pos)step_tokens.size();
            llama_pos used = (llama_pos)(1 + drafts.size());
            llama_pos new_n_past = nPast + kept;
            if (kept < used) {
                llama_memory_t mem = llama_get_memory(ctx);
                llama_memory_seq_rm(mem, seqId, new_n_past, -1);
            }
            nPast = new_n_past;

            // 6. 加入 generated；遇 EOS 立即停
            bool stop = false;
            for (auto t : step_tokens) {
                generated.push_back(t);
                tokens_so_far.push_back(t);
                if (llama_vocab_is_eog(vocab, t)) { stop = true; break; }
                if ((int32_t)generated.size() >= maxTokens) { stop = true; break; }
            }
            if (stop) break;

            token_last = generated.back();
        }

        cleanup:
        llama_batch_free(batch);
        common_speculative_free(spec);
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Array arr = Napi::Array::New(env, generated.size());
        for (size_t i = 0; i < generated.size(); ++i) {
            arr.Set((uint32_t)i, Napi::Number::New(env, (double)generated[i]));
        }
        Napi::Object res = Napi::Object::New(env);
        res.Set("tokens", arr);
        res.Set("nPast", Napi::Number::New(env, (double)nPast));
        res.Set("nDrafted", Napi::Number::New(env, (double)n_drafted));
        res.Set("nAccepted", Napi::Number::New(env, (double)n_accepted));
        deferred.Resolve(res);
    }
    void OnError(const Napi::Error& e) override { deferred.Reject(e.Value()); }

private:
    Napi::Promise::Deferred deferred;
    AddonContext* ctxWrap;
    AddonSampler* samplerWrap;
    std::vector<llama_token> prompt;
    llama_pos nPast;
    int32_t maxTokens;
    llama_seq_id seqId;
    common_params_speculative specParams;

    std::vector<llama_token> generated;
    int32_t n_drafted = 0;
    int32_t n_accepted = 0;
};

// 從 JS opts 物件建 common_params_speculative。預期 caller 已過濾不適用欄位。
static common_params_speculative build_spec_params_from_opts(Napi::Env env, Napi::Object opts) {
    common_params_speculative p;

    if (opts.Has("type")) {
        std::string typeStr = opts.Get("type").ToString().Utf8Value();
        p.type = spec_type_from_string(typeStr);
        if (p.type == COMMON_SPECULATIVE_TYPE_COUNT) {
            throw Napi::Error::New(env, "unknown speculative type: " + typeStr);
        }
    } else {
        p.type = COMMON_SPECULATIVE_TYPE_NONE;
    }

    if (opts.Has("nMax")) p.n_max = opts.Get("nMax").ToNumber().Int32Value();
    if (opts.Has("nMin")) p.n_min = opts.Get("nMin").ToNumber().Int32Value();
    if (opts.Has("treeBudget")) p.tree_budget = opts.Get("treeBudget").ToNumber().Int32Value();
    if (opts.Has("dflashMaxSlots")) p.dflash_max_slots = opts.Get("dflashMaxSlots").ToNumber().Int32Value();
    if (opts.Has("pSplit")) p.p_split = opts.Get("pSplit").ToNumber().FloatValue();
    if (opts.Has("pMin")) p.p_min = opts.Get("pMin").ToNumber().FloatValue();
    if (opts.Has("sampleTemp")) p.sample_temp = opts.Get("sampleTemp").ToNumber().FloatValue();
    if (opts.Has("draftTopk")) p.draft_topk = opts.Get("draftTopk").ToNumber().Int32Value();

    // CopySpec
    if (opts.Has("copyspecGamma")) p.copyspec_gamma = opts.Get("copyspecGamma").ToNumber().Int32Value();

    // Suffix tree
    if (opts.Has("suffixMaxDepth")) p.suffix_max_depth = opts.Get("suffixMaxDepth").ToNumber().Int32Value();
    if (opts.Has("suffixSpecFactor")) p.suffix_spec_factor = opts.Get("suffixSpecFactor").ToNumber().FloatValue();
    if (opts.Has("suffixSpecOffset")) p.suffix_spec_offset = opts.Get("suffixSpecOffset").ToNumber().FloatValue();
    if (opts.Has("suffixMinProb")) p.suffix_min_prob = opts.Get("suffixMinProb").ToNumber().FloatValue();

    // RECYCLE
    if (opts.Has("recycleK")) p.recycle_k = opts.Get("recycleK").ToNumber().Int32Value();

    return p;
}

}  // namespace

Napi::Value AddonGenerateWithSpec(const Napi::CallbackInfo& info) {
    // generateWithSpec(llamaCtx, sampler, {
    //   prompt: number[], nPast, maxTokens, seqId,
    //   spec: { type, nMax, nMin, treeBudget, copyspecGamma, ... }
    // }) → Promise<{tokens, nPast, nDrafted, nAccepted}>
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsObject() || !info[2].IsObject()) {
        Napi::TypeError::New(env, "generateWithSpec(llamaCtx, sampler, opts)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    AddonContext* ctxWrap = Napi::ObjectWrap<AddonContext>::Unwrap(info[0].As<Napi::Object>());
    AddonSampler* samplerWrap = Napi::ObjectWrap<AddonSampler>::Unwrap(info[1].As<Napi::Object>());
    Napi::Object opts = info[2].As<Napi::Object>();

    if (!ctxWrap->ctx) {
        Napi::Error::New(env, "llamaCtx not initialized").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::vector<llama_token> prompt;
    if (opts.Has("prompt") && opts.Get("prompt").IsArray()) {
        Napi::Array arr = opts.Get("prompt").As<Napi::Array>();
        prompt.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            prompt.push_back((llama_token)arr.Get(i).ToNumber().Int32Value());
        }
    }
    llama_pos nPast = opts.Has("nPast") ? (llama_pos)opts.Get("nPast").ToNumber().Int32Value() : 0;
    int32_t maxTokens = opts.Has("maxTokens") ? opts.Get("maxTokens").ToNumber().Int32Value() : 256;
    llama_seq_id seqId = opts.Has("seqId") ? (llama_seq_id)opts.Get("seqId").ToNumber().Int32Value() : 0;

    Napi::Object specOpts = opts.Has("spec") && opts.Get("spec").IsObject()
        ? opts.Get("spec").As<Napi::Object>() : Napi::Object::New(env);

    common_params_speculative specParams;
    try {
        specParams = build_spec_params_from_opts(env, specOpts);
    } catch (const Napi::Error& e) {
        e.ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto worker = new GenerateWithSpecWorker(
        deferred, ctxWrap, samplerWrap,
        std::move(prompt), nPast, maxTokens, seqId,
        std::move(specParams)
    );
    worker->Queue();
    return deferred.Promise();
}
