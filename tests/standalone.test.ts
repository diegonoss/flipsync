import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { SyncServer } from "../src/server.js";

export async function testStandaloneClients(): Promise<void> {
    console.log("  [TEST] Standalone Script Clients (JS & Bash)");

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-standalone-host-"));
    const clientDirJs = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-standalone-client-js-"));
    const clientDirBash = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-standalone-client-bash-"));
    const token = "standalone-token-789";

    fs.writeFileSync(path.join(hostDir, "data.json"), JSON.stringify({ message: "hello standalone" }));

    const server = new SyncServer({
        port: 0,
        host: "127.0.0.1",
        syncDir: hostDir,
        token,
        verbose: false
    });

    const { localUrl } = await server.start();

    try {
        // 1. Standalone sync-client.js
        const jsScript = path.resolve("scripts/sync-client.js");
        await new Promise<void>((resolve, reject) => {
            exec(
                `node "${jsScript}" --server "${localUrl}" --token "${token}" --target "${clientDirJs}" --once`,
                (err, stdout, stderr) => {
                    if (err) {
                        reject(new Error(`JS Client failed: ${err.message}\n${stdout}\n${stderr}`));
                    } else {
                        resolve();
                    }
                }
            );
        });

        assert.ok(fs.existsSync(path.join(clientDirJs, "data.json")));
        const jsData = JSON.parse(fs.readFileSync(path.join(clientDirJs, "data.json"), "utf8"));
        assert.equal(jsData.message, "hello standalone");

        // 2. Standalone sync-client.sh (if bash is available)
        if (process.platform !== "win32") {
            const shScript = path.resolve("scripts/sync-client.sh");
            await new Promise<void>((resolve, reject) => {
                exec(
                    `bash "${shScript}" --server "${localUrl}" --token "${token}" --target "${clientDirBash}" --once`,
                    (err, stdout, stderr) => {
                        if (err) {
                            reject(new Error(`Bash Client failed: ${err.message}\n${stdout}\n${stderr}`));
                        } else {
                            resolve();
                        }
                    }
                );
            });

            assert.ok(fs.existsSync(path.join(clientDirBash, "data.json")));
            const bashData = JSON.parse(fs.readFileSync(path.join(clientDirBash, "data.json"), "utf8"));
            assert.equal(bashData.message, "hello standalone");
        }
        // 3. Verify standalone clients terminate immediately on 401 when token is missing
        const expectAuthFailure = (cmd: string) =>
            new Promise<void>((resolve, reject) => {
                exec(cmd, (err, _stdout, stderr) => {
                    if (err && err.code !== 0) {
                        assert.match(stderr, /Authentication failed/);
                        resolve();
                    } else reject(new Error(`Expected "${cmd}" to fail with auth error`));
                });
            });

        await expectAuthFailure(`node "${jsScript}" --server "${localUrl}" --target "${clientDirJs}"`);
        if (process.platform !== "win32") {
            await expectAuthFailure(`bash "${path.resolve("scripts/sync-client.sh")}" --server "${localUrl}" --target "${clientDirBash}"`);
        }
    } finally {
        await server.stop();
        fs.rmSync(hostDir, { recursive: true, force: true });
        fs.rmSync(clientDirJs, { recursive: true, force: true });
        fs.rmSync(clientDirBash, { recursive: true, force: true });
    }

    console.log("  [PASS] Standalone Script Clients: Verified zero-dependency JS and Bash clients.");
}
