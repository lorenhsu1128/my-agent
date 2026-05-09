// Live vision/audio test for TCQ-shim. Run after starting shim with --mmproj.
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8081";
const MODEL = process.env.MODEL ?? "qwen3.5-9b";
// 絕對路徑 — file:// URL 與 bare-path 變體都需要 absolute，否則 Windows 上會 resolve 到 C: 根
const IMAGE = path.resolve(process.env.IMAGE ?? "llama/llama.cpp/tools/mtmd/test-1.jpeg");
let pass = 0, fail = 0;

async function chat(name: string, body: any, expectKey: string = "content") {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });
    const dt = Date.now() - t0;
    const json: any = await res.json().catch(() => ({}));
    const choice = json?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content ?? "";
    const usage = json?.usage ?? {};

    console.log(`\n===== ${name} =====`);
    console.log(`HTTP ${res.status} time=${dt}ms p=${usage.prompt_tokens ?? "?"} c=${usage.completion_tokens ?? "?"} finish=${choice?.finish_reason ?? "?"}`);
    if (json?.error) console.log(`ERROR: ${JSON.stringify(json.error)}`);
    if (content) console.log(`-- content[0..240]:\n${content.slice(0, 240)}`);
    if (reasoning) console.log(`-- reasoning[0..120]:\n${reasoning.slice(0, 120)}`);

    const ok = res.status === 200 && content.length > 0;
    if (ok) { pass++; console.log("PASS"); } else { fail++; console.log("FAIL"); }
}

(async () => {
    if (!fs.existsSync(IMAGE)) {
        console.error(`IMAGE not found: ${IMAGE}`);
        process.exit(2);
    }

    // V1: file:// URL（最簡單，不要 base64 來回轉）
    const fileUrl = `file:///${IMAGE.replace(/\\/g, "/")}`;
    await chat("V1 image via file:// URL", {
        model: MODEL,
        messages: [{
            role: "user",
            content: [
                {type: "image_url", image_url: {url: fileUrl}},
                {type: "text", text: "用 2-3 句話描述這張圖片。"}
            ]
        }],
        max_tokens: 256, temperature: 0
    });

    // V2: data: URL（base64-encoded）
    const buf = fs.readFileSync(IMAGE);
    const ext = IMAGE.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const dataUrl = `data:${ext};base64,${buf.toString("base64")}`;
    console.log(`-- data url len=${dataUrl.length}`);
    await chat("V2 image via data:base64 URL", {
        model: MODEL,
        messages: [{
            role: "user",
            content: [
                {type: "image_url", image_url: {url: dataUrl}},
                {type: "text", text: "Describe this image in one English sentence."}
            ]
        }],
        max_tokens: 200, temperature: 0
    });

    // V3: bare path
    await chat("V3 image via bare path", {
        model: MODEL,
        messages: [{
            role: "user",
            content: [
                {type: "image_url", image_url: {url: IMAGE}},
                {type: "text", text: "圖片中主要的物體是什麼？一句話回答。"}
            ]
        }],
        max_tokens: 128, temperature: 0
    });

    // V4: vision + 後置問題（多 turn —— 一輪就好，因為我們不保多輪 vision history）
    await chat("V4 vision multi-text-part", {
        model: MODEL,
        messages: [{
            role: "user",
            content: [
                {type: "text", text: "我給你一張圖："},
                {type: "image_url", image_url: {url: fileUrl}},
                {type: "text", text: "請數一下有幾隻動物。"}
            ]
        }],
        max_tokens: 128, temperature: 0
    });

    // V5: vision_not_enabled negative case — request with image but server has mmproj?
    // Skip — we have mmproj loaded so this would always pass. Tested in unit test instead.

    console.log(`\n================================\nTotal: PASS=${pass} FAIL=${fail}`);
    process.exit(fail);
})();
