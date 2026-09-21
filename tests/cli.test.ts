import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function testCliExecution(): Promise<void> {
    console.log("  [TEST] Dual-Mode CLI Execution: Headless Daemon & One-Shot Sync");

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-cli-test-host-"));
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-cli-test-client-"));
    const port = 8923;

    fs.writeFileSync(path.join(hostDir, "data.txt"), "hello from cli host");

    const binPath = path.resolve("dist/bin/flipsync.js");

    // 1. Launch host in headless mode
    const hostProc = spawn(process.execPath, [
        binPath,
        "host",
        "--dir", hostDir,
        "--port", String(port),
        "--headless",
        "--no-token"
    ]);

    let hostReady = false;
    let hostOutput = "";

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error("Timed out waiting for host CLI to start:\n" + hostOutput));
        }, 8000);

        hostProc.stdout.on("data", (chunk: Buffer) => {
            const str = chunk.toString();
            hostOutput += str;
            if (str.includes("[READY]") || str.includes("engine:ready")) {
                hostReady = true;
                clearTimeout(timer);
                resolve();
            }
        });

        hostProc.stderr.on("data", (chunk: Buffer) => {
            hostOutput += chunk.toString();
        });

        hostProc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        hostProc.on("exit", (code) => {
            if (!hostReady) {
                clearTimeout(timer);
                reject(new Error(`Host exited prematurely with code ${code}. Output: ${hostOutput}`));
            }
        });
    });

    assert.ok(hostReady, "Host should be ready in headless mode");

    // 2. Run client in headless mode with --once
    const clientProc = spawn(process.execPath, [
        binPath,
        "client",
        "--server", `http://127.0.0.1:${port}`,
        "--target", clientDir,
        "--headless",
        "--once"
    ]);

    let clientOutput = "";
    const clientExitCode = await new Promise<number>((resolve, reject) => {
        clientProc.stdout.on("data", (chunk) => {
            clientOutput += chunk.toString();
        });
        clientProc.stderr.on("data", (chunk) => {
            clientOutput += chunk.toString();
        });
        clientProc.on("exit", (code) => resolve(code ?? 0));
        clientProc.on("error", reject);
    });

    assert.equal(clientExitCode, 0, `Client should exit 0 with --once. Output: ${clientOutput}`);
    assert.ok(fs.existsSync(path.join(clientDir, "data.txt")));
    assert.equal(fs.readFileSync(path.join(clientDir, "data.txt"), "utf8"), "hello from cli host");

    // 3. Graceful shutdown of host via SIGINT
    const hostExitPromise = new Promise<number>((resolve) => {
        hostProc.on("exit", (code) => resolve(code ?? 0));
    });

    hostProc.kill("SIGINT");
    const hostExitCode = await hostExitPromise;
    assert.equal(hostExitCode, 0, "Host should exit 0 on SIGINT");

    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(clientDir, { recursive: true, force: true });

    console.log("  [PASS] Dual-Mode CLI Execution: Headless host, client one-shot, and SIGINT shutdown verified.");
}
