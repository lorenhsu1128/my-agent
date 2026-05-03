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

export interface MtmdImageInput {
    type: "file" | "rgb-buffer";
    /** path（type=file）或 RGB raw bytes（type=rgb-buffer） */
    data: string | Buffer | Uint8Array;
    /** type=rgb-buffer 必填 */
    width?: number;
    height?: number;
}

export interface MtmdTokenizeOptions {
    /** prompt 文字，須含一個或多個 marker（mtmd default: "<__media__>"） */
    text: string;
    /** 對應 marker 的 image inputs */
    images?: MtmdImageInput[];
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

    /**
     * Tokenize 文字 + 圖片（含 marker 替換）→ MtmdChunks。
     * Returns: chunks 物件可後續餵給 evalChunks。
     * Throws: tokenize rc != 0 時拋（marker 數量不對 / 圖片預處理失敗）。
     */
    public async tokenize(opts: MtmdTokenizeOptions): Promise<MtmdChunks> {
        const bindings = (this._model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        const chunks: AddonMtmdChunks = new bindings.MtmdChunks();

        const bitmaps: AddonMtmdBitmap[] = [];
        try {
            for (const img of opts.images ?? []) {
                const bm = await this._loadBitmap(img);
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
        const tokens: number[] = [];
        let cur = nPast;
        let pendingBytes: number[] = []; // 累積 byte 直到湊成 valid UTF-8
        let emittedText = "";

        for (let i = 0; i < maxTokens; ++i) {
            const r = await bindings.mtmdGenerateStep(llamaCtxNative, sampler, cur, {seqId: opts.seqId});
            tokens.push(r.token);
            cur = r.nPast;

            // 累積 + 嘗試 emit valid UTF-8 chunk
            const piece = modelNative.detokenize(new Uint32Array([r.token]), false);
            if (piece && piece.length > 0) {
                // detokenize 已回 string；理論上 BPE 半 byte 會吃進 piece 內部處理
                // 仍保險：用 Buffer 重新編檢查，但簡化版直接 emit
                opts.onTextChunk(piece);
                emittedText += piece;
            } else if (piece === "") {
                // 半 byte token：累積等下次完整湊出（F3 強化空間）
                pendingBytes.push(r.token);
            }

            if (r.eos) break;
        }

        // Flush pending（少見：trailing 半 byte）
        if (pendingBytes.length > 0) {
            const flush = modelNative.detokenize(new Uint32Array(pendingBytes), false);
            if (flush && flush.length > 0) {
                opts.onTextChunk(flush);
                emittedText += flush;
            }
        }

        // 最終 text 用所有 tokens 一次 detokenize（保證一致性，避免 piece-by-piece 累積誤差）
        const finalText = modelNative.detokenize(new Uint32Array(tokens), false);
        return {tokens, nPast: cur, text: finalText.length > 0 ? finalText : emittedText};
    }

    public dispose(): void {
        if (this._disposed) return;
        this._native.dispose();
        this._disposed = true;
    }

    /** @internal */
    private async _loadBitmap(img: MtmdImageInput): Promise<AddonMtmdBitmap> {
        const bindings = (this._model as unknown as {_llama: {_bindings: any}})._llama._bindings;
        if (img.type === "file") {
            if (typeof img.data !== "string") throw new Error("type=file requires data: string");
            return bindings.mtmdBitmapFromFile(this._native, img.data);
        }
        if (img.type === "rgb-buffer") {
            if (img.width == null || img.height == null)
                throw new Error("type=rgb-buffer requires width and height");
            const buf = img.data instanceof Buffer ? img.data : Buffer.from(img.data as Uint8Array);
            return bindings.mtmdBitmapFromBuffer(buf, img.width, img.height);
        }
        throw new Error(`unsupported image input type: ${(img as MtmdImageInput).type}`);
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
