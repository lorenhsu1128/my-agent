// 跨平台 process-tree kill helper（vendor scripts 獨立版）。
//
// 與 src/utils/proc/killTree.ts 同邏輯，但 vendor 內測試禁止 import my-agent
// （見 LESSONS.md：node-llama-tcq 測試獨立），故另存一份。改一邊請順手同步另一邊。
//
// 用法：
//   const child = spawn(cmd, args, {detached: process.platform !== "win32"});
//   await killTree(child.pid);

import {spawn, spawnSync} from "node:child_process";

export type KillTreeResult = {
    ok: boolean,
    method: "taskkill" | "process-group" | "pid-fallback" | "noop",
    error?: string
};

export async function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): Promise<KillTreeResult> {
    if (pid == null || pid <= 0) return {ok: false, method: "noop", error: "invalid pid"};

    if (process.platform === "win32") {
        return new Promise<KillTreeResult>((resolve) => {
            const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
                stdio: "ignore",
                windowsHide: true
            });
            let settled = false;
            const finish = (r: KillTreeResult) => {
                if (settled) return;
                settled = true;
                resolve(r);
            };
            tk.on("error", (err) => finish({ok: false, method: "taskkill", error: String(err?.message ?? err)}));
            tk.on("close", (code) => finish({ok: code === 0 || code === 128, method: "taskkill", error: code === 0 ? undefined : `taskkill exit ${code}`}));
            setTimeout(() => {
                try { tk.kill(); } catch { /* ignore */ }
                finish({ok: false, method: "taskkill", error: "taskkill timeout"});
            }, 3000);
        });
    }

    try {
        process.kill(-pid, signal);
        return {ok: true, method: "process-group"};
    } catch (groupErr) {
        try {
            process.kill(pid, signal);
            return {ok: true, method: "pid-fallback", error: String((groupErr as Error)?.message ?? groupErr)};
        } catch (pidErr) {
            return {ok: false, method: "pid-fallback", error: String((pidErr as Error)?.message ?? pidErr)};
        }
    }
}

export function killTreeSync(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): KillTreeResult {
    if (pid == null || pid <= 0) return {ok: false, method: "noop", error: "invalid pid"};

    if (process.platform === "win32") {
        const r = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3000
        });
        return {ok: r.status === 0, method: "taskkill", error: r.status === 0 ? undefined : `taskkill exit ${r.status}`};
    }

    try {
        process.kill(-pid, signal);
        return {ok: true, method: "process-group"};
    } catch {
        try {
            process.kill(pid, signal);
            return {ok: true, method: "pid-fallback"};
        } catch (e) {
            return {ok: false, method: "pid-fallback", error: String((e as Error)?.message ?? e)};
        }
    }
}
