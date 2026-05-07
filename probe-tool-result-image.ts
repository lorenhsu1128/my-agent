// 直接驗 my-agent llamacpp-fetch-adapter 對 tool_result 內 image block 的翻譯。
// 模擬 FileReadTool 對 .jpeg 的回傳：tool_result.content = [{type:'image', source:{base64,...}}]
//
// 跑：bun probe-tool-result-image.ts

import {translateMessagesToOpenAI} from "./src/services/api/llamacpp-fetch-adapter.js";

const FAKE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAA(...truncated jpeg base64 ~50KB...)";

const anthropicMessages: any[] = [
    {role: "user", content: [{type: "text", text: "讀這張圖描述一下"}]},
    {
        role: "assistant",
        content: [
            {type: "text", text: "我來讀取圖片"},
            {
                type: "tool_use",
                id: "toolu_abc",
                name: "Read",
                input: {file_path: "test.jpeg"}
            }
        ]
    },
    {
        role: "user",
        content: [
            {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: [
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            data: FAKE_BASE64,
                            media_type: "image/jpeg"
                        }
                    }
                ]
            }
        ]
    }
];

console.log("=== 翻譯結果（vision=true）===\n");
const out = translateMessagesToOpenAI(anthropicMessages, {vision: true});
for (let i = 0; i < out.length; i++) {
    const m = out[i];
    console.log(`[message ${i}] role=${m.role}`);
    if (m.role === "tool") console.log(`  tool_call_id=${m.tool_call_id}`);
    if (typeof m.content === "string") {
        console.log(`  content: <string len=${m.content.length}> ${JSON.stringify(m.content.slice(0, 80))}`);
    } else if (Array.isArray(m.content)) {
        console.log(`  content: <array of ${m.content.length} parts>`);
        for (const p of m.content) {
            if (p.type === "text") console.log(`    - text: ${JSON.stringify(p.text.slice(0, 60))}`);
            else if (p.type === "image_url") console.log(`    - image_url: ${p.image_url.url.slice(0, 50)}...`);
            else console.log(`    - <unknown part>`);
        }
    } else if (m.content == null) {
        console.log(`  content: null`);
    }
    if ((m as any).tool_calls) {
        console.log(`  tool_calls: ${JSON.stringify((m as any).tool_calls).slice(0, 100)}`);
    }
}

console.log("\n=== shim 端會收到的 image_url 數量 ===");
let imageUrlCount = 0;
for (const m of out) {
    if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === "image_url") imageUrlCount++;
    }
}
console.log(`image_url 在 messages 中出現次數: ${imageUrlCount}`);
console.log(imageUrlCount > 0 ? "✅ shim extractMediaParts 會抓到 → 走 vision path" : "❌ shim extractMediaParts 抓 0 → 純文字 path → 模型看不到圖");
