import {Token} from "../types.js";
import {LlamaNuma} from "./types.js";


export type BindingModule = {
    AddonModel: {
        new (modelPath: string, params: {
            addonExports?: BindingModule,
            gpuLayers?: number,
            vocabOnly?: boolean,
            useMmap?: boolean,
            useDirectIo?: boolean,
            useMlock?: boolean,
            checkTensors?: boolean,
            onLoadProgress?(loadPercentage: number): void,
            hasLoadAbortSignal?: boolean,
            overridesList?: Array<[key: string, value: number | bigint | boolean | string, type: 0 | 1 | undefined]>
        }): AddonModel
    },
    AddonModelLora: {
        new (model: AddonModel, filePath: string): AddonModelLora
    },
    AddonContext: {
        new (model: AddonModel, params: {
            contextSize?: number,
            batchSize?: number,
            sequences?: number,
            flashAttention?: boolean,
            logitsAll?: boolean,
            embeddings?: boolean,
            ranking?: boolean,
            threads?: number,
            performanceTracking?: boolean,
            kvCacheKeyType?: number,
            kvCacheValueType?: number,
            swaFullCache?: boolean
        }): AddonContext
    },
    AddonContextSequenceCheckpoint: {
        new (): AddonContextSequenceCheckpoint
    },
    AddonGrammar: {
        new (grammarPath: string, params?: {
            addonExports?: BindingModule,
            rootRuleName?: string
        }): AddonGrammar
    },
    AddonGrammarEvaluationState: {
        new (model: AddonModel, grammar: AddonGrammar): AddonGrammarEvaluationState,
        new (existingState: AddonGrammarEvaluationState): AddonGrammarEvaluationState
    },
    AddonSampler: {
        new (model: AddonModel): AddonSampler,
        acceptGrammarEvaluationStateToken(grammarEvaluationState: AddonGrammarEvaluationState, token: Token): void,
        canBeNextTokenForGrammarEvaluationState(grammarEvaluationState: AddonGrammarEvaluationState, token: Token): boolean
    },
    markLoaded(): boolean,
    systemInfo(): string,
    getSupportsGpuOffloading(): boolean,
    getSupportsMmap(): boolean,
    getGpuSupportsMmap(): boolean,
    getSupportsMlock(): boolean,
    getMathCores(): number,
    getBlockSizeForGgmlType(ggmlType: number): number | undefined,
    getTypeSizeForGgmlType(ggmlType: number): number | undefined,
    getGgmlGraphOverheadCustom(size: number, grads: boolean): number,
    getConsts(): {
        ggmlMaxDims: number,
        ggmlTypeF16Size: number,
        ggmlTypeF32Size: number,
        ggmlTensorOverhead: number,
        llamaPosSize: number,
        llamaSeqIdSize: number
    },
    setLogger(logger: (level: number, message: string) => void): void,
    setLoggerLogLevel(level: number): void,
    getGpuVramInfo(): {
        total: number,
        used: number,
        unifiedSize: number
    },
    getGpuDeviceInfo(): {
        deviceNames: string[]
    },
    getGpuType(): "cuda" | "vulkan" | "metal" | false | undefined,
    ensureGpuDeviceIsSupported(): void,
    getSwapInfo(): {
        total: number,
        maxSize: number,
        free: number
    },
    getMemoryInfo(): {
        total: number
    },
    init(): Promise<void>,
    setNuma(numa?: LlamaNuma): void,
    loadBackends(forceLoadLibrariesSearchPath?: string): void,
    dispose(): Promise<void>,

    // node-llama-tcq Phase E：libmtmd binding
    MtmdContext: {
        new (model: AddonModel, mmprojPath: string, opts?: {useGpu?: boolean, nThreads?: number}): AddonMtmdContext
    },
    MtmdBitmap: {
        new (): AddonMtmdBitmap  // 通常不直接 new；用 mtmdBitmapFromFile / mtmdBitmapFromBuffer
    },
    MtmdChunks: {
        new (): AddonMtmdChunks
    },
    mtmdTokenize(
        ctx: AddonMtmdContext, chunks: AddonMtmdChunks, prompt: string,
        bitmaps: AddonMtmdBitmap[], opts?: {addSpecial?: boolean, parseSpecial?: boolean}
    ): number,
    mtmdEvalChunks(
        mtmdCtx: AddonMtmdContext, llamaCtx: AddonContext, chunks: AddonMtmdChunks,
        nPast: number, opts?: {seqId?: number, nBatch?: number, logitsLast?: boolean}
    ): Promise<number>,
    mtmdBitmapFromFile(ctx: AddonMtmdContext, path: string): AddonMtmdBitmap,
    mtmdBitmapFromBuffer(buffer: Uint8Array, width: number, height: number): AddonMtmdBitmap,
    mtmdBitmapFromAudio(ctx: AddonMtmdContext, pcmMono: Float32Array): AddonMtmdBitmap,
    mtmdGenerate(
        llamaCtx: AddonContext, sampler: AddonSampler, nPast: number, maxTokens: number,
        opts?: {seqId?: number}
    ): Promise<{tokens: number[], nPast: number}>,
    mtmdGenerateStep(
        llamaCtx: AddonContext, sampler: AddonSampler, nPast: number,
        opts?: {seqId?: number}
    ): Promise<{token: number, eos: boolean, nPast: number}>
};

