// 跨平台 process-tree kill helper。
//
// 動機：bun on Windows 對子進程呼叫 child.kill("SIGKILL") 不會殺到孫進程
// （shell wrapper 起的 node/bun grandchild 會殘留），導致 stress test
// timeout 後 port 沒釋放、VRAM 沒回收。Unix 雖然 SIGKILL 一般夠，但若子
// 進程自己起了 server / sub-shell，也只有 process group 能一網打盡。
//
// 用法：
//   const child = spawn(cmd, args, {detached: process.platform !== "win32"});
//   await killTree(child.pid);
//
// 注意：POSIX 端要殺到整棵子樹，spawn 時必須帶 detached: true（讓子進程自成
// process group leader）。Windows 用 taskkill /T 不需要 detached。

import {spawn, spawnSync} from "node:child_process";

export type KillTreeResult = {
    ok: boolean,
    method: "taskkill" | "process-group" | "pid-fallback" | "noop",
    error?: string
};

/**
 * 殺掉指定 pid 及其所有後代 process。
 *
 * - Windows：呼叫 `taskkill /F /T /PID <pid>`（/T 表 tree）。
 * - POSIX：先試 `process.kill(-pid, SIGKILL)`（process group），失敗
 *   fallback 到單一 pid SIGKILL。
 *
 * 永遠不會 throw — 失敗回 `{ok: false, error}`，呼叫端決定怎麼處理。
 */
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
            // taskkill 不該卡，但保險：3 秒 timeout
            setTimeout(() => {
                try { tk.kill(); } catch { /* ignore */ }
                finish({ok: false, method: "taskkill", error: "taskkill timeout"});
            }, 3000);
        });
    }

    // POSIX：先試 process group
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

/** 同步版本，給 cleanup hook 使用（Node 退出時非同步 callback 不保證執行）。 */
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
