// 測試 case 共用 helpers（B7：寬 regex + 完整 result dump）。
//
// 動機：v3-coding-deep / v3-myagent / failure-diagnostic 等 driver 用嚴格
// 單一 regex 判定 ok，多個「真錯」其實只是 regex 沒 match 到等價措辭；同時
// 看不到完整 result text 就無從查證。提供：
//   - anyOf(...)：把多個 RegExp 合成一個 OR pattern（保留 flags 取 union）
//   - dumpResult(...)：把單個 case 的完整 result text + thinking + tool 軌跡
//     寫到 stress-results/dumps/<runId>/<safeName>.md，env DUMP_RESULTS=0 可關。
//
// 不引入外部依賴；可被 vendor scripts 任意 import（純 TS + node 內建）。

import fs from "node:fs";
import path from "node:path";

/** 把多個 RegExp 合成一個 OR pattern。flags 取 union。 */
export function anyOf(...patterns: RegExp[]): RegExp {
    if (patterns.length === 0) return /(?!)/;   // 永不 match
    const flagSet = new Set<string>();
    for (const p of patterns) for (const f of p.flags) flagSet.add(f);
    const flags = Array.from(flagSet).join("");
    const src = patterns.map((p) => `(?:${p.source})`).join("|");
    return new RegExp(src, flags);
}

export type DumpInput = {
    /** case 名（例 "B2 修 missing await"） */
    name: string,
    /** case 類別（例 "bug-fix" / "algorithm"） */
    type?: string,
    /** 原 prompt 文字 */
    prompt?: string,
    /** stream-json result 事件的 result 欄位 */
    resultText: string,
    /** thinking content（可選；長時截前後段） */
    thinkingText?: string,
    /** tool_use 名單（依序） */
    toolUses?: string[],
    /** 數值 metric */
    metrics?: Record<string, number | string | undefined | null>,
    /** match 條件結果（label → ok） */
    matches?: {label: string, ok: boolean}[],
    /** 是否最終判定通過 */
    ok?: boolean,
    /** 失敗原因 */
    note?: string,
    /** 寫入子目錄（通常用 driver 名 + 時戳，例 "coding-deep-2026-05-08T1820"） */
    runId?: string,
    /** 自訂輸出根（預設 stress-results/dumps） */
    rootDir?: string
};

/**
 * 把 case 完整結果寫到 markdown。env `DUMP_RESULTS=0` 可整體關閉。
 * 失敗只 console.warn，不 throw，避免影響主測試流程。
 */
export function dumpResult(input: DumpInput): string | null {
    if (process.env.DUMP_RESULTS === "0") return null;

    const root = input.rootDir ?? path.resolve(process.cwd(), "stress-results", "dumps");
    const runId = input.runId ?? "default";
    const dir = path.join(root, runId);
    const safe = input.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
    const file = path.join(dir, `${safe}.md`);

    try {
        fs.mkdirSync(dir, {recursive: true});
    } catch (e) {
        // bun on Windows 偶發 EEXIST throw（B4 待修），先吃掉
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") {
            console.warn(`[dumpResult] mkdir 失敗 ${dir}: ${(e as Error)?.message ?? e}`);
            return null;
        }
    }

    const lines: string[] = [];
    lines.push(`# ${input.name}`);
    lines.push("");
    if (input.type) lines.push(`- type: \`${input.type}\``);
    if (input.ok != null) lines.push(`- ok: ${input.ok ? "✅" : "❌"}`);
    if (input.note) lines.push(`- note: ${input.note}`);
    lines.push("");

    if (input.metrics) {
        lines.push("## metrics");
        lines.push("");
        for (const [k, v] of Object.entries(input.metrics)) {
            if (v == null) continue;
            lines.push(`- ${k}: ${v}`);
        }
        lines.push("");
    }

    if (input.matches?.length) {
        lines.push("## match results");
        lines.push("");
        for (const m of input.matches) {
            lines.push(`- ${m.ok ? "✅" : "❌"} ${m.label}`);
        }
        lines.push("");
    }

    if (input.toolUses?.length) {
        lines.push("## tool uses");
        lines.push("");
        lines.push("```");
        lines.push(input.toolUses.join(", "));
        lines.push("```");
        lines.push("");
    }

    if (input.prompt) {
        lines.push("## prompt");
        lines.push("");
        lines.push("```");
        lines.push(input.prompt);
        lines.push("```");
        lines.push("");
    }

    if (input.thinkingText && input.thinkingText.length > 0) {
        lines.push("## thinking");
        lines.push("");
        lines.push("```");
        lines.push(input.thinkingText);
        lines.push("```");
        lines.push("");
    }

    lines.push("## result text");
    lines.push("");
    lines.push("```");
    lines.push(input.resultText ?? "");
    lines.push("```");
    lines.push("");

    try {
        fs.writeFileSync(file, lines.join("\n"), "utf8");
        return file;
    } catch (e) {
        console.warn(`[dumpResult] writeFile 失敗 ${file}: ${(e as Error)?.message ?? e}`);
        return null;
    }
}

/** 產生本次 driver 執行的 runId（含 driver 名 + UTC 時戳到分）。 */
export function makeRunId(driverName: string): string {
    const d = new Date();
    const stamp = d.toISOString().replace(/[:.]/g, "").replace(/T/, "-").slice(0, 13);
    return `${driverName}-${stamp}`;
}
