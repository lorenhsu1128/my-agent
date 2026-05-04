import {withLock} from "lifecycle-utils";
import {getLlama} from "../bindings/getLlama.js";
import type {Llama} from "../bindings/Llama.js";
import type {LlamaModel} from "../evaluator/LlamaModel/LlamaModel.js";
import type {LlamaContext, LlamaContextSequence} from "../evaluator/LlamaContext/LlamaContext.js";
import {LlamaMtmdContext} from "../evaluator/LlamaMtmdContext.js";
import {applyTCQCodebooks} from "../tcq/codebooks.js";
import {resolveCacheType} from "./tcqPresetMap.js";
import type {BuildGpu} from "../bindings/types.js";

export type SessionInitOptions = {
    modelPath: string,
    mmprojPath?: string,
    contextSize: number,
    gpuLayers: number,
    gpu?: BuildGpu | "auto",
    threads?: number,
    batchSize?: number,
    ubatchSize?: number,
    cacheTypeK: string,
    cacheTypeV: string,
    flashAttention: boolean,
    noMmap: boolean,
    debug: boolean,
    /** "on" | "off" | "auto" — server-level default; per-request reasoning_effort can override */
    reasoning?: "on" | "off" | "auto",
    /** -1 unlimited, 0 disable, N>0 cap — server-level default */
    reasoningBudget?: number,
    /** Message appended to content when budget is exhausted without visible answer */
    reasoningBudgetMessage?: string,
    /** none | deepseek (default) | deepseek-legacy — how to expose <think> in response */
    reasoningFormat?: "none" | "deepseek" | "deepseek-legacy",
    /** Directory for /slots/{id}?action=save state files. Unset = save/restore disabled. */
    slotSavePath?: string
};

export type ServerSession = {
    llama: Llama,
    model: LlamaModel,
    context: LlamaContext,
    /** Mutable: vision path may dispose+recreate to fully reset KV cache (libmtmd state cleanup workaround). */
    sequence: LlamaContextSequence,
    mtmdCtx: LlamaMtmdContext | null,
    /** Sentinel object passed as withLock scope — TCQ-shim is single-slot. */
    inferenceLockScope: readonly [object],
    options: SessionInitOptions,
    cacheTypeKLabel: string,
    cacheTypeVLabel: string
};

let _session: ServerSession | null = null;
const _initLockScope: readonly [object] = [{}] as const;

export async function ensureSession(opts: SessionInitOptions): Promise<ServerSession> {
    if (_session != null) return _session;

    return await withLock(_initLockScope, async () => {
        if (_session != null) return _session;

        if (opts.debug) console.error("[TCQ-shim] booting llama backend…");

        const kCache = resolveCacheType(opts.cacheTypeK);
        const vCache = resolveCacheType(opts.cacheTypeV);

        // TCQ codebooks must be applied before kernels load — keep this BEFORE getLlama().
        // applyTCQCodebooks() itself is idempotent and safe to call without TCQ types selected.
        if (kCache.isTcq || vCache.isTcq) {
            applyTCQCodebooks();
            if (opts.debug) console.error(`[TCQ-shim] TCQ codebooks applied (k=${kCache.label}, v=${vCache.label})`);
        }

        const llama = await getLlama({
            gpu: opts.gpu ?? "auto"
        });

        const model = await llama.loadModel({
            modelPath: opts.modelPath,
            gpuLayers: opts.gpuLayers,
            useMmap: !opts.noMmap
        });

        const context = await model.createContext({
            contextSize: opts.contextSize,
            batchSize: opts.batchSize,
            threads: opts.threads,
            flashAttention: opts.flashAttention,
            experimentalKvCacheKeyType: kCache.type,
            experimentalKvCacheValueType: vCache.type,
            // TCQ 壓縮率（TURBO4 ~3.5x, TURBO2 ~7x）upstream estimator 不知道，預設按 F16 估會
            // 誤判 VRAM 不夠 → 用 TCQ 時自動跳過 memory safety check（buun-llama-cpp server 沒這層）。
            ignoreMemorySafetyChecks: kCache.isTcq || vCache.isTcq
        });

        const sequence = context.getSequence();

        let mtmdCtx: LlamaMtmdContext | null = null;
        if (opts.mmprojPath != null && opts.mmprojPath !== "") {
            mtmdCtx = await LlamaMtmdContext.loadMmproj(model, {
                mmprojPath: opts.mmprojPath
            });
            if (opts.debug) console.error(`[TCQ-shim] mmproj loaded: ${opts.mmprojPath}`);
        }

        _session = {
            llama,
            model,
            context,
            sequence,
            mtmdCtx,
            inferenceLockScope: [{}] as const,
            options: opts,
            cacheTypeKLabel: kCache.label,
            cacheTypeVLabel: vCache.label
        };
        return _session;
    });
}

export function getSessionSync(): ServerSession {
    if (_session == null) throw new Error("Session not initialized");
    return _session;
}

/**
 * Dispose the current session.sequence and allocate a fresh one in its place.
 *
 * Why this needs the wait dance: LlamaContextSequence.dispose() is *sync* but
 * the slot is reclaimed asynchronously inside `_reclaimUnusedSequenceId` →
 * `void withLock([context, "context"], …)`. Calling getSequence() immediately
 * after dispose() races the reclaim and throws "No sequences left" since
 * `_popSequenceId()` only sees the free pool *after* the lock drains.
 *
 * Workaround: piggyback on the same context lock — `await withLock(…)` queues
 * behind the reclaim and resolves after it completes, guaranteeing the slot
 * is back in the pool before getSequence() runs.
 */
export async function resetSessionSequence(session: ServerSession): Promise<void> {
    const ctx = session.context;
    session.sequence.dispose();
    // Drain the reclaim by entering the same lock the reclaim uses
    await withLock([ctx as object, "context"], async () => { /* drain */ });
    session.sequence = ctx.getSequence();
}

export async function disposeSession(): Promise<void> {
    if (_session == null) return;
    try { await _session.context.dispose(); } catch { /* */ }
    try { await _session.model.dispose(); } catch { /* */ }
    _session = null;
}
