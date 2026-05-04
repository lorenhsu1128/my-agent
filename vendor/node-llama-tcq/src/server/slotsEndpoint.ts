// M-TCQ-SHIM-2-1：/slots/{id}?action=save|restore|erase 對接 LlamaContextSequence。
//
// 行為對齊 buun llama-server：
//   POST /slots/0?action=save     body {filename: "x.bin"} → save_state_to_file
//   POST /slots/0?action=restore  body {filename: "x.bin"} → load_state_from_file
//   POST /slots/0?action=erase                              → clearHistory
//
// 安全策略：filename 必須是純檔名（不含 path separator / .. / 絕對路徑），
// 一律解析到 --slot-save-path 目錄下。未設 --slot-save-path 直接 501。
// 這樣 client 不能任意寫入 server filesystem。

import path from "node:path";
import type {ServerResponse} from "node:http";
import type {ServerSession} from "./session.js";
import {sendJson} from "./httpHelpers.js";
import {makeError} from "./errors.js";

export async function handleSlotAction(
    res: ServerResponse,
    body: any,
    session: ServerSession,
    slotIdStr: string,
    action: string
): Promise<void> {
    // 單 slot：只接受 id=0
    if (slotIdStr !== "0") {
        sendJson(res, 404, makeError("invalid_slot_id", `TCQ-shim is single-slot; only id=0 is valid (got ${slotIdStr})`));
        return;
    }

    if (action === "erase") {
        await session.sequence.clearHistory();
        sendJson(res, 200, {id_slot: 0, n_erased: 0});
        return;
    }

    const baseDir = session.options.slotSavePath;
    if (baseDir == null || baseDir === "") {
        sendJson(res, 501, makeError(
            "slot_persistence_disabled",
            "Slot save/restore is disabled. Restart the server with --slot-save-path <dir> to enable.",
            "not_implemented"
        ));
        return;
    }

    const filename = typeof body?.filename === "string" ? body.filename : "";
    if (filename === "" || /[\\/]|\.\./.test(filename) || path.isAbsolute(filename)) {
        sendJson(res, 400, makeError(
            "invalid_filename",
            "filename must be a non-empty plain file name (no path separators, no '..', no absolute path)"
        ));
        return;
    }

    const fullPath = path.join(baseDir, filename);

    if (action === "save") {
        try {
            const result = await session.sequence.saveStateToFile(fullPath);
            sendJson(res, 200, {id_slot: 0, filename, n_saved: 0, file_size: result.fileSize});
        } catch (err) {
            sendJson(res, 500, makeError("slot_save_failed", (err as Error).message, "server_error"));
        }
        return;
    }

    if (action === "restore") {
        try {
            await session.sequence.loadStateFromFile(fullPath, {acceptRisk: true});
            sendJson(res, 200, {id_slot: 0, filename, n_restored: 0});
        } catch (err) {
            sendJson(res, 500, makeError("slot_restore_failed", (err as Error).message, "server_error"));
        }
        return;
    }

    sendJson(res, 400, makeError(
        "invalid_action",
        `Unknown action '${action}'. Expected: save | restore | erase.`
    ));
}