export type AddonMtmdContext = {
    /** 內部 init Promise — 必須 await 後 ctx 才就緒 */
    _initPromise: Promise<void>,
    supportsVision(): boolean,
    supportsAudio(): boolean,
    defaultMarker(): string,
    /** mtmd_get_audio_sample_rate；不支援 audio 回 -1 */
    audioSampleRate(): number,
    dispose(): void
};

export type AddonMtmdBitmap = {
    width(): number,
    height(): number,
    dispose(): void
};

export type AddonMtmdChunks = {
    count(): number,
    totalTokens(): number,
    dispose(): void
};

export type AddonModel = {
    init(): Promise<boolean>,
    loadLora(lora: AddonModelLora): Promise<void>,
    abortActiveModelLoad(): void,
    dispose(): Promise<void>,
    tokenize(text: string, specialTokens: boolean): Uint32Array,
    detokenize(tokens: Uint32Array, specialTokens?: boolean): string,
    getTrainContextSize(): number,
    getEmbeddingVectorSize(): number,
    getTotalSize(): number,
    getTotalParameters(): number,
    getModelDescription(): ModelTypeDescription,
    tokenBos(): Token,
    tokenEos(): Token,
    tokenNl(): Token,
    prefixToken(): Token,
    middleToken(): Token,
    suffixToken(): Token,
    eotToken(): Token,
    sepToken(): Token,
    getTokenString(token: number): string,
    getTokenAttributes(token: Token): number,
    isEogToken(token: Token): boolean,
    getVocabularyType(): number,
    shouldPrependBosToken(): boolean,
    shouldAppendEosToken(): boolean,
    getModelSize(): number
};

