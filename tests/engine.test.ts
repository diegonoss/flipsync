import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/core/SyncEngine.js";
import { runHeadlessCli } from "../src/cli/index.js";
import type {
    SyncEngineReadyEvent,
    SyncStartEvent,
    SyncFileProgressEvent,
    SyncFileCompleteEvent,
    SyncConflictEvent
} from "../src/core/SyncEngine.js";

export async function testSyncEngine(): Promise<void> {
    console.log("  [TEST] SyncEngine: Decoupled Architecture, Events & Lifecycle");

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-engine-host-"));
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-engine-client-"));
    const token = "test-token-engine-999";

    // 1. Pre-populate host files
    fs.writeFileSync(path.join(hostDir, "doc.txt"), "hello documentation");
    fs.mkdirSync(path.join(hostDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(hostDir, "assets/logo.svg"), "<svg>logo</svg>");

    const hostEngine = new SyncEngine({
        role: "host",
        dir: hostDir,
        port: 0,
        host: "127.0.0.1",
        token,
        debounceMs: 50
    });

    let hostReadyEvent: SyncEngineReadyEvent | null = null;
    let hostCompletedFiles: string[] = [];
    let hostIdleCount = 0;

    hostEngine.on("engine:ready", (e: SyncEngineReadyEvent) => {
        hostReadyEvent = e;
    });

    hostEngine.on("sync:file-complete", (e: SyncFileCompleteEvent) => {
        hostCompletedFiles.push(e.file);
    });

    hostEngine.on("sync:idle", () => {
        hostIdleCount++;
    });

    try {
        await hostEngine.start();

        // Verify host initialization
        assert.ok(hostReadyEvent, "Host should emit engine:ready");
        assert.equal((hostReadyEvent as SyncEngineReadyEvent).role, "host");
        assert.equal((hostReadyEvent as SyncEngineReadyEvent).filesCount, 2);
        assert.ok((hostReadyEvent as SyncEngineReadyEvent).localUrl?.startsWith("http://localhost:"));
        assert.ok(hostIdleCount >= 1, "Host should emit sync:idle after ready");

        const hostState = hostEngine.getState();
        assert.equal(hostState.status, "idle");
        assert.equal(hostState.isPaused, false);
        assert.equal(hostState.stats.totalFiles, 2);

        // 2. Test Pause & Resume
        hostEngine.pause();
        assert.equal(hostEngine.isPaused(), true);
        assert.equal(hostEngine.getState().isPaused, true);
        assert.equal(hostEngine.getState().status, "paused");

        // Write file while paused -> should be queued
        fs.writeFileSync(path.join(hostDir, "paused-note.txt"), "queued while paused");
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(!hostCompletedFiles.includes("paused-note.txt"), "Should not process while paused");

        // Resume -> queue drains
        hostEngine.resume();
        assert.equal(hostEngine.isPaused(), false);
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(hostCompletedFiles.includes("paused-note.txt"), "Queued item should process after resume");

        // 3. Test forceRehash
        hostCompletedFiles = [];
        let rehashStartEmitted = false;
        hostEngine.once("sync:start", () => {
            rehashStartEmitted = true;
        });
        await hostEngine.forceRehash();
        assert.ok(rehashStartEmitted, "forceRehash should emit sync:start");
        assert.ok(hostCompletedFiles.length >= 3, "forceRehash should emit sync:file-complete for all files");

        // 3b. Test setSyncDir (dynamic directory switching)
        const altHostDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-alt-host-"));
        fs.writeFileSync(path.join(altHostDir, "alt.txt"), "alternative folder content");
        try {
            await hostEngine.setSyncDir(altHostDir);
            assert.equal(hostEngine.getSyncDir(), altHostDir);
            assert.equal(hostEngine.getState().syncDir, altHostDir);
            assert.equal(hostEngine.getState().stats.totalFiles, 1);
            // Switch back to original hostDir
            await hostEngine.setSyncDir(hostDir);
            assert.equal(hostEngine.getSyncDir(), hostDir);
        } finally {
            fs.rmSync(altHostDir, { recursive: true, force: true });
        }

        // 4. Test Client Engine & Conflict Detection
        const hostUrl = (hostReadyEvent as unknown as SyncEngineReadyEvent).localUrl!;

        // Pre-create a conflicting local file on the client with different content
        fs.writeFileSync(path.join(clientDir, "doc.txt"), "locally modified client version");

        const clientEngine = new SyncEngine({
            role: "client",
            serverUrl: hostUrl,
            dir: clientDir,
            token
        });

        let clientReady: SyncEngineReadyEvent | null = null;
        let clientStart: SyncStartEvent | null = null;
        const progressEvents: SyncFileProgressEvent[] = [];
        const clientCompleted: SyncFileCompleteEvent[] = [];
        const conflictEvents: SyncConflictEvent[] = [];

        clientEngine.on("engine:ready", (e: SyncEngineReadyEvent) => {
            clientReady = e;
        });

        clientEngine.on("sync:start", (e: SyncStartEvent) => {
            clientStart = e;
        });

        clientEngine.on("sync:file-progress", (e: SyncFileProgressEvent) => {
            progressEvents.push(e);
        });

        clientEngine.on("sync:file-complete", (e: SyncFileCompleteEvent) => {
            clientCompleted.push(e);
        });

        clientEngine.on("sync:conflict", (e: SyncConflictEvent) => {
            conflictEvents.push(e);
        });

        try {
            await clientEngine.start();

            assert.ok(clientReady, "Client should emit engine:ready");
            assert.equal((clientReady as SyncEngineReadyEvent).role, "client");
            assert.ok(clientStart, "Client should emit sync:start");

            // Verify progress events structure
            assert.ok(progressEvents.length > 0, "Should emit sync:file-progress events");
            const sampleProgress = progressEvents[0];
            assert.ok(sampleProgress.file, "Progress event must have file");
            assert.equal(typeof sampleProgress.transferred, "number");
            assert.equal(typeof sampleProgress.total, "number");
            assert.equal(typeof sampleProgress.percent, "number");

            // Verify completion events
            assert.ok(clientCompleted.some((c) => c.file === "doc.txt"), "doc.txt should complete sync");
            assert.ok(clientCompleted.some((c) => c.file === "assets/logo.svg"), "logo.svg should complete sync");

            // Verify client downloaded and wrote files
            assert.equal(fs.readFileSync(path.join(clientDir, "assets/logo.svg"), "utf8"), "<svg>logo</svg>");
            assert.equal(fs.readFileSync(path.join(clientDir, "doc.txt"), "utf8"), "hello documentation");

            // Test live sync from host to client
            progressEvents.length = 0;
            clientCompleted.length = 0;
            fs.writeFileSync(path.join(hostDir, "live.txt"), "live sync test");

            await new Promise((r) => setTimeout(r, 400));
            assert.ok(fs.existsSync(path.join(clientDir, "live.txt")), "live.txt should sync to client");
            assert.equal(fs.readFileSync(path.join(clientDir, "live.txt"), "utf8"), "live sync test");

            // Test conflict detection on subsequent update:
            // Modify client's live.txt locally first, then modify host's live.txt
            fs.writeFileSync(path.join(clientDir, "live.txt"), "client conflicting edits");
            // Also trigger host change
            fs.writeFileSync(path.join(hostDir, "live.txt"), "host new version");

            await new Promise((r) => setTimeout(r, 400));
            assert.ok(conflictEvents.length > 0, "Conflict event should be emitted when local version differs");
            assert.equal(conflictEvents[0].file, "live.txt");
            assert.ok(conflictEvents[0].localVersion, "Conflict should include localVersion");
            assert.ok(conflictEvents[0].remoteVersion, "Conflict should include remoteVersion");
        } finally {
            await clientEngine.stop();
        }

        // Test that client without token rejects on start
        const unauthEngine = new SyncEngine({ role: "client", serverUrl: hostUrl, syncDir: clientDir });
        await assert.rejects(() => unauthEngine.start(), { message: /Authentication failed/ });
        assert.equal(unauthEngine.getState().status, "stopped");
        assert.equal((unauthEngine as any).isRunning, false);
    } finally {
        await hostEngine.stop();
        fs.rmSync(hostDir, { recursive: true, force: true });
        fs.rmSync(clientDir, { recursive: true, force: true });
    }

    console.log("  [PASS] SyncEngine: Events, lifecycle, state, pause/resume, and conflict handling verified.");
}

export async function testHeadlessCli(): Promise<void> {
    console.log("  [TEST] Headless CLI Adapter: Formatting & Clean Signal Shutdown");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-headless-"));
    fs.writeFileSync(path.join(tempDir, "sample.txt"), "test content");

    const engine = new SyncEngine({
        role: "host",
        dir: tempDir,
        port: 0,
        host: "127.0.0.1",
        noToken: true
    });

    const capturedStdout: string[] = [];
    const capturedStderr: string[] = [];

    const origStdoutWrite = process.stdout.write;
    const origStderrWrite = process.stderr.write;

    process.stdout.write = (chunk: string | Uint8Array) => {
        capturedStdout.push(chunk.toString());
        return true;
    };

    process.stderr.write = (chunk: string | Uint8Array) => {
        capturedStderr.push(chunk.toString());
        return true;
    };

    let controller;
    try {
        controller = await runHeadlessCli(engine, { format: "json" });
        await engine.start();

        // Verify JSON structured output was generated
        const fullOutput = capturedStdout.join("");
        const lines = fullOutput.trim().split("\n").filter(Boolean);
        assert.ok(lines.length >= 1, "Should output structured JSON lines");

        const readyLine = lines.find((l) => {
            try {
                return JSON.parse(l).event === "engine:ready";
            } catch {
                return false;
            }
        });
        assert.ok(readyLine, "Should output engine:ready JSON event");
        const parsed = JSON.parse(readyLine);
        assert.equal(parsed.event, "engine:ready");
        assert.equal(parsed.role, "host");
    } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
        if (controller) {
            await controller.stop();
        } else {
            await engine.stop();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("  [PASS] Headless CLI Adapter: Structured streams and controller shutdown verified.");
}
