import {LlamaModel} from "./LlamaModel/LlamaModel.js";
import {LlamaContext} from "./LlamaContext/LlamaContext.js";
import type {AddonMtmdContext, AddonMtmdBitmap, AddonMtmdChunks} from "../bindings/AddonTypes.js";

export interface LlamaMtmdContextOptions {
    /** mmproj.gguf 檔案路徑 */
    mmprojPath: string;
    /** 是否在 GPU 跑 vision encoder（default: true） */
    useGpu?: boolean;
    /** vision encoder threads（default: 4） */
    nThreads?: number;
}

/**
 * 媒體輸入：影像（file / rgb-buffer）或音訊（audio-pcm / file 自動偵測 mp3/wav）。
 * mtmd_helper_bitmap_init_from_file 內含 stb_image + miniaudio.h，會自動判斷檔案類型。
 */
export type MtmdMediaInput =
    | {type: "file"; data: string}                           // path：圖片或音訊檔（.mp3/.wav 自動解碼）
    | {type: "rgb-buffer"; data: Buffer | Uint8Array; width: number; height: number}  // 影像 raw RGB
    | {type: "audio-pcm"; data: Float32Array; sampleRate?: number};                    // PCM mono F32

/** @deprecated 改用 MtmdMediaInput */
export type MtmdImageInput = MtmdMediaInput;

export interface MtmdTokenizeOptions {
    /** prompt 文字，須含一個或多個 marker（mtmd default: "<__media__>"） */
    text: string;
    /** 統一媒體陣列；順序對應 prompt 中 marker 順序 */
    media?: MtmdMediaInput[];
    /** @deprecated 改用 media；仍支援以保向後相容 */
    images?: MtmdMediaInput[];
    addSpecial?: boolean;
    parseSpecial?: boolean;
}

export interface MtmdEvalOptions {
    seqId?: number;
    nBatch?: number;
    logitsLast?: boolean;
}

export class LlamaMtmdContext {
    /** @internal */ private readonly _model: LlamaModel;
    /** @internal */ public readonly _native: AddonMtmdContext;
    /** @internal */ private _disposed = false;

    private constructor(model: LlamaModel, native: AddonMtmdContext) {
        this._model = model;
        this._native = native;
    }

