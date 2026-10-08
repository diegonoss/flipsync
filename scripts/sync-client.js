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
import { URL, fileURLToPath } from "node:url";

/**
 * Computes SHA-256 hex digest for a given Buffer.
 * @param {Buffer} buf - Data buffer to hash.
 * @returns {string} Hexadecimal SHA-256 digest.
 */
function computeHash(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Reads a local file and calculates its SHA-256 hash.
 * @param {string} filePath - Absolute path to local file.
 * @returns {string|null} Hex digest or null if file does not exist.
 */
function getFileHash(filePath) {
    try {
        return fs.existsSync(filePath) ? computeHash(fs.readFileSync(filePath)) : null;
    } catch {
        return null;
    }
}

/**
 * Formats a byte quantity into a human-readable string (B, KB, MB, GB).
 * @param {number} bytes - Number of bytes.
 * @returns {string} Formatted byte string.
 */
function formatBytes(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

/**
 * Formats a transfer rate in bytes per second.
 * @param {number} bytesPerSec - Speed in bytes per second.
 * @returns {string} Formatted speed string (e.g. "1.5 MB/s").
 */
function formatSpeed(bytesPerSec) {
    return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Formats estimated remaining duration in seconds.
 * @param {number} seconds - Remaining time in seconds.
 * @returns {string} Formatted ETA string.
 */
function formatEta(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Generates an ASCII progress bar string of specified width.
 * @param {number} percent - Completion percentage (0-100).
 * @param {number} width - Character width of the bar.
 * @returns {string} Formatted bar string.
 */
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

/**
 * Strips ANSI escape sequences and replaces control characters for safe terminal output.
 * @param {string} str - Raw string.
 * @returns {string} Sanitized string safe for terminal rendering.
 */
function sanitizeForTerminal(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

/**
 * Formats a single-line progress indicator clamped to terminal width.
 * @param {string} prefix - Status prefix (e.g. "[SYNC] [1/5]").
 * @param {string} fileName - File being downloaded.
 * @param {number} percent - Percentage transferred.
 * @param {string} curStr - Transferred byte string.
 * @param {string} totStr - Total byte string.
 * @param {string} speedStr - Current speed string.
 * @param {string} etaStr - Estimated time remaining string.
 * @param {number} maxWidth - Available console columns.
 * @returns {string} Clamped, padded progress line.
 */
function formatProgressLine(prefix, fileName, percent, curStr, totStr, speedStr, etaStr, maxWidth = 80) {
    const limit = Math.max(1, maxWidth - 1);
    const safeName = sanitizeForTerminal(fileName);
    const pctStr = String(percent).padStart(3);
    let stats;
    if (totStr) {
        const fullStats = ` ${pctStr}% (${curStr} / ${totStr}) ${speedStr} ETA ${etaStr}`;
        const compactStats = ` ${pctStr}% ${curStr} ${speedStr}`;
        const minStats = ` ${pctStr}% ${speedStr}`;
        if (limit >= prefix.length + 1 + fullStats.length) {
            stats = fullStats;
        } else if (limit >= prefix.length + 1 + compactStats.length) {
            stats = compactStats;
        } else if (limit >= prefix.length + 1 + minStats.length) {
            stats = minStats;
        } else {
            stats = ` ${pctStr}%`;
        }
    } else {
        const fullStats = ` ${curStr} (${speedStr})`;
        stats = limit >= prefix.length + 1 + fullStats.length ? fullStats : ` ${curStr}`;
    }

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
    let name = safeName;
    if (name.length > avail) {
        if (avail >= 7) {
            const left = Math.floor((avail - 3) / 2);
            const right = avail - 3 - left;
            name = safeName.slice(0, left) + "..." + safeName.slice(safeName.length - right);
        } else if (avail >= 4) {
            name = safeName.slice(0, avail - 3) + "...";
        } else if (avail > 0) {
            name = safeName.slice(0, avail);
        } else {
            name = "";
        }
    }

    const line = `${prefix} ${name}${tail}`;
    return line.length < limit ? line.padEnd(limit, " ") : line.slice(0, limit);
}

/**
 * Logs a fatal error message to stderr and terminates process with exit code 1.
 * @param {string} msg - Error message to log.
 */
function fatal(msg) {
    console.error(`[CLIENT] [FATAL] ${msg}`);
    process.exit(1);
}

class Client {
    /**
     * Creates an instance of the standalone FlipSync Client.
     * @param {object} opts - Configuration options.
     * @param {string} opts.server - Host server base URL.
     * @param {string} [opts.token] - Optional bearer authentication token.
     * @param {string} opts.target - Target directory to synchronize.
     * @param {boolean} [opts.once] - Whether to perform a single sync and exit.
     */
    constructor(opts) {
        this.server = opts.server.replace(/\/+$/, "");
        this.token = opts.token;
        this.target = path.resolve(opts.target);
        this.once = !!opts.once;
        this.reconnectTimer = null;
        this.activeReq = null;
        this.activeDownloadReqs = new Set();
        this.running = false;
        this.generation = 0;
        this.downloadQueue = [];
        this.isProcessingQueue = false;
        this.reconnectDelay = opts.reconnectDelay || 1000;
        this.lastFilePromise = null;
        this.activeSyncPromise = null;
    }

    /**
     * Compatibility getter for the primary active download request.
     * @returns {import("node:http").ClientRequest|null}
     */
    get activeDownloadReq() {
        return this.activeDownloadReqs.values().next().value || null;
    }

    set activeDownloadReq(val) {
        if (!val) {
            this.activeDownloadReqs.clear();
        } else {
            this.activeDownloadReqs.add(val);
        }
    }

    /**
     * Enqueues a file for sequential download to avoid stdout collisions.
     * @param {object} file - File metadata object.
     * @param {number} [idx=0] - 1-based index in batch.
     * @param {number} [total=0] - Total count of files in batch.
     * @returns {Promise<boolean>}
     */
    queueFile(file, idx = 0, total = 0) {
        if (!this.running) {
            return Promise.reject(new Error("Client stopped"));
        }
        return new Promise((resolve, reject) => {
            this.downloadQueue.push({ file, idx, total, resolve, reject });
            this.processQueue();
        });
    }

    /**
     * Processes enqueued file downloads sequentially.
     */
    async processQueue() {
        if (this.isProcessingQueue || !this.running) return;
        this.isProcessingQueue = true;
        while (this.downloadQueue.length > 0 && this.running) {
            const item = this.downloadQueue.shift();
            try {
                const res = await this.downloadIfChanged(item.file, item.idx, item.total);
                item.resolve(res);
            } catch (err) {
                if (this.running) {
                    console.error(`[CLIENT] [ERROR] Failed update: ${err.message}`);
                }
                item.reject(err);
            }
        }
        this.isProcessingQueue = false;
    }

    /**
     * Initializes sync directory, runs initial sync, and connects SSE stream.
     * @returns {Promise<void>}
     */
    async start() {
        this.running = true;
        this.generation++;
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

        this.connectSse(this.reconnectDelay);
    }

    /**
     * Stops the client and releases timers and active network connections.
     */
    stop() {
        this.running = false;
        this.generation++;
        const pending = this.downloadQueue;
        this.downloadQueue = [];
        for (const item of pending) {
            item.reject(new Error("Client stopped"));
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.activeReq) {
            this.activeReq.destroy(new Error("Client stopped"));
            this.activeReq = null;
        }
        for (const req of Array.from(this.activeDownloadReqs)) {
            req.destroy(new Error("Client stopped"));
        }
        this.activeDownloadReqs.clear();
    }

    /**
     * Constructs a full API URL with token query parameter if configured.
     * @param {string} endpoint - API route (e.g. "/api/manifest").
     * @returns {string} Fully qualified URL.
     */
    url(endpoint) {
        return `${this.server}${endpoint}${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
    }

    /**
     * Fetches the host manifest and synchronizes changed or missing files.
     * @returns {Promise<void>}
     */
    async syncAll() {
        const opGen = this.generation;
        if (!this.running) throw new Error("Client stopped");
        try {
            const res = await this.httpGet(this.url("/api/manifest"));
            if (!this.running || this.generation !== opGen) throw new Error("Client stopped");
            if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body}`);
            const manifest = JSON.parse(res.body);
            const files = Object.values(manifest.files || {});
            let updated = 0;
            let idx = 0;
            for (const f of files) {
                if (!this.running || this.generation !== opGen) throw new Error("Client stopped");
                idx++;
                if (await this.downloadIfChanged(f, idx, files.length)) updated++;
            }
            if (!this.running || this.generation !== opGen) throw new Error("Client stopped");
            console.log(`[CLIENT] Remote check: ${files.length} file(s) verified, ${updated} updated.`);
        } catch (err) {
            if (this.running) {
                console.error(`[CLIENT] [ERROR] Sync failed: ${err.message}`);
            }
            if (this.once || !this.running) throw err;
        }
    }

    /**
     * Downloads a file if it does not exist locally or its SHA-256 differs.
     * @param {object} file - File metadata object.
     * @param {string} file.name - Relative path on host.
     * @param {string} file.sha256 - Expected SHA-256 digest.
     * @param {number} [file.size] - File size in bytes.
     * @param {number} [idx=0] - 1-based index in batch.
     * @param {number} [totalFiles=0] - Total count of files in batch.
     * @returns {Promise<boolean>} True if file was downloaded and written.
     */
    async downloadIfChanged(file, idx = 0, totalFiles = 0) {
        const opGen = this.generation;
        if (!this.running) {
            throw new Error("Client stopped");
        }
        const dest = path.resolve(this.target, file.name);
        const rel = path.relative(this.target, dest);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            console.error(`[ERROR] Path traversal blocked: ${sanitizeForTerminal(file.name)}`);
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

        if (!this.running || this.generation !== opGen) {
            throw new Error("Client stopped");
        }

        const hash = computeHash(buf);
        if (hash !== file.sha256) {
            throw new Error(`Hash mismatch for ${sanitizeForTerminal(file.name)}: expected ${file.sha256}, got ${hash}`);
        }

        if (!this.running || this.generation !== opGen) {
            throw new Error("Client stopped");
        }

        // Atomic write
        fs.mkdirSync(parentDir, { recursive: true });
        const tmp = path.join(parentDir, `.${path.basename(file.name)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);
        fs.writeFileSync(tmp, buf);

        if (!this.running || this.generation !== opGen) {
            try { fs.unlinkSync(tmp); } catch {}
            throw new Error("Client stopped");
        }

        fs.renameSync(tmp, dest);

        const ms = Date.now() - start;
        const durSec = Math.max(0.001, ms / 1000);
        const finalSizeStr = formatBytes(buf.length);
        const finalSpeedStr = formatSpeed(buf.length / durSec);
        const timeStr = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        const displayName = sanitizeForTerminal(file.name);
        console.log(`[CLIENT] ${prefix} Received ${displayName} (${finalSizeStr}) in ${timeStr} (${finalSpeedStr}) -> ${sanitizeForTerminal(dest)}`);
        return true;
    }

    /**
     * Connects to the host Server-Sent Events stream for live file change updates.
     * @param {number} [backoff=1000] - Reconnection backoff delay in milliseconds.
     */
    connectSse(backoff = this.reconnectDelay || 1000) {
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

                backoff = this.reconnectDelay || 1000;

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

    /**
     * Schedules a reconnection attempt with exponential backoff.
     * @param {number} delay - Backoff delay in milliseconds.
     */
    retry(delay) {
        if (!this.running) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(async () => {
            if (!this.running) return;
            console.log("[CLIENT] Reconnecting to host...");
            this.activeSyncPromise = this.syncAll();
            try {
                await this.activeSyncPromise;
            } catch (err) {
                if (this.running) {
                    console.error(`[CLIENT] [ERROR] Reconnect sync failed: ${err.message}`);
                }
            } finally {
                this.activeSyncPromise = null;
            }
            if (this.running) {
                this.connectSse(delay * 2);
            }
        }, delay);
    }

    /**
     * Parses an SSE event message and triggers file addition or deletion.
     * @param {string} msg - Raw SSE message string.
     */
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
            if (event === "init" && parsed.manifest?.files) {
                const files = Object.values(parsed.manifest.files);
                files.forEach((f, i) => this.queueFile(f, i + 1, files.length).catch(() => {}));
            } else if (event === "file_changed" && parsed.file) {
                const p = this.queueFile(parsed.file);
                this.lastFilePromise = p;
                p.catch(() => {});
            } else if (event === "file_deleted" && parsed.filename) {
                const dest = path.resolve(this.target, parsed.filename);
                const rel = path.relative(this.target, dest);
                if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                    try { fs.unlinkSync(dest); } catch {}
                    console.log(`[CLIENT] Host deleted: ${sanitizeForTerminal(parsed.filename)}`);
                } else {
                    console.error(`[ERROR] Path traversal blocked: ${sanitizeForTerminal(parsed.filename)}`);
                }
            }
        } catch {}
    }

    /**
     * Performs an HTTP GET request and returns a string or Buffer.
     * @param {string} urlStr - Target endpoint URL.
     * @param {boolean} [asBuffer=false] - Whether to return raw Buffer.
     * @returns {Promise<{status: number, body: string}|Buffer>} Response payload.
     */
    httpReq(urlStr, asBuffer = false) {
        if (!this.running && this.running !== undefined) {
            return Promise.reject(new Error("Client stopped"));
        }
        return new Promise((resolve, reject) => {
            const parsed = new URL(urlStr);
            const req = (parsed.protocol === "https:" ? https : http)
                .get(parsed, (res) => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        this.activeDownloadReqs.delete(req);
                        res.resume();
                        res.destroy();
                        req.destroy();
                        fatal(`Authentication failed (HTTP ${res.statusCode}). A valid bearer token is required.`);
                    }
                    if (asBuffer && res.statusCode !== 200) {
                        this.activeDownloadReqs.delete(req);
                        res.resume();
                        res.destroy();
                        req.destroy();
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        this.activeDownloadReqs.delete(req);
                        const buf = Buffer.concat(chunks);
                        resolve(asBuffer ? buf : { status: res.statusCode || 0, body: buf.toString("utf8") });
                    });
                    res.on("error", (err) => {
                        this.activeDownloadReqs.delete(req);
                        reject(err);
                    });
                })
                .on("error", (err) => {
                    this.activeDownloadReqs.delete(req);
                    reject(err);
                });
            this.activeDownloadReqs.add(req);
            req.on("close", () => {
                this.activeDownloadReqs.delete(req);
            });
        });
    }

    /**
     * Performs an HTTP GET request expecting a UTF-8 text response.
     * @param {string} urlStr - Target URL.
     * @returns {Promise<{status: number, body: string}>} Response status and body.
     */
    httpGet(urlStr) { return this.httpReq(urlStr, false); }

    /**
     * Streams an HTTP download while rendering a real-time progress indicator.
     * @param {string} urlStr - Download endpoint URL.
     * @param {string} [fileName="file"] - Display file name.
     * @param {number} [totalSize=0] - Expected file size.
     * @param {string} [prefix="[SYNC]"] - Output line prefix.
     * @returns {Promise<Buffer>} Complete file content Buffer.
     */
    httpDownload(urlStr, fileName = "file", totalSize = 0, prefix = "[SYNC]") {
        if (!this.running) {
            return Promise.reject(new Error("Client stopped"));
        }
        return new Promise((resolve, reject) => {
            const parsed = new URL(urlStr);
            const transport = parsed.protocol === "https:" ? https : http;
            const displayName = sanitizeForTerminal(fileName);
            const req = transport.get(parsed, (res) => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    this.activeDownloadReqs.delete(req);
                    res.resume();
                    res.destroy();
                    req.destroy();
                    fatal(`Authentication failed downloading ${displayName} (HTTP ${res.statusCode}). A valid bearer token is required.`);
                }
                if (res.statusCode !== 200) {
                    this.activeDownloadReqs.delete(req);
                    res.resume();
                    res.destroy();
                    req.destroy();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const total = parseInt(res.headers["content-length"] || "0", 10) || totalSize || 0;
                let transferred = 0;
                let lastUpdateTime = Date.now();
                let lastTransferred = 0;
                let instantSpeed = 0;
                const isTTY = !!process.stdout.isTTY;
                const cols = isTTY && process.stdout.columns > 0 ? process.stdout.columns : 80;
                const limit = Math.max(1, cols - 1);

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
                            const line = formatProgressLine(prefix, displayName, pct, curStr, totStr, spdStr, etaStr, cols);
                            process.stdout.write(`\r${line}`);
                        }
                    }
                });

                res.on("end", () => {
                    this.activeDownloadReqs.delete(req);
                    if (isTTY) {
                        process.stdout.write(`\r${" ".repeat(limit)}\r`);
                    }
                    resolve(Buffer.concat(chunks));
                });
                res.on("error", (err) => {
                    this.activeDownloadReqs.delete(req);
                    reject(err);
                });
            });

            this.activeDownloadReqs.add(req);
            req.on("close", () => {
                this.activeDownloadReqs.delete(req);
            });
            req.on("error", (err) => {
                this.activeDownloadReqs.delete(req);
                reject(err);
            });
        });
    }
}

// CLI entrypoint
const isDirectRun = (() => {
    if (!process.argv[1]) return false;
    try {
        return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
    } catch {
        return false;
    }
})();

if (isDirectRun) {
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
}

export {
    formatProgressLine,
    getProgressBar,
    formatBytes,
    formatSpeed,
    formatEta,
    sanitizeForTerminal,
    Client
};
