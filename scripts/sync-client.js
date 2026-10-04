#!/usr/bin/env node
/**
 * FlipSync — Standalone Zero-Dependency Sync Client
 *
 * Runs on any OS with Node.js installed without any npm packages.
 * Usage:
 *   node sync-client.js --server <URL> [--token <TOKEN>] [--target <DIRECTORY>] [--once]
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

function computeHash(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function getFileHash(filePath) {
    try {
        return fs.existsSync(filePath) ? computeHash(fs.readFileSync(filePath)) : null;
    } catch {
        return null;
    }
}

function formatBytes(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function formatSpeed(bytesPerSec) {
    return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function getProgressBar(percent, width = 10) {
    const filled = Math.max(0, Math.min(width, Math.round((width * percent) / 100)));
    const empty = width - filled;
    if (filled > 0 && empty > 0) {
        return "=".repeat(filled - 1) + ">" + " ".repeat(empty);
    } else if (filled === width) {
        return "=".repeat(width);
    } else {
        return " ".repeat(width);
    }
}

function formatProgressLine(prefix, fileName, percent, curStr, totStr, speedStr, etaStr, maxWidth = 80) {
    const limit = Math.max(30, maxWidth - 1);
    const pctStr = String(percent).padStart(3);
    const stats = totStr
        ? ` ${pctStr}% (${curStr} / ${totStr}) ${speedStr} ETA ${etaStr}`
        : ` ${curStr} (${speedStr})`;

    const overhead = prefix.length + 1 + stats.length;
    const rem = limit - overhead;

    let barStr = "";
    if (totStr && rem >= 24) {
        const barWidth = Math.min(14, Math.max(8, rem - 20));
        const bar = getProgressBar(percent, barWidth);
        barStr = ` [${bar}]`;
    }

    const tail = `${barStr}${stats}`;
    const avail = limit - prefix.length - 1 - tail.length;
    let name = fileName;
    if (name.length > avail) {
        if (avail >= 7) {
            const left = Math.floor((avail - 3) / 2);
            const right = avail - 3 - left;
            name = fileName.slice(0, left) + "..." + fileName.slice(fileName.length - right);
        } else if (avail >= 4) {
            name = fileName.slice(0, avail - 3) + "...";
        } else if (avail > 0) {
            name = fileName.slice(0, avail);
        } else {
            name = "";
        }
    }

    const line = `${prefix} ${name}${tail}`;
    return line.length < limit ? line.padEnd(limit, " ") : line.slice(0, limit);
}

function fatal(msg) {
    console.error(`[CLIENT] [FATAL] ${msg}`);
    process.exit(1);
}

class Client {
    constructor(opts) {
        this.server = opts.server.replace(/\/+$/, "");
        this.token = opts.token;
        this.target = path.resolve(opts.target);
        this.once = !!opts.once;
        this.reconnectTimer = null;
        this.activeReq = null;
        this.running = false;
    }

    async start() {
        this.running = true;
        if (!fs.existsSync(this.target)) {
            fs.mkdirSync(this.target, { recursive: true });
        }
        console.log(`[CLIENT] Connecting to:  ${this.server}`);
        console.log(`[CLIENT] Destination:    ${this.target}`);

        await this.syncAll();
        if (this.once) {
            console.log("[CLIENT] Single sync complete (--once specified). Exiting.");
            return;
        }

        this.connectSse(1000);
    }

    stop() {
        this.running = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.activeReq) this.activeReq.destroy();
    }

    url(endpoint) {
        return `${this.server}${endpoint}${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
    }

    async syncAll() {
        try {
            const res = await this.httpGet(this.url("/api/manifest"));
            if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body}`);
            const manifest = JSON.parse(res.body);
            const files = Object.values(manifest.files || {});
            let updated = 0;
            let idx = 0;
            for (const f of files) {
                idx++;
                if (await this.downloadIfChanged(f, idx, files.length)) updated++;
            }
            console.log(`[CLIENT] Remote check: ${files.length} file(s) verified, ${updated} updated.`);
        } catch (err) {
            console.error(`[CLIENT] [ERROR] Sync failed: ${err.message}`);
            if (this.once) throw err;
        }
    }

    async downloadIfChanged(file, idx = 0, totalFiles = 0) {
        const dest = path.resolve(this.target, file.name);
        const rel = path.relative(this.target, dest);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            console.error(`[ERROR] Path traversal blocked: ${file.name}`);
            return false;
        }
        const parentDir = path.dirname(dest);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        if (fs.existsSync(dest)) {
            const localHash = getFileHash(dest);
            if (localHash === file.sha256) return false;
        }

        const prefix = totalFiles > 1 && idx > 0 ? `[SYNC] [${idx}/${totalFiles}]` : "[SYNC]";
        const start = Date.now();
        const encName = file.name.split("/").map(encodeURIComponent).join("/");
        const buf = await this.httpDownload(this.url(`/api/download/${encName}`), file.name, file.size, prefix);

        const hash = computeHash(buf);
        if (hash !== file.sha256) {
            throw new Error(`Hash mismatch for ${file.name}: expected ${file.sha256}, got ${hash}`);
        }

        // Atomic write
        fs.mkdirSync(parentDir, { recursive: true });
        const tmp = path.join(parentDir, `.${path.basename(file.name)}.tmp.${Date.now()}`);
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);

        const ms = Date.now() - start;
        const durSec = Math.max(0.001, ms / 1000);
        const finalSizeStr = formatBytes(buf.length);
        const finalSpeedStr = formatSpeed(buf.length / durSec);
        const timeStr = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        console.log(`[CLIENT] ${prefix} Received ${file.name} (${finalSizeStr}) in ${timeStr} (${finalSpeedStr}) -> ${dest}`);
        return true;
    }

    connectSse(backoff = 1000) {
        if (!this.running) return;

        if (backoff > 30000) {
            fatal(`Connection lost. Retry timer (${(backoff / 1000).toFixed(1)}s) exceeded limit (30.0s). Terminating.`);
        }

        const parsed = new URL(this.url("/api/events"));
        const transport = parsed.protocol === "https:" ? https : http;

        const req = transport.request(
            parsed,
            {
                headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" }
            },
            (res) => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    fatal(`Authentication failed (HTTP ${res.statusCode}). A valid bearer token is required.`);
                }

                if (res.statusCode !== 200) {
                    console.error(`[CLIENT] [ERROR] SSE stream rejected: HTTP ${res.statusCode}`);
                    this.retry(backoff);
                    return;
                }

                console.log("[CLIENT] Live sync active. Waiting for file changes on host...");

                backoff = 1000;

                let buffer = "";
                res.on("data", (chunk) => {
                    buffer += chunk.toString("utf8");
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop() || "";
                    for (const p of parts) this.handleSseMessage(p.trim());
                });

                res.on("end", () => {
                    if (!this.running) return;
                    console.log("[CLIENT] Stream ended by host.");
                    this.retry(backoff);
                });

                res.on("error", (err) => {
                    if (!this.running) return;
                    console.error(`[CLIENT] [ERROR] Stream error: ${err.message}`);
                });
            }
        );

        this.activeReq = req;
        req.on("error", (err) => {
            if (!this.running) return;
            console.error(`[CLIENT] Connection error: ${err.message}. Retrying in ${(backoff / 1000).toFixed(1)}s...`);
            this.retry(backoff);
        });
        req.end();
    }

    retry(delay) {
        if (!this.running) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(async () => {
            if (!this.running) return;
            console.log("[CLIENT] Reconnecting to host...");
            try {
                await this.syncAll();
            } catch (err) {
                console.error(`[CLIENT] [ERROR] Reconnect sync failed: ${err.message}`);
            }
            this.connectSse(delay * 2);
        }, delay);
    }

    handleSseMessage(msg) {
        if (!msg || msg.startsWith(":")) return;
        let event = "message", data = "";
        for (const line of msg.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (!data) return;

        try {
            const parsed = JSON.parse(data);
            const syncFile = (f) => this.downloadIfChanged(f).catch((e) =>
                console.error(`[CLIENT] [ERROR] Failed update: ${e.message}`)
            );
            if (event === "init" && parsed.manifest?.files) {
                Object.values(parsed.manifest.files).forEach(syncFile);
            } else if (event === "file_changed" && parsed.file) {
                syncFile(parsed.file);
            } else if (event === "file_deleted" && parsed.filename) {
                const dest = path.resolve(this.target, parsed.filename);
                const rel = path.relative(this.target, dest);
                if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                    try { fs.unlinkSync(dest); } catch {}
                    console.log(`[CLIENT] Host deleted: ${parsed.filename}`);
                }
            }
        } catch {}
    }

    httpReq(urlStr, asBuffer = false) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(urlStr);
            (parsed.protocol === "https:" ? https : http)
                .get(parsed, (res) => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        fatal(`Authentication failed (HTTP ${res.statusCode}). A valid bearer token is required.`);
                    }
                    if (asBuffer && res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        const buf = Buffer.concat(chunks);
                        resolve(asBuffer ? buf : { status: res.statusCode || 0, body: buf.toString("utf8") });
                    });
                })
                .on("error", reject);
        });
    }

    httpGet(urlStr) { return this.httpReq(urlStr, false); }
    httpDownload(urlStr, fileName = "file", totalSize = 0, prefix = "[SYNC]") {
        return new Promise((resolve, reject) => {
            const parsed = new URL(urlStr);
            const transport = parsed.protocol === "https:" ? https : http;
            const req = transport.get(parsed, (res) => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    fatal(`Authentication failed downloading ${fileName} (HTTP ${res.statusCode}). A valid bearer token is required.`);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const total = parseInt(res.headers["content-length"] || "0", 10) || totalSize || 0;
                let transferred = 0;
                let lastUpdateTime = Date.now();
                let lastTransferred = 0;
                let instantSpeed = 0;
                const isTTY = !!process.stdout.isTTY;
                const cols = isTTY ? Math.max(40, process.stdout.columns || 80) : 80;
                const limit = Math.max(30, cols - 1);

                const chunks = [];
                res.on("data", (chunk) => {
                    chunks.push(chunk);
                    transferred += chunk.length;

                    const now = Date.now();
                    const dt = (now - lastUpdateTime) / 1000;
                    if (dt >= 0.15 || (total > 0 && transferred >= total)) {
                        if (dt > 0) {
                            instantSpeed = (transferred - lastTransferred) / dt;
                        }
                        lastUpdateTime = now;
                        lastTransferred = transferred;

                        if (isTTY) {
                            const curStr = formatBytes(transferred);
                            const spdStr = formatSpeed(instantSpeed);
                            const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((transferred / total) * 100))) : 0;
                            const totStr = total > 0 ? formatBytes(total) : "";
                            let etaStr = "--:--";
                            if (instantSpeed > 0 && total > 0 && transferred < total) {
                                etaStr = formatEta(Math.round((total - transferred) / instantSpeed));
                            } else if (total > 0 && transferred >= total) {
                                etaStr = "0s";
                            }
                            const line = formatProgressLine(prefix, fileName, pct, curStr, totStr, spdStr, etaStr, cols);
                            process.stdout.write(`\r${line}`);
                        }
                    }
                });

                res.on("end", () => {
                    if (isTTY) {
                        process.stdout.write(`\r${" ".repeat(limit)}\r`);
                    }
                    resolve(Buffer.concat(chunks));
                });
                res.on("error", reject);
            });
            req.on("error", reject);
        });
    }
}

// CLI entrypoint
const args = process.argv.slice(2);
const getArg = (s, l) => {
    const i = Math.max(args.indexOf(s), args.indexOf(l));
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};
const hasFlag = (s, l) => args.includes(s) || args.includes(l);

if (hasFlag("-h", "--help")) {
    console.log(`
FlipSync — Standalone Zero-Dependency Client

Usage:
  node sync-client.js --server <URL> [options]

Options:
  -s, --server <url>     FlipSync host URL [required]
  -t, --token <token>    Auth token
  --target <path>        Destination directory (default: current directory ".")
  --once                 Sync once and exit
  -h, --help             Show this help
`);
    process.exit(0);
}

const server = getArg("-s", "--server") || process.env.SYNC_SERVER;
if (!server) {
    console.error("[ERROR] Missing required option: --server <URL>\nRun with --help for details.");
    process.exit(1);
}

const client = new Client({
    server,
    token: getArg("-t", "--token") || process.env.SYNC_TOKEN,
    target: getArg("", "--target") || process.env.SYNC_TARGET || ".",
    once: hasFlag("", "--once")
});

const onExit = () => {
    console.log("\n[CLIENT] Exiting.");
    client.stop();
    process.exit(0);
};
process.on("SIGINT", onExit);
process.on("SIGTERM", onExit);

client.start()
    .then(() => { if (client.once) process.exit(0); })
    .catch((err) => {
        console.error("[CLIENT] [FATAL]", err.message);
        process.exit(1);
    });
