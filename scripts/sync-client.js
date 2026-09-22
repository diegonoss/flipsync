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
            for (const f of files) {
                if (await this.downloadIfChanged(f)) updated++;
            }
            console.log(`[CLIENT] Remote check: ${files.length} file(s) verified, ${updated} updated.`);
        } catch (err) {
            console.error(`[CLIENT] [ERROR] Sync failed: ${err.message}`);
            if (this.once) throw err;
        }
    }

    async downloadIfChanged(file) {
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

        const start = Date.now();
        const buf = await this.httpDownload(this.url(`/api/download/${encodeURIComponent(file.name)}`));

        const hash = computeHash(buf);
        if (hash !== file.sha256) {
            throw new Error(`Hash mismatch for ${file.name}: expected ${file.sha256}, got ${hash}`);
        }

        // Atomic write
        const tmp = path.join(parentDir, `.${path.basename(file.name)}.tmp.${Date.now()}`);
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);

        const ms = Date.now() - start;
        const kb = (file.size / 1024).toFixed(1);
        console.log(`[CLIENT] [SYNC] Transferred ${file.name} (${kb} KB) in ${ms}ms -> ${dest}`);
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
            if (event === "file_changed" && parsed.file) {
                this.downloadIfChanged(parsed.file).catch((e) =>
                    console.error(`[CLIENT] [ERROR] Failed update: ${e.message}`)
                );
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
    httpDownload(urlStr) { return this.httpReq(urlStr, true); }
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
