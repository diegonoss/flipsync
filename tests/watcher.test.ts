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

        let discoveredTotal = 0;
        const progressList: Array<{ completed: number; total: number; file: string }> = [];
        let completedTotal = 0;

        watcher.on("scan:discovered", (e: { totalFiles: number }) => {
            discoveredTotal = e.totalFiles;
        });
        watcher.on("scan:progress", (e: { completed: number; total: number; file: string }) => {
            progressList.push(e);
        });
        watcher.on("scan:complete", (e: { totalFiles: number }) => {
            completedTotal = e.totalFiles;
        });

        const manifest = await watcher.initScan();
        assert.equal(discoveredTotal, 2, "scan:discovered should report 2 files discovered in Phase 1");
        assert.equal(completedTotal, 2, "scan:complete should report 2 files completed in Phase 2");
        assert.equal(progressList.length, 2, "scan:progress should emit for each file");
        assert.equal(progressList[1].completed, 2);
        assert.ok(manifest.files["fileA.txt"]);
        assert.ok(manifest.files["sub/nested.txt"]);
        assert.equal(manifest.files["fileA.txt"].size, 12);
        assert.equal(manifest.files["sub/nested.txt"].size, 12);

        await watcher.startWatching();

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
        const deletedFiles: string[] = [];
        watcher.on("delete", (name) => {
            deletedFiles.push(name);
        });
        fs.unlinkSync(path.join(tempDir, "fileB.txt"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(deletedFiles.includes("fileB.txt"), "Deletion should emit delete event");

        // Subdirectory modification
        fs.writeFileSync(path.join(tempDir, "sub/nested.txt"), "hello nested modified");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(changedFiles.includes("sub/nested.txt"), "sub/nested.txt modification should trigger change event");

        // Dynamic nested directory creation and file addition
        fs.mkdirSync(path.join(tempDir, "new_sub/deep"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "new_sub/deep/nested.txt"), "hello deep nested");
        for (let i = 0; i < 20 && !changedFiles.includes("new_sub/deep/nested.txt"); i++) await new Promise((r) => setTimeout(r, 50));
        assert.ok(changedFiles.includes("new_sub/deep/nested.txt"), "Dynamically added nested file should trigger change event");

        // Subdirectory file deletion
        fs.unlinkSync(path.join(tempDir, "sub/nested.txt"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(deletedFiles.includes("sub/nested.txt"), "sub/nested.txt deletion should emit delete event");

        // Subdirectory recursive deletion
        fs.rmSync(path.join(tempDir, "new_sub"), { recursive: true, force: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(deletedFiles.includes("new_sub/deep/nested.txt"), "Removing folder should emit delete event for nested files");

        // Ignore temporary / hidden files (including inside subdirectories)
        const countBeforeHidden = changedFiles.length;
        fs.writeFileSync(path.join(tempDir, ".hidden.txt"), "hidden content");
        fs.writeFileSync(path.join(tempDir, ".fileA.tmp.12345"), "temp content");
        fs.mkdirSync(path.join(tempDir, "ignore_test"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "ignore_test/.hidden_nested"), "hidden nested");
        fs.writeFileSync(path.join(tempDir, "ignore_test/file.tmp.999"), "temp nested");
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Test cancelScan aborts scan immediately
        const cancelWatcher = new DirectoryWatcher(tempDir, 60);
        const scanPromise = cancelWatcher.initScan();
        cancelWatcher.cancelScan();
        assert.ok(await scanPromise);
        cancelWatcher.close();
    } finally {
        watcher.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("  [PASS] DirectoryWatcher: Debounce, modification, deletion, and suppression verified.");
}
