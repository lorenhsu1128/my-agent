// M-LOCAL-MODEL-ROBUSTNESS-B4：bun on Windows mkdir-EEXIST workaround。
//
// 觀察：bun on Windows 對 fs.mkdir(p, {recursive: true}) 在 p 已存在時會 throw
// EEXIST，違反 node spec（recursive:true 應 silent no-op for existing dirs）。
// fs-extra mkdirp / ensureDir、proper-lockfile、cmake-js / npm wrapper 等鏈
// 多處受影響，build 路徑撞個沒完。
//
// 此檔在 process 進入點 import 一次（cli.ts 已串），效果：
//   - 只 patch win32 + bun runtime（process.versions.bun 存在）
//   - 把 fs.mkdirSync / fs.promises.mkdir 對「目標已是 dir」的 EEXIST swallow
//   - 其他錯（permission / 父路徑 invalid）照原樣 throw
//
// 不污染 node runtime（process.versions.bun undefined → noop）。

import {default as fsImport, statSync} from "node:fs";

const fs = fsImport as typeof import("node:fs");

const isBun = typeof (process as any).versions?.bun === "string";
const isWin = process.platform === "win32";

if (isBun && isWin && !(globalThis as any).__bunWinMkdirShimApplied) {
    (globalThis as any).__bunWinMkdirShimApplied = true;

    const origMkdirSync = fs.mkdirSync.bind(fs);
    const origMkdirAsync = fs.promises.mkdir.bind(fs.promises);

    function isExistingDir(p: string | URL | Buffer): boolean {
        try {
            const sp = typeof p === "string" ? p : p.toString();
            return statSync(sp).isDirectory();
        } catch {
            return false;
        }
    }

    // sync 版
    (fs as any).mkdirSync = function patchedMkdirSync(p: any, opts?: any): any {
        try {
            return origMkdirSync(p, opts);
        } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err?.code === "EEXIST" && isExistingDir(p)) return undefined;
            throw e;
        }
    };

    // async 版
    (fs.promises as any).mkdir = async function patchedMkdir(p: any, opts?: any): Promise<any> {
        try {
            return await origMkdirAsync(p, opts);
        } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err?.code === "EEXIST" && isExistingDir(p)) return undefined;
            throw e;
        }
    };

    // callback 版（fs.mkdir(path, opts, cb)）
    const origMkdirCb: any = (fs as any).mkdir;
    (fs as any).mkdir = function patchedMkdirCb(p: any, optsOrCb: any, maybeCb?: any): void {
        const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
        const opts = typeof optsOrCb === "function" ? undefined : optsOrCb;
        origMkdirCb.call(fs, p, opts, (err: NodeJS.ErrnoException | null, ...rest: any[]) => {
            if (err?.code === "EEXIST" && isExistingDir(p)) {
                if (typeof cb === "function") cb(null, ...rest);
                return;
            }
            if (typeof cb === "function") cb(err, ...rest);
        });
    };
}
