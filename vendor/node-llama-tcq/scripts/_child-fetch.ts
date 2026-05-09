const r = await fetch("http://127.0.0.1:8081/v1/chat/completions", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
        model: "qwen3.5-9b",
        messages: [
            {role: "system", content: "請寫一篇非常長的中文敘事文章，至少 5000 字，不要停下。"},
            {role: "user", content: "主題：森林。"}
        ],
        max_tokens: 2048,
        stream: false
    })
});
const t = await r.text();
process.stdout.write(`OK ${t.length} chars\n`);