export type AddonContext = {
    init(): Promise<boolean>,
    dispose(): Promise<void>,
    getContextSize(): number,
    initBatch(size: number): void, // size must be less or equal to batchSize
    addToBatch(
        sequenceId: number,
        firstTokenSequenceIndex: number,
        tokens: Uint32Array,
        logitIndexes: Uint32Array,
    ): Uint32Array, // returns an array with batchLogitIndex for each item in the logitIndexes array
    decodeBatch(): Promise<void>,
    sampleToken(batchLogitIndex: BatchLogitIndex, sampler: AddonSampler): Promise<Token | -1>,
    sampleToken(
        batchLogitIndex: BatchLogitIndex,
        sampler: AddonSampler,
        probabilities: boolean,
        confidence?: boolean
    ): Promise<[token: Token | -1, probabilities: (Token | number)[] | undefined, confidence: number | undefined]>,
    disposeSequence(sequenceId: number): void,

    // startPos in inclusive, endPos is exclusive
    removeTokenCellsFromSequence(sequenceId: number, startPos: number, endPos: number): boolean,

    // startPos in inclusive, endPos is exclusive
    shiftSequenceTokenCells(sequenceId: number, startPos: number, endPos: number, shiftDelta: number): void,

    getSequenceKvCacheMinPosition(sequenceId: number): number,
    getSequenceKvCacheMaxPosition(sequenceId: number): number,
    getEmbedding(inputTokensLength: number, maxVectorSize?: number): Float64Array,
    getStateSize(): number,
    getThreads(): number,
    setThreads(threads: number): void,
    printTimings(): void,
    ensureDraftContextIsCompatibleForSpeculative(draftContext: AddonContext): void,
    saveSequenceStateToFile(filePath: string, sequenceId: number, tokens: Uint32Array): Promise<number>,
    loadSequenceStateFromFile(filePath: string, sequenceId: number, maxContextSize: number): Promise<Uint32Array>,
    setLoras(loras: AddonModelLora[], scales: number[]): void,

    restoreCheckpoint(checkpoint: AddonContextSequenceCheckpoint, maxPosIndex: number): Promise<boolean>
};

export type AddonContextSequenceCheckpoint = {
    init(context: AddonContext, sequenceId: number): Promise<void>,
    dispose(): void,

    get size(): number,
    get minPos(): number,
    get maxPos(): number
};

export type BatchLogitIndex = number & {
    readonly __batchLogitIndex: never
};

export type AddonGrammar = {
    isTextCompatible(testText: string): boolean
};

export type AddonGrammarEvaluationState = "AddonGrammarEvaluationState" & {
    readonly __brand: never
};

export type AddonSampler = {
    dispose(): void,
    applyConfig(config: {
        temperature?: number,
        minP?: number,
        topK?: number,
        topP?: number,
        seed?: number,
        xtcProbability?: number,
        xtcThreshold?: number,
        repeatPenalty?: number,
        repeatPenaltyMaxTokens?: number,
        repeatPenaltyTokens?: Uint32Array,
        repeatPenaltyPresencePenalty?: number, // alpha_presence
        repeatPenaltyFrequencyPenalty?: number, // alpha_frequency
        dryRepeatPenaltyStrength?: number,
        dryRepeatPenaltyBase?: number,
        dryRepeatPenaltyAllowedLength?: number,
        dryRepeatPenaltyLastTokens?: number,
        dryRepeatPenaltySequenceBreakers?: false | string[],
        grammarEvaluationState?: AddonGrammarEvaluationState,
        tokenBiasKeys?: Uint32Array,
        tokenBiasValues?: Float32Array
    }): void
};

export type AddonModelLora = {
    usages: number,
    readonly filePath: string,
    readonly disposed: boolean,
    dispose(): Promise<void>
};

export type ModelTypeDescription = `${AddonModelArchName} ${AddonModelTypeName} ${AddonModelFileTypeName}`;
export type AddonModelArchName = "unknown" | "llama" | "falcon" | "gpt2" | "gptj" | "gptneox" | "mpt" | "baichuan" | "starcoder" | "persimmon" |
    "refact" | "bloom" | "stablelm";
export type AddonModelTypeName = "1B" | "3B" | "7B" | "8B" | "13B" | "15B" | "30B" | "34B" | "40B" | "65B" | "70B" | "?B";
export type AddonModelFileTypeName = _AddonModelFileTypeName | `${_AddonModelFileTypeName} (guessed)`;
type _AddonModelFileTypeName = "all F32" | "mostly F16" | "mostly Q4_0" | "mostly Q4_1" | "mostly Q4_1, some F16" | "mostly Q5_0" |
    "mostly Q5_1" | "mostly Q8_0" | "mostly Q2_K" | "mostly Q3_K - Small" | "mostly Q3_K - Medium" | "mostly Q3_K - Large" |
    "mostly Q4_K - Small" | "mostly Q4_K - Medium" | "mostly Q5_K - Small" | "mostly Q5_K - Medium" | "mostly Q6_K" |
    "unknown, may not work";
