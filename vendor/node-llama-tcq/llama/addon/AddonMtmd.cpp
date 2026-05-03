// node-llama-tcq Phase E：libmtmd N-API binding 實作
//
// 包裝 mtmd_context / mtmd_bitmap / mtmd_input_chunks 與
// mtmd_tokenize / mtmd_helper_eval_chunks 等函式。
//
// 設計原則：
// - 純 ObjectWrap，建構函式在 JS 端用 new MtmdContext(model, mmprojPath, ...)
// - 重活（init_from_file、eval_chunks）放 AsyncWorker 避免阻 event loop
// - 失敗以 Napi::Error::ThrowAsJavaScriptException 拋
//
// 使用流程（JS 端）：
//   const mtmd = new addon.MtmdContext(model, mmprojPath, options);
//   const bitmap = addon.mtmdBitmapFromFile(mtmd, "/path/to/img.png");
//   const chunks = new addon.MtmdChunks();
//   await addon.mtmdTokenize(mtmd, chunks, prompt, [bitmap]);
//   const newNPast = await addon.mtmdEvalChunks(mtmd, llamaCtx, chunks, nPast);

#include "AddonMtmd.h"
#include "AddonContext.h"
#include "AddonModel.h"
#include "AddonSampler.h"
#include "addonGlobals.h"

#include <vector>
#include <string>

// 全域 constructor reference 給 BitmapFromFile / FromBuffer 使用
static Napi::FunctionReference g_mtmdBitmapCtor;

// ---------- AddonMtmdContext ----------

class MtmdInitWorker : public Napi::AsyncWorker {
public:
    MtmdInitWorker(Napi::Promise::Deferred def, AddonMtmdContext* self,
                   const std::string& mmprojPath, llama_model* model,
                   bool useGpu, int nThreads)
        : Napi::AsyncWorker(def.Env()),
          deferred(def), self(self), path(mmprojPath), model(model),
          useGpu(useGpu), nThreads(nThreads) {}

    void Execute() override {
        mtmd_context_params params = mtmd_context_params_default();
        params.use_gpu = useGpu;
        params.print_timings = false;
        params.n_threads = nThreads;
        params.warmup = false;
        ctx = mtmd_init_from_file(path.c_str(), model, params);
        if (!ctx) SetError("mtmd_init_from_file failed");
    }
    void OnOK() override {
        self->ctx = ctx;
        deferred.Resolve(Env().Undefined());
    }
    void OnError(const Napi::Error& e) override {
        deferred.Reject(e.Value());
    }
private:
    Napi::Promise::Deferred deferred;
    AddonMtmdContext* self;
    std::string path;
    llama_model* model;
    bool useGpu;
    int nThreads;
    mtmd_context* ctx = nullptr;
};

void AddonMtmdContext::init(Napi::Env env, Napi::Object exports) {
    Napi::Function fn = DefineClass(env, "MtmdContext", {
        InstanceMethod("supportsVision", &AddonMtmdContext::SupportsVision),
        InstanceMethod("supportsAudio", &AddonMtmdContext::SupportsAudio),
        InstanceMethod("defaultMarker", &AddonMtmdContext::DefaultMarker),
        InstanceMethod("audioSampleRate", &AddonMtmdContext::AudioSampleRate),
        InstanceMethod("dispose", &AddonMtmdContext::Dispose)
    });
    exports.Set("MtmdContext", fn);
}

AddonMtmdContext::AddonMtmdContext(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AddonMtmdContext>(info) {
    // signature: new MtmdContext(model: AddonModel, mmprojPath: string, opts?: { useGpu, nThreads })
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
        Napi::TypeError::New(info.Env(), "MtmdContext(model, mmprojPath, opts?) - bad args")
            .ThrowAsJavaScriptException();
        return;
    }
    AddonModel* mw = Napi::ObjectWrap<AddonModel>::Unwrap(info[0].As<Napi::Object>());
    std::string path = info[1].As<Napi::String>().Utf8Value();

    bool useGpu = true;
    int nThreads = 4;
    if (info.Length() >= 3 && info[2].IsObject()) {
        Napi::Object opts = info[2].As<Napi::Object>();
        if (opts.Has("useGpu")) useGpu = opts.Get("useGpu").ToBoolean();
        if (opts.Has("nThreads")) nThreads = opts.Get("nThreads").ToNumber().Int32Value();
    }

    auto deferred = Napi::Promise::Deferred::New(info.Env());
    auto worker = new MtmdInitWorker(deferred, this, path, mw->model, useGpu, nThreads);
    worker->Queue();

    // 將 promise 暴露為 _initPromise，JS 端要 await 才能保證 ctx 就緒
    info.This().As<Napi::Object>().Set("_initPromise", deferred.Promise());
}