    /**
     * 載入 mmproj 檔，建立 mtmd context。
     * 必須與 model 共享同一個 LlamaModel 實例（mtmd 內部會跑 vision encoder
     * 然後接到 main model 的 token embedding）。
     */
    public static async loadMmproj(
        model: LlamaModel,
        opts: LlamaMtmdContextOptions
    ): Promise<LlamaMtmdContext> {
        const bindings = (model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        const native = new bindings.MtmdContext(model._model, opts.mmprojPath, {
            useGpu: opts.useGpu ?? true,
            nThreads: opts.nThreads ?? 4
        }) as AddonMtmdContext;
        // C++ side 把 init Promise 暴露在 _initPromise；await 確保 ctx 就緒
        await (native as any)._initPromise;
        return new LlamaMtmdContext(model, native);
    }

    public get supportsVision(): boolean {
        return this._native.supportsVision();
    }

    public get supportsAudio(): boolean {
        return this._native.supportsAudio();
    }

    /** mtmd 預設 marker（如 "<__media__>"），可覆蓋進入 prompt */
    public get defaultMarker(): string {
        return this._native.defaultMarker();
    }

    /** mtmd 期望的音訊取樣率（典型 16000 Hz Whisper）。不支援 audio 回 -1 */
    public get audioSampleRate(): number {
        return this._native.audioSampleRate();
    }

    /**
     * Tokenize 文字 + 圖片（含 marker 替換）→ MtmdChunks。
     * Returns: chunks 物件可後續餵給 evalChunks。
     * Throws: tokenize rc != 0 時拋（marker 數量不對 / 圖片預處理失敗）。
     */
    public async tokenize(opts: MtmdTokenizeOptions): Promise<MtmdChunks> {
        const bindings = (this._model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        const chunks: AddonMtmdChunks = new bindings.MtmdChunks();

        const inputs = opts.media ?? opts.images ?? [];
        const bitmaps: AddonMtmdBitmap[] = [];
        try {
            for (const item of inputs) {
                const bm = await this._loadBitmap(item);
                bitmaps.push(bm);
            }
            const rc = bindings.mtmdTokenize(this._native, chunks, opts.text, bitmaps, {
                addSpecial: opts.addSpecial ?? true,
                parseSpecial: opts.parseSpecial ?? true
            });
            if (rc !== 0) {
                chunks.dispose();
                bitmaps.forEach(b => b.dispose());
                throw new Error(`mtmd_tokenize failed rc=${rc} ` +
                    `(1=marker count mismatch, 2=image preprocessing error)`);
            }
            // bitmaps 在 tokenize 後其實可以釋放（內容已被 encode 進 chunks），
            // 但為安全 — 先持有到 chunks dispose 時一起釋放
            return new MtmdChunks(chunks, bitmaps);
        } catch (err) {
            chunks.dispose();
            bitmaps.forEach(b => b.dispose());
            throw err;
        }
    }

    /**
     * 把 chunks 跑進 llamaContext（vision encoder + llama_decode）。
     * Returns: newNPast — 後續推論的起始位置。
     */
    public async evalChunks(
        llamaContext: LlamaContext,
        chunks: MtmdChunks,
        nPast: number,
        opts: MtmdEvalOptions = {}
    ): Promise<number> {
        const bindings = (this._model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        const llamaCtxNative = (llamaContext as unknown as {_ctx: any})._ctx;
        return await bindings.mtmdEvalChunks(this._native, llamaCtxNative, chunks._native, nPast, {
            seqId: opts.seqId ?? 0,
            nBatch: opts.nBatch ?? 512,
            logitsLast: opts.logitsLast ?? true
        });
    }

    /**
     * 從 evalChunks 後的 nPast 接著 sample/decode 直到 EOS or maxTokens。
     * Returns: {tokens, nPast, text}
     * 需自行傳入已建好的 AddonSampler（用 model._llama._bindings.AddonSampler 建）。
     *
     * opts.onTextChunk: F2 streaming — 每 token sample 完就 detokenize 推回去。
     *   注意 BPE/SP tokenizer 半 byte token 可能讓單 piece detokenize 出空字串/亂碼，
     *   實作會累積 buffer 直到 piece 是 valid UTF-8 才 emit（F3 處理）。
     */
    public async generate(
        llamaContext: LlamaContext,
        sampler: any,
        nPast: number,
        maxTokens: number,
        opts: {seqId?: number; onTextChunk?: (chunk: string) => void} = {}
    ): Promise<{tokens: number[]; nPast: number; text: string}> {
        const bindings = (this._model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        const llamaCtxNative = (llamaContext as unknown as {_ctx: any})._ctx;
        const modelNative = (this._model as unknown as {_model: any})._model;

        // 無 streaming → 走原 batch API（C++ side 一個 worker 跑完，IPC 開銷較少）
        if (!opts.onTextChunk) {
            const result = await bindings.mtmdGenerate(llamaCtxNative, sampler, nPast, maxTokens, opts);
            const text = modelNative.detokenize(new Uint32Array(result.tokens), false);
            return {tokens: result.tokens, nPast: result.nPast, text};
        }

        // Streaming：JS 端 loop 用 mtmdGenerateStep 單步驅動
        // F3 — UTF-8 邊界處理：每 step 都 detokenize 「全部累積 tokens」，
        // 相減算出 delta；遇到半 byte token，detokenize 回的 string 不會比上次長
        // （或可能換出 U+FFFD，但下個 token 完整時就會修正），因此：
        //   1) 只 emit「以 valid UTF-8 結尾」的 delta
        //   2) 半段 byte 的部分留在 emittedSoFar，下個 step 再嘗試
        // 這比 per-token piece detokenize 穩定，因為避免 BPE byte token 拆字。
        const tokens: number[] = [];
        let cur = nPast;
        let emittedSoFar = "";

        // 偵測字串尾端是否落在 valid UTF-8 邊界（不是 surrogate / replacement char tail）
        // 簡化判斷：尾端不為 U+FFFD（通常是 codepoint truncated）
        const REPLACEMENT_CHAR = "�";
        const endsAtValidBoundary = (s: string): boolean => {
            if (s.length === 0) return true;
            const last = s.charCodeAt(s.length - 1);
            if (last === 0xFFFD) return false;
            // high surrogate 沒 paired
            if (last >= 0xD800 && last <= 0xDBFF) return false;
            return true;
        };

        for (let i = 0; i < maxTokens; ++i) {
            const r = await bindings.mtmdGenerateStep(llamaCtxNative, sampler, cur, {seqId: opts.seqId});
            tokens.push(r.token);
            cur = r.nPast;

            // 重新 detokenize 全部累積，避免半 byte 拆字
            const fullText: string = modelNative.detokenize(new Uint32Array(tokens), false);

            if (fullText.length > emittedSoFar.length && fullText.startsWith(emittedSoFar)) {
                let delta = fullText.slice(emittedSoFar.length);
                // 若 delta 結尾不是 valid UTF-8 邊界，吐前綴留尾巴
                while (delta.length > 0 && !endsAtValidBoundary(delta)) {
                    delta = delta.slice(0, -1);
                }
                if (delta.length > 0) {
                    opts.onTextChunk(delta);
                    emittedSoFar += delta;
                }
            } else if (fullText.length > 0 && fullText !== emittedSoFar) {
                // 邊緣情況：detokenize 改寫了前面（替換字元），重新對齊
                opts.onTextChunk(fullText.slice(emittedSoFar.length));
                emittedSoFar = fullText;
            }

            if (r.eos) break;
        }

        // Flush 任何尚未 emit 的尾段（包括之前因 boundary 卡住的）
        const finalText: string = modelNative.detokenize(new Uint32Array(tokens), false);
        if (finalText.length > emittedSoFar.length && finalText.startsWith(emittedSoFar)) {
            const trailing = finalText.slice(emittedSoFar.length);
            if (trailing.length > 0) opts.onTextChunk(trailing);
        }

        return {tokens, nPast: cur, text: finalText};
    }

    public dispose(): void {
        if (this._disposed) return;
        this._native.dispose();
        this._disposed = true;
    }

    /** @internal */
    private async _loadBitmap(input: MtmdMediaInput): Promise<AddonMtmdBitmap> {
        const bindings = (this._model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        if (input.type === "file") {
            // mtmd_helper_bitmap_init_from_file 自動偵測：圖片 (PNG/JPG) 或音訊 (MP3/WAV)
            return bindings.mtmdBitmapFromFile(this._native, input.data);
        }
        if (input.type === "rgb-buffer") {
            const buf = input.data instanceof Buffer ? input.data : Buffer.from(input.data as Uint8Array);
            return bindings.mtmdBitmapFromBuffer(buf, input.width, input.height);
        }
        if (input.type === "audio-pcm") {
            // 取樣率僅用於警告，bitmap_init_from_audio 不接 sampleRate（內部假設與 model 一致）
            if (input.sampleRate != null && this.audioSampleRate > 0 && input.sampleRate !== this.audioSampleRate) {
                throw new Error(
                    `audio sampleRate ${input.sampleRate} does not match model expected ${this.audioSampleRate}; ` +
                    `please resample to ${this.audioSampleRate} Hz mono before calling`
                );
            }
            const pcm = input.data instanceof Float32Array ? input.data : new Float32Array(input.data);
            return bindings.mtmdBitmapFromAudio(this._native, pcm);
        }
        throw new Error(`unsupported media input type: ${(input as MtmdMediaInput).type}`);
    }
}

export class MtmdChunks {
    /** @internal */ public readonly _native: AddonMtmdChunks;
    /** @internal */ private readonly _bitmaps: AddonMtmdBitmap[];
    /** @internal */ private _disposed = false;

    /** @internal */
    constructor(native: AddonMtmdChunks, bitmaps: AddonMtmdBitmap[] = []) {
        this._native = native;
        this._bitmaps = bitmaps;
    }

    public get count(): number {
        return this._native.count();
    }

    public get totalTokens(): number {
        return this._native.totalTokens();
    }

    public dispose(): void {
        if (this._disposed) return;
        this._native.dispose();
        this._bitmaps.forEach(b => b.dispose());
        this._disposed = true;
    }
}
