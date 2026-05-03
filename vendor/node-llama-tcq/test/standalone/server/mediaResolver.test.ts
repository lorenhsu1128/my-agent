import {describe, expect, test} from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {resolveMedia, cleanupMedia} from "../../../src/server/mediaResolver.js";

describe("mediaResolver", () => {
    test("data: base64 → tmpfile", async () => {
        const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=";
        const url = `data:image/png;base64,${png1x1}`;
        const m = await resolveMedia(url);
        expect(m.ephemeral).toBe(true);
        expect(m.mime).toBe("image/png");
        const bytes = await fs.readFile(m.filePath);
        expect(bytes.length).toBeGreaterThan(0);
        await cleanupMedia(m);
    });

    test("file:// resolves to absolute path", async () => {
        const tmp = path.join(process.cwd(), "_tcq-shim-fixture.txt");
        await fs.writeFile(tmp, "hi");
        try {
            const url = process.platform === "win32"
                ? `file:///${tmp.replace(/\\/g, "/")}`
                : `file://${tmp}`;
            const m = await resolveMedia(url);
            expect(m.ephemeral).toBe(false);
            expect(m.filePath.toLowerCase()).toBe(tmp.toLowerCase());
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });

    test("bare path passes through", async () => {
        const m = await resolveMedia("/some/local/path.png");
        expect(m.ephemeral).toBe(false);
        expect(path.isAbsolute(m.filePath)).toBe(true);
    });
});