AddonMtmdContext::~AddonMtmdContext() {
    if (ctx && !disposed) {
        mtmd_free(ctx);
        ctx = nullptr;
    }
}

Napi::Value AddonMtmdContext::SupportsVision(const Napi::CallbackInfo& info) {
    if (!ctx) return Napi::Boolean::New(info.Env(), false);
    return Napi::Boolean::New(info.Env(), mtmd_support_vision(ctx));
}
Napi::Value AddonMtmdContext::SupportsAudio(const Napi::CallbackInfo& info) {
    if (!ctx) return Napi::Boolean::New(info.Env(), false);
    return Napi::Boolean::New(info.Env(), mtmd_support_audio(ctx));
}
Napi::Value AddonMtmdContext::DefaultMarker(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), mtmd_default_marker());
}
Napi::Value AddonMtmdContext::AudioSampleRate(const Napi::CallbackInfo& info) {
    if (!ctx) return Napi::Number::New(info.Env(), -1);
    return Napi::Number::New(info.Env(), (double)mtmd_get_audio_sample_rate(ctx));
}
Napi::Value AddonMtmdContext::Dispose(const Napi::CallbackInfo& info) {
    if (ctx && !disposed) {
        mtmd_free(ctx);
        ctx = nullptr;
        disposed = true;
    }
    return info.Env().Undefined();
}

// ---------- AddonMtmdBitmap ----------

void AddonMtmdBitmap::init(Napi::Env env, Napi::Object exports) {
    Napi::Function fn = DefineClass(env, "MtmdBitmap", {
        InstanceMethod("width", &AddonMtmdBitmap::GetWidth),
        InstanceMethod("height", &AddonMtmdBitmap::GetHeight),
        InstanceMethod("dispose", &AddonMtmdBitmap::Dispose)
    });
    g_mtmdBitmapCtor = Napi::Persistent(fn);
    g_mtmdBitmapCtor.SuppressDestruct();
    exports.Set("MtmdBitmap", fn);
}
AddonMtmdBitmap::AddonMtmdBitmap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AddonMtmdBitmap>(info) {
    // 預期由 mtmdBitmapFromFile / mtmdBitmapFromBuffer 內部 new + 把 bitmap 寫入
}
AddonMtmdBitmap::~AddonMtmdBitmap() {
    if (bitmap && !disposed) {
        mtmd_bitmap_free(bitmap);
        bitmap = nullptr;
    }
}
Napi::Value AddonMtmdBitmap::GetWidth(const Napi::CallbackInfo& info) {
    if (!bitmap) return Napi::Number::New(info.Env(), 0);
    return Napi::Number::New(info.Env(), (double)mtmd_bitmap_get_nx(bitmap));
}
Napi::Value AddonMtmdBitmap::GetHeight(const Napi::CallbackInfo& info) {
    if (!bitmap) return Napi::Number::New(info.Env(), 0);
    return Napi::Number::New(info.Env(), (double)mtmd_bitmap_get_ny(bitmap));
}
Napi::Value AddonMtmdBitmap::Dispose(const Napi::CallbackInfo& info) {
    if (bitmap && !disposed) {
        mtmd_bitmap_free(bitmap);
        bitmap = nullptr;
        disposed = true;
    }
    return info.Env().Undefined();
}

