import {GgmlType} from "../gguf/types/GgufTensorInfoTypes.js";
import {TCQPresets} from "../tcq/presets.js";
import {isTCQAvailable} from "../tcq/compatibility.js";

export type ResolvedCacheType = {
    /** GgmlType to pass to createContext({type:...}) — see node-llama-tcq context options */
    type: GgmlType,
    /** human label for /props + logs */
    label: string,
    /** True if this came from a TCQ-fork preset (vs. plain llama.cpp type) */
    isTcq: boolean
};

/**
 * Resolve --cache-type-k / --cache-type-v string to a GgmlType the engine accepts.
 * Accepts both llama.cpp standard names (f16, q8_0, q4_0, ...) and TCQ-fork names
 * (turbo2, turbo3, turbo4 — case-insensitive, underscores optional).
 *
 * On platforms where TCQ is unavailable (e.g. macOS Metal), TCQ types fall back to
 * F16 with a warn message printed to stderr by the caller.
 */
export function resolveCacheType(input: string, fallbackToF16OnUnsupported = true): ResolvedCacheType {
    const normalized = input.toLowerCase().replace(/[_-]/g, "");
    const tcqAvailable = isTCQAvailable();

    const tcqAlias: Record<string, ResolvedCacheType> = {
        turbo4: {type: GgmlType.TURBO4_0, label: "turbo4", isTcq: true},
        turbo40: {type: GgmlType.TURBO4_0, label: "turbo4", isTcq: true},
        turbo3: {type: GgmlType.TURBO3_TCQ, label: "turbo3_tcq", isTcq: true},
        turbo3tcq: {type: GgmlType.TURBO3_TCQ, label: "turbo3_tcq", isTcq: true},
        turbo30: {type: GgmlType.TURBO3_0, label: "turbo3", isTcq: true},
        turbo2: {type: GgmlType.TURBO2_TCQ, label: "turbo2_tcq", isTcq: true},
        turbo2tcq: {type: GgmlType.TURBO2_TCQ, label: "turbo2_tcq", isTcq: true},
        turbo20: {type: GgmlType.TURBO2_0, label: "turbo2", isTcq: true}
    };
    const tcqHit = tcqAlias[normalized];
    if (tcqHit != null) {
        if (!tcqAvailable && fallbackToF16OnUnsupported) {
            return {type: GgmlType.F16, label: "f16(tcq-unavailable-fallback)", isTcq: false};
        }
        return tcqHit;
    }

    // llama.cpp standard cache types
    const stdMap: Record<string, GgmlType> = {
        f32: GgmlType.F32,
        f16: GgmlType.F16,
        q80: GgmlType.Q8_0,
        q40: GgmlType.Q4_0,
        q41: GgmlType.Q4_1,
        q50: GgmlType.Q5_0,
        q51: GgmlType.Q5_1
    };
    const stdHit = stdMap[normalized];
    if (stdHit != null) {
        return {type: stdHit, label: normalized, isTcq: false};
    }

    throw new Error(`Unknown --cache-type value: ${input}`);
}

export {TCQPresets};
