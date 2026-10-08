import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../src/core/SyncEngine.js";
import { runHeadlessCli, startSyncCli } from "../src/cli/index.js";
import { SyncClient } from "../src/client.js";
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
    const hostProgressEvents: SyncFileProgressEvent[] = [];
    const hostServedEvents: any[] = [];
    let hostIdleCount = 0;

    hostEngine.on("engine:ready", (e: SyncEngineReadyEvent) => {
        hostReadyEvent = e;
    });

    hostEngine.on("sync:file-complete", (e: SyncFileCompleteEvent) => {
        hostCompletedFiles.push(e.file);
    });

    hostEngine.on("sync:file-progress", (e: SyncFileProgressEvent) => {
        hostProgressEvents.push(e);
    });

    hostEngine.on("sync:file-served", (e: any) => {
        hostServedEvents.push(e);
    });

    hostEngine.on("sync:idle", () => {
        hostIdleCount++;
    });

    try {
        await hostEngine.start();

        // Verify host initialization
        assert.ok(hostReadyEvent, "Host should emit engine:ready");
        assert.equal((hostReadyEvent as SyncEngineReadyEvent).role, "host");
        assert.ok((hostReadyEvent as SyncEngineReadyEvent).localUrl?.startsWith("http://localhost:"));

        await hostEngine.waitForInitialScan();
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

            // Test streaming transfer of a multi-chunk file
            progressEvents.length = 0;
            clientCompleted.length = 0;
            hostProgressEvents.length = 0;
            hostServedEvents.length = 0;
            const largeData = Buffer.alloc(256 * 1024, "f");
            fs.writeFileSync(path.join(hostDir, "stream-large.bin"), largeData);

            await new Promise((r) => setTimeout(r, 600));
            assert.ok(fs.existsSync(path.join(clientDir, "stream-large.bin")), "stream-large.bin should sync to client");
            assert.equal(fs.readFileSync(path.join(clientDir, "stream-large.bin")).length, largeData.length);
            assert.ok(clientCompleted.some((c) => c.file === "stream-large.bin"), "stream-large.bin should emit completion");
            assert.ok(hostProgressEvents.some((c) => c.file === "stream-large.bin"), "host should emit sync:file-progress for sent data");
            assert.ok(hostServedEvents.some((c) => c.file === "stream-large.bin"), "host should emit sync:file-served when send completes");
            const lastHostProgress = hostProgressEvents.filter((c) => c.file === "stream-large.bin").pop();
            assert.equal(lastHostProgress?.percent, 100);
            assert.equal(lastHostProgress?.transferred, largeData.length);
            assert.equal(hostEngine.getState().activeTransfers.length, 0, "No active transfers should linger after transfer completes");
            // Verify no leftover .tmp files
            const clientFiles = fs.readdirSync(clientDir);
            assert.ok(!clientFiles.some((f) => f.includes(".tmp.")), "No temporary files should remain");
        } finally {
            await clientEngine.stop();
        }

        // Test cancelTransfers on host
        let cancelEmitted = false;
        hostEngine.once("sync:cancelled", () => { cancelEmitted = true; });
        hostEngine.cancelTransfers();
        assert.ok(cancelEmitted, "Should emit sync:cancelled");
        assert.equal(hostEngine.getState().status, "idle");
        assert.equal(hostEngine.getState().activeTransfers.length, 0);

        // Test status restoration on failed manifest request
        const reconnectEngine = new SyncEngine({ role: "client", serverUrl: hostUrl, syncDir: clientDir, token });
        await reconnectEngine.start();
        assert.equal(reconnectEngine.getState().status, "idle");

        const origHttpRequest = (reconnectEngine as any).httpRequest;
        (reconnectEngine as any).httpRequest = async () => { throw new Error("Network glitch"); };
        await reconnectEngine.syncManifest();
        assert.equal(reconnectEngine.getState().status, "idle", "Should restore status to idle after failed manifest sync");

        (reconnectEngine as any).httpRequest = origHttpRequest;
        await reconnectEngine.syncManifest();
        assert.equal(reconnectEngine.getState().status, "idle", "Should return to idle after successful sync");
        await reconnectEngine.stop();

        // Test that client without token rejects on start
        const unauthEngine = new SyncEngine({ role: "client", serverUrl: hostUrl, syncDir: clientDir });
        await assert.rejects(() => unauthEngine.start(), { message: /Authentication failed/ });
        assert.equal(unauthEngine.getState().status, "stopped");
        assert.equal((unauthEngine as any).isRunning, false);

        // Test that sibling downloads cancel after auth failure with exactly one fatal error during concurrent downloads
        const abortedSiblings = new Set<string>();
        const pendingTimers: NodeJS.Timeout[] = [];
        const mockServer = http.createServer((req, res) => {
            const reqUrl = req.url ?? "";
            if (reqUrl === "/api/manifest") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    files: {
                        "f1.txt": { name: "f1.txt", size: 10, mtime: 1000, sha256: "fakehash1" },
                        "f2.txt": { name: "f2.txt", size: 10, mtime: 1000, sha256: "fakehash2" },
                        "f3.txt": { name: "f3.txt", size: 10, mtime: 1000, sha256: "fakehash3" },
                        "f4.txt": { name: "f4.txt", size: 10, mtime: 1000, sha256: "fakehash4" }
                    }
                }));
                return;
            }

            if (reqUrl === "/api/download/f1.txt") {
                const t = setTimeout(() => {
                    if (!res.writableEnded) {
                        res.writeHead(401, { "Content-Type": "text/plain" });
                        res.end("Unauthorized");
                    }
                }, 50);
                pendingTimers.push(t);
                return;
            }

            const siblingMatch = reqUrl.match(/^\/api\/download\/(f[2-4]\.txt)$/);
            if (siblingMatch) {
                const siblingName = siblingMatch[1];
                res.on("close", () => {
                    if (!res.writableEnded) {
                        abortedSiblings.add(siblingName);
                    }
                });
                const t = setTimeout(() => {
                    if (!res.writableEnded) {
                        res.writeHead(200, { "Content-Type": "application/octet-stream" });
                        res.end("1234567890");
                    }
                }, 500);
                pendingTimers.push(t);
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
        const mockPort = (mockServer.address() as any).port;
        const mockUrl = `http://127.0.0.1:${mockPort}`;

        const batchClientDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-batch-client-"));
        try {
            let clientErrorCount = 0;
            const testClient = new SyncClient({
                serverUrl: mockUrl,
                targetDir: batchClientDir,
                verbose: false,
                onError: () => { clientErrorCount++; }
            });

            await assert.rejects(
                () => testClient.start(),
                { message: /Authentication failed downloading f1\.txt: HTTP 401/ }
            );
            assert.equal(clientErrorCount, 1, "Should emit exactly one fatal onError callback on auth failure");
            assert.equal((testClient as any).isRunning, false);
            // Wait beyond the 500ms delayed sibling response timer to ensure all in-flight siblings settle
            await new Promise((r) => setTimeout(r, 650));
            assert.equal(abortedSiblings.size, 3, "All 3 sibling downloads (f2, f3, f4) should be aborted via signal");
            assert.ok(abortedSiblings.has("f2.txt"), "f2.txt download should be cancelled");
            assert.ok(abortedSiblings.has("f3.txt"), "f3.txt download should be cancelled");
            assert.ok(abortedSiblings.has("f4.txt"), "f4.txt download should be cancelled");

            const listFilesRecursively = (dir: string): string[] => {
                if (!fs.existsSync(dir)) return [];
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                let files: string[] = [];
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        files = files.concat(listFilesRecursively(fullPath));
                    } else {
                        files.push(entry.name);
                    }
                }
                return files;
            };
            const writtenFiles = listFilesRecursively(batchClientDir);
            assert.equal(writtenFiles.length, 0, `No files or temporary artifacts should be written, found: ${writtenFiles.join(", ")}`);
        } finally {
            for (const t of pendingTimers) clearTimeout(t);
            await new Promise<void>((resolve) => mockServer.close(() => resolve()));
            fs.rmSync(batchClientDir, { recursive: true, force: true });
        }

        // Test engine startup failure resets state and startSyncCli handles failure
        const failingEngine = new SyncEngine({ role: "client", serverUrl: "http://127.0.0.1:1", syncDir: clientDir, once: true });
        await assert.rejects(() => failingEngine.start());
        assert.equal(failingEngine.getState().status, "stopped");
        assert.equal((failingEngine as any).isRunning, false);

        // Test TUI interactive startup fallback with injected TTY:
        // Force the interactive path, make first engine.start reject after TUI wiring,
        // and verify destroyTui cleans up listeners/signals/screen before headless startup succeeds.
        const ttyEngine = new SyncEngine({ role: "client", serverUrl: "http://127.0.0.1:9999", syncDir: clientDir, once: true });
        const origStdinIsTTY = process.stdin.isTTY;
        const origStdoutIsTTY = process.stdout.isTTY;
        process.stdin.isTTY = true;
        process.stdout.isTTY = true;

        let ttyStartAttempts = 0;
        let listenersWiredInTui = 0;
        ttyEngine.start = async () => {
            ttyStartAttempts++;
            if (ttyStartAttempts === 1) {
                listenersWiredInTui = ttyEngine.listenerCount("scan:discovered");
                throw new Error("Simulated TUI startup failure");
            }
            (ttyEngine as any).isRunning = true;
            (ttyEngine as any).status = "idle";
            return Promise.resolve();
        };

        const sigintHandlersBefore = process.listeners("SIGINT");
        const sigtermHandlersBefore = process.listeners("SIGTERM");

        try {
            await startSyncCli(ttyEngine, { execMode: "tui", hasExplicitDir: true, quiet: true });
            assert.equal(ttyStartAttempts, 2, "Should attempt TUI start first, then headless start on fallback");
            assert.ok(listenersWiredInTui > 0, "TUI listeners must have been wired before startup failure");
            assert.equal(ttyEngine.listenerCount("scan:discovered"), 0, "TUI scan:discovered listener should be removed on fallback");
            assert.equal(ttyEngine.listenerCount("scan:complete"), 0, "TUI scan:complete listener should be removed on fallback");
            assert.equal(ttyEngine.listenerCount("engine:pause"), 0, "TUI engine:pause listener should be removed on fallback");
            assert.equal(ttyEngine.listenerCount("engine:resume"), 0, "TUI engine:resume listener should be removed on fallback");
            assert.equal(ttyEngine.listenerCount("sync:cancelled"), 0, "TUI sync:cancelled listener should be removed on fallback");
            // Only the headless signal handler should be added (TUI signal handler cleaned up)
            assert.equal(process.listenerCount("SIGINT"), sigintHandlersBefore.length + 1, "TUI SIGINT handler should be removed on fallback");
            assert.equal(process.listenerCount("SIGTERM"), sigtermHandlersBefore.length + 1, "TUI SIGTERM handler should be removed on fallback");

            // Verify headless startup proceeds and later engine events do not touch destroyed TUI
            ttyEngine.emit("engine:ready", { role: "client", syncDir: clientDir, filesCount: 0, endpoints: [] });
            ttyEngine.emit("sync:start", { count: 0, files: [] });
            ttyEngine.emit("sync:idle");
            ttyEngine.emit("sync:error", { error: new Error("recoverable non-fatal"), context: "test" });
        } finally {
            process.stdin.isTTY = origStdinIsTTY;
            process.stdout.isTTY = origStdoutIsTTY;
            // Clean up any extra signal handlers added during headless startup
            for (const h of process.listeners("SIGINT")) {
                if (!sigintHandlersBefore.includes(h)) process.removeListener("SIGINT", h as any);
            }
            for (const h of process.listeners("SIGTERM")) {
                if (!sigtermHandlersBefore.includes(h)) process.removeListener("SIGTERM", h as any);
            }
            await ttyEngine.stop();
        }
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
