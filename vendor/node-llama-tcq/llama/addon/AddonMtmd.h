// node-llama-tcq Phase E：libmtmd N-API binding
// 包 mtmd_context / mtmd_bitmap / mtmd_input_chunks 三個 opaque type，
// 加上 tokenize / evalChunks 兩個函式。
#pragma once

#include "napi.h"
#include "mtmd.h"
#include "mtmd-helper.h"

class AddonMtmdContext : public Napi::ObjectWrap<AddonMtmdContext> {
public:
    static void init(Napi::Env env, Napi::Object exports);

    AddonMtmdContext(const Napi::CallbackInfo& info);
    ~AddonMtmdContext();

    mtmd_context* ctx = nullptr;
    bool disposed = false;

private:
    Napi::Value SupportsVision(const Napi::CallbackInfo& info);
    Napi::Value SupportsAudio(const Napi::CallbackInfo& info);
    Napi::Value DefaultMarker(const Napi::CallbackInfo& info);
    Napi::Value Dispose(const Napi::CallbackInfo& info);
};

class AddonMtmdBitmap : public Napi::ObjectWrap<AddonMtmdBitmap> {
public:
    static void init(Napi::Env env, Napi::Object exports);

    AddonMtmdBitmap(const Napi::CallbackInfo& info);
    ~AddonMtmdBitmap();

    mtmd_bitmap* bitmap = nullptr;
    bool disposed = false;

private:
    Napi::Value GetWidth(const Napi::CallbackInfo& info);
    Napi::Value GetHeight(const Napi::CallbackInfo& info);
    Napi::Value Dispose(const Napi::CallbackInfo& info);
};

class AddonMtmdChunks : public Napi::ObjectWrap<AddonMtmdChunks> {
public:
    static void init(Napi::Env env, Napi::Object exports);

    AddonMtmdChunks(const Napi::CallbackInfo& info);
    ~AddonMtmdChunks();

    mtmd_input_chunks* chunks = nullptr;
    bool disposed = false;

private:
    Napi::Value GetCount(const Napi::CallbackInfo& info);
    Napi::Value GetTotalTokens(const Napi::CallbackInfo& info);
    Napi::Value Dispose(const Napi::CallbackInfo& info);
};

// 全域函式
Napi::Value AddonMtmdTokenize(const Napi::CallbackInfo& info);
Napi::Value AddonMtmdEvalChunks(const Napi::CallbackInfo& info);
Napi::Value AddonMtmdBitmapFromFile(const Napi::CallbackInfo& info);
Napi::Value AddonMtmdBitmapFromBuffer(const Napi::CallbackInfo& info);
