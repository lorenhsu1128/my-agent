import {spawn} from "node:child_process";
import path from "node:path";

const child = spawn("bun", [
    path.join(import.meta.dir, "src/entrypoints/cli.tsx"),
    "--print", "--output-format", "json",
    "--allow-dangerously-skip-permissions",
    "--disallowed-tools", "Edit Write NotebookEdit",
    "--model", "qwen3.5-9b",
    "--no-session-persistence",
    "-p", "說一句話：『阿波羅 11 號登月。』"
], {stdio: ["ignore", "pipe", "pipe"], env: {...process.env}});

const chunks: Buffer[] = [];
child.stdout.on("data", (c: Buffer) => chunks.push(c));
child.on("close", () => {
    const buf = Buffer.concat(chunks);
    console.log("raw bytes len:", buf.length);
    const utf8 = buf.toString("utf8");
    console.log("utf8 decode:", utf8.slice(-300));
    console.log("\n--- hex around 阿 (E9 98 BF) ---");
    const idx = buf.indexOf(Buffer.from([0xE9, 0x98, 0xBF]));
    console.log("阿 found at:", idx);
    if (idx > 0) console.log("around:", buf.slice(idx-3, idx+15).toString("hex"));
    // 找 result 字串
    try {
        const arr = JSON.parse(utf8);
        for (const ev of arr) {
            if (ev.type === "result") {
                console.log("result.result:", JSON.stringify(ev.result));
            }
        }
    } catch (e) { console.log("parse err:", String(e).slice(0, 100)); }
});
