import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncServer } from "../src/server.js";
import { SyncClient } from "../src/client.js";

export async function testEndToEnd(): Promise<void> {
    console.log("  [TEST] End-to-End Live Sync: Host -> SSE Stream -> Client Atomic Sync");

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-e2e-host-"));
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-e2e-client-"));
    const token = "e2e-token-live-456";

    // 1. Pre-populate host directory
    fs.writeFileSync(path.join(hostDir, "initial.txt"), "version 1");
    fs.mkdirSync(path.join(hostDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(hostDir, "nested/config.json"), '{"v":1}');
    fs.writeFileSync(path.join(hostDir, "La_ecuación_de_Samuel.mp3"), "audio track");
    fs.mkdirSync(path.join(hostDir, "Parking.in.Tight.Spaces.v1.49/StreamingAssets/APVStreamingAssets"), { recursive: true });
    fs.writeFileSync(path.join(hostDir, "Parking.in.Tight.Spaces.v1.49/StreamingAssets/APVStreamingAssets/data.bytes"), "game asset");

    const server = new SyncServer({
        port: 0,
        host: "127.0.0.1",
        syncDir: hostDir,
        token,
        verbose: false
    });

    const { localUrl } = await server.start();
    await server.getWatcher().initScan();
    const syncedFiles: string[] = [];
    const deletedFiles: string[] = [];

    const client = new SyncClient({
        serverUrl: localUrl,
        token,
        targetDir: clientDir,
        verbose: false,
        onSync: (f) => syncedFiles.push(f.name),
        onDelete: (f) => deletedFiles.push(f)
    });

    try {
        await client.start();

        // 2. Verify initial handshake sync
        assert.ok(fs.existsSync(path.join(clientDir, "initial.txt")));
        assert.equal(fs.readFileSync(path.join(clientDir, "initial.txt"), "utf8"), "version 1");
        assert.ok(fs.existsSync(path.join(clientDir, "nested/config.json")));
        assert.equal(fs.readFileSync(path.join(clientDir, "nested/config.json"), "utf8"), '{"v":1}');
        assert.ok(fs.existsSync(path.join(clientDir, "La_ecuación_de_Samuel.mp3")));
        assert.equal(fs.readFileSync(path.join(clientDir, "La_ecuación_de_Samuel.mp3"), "utf8"), "audio track");
        assert.ok(fs.existsSync(path.join(clientDir, "Parking.in.Tight.Spaces.v1.49/StreamingAssets/APVStreamingAssets/data.bytes")));
        assert.equal(syncedFiles.length, 4);

        // 3. Simulate host modifying a file
        syncedFiles.length = 0;
        fs.writeFileSync(path.join(hostDir, "initial.txt"), "version 2 modified");

        const waitUntil = async (fn: () => boolean, timeout = 2500) => {
            const start = Date.now();
            while (!fn() && Date.now() - start < timeout) await new Promise((r) => setTimeout(r, 50));
            assert.ok(fn(), "Condition timed out");
        };

        await waitUntil(() => fs.existsSync(path.join(clientDir, "initial.txt")) && fs.readFileSync(path.join(clientDir, "initial.txt"), "utf8") === "version 2 modified");
        assert.equal(syncedFiles.length, 1);
        assert.equal(syncedFiles[0], "initial.txt");

        // 4. Simulate host creating a new nested file
        syncedFiles.length = 0;
        fs.writeFileSync(path.join(hostDir, "nested/newfile.txt"), "brand new nested file");

        await waitUntil(() => fs.existsSync(path.join(clientDir, "nested/newfile.txt")) && fs.readFileSync(path.join(clientDir, "nested/newfile.txt"), "utf8") === "brand new nested file");
        assert.equal(syncedFiles.length, 1);

        // 5. Simulate host deleting a file
        fs.unlinkSync(path.join(hostDir, "nested/newfile.txt"));

        await waitUntil(() => !fs.existsSync(path.join(clientDir, "nested/newfile.txt")));
        assert.ok(deletedFiles.includes("nested/newfile.txt"));

        // 6. Verify client without token rejects with authentication error
        const unauthClient = new SyncClient({ serverUrl: localUrl, targetDir: clientDir, verbose: false });
        await assert.rejects(() => unauthClient.start(), { message: /Authentication failed/ });

        // 7. Verify SyncClient terminates when retry limit is exceeded
        let reconnectLimitError: any = null;
        const reconnectClient = new SyncClient({
            serverUrl: localUrl,
            targetDir: clientDir,
            token,
            verbose: false,
            onError: (err) => { reconnectLimitError = err; }
        });
        (reconnectClient as any).isRunning = true;
        await (reconnectClient as any).connectSse(35000);
        assert.match(reconnectLimitError?.message || "", /retry timer .* exceeded limit/);
        assert.equal((reconnectClient as any).isRunning, false);

        // 8. Verify SyncClient rejects path traversal in downloadIfChanged
        await assert.rejects(
            () => client.downloadIfChanged({ name: "../escaped.txt", sha256: "dummy", size: 0, mtimeMs: 0 }),
            { message: /Path traversal blocked/ }
        );
    } finally {
        client.stop();
        await server.stop();
        fs.rmSync(hostDir, { recursive: true, force: true });
        fs.rmSync(clientDir, { recursive: true, force: true });
    }

    console.log("  [PASS] End-to-End Live Sync: Initial sync, live modification, addition, and deletion verified.");
}
