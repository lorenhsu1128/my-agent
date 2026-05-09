// 驗 FIXUP-3 寬鬆 parser：debug-c13-mitigations.ts M4 觀察到的「答對但 tag 偏離」變種。
// 模型在 Q4 退化下會 emit <key>val</key> 而非 <parameter=key>val</parameter>。

import {parseQwenToolCalls} from "../src/server/qwenToolFormat.js";
import type {OpenAIToolDef} from "../src/server/types.js";

const TOOLS: OpenAIToolDef[] = [
    {type: "function", function: {name: "edit_file", description: "編輯檔案", parameters: {type: "object", properties: {path: {type: "string"}, old_str: {type: "string"}, new_str: {type: "string"}}, required: ["path", "old_str", "new_str"]}}},
    {type: "function", function: {name: "read_file", description: "讀取檔案", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}},
    {type: "function", function: {name: "calculator", description: "計算", parameters: {type: "object", properties: {op: {type: "string"}, a: {type: "number"}, b: {type: "number"}}, required: ["op", "a", "b"]}}}
];

type Case = {label: string, input: string, expectName: string, expectArgs: Record<string, unknown>, expectToolCount?: number};

const cases: Case[] = [
    {
        label: "C1 嚴格格式（control）",
        input: `<tool_call>
<function=edit_file>
<parameter=path>src/server/utils.ts</parameter>
<parameter=old_str>function delay(ms: number)</parameter>
<parameter=new_str>function delay(ms: number, signal?: AbortSignal)</parameter>
</function>
</tool_call>`,
        expectName: "edit_file",
        expectArgs: {path: "src/server/utils.ts", old_str: "function delay(ms: number)", new_str: "function delay(ms: number, signal?: AbortSignal)"}
    },
    {
        label: "C2 寬鬆 <key>val</key> 變種（M4）",
        input: `<tool_call>
<function=edit_file>
<path>src/server/utils.ts</path>
<old_str>function delay(ms: number)</old_str>
<new_str>function delay(ms: number, signal?: AbortSignal)</new_str>
</function>
</tool_call>`,
        expectName: "edit_file",
        expectArgs: {path: "src/server/utils.ts", old_str: "function delay(ms: number)", new_str: "function delay(ms: number, signal?: AbortSignal)"}
    },
    {
        label: "C3 寬鬆但混入非 schema key（亂抓 mitigation 驗證）",
        input: `<tool_call>
<function=edit_file>
<path>foo.ts</path>
<think>let me think</think>
<old_str>a</old_str>
<random_tag>nope</random_tag>
<new_str>b</new_str>
</function>
</tool_call>`,
        expectName: "edit_file",
        expectArgs: {path: "foo.ts", old_str: "a", new_str: "b"}
    },
    {
        label: "C4 嚴格優先 — 兩種格式並存時用嚴格",
        input: `<tool_call>
<function=read_file>
<parameter=path>strict.ts</parameter>
<path>loose.ts</path>
</function>
</tool_call>`,
        expectName: "read_file",
        expectArgs: {path: "strict.ts"} // 嚴格抓到 path 後不啟用寬鬆
    },
    {
        label: "C5 寬鬆 + 數值 coerce",
        input: `<tool_call>
<function=calculator>
<op>add</op>
<a>2026</a>
<b>1969</b>
</function>
</tool_call>`,
        expectName: "calculator",
        expectArgs: {op: "add", a: 2026, b: 1969}
    },
    {
        label: "C6 模型完全沒給 args（C1.3 真實情境）— parser 救不了，args=空 但要 emit tool_call",
        input: `<tool_call>
<function=read_file>
</function>
</tool_call>`,
        expectName: "read_file",
        expectArgs: {}
    },
    {
        label: "C7 兩個連續 tool_call",
        input: `<tool_call><function=read_file><path>a.ts</path></function></tool_call>
<tool_call><function=read_file><path>b.ts</path></function></tool_call>`,
        expectName: "read_file",
        expectArgs: {path: "a.ts"},
        expectToolCount: 2
    }
];

let passed = 0;
for (const c of cases) {
    const result = parseQwenToolCalls(c.input, TOOLS);
    const tc = result.toolCalls[0];
    let ok = false;
    let detail = "";
    if (!tc) {
        detail = "no tool_call extracted";
    } else if (tc.function.name !== c.expectName) {
        detail = `name mismatch got=${tc.function.name}`;
    } else {
        const gotArgs = JSON.parse(tc.function.arguments);
        const expectKeys = Object.keys(c.expectArgs).sort();
        const gotKeys = Object.keys(gotArgs).sort();
        const sameKeys = JSON.stringify(expectKeys) === JSON.stringify(gotKeys);
        if (!sameKeys) {
            detail = `keys mismatch expect=${expectKeys.join(",")} got=${gotKeys.join(",")}`;
        } else {
            const allSame = expectKeys.every((k) => JSON.stringify(gotArgs[k]) === JSON.stringify(c.expectArgs[k]));
            if (!allSame) {
                detail = `value mismatch got=${JSON.stringify(gotArgs)}`;
            } else if (c.expectToolCount && result.toolCalls.length !== c.expectToolCount) {
                detail = `tool_count mismatch expect=${c.expectToolCount} got=${result.toolCalls.length}`;
            } else {
                ok = true;
            }
        }
    }
    console.log(`${ok ? "✅" : "❌"} ${c.label}${detail ? "  — " + detail : ""}`);
    if (ok) passed++;
}
console.log(`\n${passed}/${cases.length} passed`);
process.exit(passed === cases.length ? 0 : 1);
