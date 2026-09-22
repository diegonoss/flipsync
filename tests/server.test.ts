import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncServer } from "../src/server.js";

export async function testServer(): Promise<void> {
    console.log("  [TEST] SyncServer: Endpoints, Auth & Security Guardrails");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-server-"));
    fs.writeFileSync(path.join(tempDir, "test.txt"), "hello flipsync server");
    fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "sub/deep.txt"), "deep contents");

    const token = "secret-token-xyz-123";

    const server = new SyncServer({
        port: 0,
        host: "127.0.0.1",
        syncDir: tempDir,
        token,
        verbose: false
    });

    const { localUrl } = await server.start();

    try {
        // 1. Unauthenticated request -> 401
        const unauthRes = await fetch(`${localUrl}/api/manifest`);
        assert.equal(unauthRes.status, 401);

        // 2. Invalid Bearer token -> 401
        const badTokenRes = await fetch(`${localUrl}/api/manifest`, {
            headers: { Authorization: "Bearer wrong-token" }
        });
        assert.equal(badTokenRes.status, 401);

        // 3. Valid Bearer token -> 200
        const authRes = await fetch(`${localUrl}/api/manifest`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(authRes.status, 200);
        const manifest = (await authRes.json()) as { files: Record<string, { size: number }> };
        assert.ok(manifest.files["test.txt"]);
        assert.ok(manifest.files["sub/deep.txt"]);

        // 4. Valid query token -> 200
        const queryRes = await fetch(`${localUrl}/api/manifest?token=${token}`);
        assert.equal(queryRes.status, 200);

        // 5. Status endpoint
        const statusRes = await fetch(`${localUrl}/api/status?token=${token}`);
        assert.equal(statusRes.status, 200);
        const statusData = (await statusRes.json()) as { app: string; status: string; filesCount: number };
        assert.equal(statusData.app, "flipsync");
        assert.equal(statusData.status, "ok");
        assert.equal(statusData.filesCount, 2);

        // 6. Download file
        const dlRes = await fetch(`${localUrl}/api/download/test.txt?token=${token}`);
        assert.equal(dlRes.status, 200);
        const dlText = await dlRes.text();
        assert.equal(dlText, "hello flipsync server");

        // 7. Download nested file
        const dlNestedRes = await fetch(`${localUrl}/api/download/sub%2Fdeep.txt?token=${token}`);
        assert.equal(dlNestedRes.status, 200);
        const dlNestedText = await dlNestedRes.text();
        assert.equal(dlNestedText, "deep contents");

        // 8. Path traversal attempt: ../ -> 400
        const traversalRes1 = await fetch(`${localUrl}/api/download/..%2Fpackage.json?token=${token}`);
        assert.equal(traversalRes1.status, 400);

        // 9. Path traversal attempt: absolute path -> 400
        const traversalRes2 = await fetch(`${localUrl}/api/download/%2Fetc%2Fpasswd?token=${token}`);
        assert.equal(traversalRes2.status, 400);

        // 10. Nonexistent file -> 404
        let fileServedEvent: any = null;
        server.on("file_served", (evt) => {
            fileServedEvent = evt;
        });

        const dlRes2 = await fetch(`${localUrl}/api/download/test.txt?token=${token}`);
        assert.equal(dlRes2.status, 200);
        await dlRes2.text();
        assert.ok(fileServedEvent);
        assert.equal(fileServedEvent.file, "test.txt");
        assert.ok(fileServedEvent.size > 0);

        const notFoundRes = await fetch(`${localUrl}/api/download/missing.txt?token=${token}`);
        assert.equal(notFoundRes.status, 404);

        // 11. Helper script endpoints (serve public client scripts)
        const ps1Res = await fetch(`${localUrl}/client.ps1`);
        assert.equal(ps1Res.status, 200);
        const ps1Text = await ps1Res.text();
        assert.ok(ps1Text.includes("FlipSync"));

        const shRes = await fetch(`${localUrl}/client.sh`);
        assert.equal(shRes.status, 200);
        const shText = await shRes.text();
        assert.ok(shText.includes("FlipSync"));

        const jsRes = await fetch(`${localUrl}/client.js`);
        assert.equal(jsRes.status, 200);
        const jsText = await jsRes.text();
        assert.ok(jsText.includes("FlipSync"));

        // 12. Bundled CLI script serving from external working directory
        const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-external-dir-"));
        const hostBin = path.resolve("dist/bin/flipsync-host.js");
        if (fs.existsSync(hostBin)) {
            const externalPort = 8991;
            const hostChild = spawn(process.execPath, [
                hostBin,
                "--dir", externalDir,
                "--port", String(externalPort),
                "--headless",
                "--no-token"
            ], { cwd: externalDir });

            try {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("Timeout waiting for external host")), 6000);
                    hostChild.stdout.on("data", (d: Buffer) => {
                        if (d.toString().includes("[READY]")) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                    hostChild.on("error", (err) => {
                        clearTimeout(timer);
                        reject(err);
                    });
                });

                const extPs1 = await fetch(`http://127.0.0.1:${externalPort}/client.ps1`);
                assert.equal(extPs1.status, 200);
                assert.ok((await extPs1.text()).includes("FlipSync"));

                const extSh = await fetch(`http://127.0.0.1:${externalPort}/client.sh`);
                assert.equal(extSh.status, 200);
                assert.ok((await extSh.text()).includes("FlipSync"));
            } finally {
                hostChild.kill();
                fs.rmSync(externalDir, { recursive: true, force: true });
            }
        }
    } finally {
        await server.stop();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("  [PASS] SyncServer: Token auth, endpoints, scripts, and path traversal protection verified.");
}
