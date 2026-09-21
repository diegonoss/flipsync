import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirectoryWatcher } from "../src/watcher.js";

export async function testWatcher(): Promise<void> {
    console.log("  [TEST] DirectoryWatcher: Change Detection & Debouncing");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-watcher-"));
    const watcher = new DirectoryWatcher(tempDir, 60);

    try {
        // Pre-populate with a file and subdirectory
        fs.writeFileSync(path.join(tempDir, "fileA.txt"), "hello file A");
        fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "sub/nested.txt"), "hello nested");

        const manifest = await watcher.initScan();
        assert.ok(manifest.files["fileA.txt"]);
        assert.ok(manifest.files["sub/nested.txt"]);
        assert.equal(manifest.files["fileA.txt"].size, 12);
        assert.equal(manifest.files["sub/nested.txt"].size, 12);

        watcher.startWatching();

        const changedFiles: string[] = [];
        watcher.on("change", (f) => changedFiles.push(f.name));

        // Write a new file
        fs.writeFileSync(path.join(tempDir, "fileB.txt"), "hello file B");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(changedFiles.includes("fileB.txt"), "fileB.txt should trigger change event");

        // Overwrite fileB with identical content — should NOT trigger change event
        const countBefore = changedFiles.length;
        fs.writeFileSync(path.join(tempDir, "fileB.txt"), "hello file B");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(changedFiles.length, countBefore, "Identical content should not emit change");

        // Overwrite fileB with modified content — should trigger change
        fs.writeFileSync(path.join(tempDir, "fileB.txt"), "hello file B modified");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(changedFiles.length, countBefore + 1, "Modified content should emit change");

        // Delete fileB
        let deletedFile = "";
        watcher.on("delete", (name) => {
            deletedFile = name;
        });
        fs.unlinkSync(path.join(tempDir, "fileB.txt"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(deletedFile, "fileB.txt", "Deletion should emit delete event");

        // Ignore temporary / hidden files
        const countBeforeHidden = changedFiles.length;
        fs.writeFileSync(path.join(tempDir, ".hidden.txt"), "hidden content");
        fs.writeFileSync(path.join(tempDir, ".fileA.tmp.12345"), "temp content");
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(changedFiles.length, countBeforeHidden, "Hidden/temp files should be ignored");
    } finally {
        watcher.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("  [PASS] DirectoryWatcher: Debounce, modification, deletion, and suppression verified.");
}