Napi::Value AddonMtmdBitmapFromFile(const Napi::CallbackInfo& info) {
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
        Napi::TypeError::New(info.Env(), "mtmdBitmapFromFile(mtmdCtx, path)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    AddonMtmdContext* mctx = Napi::ObjectWrap<AddonMtmdContext>::Unwrap(info[0].As<Napi::Object>());
    if (!mctx->ctx) {
        Napi::Error::New(info.Env(), "mtmd context not initialized (await ctor first)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    std::string path = info[1].As<Napi::String>().Utf8Value();
    mtmd_bitmap* bm = mtmd_helper_bitmap_init_from_file(mctx->ctx, path.c_str());
    if (!bm) {
        Napi::Error::New(info.Env(), "mtmd_helper_bitmap_init_from_file failed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Object bitmapObj = g_mtmdBitmapCtor.New({});
    AddonMtmdBitmap* wrap = Napi::ObjectWrap<AddonMtmdBitmap>::Unwrap(bitmapObj);
    wrap->bitmap = bm;
    return bitmapObj;
}

Napi::Value AddonMtmdBitmapFromBuffer(const Napi::CallbackInfo& info) {
    // mtmdBitmapFromBuffer(buffer: Uint8Array, width: number, height: number)
    // buffer 必須是 RGB raw（width*height*3 bytes）
    if (info.Length() < 3 || !info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(info.Env(), "mtmdBitmapFromBuffer(buf, w, h)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t w = info[1].As<Napi::Number>().Uint32Value();
    uint32_t h = info[2].As<Napi::Number>().Uint32Value();

    if (buf.Length() < (size_t)w * h * 3) {
        Napi::Error::New(info.Env(), "buffer too small for w*h*3 RGB").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    mtmd_bitmap* bm = mtmd_bitmap_init(w, h, buf.Data());
    if (!bm) {
        Napi::Error::New(info.Env(), "mtmd_bitmap_init failed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Object bitmapObj = g_mtmdBitmapCtor.New({});
    AddonMtmdBitmap* wrap = Napi::ObjectWrap<AddonMtmdBitmap>::Unwrap(bitmapObj);
    wrap->bitmap = bm;
    return bitmapObj;
}

// mtmdBitmapFromAudio(mtmdCtx, Float32Array pcmMono)
// data 必須是 PCM F32 mono；sample rate 預期符合 mtmd_get_audio_sample_rate（通常 16000）
Napi::Value AddonMtmdBitmapFromAudio(const Napi::CallbackInfo& info) {
    if (info.Length() < 2 || !info[0].IsObject() ||
        !(info[1].IsTypedArray() || info[1].IsArrayBuffer())) {
        Napi::TypeError::New(info.Env(),
            "mtmdBitmapFromAudio(mtmdCtx, Float32Array)")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    AddonMtmdContext* mctx = Napi::ObjectWrap<AddonMtmdContext>::Unwrap(info[0].As<Napi::Object>());
    if (!mctx->ctx) {
        Napi::Error::New(info.Env(), "mtmd context not initialized").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Float32Array arr = info[1].As<Napi::Float32Array>();
    size_t nSamples = arr.ElementLength();
    const float* data = arr.Data();
    mtmd_bitmap* bm = mtmd_bitmap_init_from_audio(nSamples, data);
    if (!bm) {
        Napi::Error::New(info.Env(), "mtmd_bitmap_init_from_audio failed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Object bitmapObj = g_mtmdBitmapCtor.New({});
    AddonMtmdBitmap* wrap = Napi::ObjectWrap<AddonMtmdBitmap>::Unwrap(bitmapObj);
    wrap->bitmap = bm;
    return bitmapObj;
}

// ---------- AddonMtmdChunks ----------

void AddonMtmdChunks::init(Napi::Env env, Napi::Object exports) {
    Napi::Function fn = DefineClass(env, "MtmdChunks", {
        InstanceMethod("count", &AddonMtmdChunks::GetCount),
        InstanceMethod("totalTokens", &AddonMtmdChunks::GetTotalTokens),
        InstanceMethod("dispose", &AddonMtmdChunks::Dispose)
    });
    exports.Set("MtmdChunks", fn);
}

AddonMtmdChunks::AddonMtmdChunks(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AddonMtmdChunks>(info) {
    chunks = mtmd_input_chunks_init();
}

AddonMtmdChunks::~AddonMtmdChunks() {
    if (chunks && !disposed) {
        mtmd_input_chunks_free(chunks);
        chunks = nullptr;
    }
}

Napi::Value AddonMtmdChunks::GetCount(const Napi::CallbackInfo& info) {
    if (!chunks) return Napi::Number::New(info.Env(), 0);
    return Napi::Number::New(info.Env(), (double)mtmd_input_chunks_size(chunks));
}

Napi::Value AddonMtmdChunks::GetTotalTokens(const Napi::CallbackInfo& info) {
    if (!chunks) return Napi::Number::New(info.Env(), 0);
    return Napi::Number::New(info.Env(), (double)mtmd_helper_get_n_tokens(chunks));
}

Napi::Value AddonMtmdChunks::Dispose(const Napi::CallbackInfo& info) {
    if (chunks && !disposed) {
        mtmd_input_chunks_free(chunks);
        chunks = nullptr;
        disposed = true;
    }
    return info.Env().Undefined();
}

// ---------- mtmdTokenize ----------

Napi::Value AddonMtmdTokenize(const Napi::CallbackInfo& info) {
    // mtmdTokenize(mtmdCtx, chunks, prompt, bitmaps[], opts?: { addSpecial, parseSpecial })
    if (info.Length() < 4 || !info[0].IsObject() || !info[1].IsObject() || !info[2].IsString() || !info[3].IsArray()) {
        Napi::TypeError::New(info.Env(), "mtmdTokenize(ctx, chunks, prompt, bitmaps[])")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    AddonMtmdContext* mctx = Napi::ObjectWrap<AddonMtmdContext>::Unwrap(info[0].As<Napi::Object>());
    AddonMtmdChunks* mchunks = Napi::ObjectWrap<AddonMtmdChunks>::Unwrap(info[1].As<Napi::Object>());
    std::string prompt = info[2].As<Napi::String>().Utf8Value();
    Napi::Array bitmapsArr = info[3].As<Napi::Array>();

    bool addSpecial = true, parseSpecial = true;
    if (info.Length() >= 5 && info[4].IsObject()) {
        Napi::Object opts = info[4].As<Napi::Object>();
        if (opts.Has("addSpecial")) addSpecial = opts.Get("addSpecial").ToBoolean();
        if (opts.Has("parseSpecial")) parseSpecial = opts.Get("parseSpecial").ToBoolean();
    }

    if (!mctx->ctx) {
        Napi::Error::New(info.Env(), "mtmd context not initialized").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    mtmd_input_text txt;
    txt.text = prompt.c_str();
    txt.add_special = addSpecial;
    txt.parse_special = parseSpecial;

    std::vector<const mtmd_bitmap*> bms;
    bms.reserve(bitmapsArr.Length());
    for (uint32_t i = 0; i < bitmapsArr.Length(); ++i) {
        Napi::Value v = bitmapsArr.Get(i);
        AddonMtmdBitmap* bw = Napi::ObjectWrap<AddonMtmdBitmap>::Unwrap(v.As<Napi::Object>());
        if (!bw->bitmap) {
            Napi::Error::New(info.Env(), "bitmap[" + std::to_string(i) + "] not initialized").ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }
        bms.push_back(bw->bitmap);
    }

    int32_t rc = mtmd_tokenize(mctx->ctx, mchunks->chunks, &txt, bms.data(), bms.size());
    return Napi::Number::New(info.Env(), rc);
}

// ---------- mtmdEvalChunks (async) ----------

class MtmdEvalWorker : public Napi::AsyncWorker {
public:
    MtmdEvalWorker(Napi::Promise::Deferred def, mtmd_context* mctx, llama_context* lctx,
                   mtmd_input_chunks* chunks, llama_pos nPast, llama_seq_id seqId,
                   int32_t nBatch, bool logitsLast)
        : Napi::AsyncWorker(def.Env()),
          deferred(def), mctx(mctx), lctx(lctx), chunks(chunks),
          nPast(nPast), seqId(seqId), nBatch(nBatch), logitsLast(logitsLast) {}

    void Execute() override {
        llama_pos newNPast = nPast;
        int32_t rc = mtmd_helper_eval_chunks(mctx, lctx, chunks, nPast, seqId, nBatch, logitsLast, &newNPast);
        if (rc != 0) {
            SetError("mtmd_helper_eval_chunks failed rc=" + std::to_string(rc));
            return;
        }
        result = newNPast;
    }

    void OnOK() override {
        deferred.Resolve(Napi::Number::New(Env(), (double)result));
    }
    void OnError(const Napi::Error& e) override {
        deferred.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred deferred;
    mtmd_context* mctx;
    llama_context* lctx;
    mtmd_input_chunks* chunks;
    llama_pos nPast;
    llama_seq_id seqId;
    int32_t nBatch;
    bool logitsLast;
    llama_pos result = 0;
};

Napi::Value AddonMtmdEvalChunks(const Napi::CallbackInfo& info) {
    // mtmdEvalChunks(mtmdCtx, llamaCtx, chunks, nPast, opts?: { seqId, nBatch, logitsLast }) -> Promise<newNPast>
    if (info.Length() < 4 || !info[0].IsObject() || !info[1].IsObject() ||
        !info[2].IsObject() || !info[3].IsNumber()) {
        Napi::TypeError::New(info.Env(), "mtmdEvalChunks(mtmdCtx, llamaCtx, chunks, nPast)")
            .ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    AddonMtmdContext* mctx = Napi::ObjectWrap<AddonMtmdContext>::Unwrap(info[0].As<Napi::Object>());
    AddonContext* lctx = Napi::ObjectWrap<AddonContext>::Unwrap(info[1].As<Napi::Object>());
    AddonMtmdChunks* chunks = Napi::ObjectWrap<AddonMtmdChunks>::Unwrap(info[2].As<Napi::Object>());
    llama_pos nPast = (llama_pos)info[3].As<Napi::Number>().Int32Value();

    llama_seq_id seqId = 0;
    int32_t nBatch = 512;
    bool logitsLast = true;
    if (info.Length() >= 5 && info[4].IsObject()) {
        Napi::Object opts = info[4].As<Napi::Object>();
        if (opts.Has("seqId")) seqId = (llama_seq_id)opts.Get("seqId").ToNumber().Int32Value();
        if (opts.Has("nBatch")) nBatch = opts.Get("nBatch").ToNumber().Int32Value();
        if (opts.Has("logitsLast")) logitsLast = opts.Get("logitsLast").ToBoolean();
    }

    if (!mctx->ctx || !lctx->ctx || !chunks->chunks) {
        Napi::Error::New(info.Env(), "mtmdEvalChunks: ctx/chunks not initialized").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    auto deferred = Napi::Promise::Deferred::New(info.Env());
    auto worker = new MtmdEvalWorker(deferred, mctx->ctx, lctx->ctx, chunks->chunks,
                                     nPast, seqId, nBatch, logitsLast);
    worker->Queue();
    return deferred.Promise();
}

// ---------- mtmdGenerate (vision continuation: sample + decode loop) ----------

class MtmdGenerateWorker : public Napi::AsyncWorker {
public:
    MtmdGenerateWorker(Napi::Promise::Deferred def, AddonContext* lctx, AddonSampler* sampler,
                       llama_pos nPast, int32_t maxTokens, llama_seq_id seqId)
        : Napi::AsyncWorker(def.Env()),
          deferred(def), lctxWrap(lctx), samplerWrap(sampler),
          nPast(nPast), maxTokens(maxTokens), seqId(seqId) {
        lctxWrap->Ref();
        samplerWrap->Ref();
    }
    ~MtmdGenerateWorker() {
        lctxWrap->Unref();
        samplerWrap->Unref();
    }

    void Execute() override {
        llama_context* ctx = lctxWrap->ctx;
        const llama_model* model = lctxWrap->model->model;
        const llama_vocab* vocab = llama_model_get_vocab(model);

        samplerWrap->rebuildChainIfNeeded();

        llama_batch batch = llama_batch_init(1, 0, 1);
        const int32_t n_vocab = llama_vocab_n_tokens(vocab);
        auto& candidates = samplerWrap->tokenCandidates;

        for (int32_t step = 0; step < maxTokens; ++step) {
            // 從上一次 decode 留下的 last logits（或 mtmd_helper_eval_chunks 留下）sample
            const float* logits = llama_get_logits_ith(ctx, -1);
            if (!logits) {
                SetError("llama_get_logits_ith returned null at step " + std::to_string(step));
                break;
            }
            for (llama_token t = 0; t < n_vocab; ++t) {
                candidates[t] = llama_token_data{t, logits[t], 0.0f};
            }
            llama_token_data_array cur_p = {candidates.data(), candidates.size(), -1, false};
            llama_sampler_apply(samplerWrap->chain, &cur_p);
            if (cur_p.selected < 0 || cur_p.selected >= (int32_t)cur_p.size) {
                break;
            }
            llama_token tok = cur_p.data[cur_p.selected].id;
            generated.push_back(tok);
            llama_sampler_accept(samplerWrap->chain, tok);

            if (llama_vocab_is_eog(vocab, tok)) {
                break;
            }

            // 把 token 餵回去
            batch.token[0] = tok;
            batch.pos[0] = nPast;
            batch.n_seq_id[0] = 1;
            batch.seq_id[0][0] = seqId;
            batch.logits[0] = true;
            batch.n_tokens = 1;

            int32_t rc = llama_decode(ctx, batch);
            if (rc != 0) {
                SetError("llama_decode failed rc=" + std::to_string(rc));
                break;
            }
            nPast += 1;
        }

        llama_batch_free(batch);
    }

    void OnOK() override {
        Napi::Array arr = Napi::Array::New(Env(), generated.size());
        for (size_t i = 0; i < generated.size(); ++i) {
            arr.Set((uint32_t)i, Napi::Number::New(Env(), (double)generated[i]));
        }
        Napi::Object res = Napi::Object::New(Env());
        res.Set("tokens", arr);
        res.Set("nPast", Napi::Number::New(Env(), (double)nPast));
        deferred.Resolve(res);
    }
    void OnError(const Napi::Error& e) override {
        deferred.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred deferred;
    AddonContext* lctxWrap;
    AddonSampler* samplerWrap;
    llama_pos nPast;
    int32_t maxTokens;
    llama_seq_id seqId;
    std::vector<llama_token> generated;
};

Napi::Value AddonMtmdGenerate(const Napi::CallbackInfo& info) {
    // mtmdGenerate(llamaCtx, sampler, nPast, maxTokens, opts?: { seqId })
    if (info.Length() < 4 || !info[0].IsObject() || !info[1].IsObject() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(info.Env(), "mtmdGenerate(llamaCtx, sampler, nPast, maxTokens)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    AddonContext* lctx = Napi::ObjectWrap<AddonContext>::Unwrap(info[0].As<Napi::Object>());
    AddonSampler* sampler = Napi::ObjectWrap<AddonSampler>::Unwrap(info[1].As<Napi::Object>());
    llama_pos nPast = (llama_pos)info[2].As<Napi::Number>().Int32Value();
    int32_t maxTokens = info[3].As<Napi::Number>().Int32Value();
    llama_seq_id seqId = 0;
    if (info.Length() >= 5 && info[4].IsObject()) {
        Napi::Object opts = info[4].As<Napi::Object>();
        if (opts.Has("seqId")) seqId = opts.Get("seqId").ToNumber().Int32Value();
    }

    if (!lctx->ctx) {
        Napi::Error::New(info.Env(), "llamaCtx not initialized").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    auto deferred = Napi::Promise::Deferred::New(info.Env());
    auto worker = new MtmdGenerateWorker(deferred, lctx, sampler, nPast, maxTokens, seqId);
    worker->Queue();
    return deferred.Promise();
}

// ---------- mtmdGenerateStep（單步 sample + decode，用於 streaming） ----------

class MtmdGenerateStepWorker : public Napi::AsyncWorker {
public:
    MtmdGenerateStepWorker(Napi::Promise::Deferred def, AddonContext* lctx, AddonSampler* sampler,
                           llama_pos nPast, llama_seq_id seqId)
        : Napi::AsyncWorker(def.Env()),
          deferred(def), lctxWrap(lctx), samplerWrap(sampler),
          nPast(nPast), seqId(seqId) {
        lctxWrap->Ref();
        samplerWrap->Ref();
    }
    ~MtmdGenerateStepWorker() {
        lctxWrap->Unref();
        samplerWrap->Unref();
    }

    void Execute() override {
        llama_context* ctx = lctxWrap->ctx;
        const llama_model* model = lctxWrap->model->model;
        const llama_vocab* vocab = llama_model_get_vocab(model);

        samplerWrap->rebuildChainIfNeeded();

        const float* logits = llama_get_logits_ith(ctx, -1);
        if (!logits) {
            SetError("llama_get_logits_ith returned null");
            return;
        }
        const int32_t n_vocab = llama_vocab_n_tokens(vocab);
        auto& candidates = samplerWrap->tokenCandidates;
        for (llama_token t = 0; t < n_vocab; ++t) {
            candidates[t] = llama_token_data{t, logits[t], 0.0f};
        }
        llama_token_data_array cur_p = {candidates.data(), candidates.size(), -1, false};
        llama_sampler_apply(samplerWrap->chain, &cur_p);
        if (cur_p.selected < 0 || cur_p.selected >= (int32_t)cur_p.size) {
            SetError("sampler produced no selected token");
            return;
        }
        token = cur_p.data[cur_p.selected].id;
        llama_sampler_accept(samplerWrap->chain, token);

        if (llama_vocab_is_eog(vocab, token)) {
            eos = true;
            return;
        }

        // 餵回去推進 KV
        llama_batch batch = llama_batch_init(1, 0, 1);
        batch.token[0] = token;
        batch.pos[0] = nPast;
        batch.n_seq_id[0] = 1;
        batch.seq_id[0][0] = seqId;
        batch.logits[0] = true;
        batch.n_tokens = 1;
        int32_t rc = llama_decode(ctx, batch);
        llama_batch_free(batch);
        if (rc != 0) {
            SetError("llama_decode failed rc=" + std::to_string(rc));
            return;
        }
        nPast += 1;
    }

    void OnOK() override {
        Napi::Object res = Napi::Object::New(Env());
        res.Set("token", Napi::Number::New(Env(), (double)token));
        res.Set("eos", Napi::Boolean::New(Env(), eos));
        res.Set("nPast", Napi::Number::New(Env(), (double)nPast));
        deferred.Resolve(res);
    }
    void OnError(const Napi::Error& e) override { deferred.Reject(e.Value()); }

private:
    Napi::Promise::Deferred deferred;
    AddonContext* lctxWrap;
    AddonSampler* samplerWrap;
    llama_pos nPast;
    llama_seq_id seqId;
    llama_token token = 0;
    bool eos = false;
};

Napi::Value AddonMtmdGenerateStep(const Napi::CallbackInfo& info) {
    if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsObject() || !info[2].IsNumber()) {
        Napi::TypeError::New(info.Env(), "mtmdGenerateStep(llamaCtx, sampler, nPast, opts?)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    AddonContext* lctx = Napi::ObjectWrap<AddonContext>::Unwrap(info[0].As<Napi::Object>());
    AddonSampler* sampler = Napi::ObjectWrap<AddonSampler>::Unwrap(info[1].As<Napi::Object>());
    llama_pos nPast = (llama_pos)info[2].As<Napi::Number>().Int32Value();
    llama_seq_id seqId = 0;
    if (info.Length() >= 4 && info[3].IsObject()) {
        Napi::Object opts = info[3].As<Napi::Object>();
        if (opts.Has("seqId")) seqId = opts.Get("seqId").ToNumber().Int32Value();
    }
    if (!lctx->ctx) {
        Napi::Error::New(info.Env(), "llamaCtx not initialized").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    auto deferred = Napi::Promise::Deferred::New(info.Env());
    auto worker = new MtmdGenerateStepWorker(deferred, lctx, sampler, nPast, seqId);
    worker->Queue();
    return deferred.Promise();
}
