import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { SyncServer } from "../src/server.js";
// @ts-ignore - standalone script ESM exports
import { formatProgressLine, getProgressBar, sanitizeForTerminal } from "../scripts/sync-client.js";

function runInPty(args: string[], cols = 80, rows = 24): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
        const pyScript = `
import pty, os, struct, fcntl, termios, subprocess, sys, json
cols = int(sys.argv[1])
rows = int(sys.argv[2])
cmd = json.loads(sys.argv[3])
master, slave = pty.openpty()
winsize = struct.pack("HHHH", rows, cols, 0, 0)
fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)
p = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = b""
while True:
    try:
        chunk = os.read(master, 1024)
        if not chunk: break
        out += chunk
    except OSError:
        break
os.close(master)
p.wait()
sys.stdout.buffer.write(out)
sys.exit(p.returncode)
`;
        const proc = spawn("python3", ["-c", pyScript, String(cols), String(rows), JSON.stringify(args)]);
        let stdout = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.on("close", (code) => {
            resolve({ code: code ?? 0, output: stdout });
        });
        proc.on("error", reject);
    });
}

export async function testStandaloneClients(): Promise<void> {
    console.log("  [TEST] Standalone Script Clients (JS & Bash)");

    // 0. Terminal progress formatting, width clamping, and sanitization tests
    assert.equal(sanitizeForTerminal("\x1b[31mhello\x1b[0m\r\n\tworld"), "hello???world");
    assert.equal(getProgressBar(0, 10), "          ");
    assert.equal(getProgressBar(50, 10), "====>     ");
    assert.equal(getProgressBar(100, 10), "==========");

    for (const width of [10, 20, 35, 80]) {
        const line = formatProgressLine("[SYNC]", "test-file.txt", 45, "500 KB", "1.1 MB", "200 KB/s", "3s", width);
        const expectedLimit = Math.max(1, width - 1);
        assert.ok(line.length <= expectedLimit, `Line length ${line.length} exceeds expected limit ${expectedLimit} at width ${width}`);
    }

    if (process.platform !== "win32") {
        const bashTestScript = `
            source scripts/sync-client.sh
            raw=$(printf "hello\\033[31mcolor\\r\\nworld")
            sanitized=$(sanitize_for_terminal "$raw")
            echo "SAN:$sanitized"
            for w in 20 35 80; do
                line=$(format_progress_line "[SYNC]" "file.txt" 50 "50 KB" "100 KB" "10 KB/s" "5s" "$w")
                echo "LEN:$w:\${#line}"
            done
        `;
        const bashHelperOut = await new Promise<string>((resolve, reject) => {
            const proc = spawn("bash", ["-c", bashTestScript]);
            let stdout = "";
            proc.stdout.on("data", (d) => { stdout += d.toString(); });
            proc.on("close", (code) => {
                if (code === 0) resolve(stdout);
                else reject(new Error(`Bash helper test exited with code ${code}: ${stdout}`));
            });
            proc.on("error", reject);
        });
        assert.match(bashHelperOut, /SAN:hellocolor\?\?world/);
        for (const match of bashHelperOut.matchAll(/LEN:(\d+):(\d+)/g)) {
            const width = parseInt(match[1], 10);
            const len = parseInt(match[2], 10);
            const expectedLimit = Math.max(1, width - 1);
            assert.ok(len <= expectedLimit, `Bash line length ${len} exceeds limit ${expectedLimit} for width ${width}`);
        }
    }

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-standalone-host-"));
    const clientDirJs = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-standalone-client-js-"));
    const clientDirBash = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-standalone-client-bash-"));
    const token = "standalone-token-789";

    fs.writeFileSync(path.join(hostDir, "data.json"), JSON.stringify({ message: "hello standalone" }));
    fs.writeFileSync(path.join(hostDir, "La_ecuación_de_Samuel.mp3"), "accent-data");
    fs.mkdirSync(path.join(hostDir, "sub/deep"), { recursive: true });
    fs.writeFileSync(path.join(hostDir, "sub/deep/file.txt"), "nested-data");

    const server = new SyncServer({
        port: 0,
        host: "127.0.0.1",
        syncDir: hostDir,
        token,
        verbose: false
    });

    const { localUrl } = await server.start();
    await server.getWatcher().initScan();

    try {
        // 1. Standalone sync-client.js
        const jsScript = path.resolve("scripts/sync-client.js");
        let jsStdout = "";
        await new Promise<void>((resolve, reject) => {
            exec(
                `node "${jsScript}" --server "${localUrl}" --token "${token}" --target "${clientDirJs}" --once`,
                (err, stdout, stderr) => {
                    if (err) {
                        reject(new Error(`JS Client failed: ${err.message}\n${stdout}\n${stderr}`));
                    } else {
                        jsStdout = stdout;
                        resolve();
                    }
                }
            );
        });

        assert.match(jsStdout, /Received data\.json/);
        assert.match(jsStdout, /\/s/);
        assert.ok(fs.existsSync(path.join(clientDirJs, "data.json")));
        const jsData = JSON.parse(fs.readFileSync(path.join(clientDirJs, "data.json"), "utf8"));
        assert.equal(jsData.message, "hello standalone");
        assert.ok(fs.existsSync(path.join(clientDirJs, "La_ecuación_de_Samuel.mp3")));
        assert.equal(fs.readFileSync(path.join(clientDirJs, "La_ecuación_de_Samuel.mp3"), "utf8"), "accent-data");
        assert.ok(fs.existsSync(path.join(clientDirJs, "sub/deep/file.txt")));
        assert.equal(fs.readFileSync(path.join(clientDirJs, "sub/deep/file.txt"), "utf8"), "nested-data");

        // 1b. Standalone sync-client.js executed via symlink
        if (process.platform !== "win32") {
            const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-symlink-"));
            const symlinkScript = path.join(symlinkDir, "symlink-sync-client.js");
            const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-symlink-target-"));
            try {
                fs.symlinkSync(jsScript, symlinkScript);
                await new Promise<void>((resolve, reject) => {
                    exec(
                        `node "${symlinkScript}" --server "${localUrl}" --token "${token}" --target "${symlinkTarget}" --once`,
                        (err, stdout, stderr) => {
                            if (err) reject(new Error(`Symlinked JS client failed: ${err.message}\n${stdout}\n${stderr}`));
                            else resolve();
                        }
                    );
                });
                assert.ok(fs.existsSync(path.join(symlinkTarget, "data.json")));
            } finally {
                fs.rmSync(symlinkDir, { recursive: true, force: true });
                fs.rmSync(symlinkTarget, { recursive: true, force: true });
            }
        }

        // 2. Standalone sync-client.sh (if bash is available)
        if (process.platform !== "win32") {
            const shScript = path.resolve("scripts/sync-client.sh");
            let bashStdout = "";
            await new Promise<void>((resolve, reject) => {
                exec(
                    `bash "${shScript}" --server "${localUrl}" --token "${token}" --target "${clientDirBash}" --once`,
                    (err, stdout, stderr) => {
                        if (err) {
                            reject(new Error(`Bash Client failed: ${err.message}\n${stdout}\n${stderr}`));
                        } else {
                            bashStdout = stdout;
                            resolve();
                        }
                    }
                );
            });

            assert.match(bashStdout, /Received data\.json/);
            assert.match(bashStdout, /\/s/);
            assert.ok(fs.existsSync(path.join(clientDirBash, "data.json")));
            const bashData = JSON.parse(fs.readFileSync(path.join(clientDirBash, "data.json"), "utf8"));
            assert.equal(bashData.message, "hello standalone");
            assert.ok(fs.existsSync(path.join(clientDirBash, "La_ecuación_de_Samuel.mp3")));
            assert.equal(fs.readFileSync(path.join(clientDirBash, "La_ecuación_de_Samuel.mp3"), "utf8"), "accent-data");
            assert.ok(fs.existsSync(path.join(clientDirBash, "sub/deep/file.txt")));
            assert.equal(fs.readFileSync(path.join(clientDirBash, "sub/deep/file.txt"), "utf8"), "nested-data");
        }

        // 3. Pseudo-Terminal (PTY) execution for real-time progress verification (POSIX only)
        if (process.platform !== "win32") {
            const ptyClientDirJs = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-pty-js-"));
            const ptyClientDirBash = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-pty-bash-"));
            try {
                const jsPty = await runInPty(
                    ["node", jsScript, "--server", localUrl, "--token", token, "--target", ptyClientDirJs, "--once"],
                    35
                );
                assert.equal(jsPty.code, 0, `JS client in PTY failed: ${jsPty.output}`);
                assert.match(jsPty.output, /\r/);
                assert.match(jsPty.output, /Received data\.json/);
                assert.ok(fs.existsSync(path.join(ptyClientDirJs, "data.json")));

                const bashPty = await runInPty(
                    ["bash", path.resolve("scripts/sync-client.sh"), "--server", localUrl, "--token", token, "--target", ptyClientDirBash, "--once"],
                    35
                );
                assert.equal(bashPty.code, 0, `Bash client in PTY failed: ${bashPty.output}`);
                assert.match(bashPty.output, /\r/);
                assert.match(bashPty.output, /Received data\.json/);
                assert.ok(fs.existsSync(path.join(ptyClientDirBash, "data.json")));
            } finally {
                fs.rmSync(ptyClientDirJs, { recursive: true, force: true });
                fs.rmSync(ptyClientDirBash, { recursive: true, force: true });
            }
        }

        // 4. Verify standalone clients terminate immediately on 401 when token is missing
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
            const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-clean-"));
            try {
                await expectAuthFailure(`bash "${path.resolve("scripts/sync-client.sh")}" --server "${localUrl}" --target "${badDir}"`);
                const remainingFiles = fs.readdirSync(badDir);
                const tempArtifacts = remainingFiles.filter((f) => f.includes(".tmp."));
                assert.equal(tempArtifacts.length, 0, `Found dangling temporary files after auth failure: ${tempArtifacts.join(", ")}`);
            } finally {
                fs.rmSync(badDir, { recursive: true, force: true });
            }
        }
    } finally {
        await server.stop();
        fs.rmSync(hostDir, { recursive: true, force: true });
        fs.rmSync(clientDirJs, { recursive: true, force: true });
        fs.rmSync(clientDirBash, { recursive: true, force: true });
    }

    console.log("  [PASS] Standalone Script Clients: Verified zero-dependency JS and Bash clients.");
}
