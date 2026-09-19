import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { computeBufferHash, computeFileHash } from "./hasher.js";
import type { ClientOptions, SyncEvent, SyncFileMeta, SyncManifest } from "./types.js";

export class SyncClient {
    private readonly serverUrl: string;
    private readonly token?: string;
    private readonly targetDir: string;
    private readonly verbose: boolean;
    private readonly once: boolean;
    private readonly onSync?: (file: SyncFileMeta) => void;
    private readonly onDelete?: (filename: string) => void;
    private readonly onError?: (err: Error) => void;
    private isRunning = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private currentSseReq: http.ClientRequest | null = null;

    constructor(options: ClientOptions) {
        this.serverUrl = options.serverUrl.replace(/\/+$/, "");
        this.token = options.token;
        this.targetDir = path.resolve(options.targetDir);
        this.verbose = options.verbose ?? true;
        this.once = options.once ?? false;
        this.onSync = options.onSync;
        this.onDelete = options.onDelete;
        this.onError = options.onError;
    }

    public async start(): Promise<void> {
        this.isRunning = true;

        if (!fs.existsSync(this.targetDir)) {
            fs.mkdirSync(this.targetDir, { recursive: true });
        }

        if (this.verbose) {
            console.log(`[CLIENT] Connecting to host: ${this.serverUrl}`);
            console.log(`[CLIENT] Target folder:   ${this.targetDir}`);
        }

        // Initial synchronization
        await this.syncManifest();

        if (this.once) {
            if (this.verbose) {
                console.log("[CLIENT] Initial sync complete (--once specified). Exiting.");
            }
            return;
        }

        // Start real-time SSE connection
        this.connectSse(1000);
    }

    public stop(): void {
        this.isRunning = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.currentSseReq) {
            this.currentSseReq.destroy();
            this.currentSseReq = null;
        }
    }

    public async syncManifest(): Promise<void> {
        try {
            const manifestUrl = `${this.serverUrl}/api/manifest${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
            const res = await this.httpRequest(manifestUrl);
            if (res.statusCode !== 200) {
                throw new Error(`Server returned HTTP ${res.statusCode}: ${res.body}`);
            }

            const manifest = JSON.parse(res.body) as SyncManifest;
            const files = Object.values(manifest.files || {});

            let syncedCount = 0;
            for (const file of files) {
                const updated = await this.downloadIfChanged(file);
                if (updated) syncedCount++;
            }

            if (this.verbose) {
                console.log(`[CLIENT] Verified ${files.length} remote file(s). ${syncedCount} downloaded/updated.`);
            }
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`[CLIENT] Failed to sync manifest: ${error.message}`);
            this.onError?.(error);
            if (this.once) {
                throw error;
            }
        }
    }

    public async downloadIfChanged(file: SyncFileMeta): Promise<boolean> {
        const destPath = path.join(this.targetDir, file.name);
        const destDir = path.dirname(destPath);

        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        // Compare with local copy
        if (fs.existsSync(destPath)) {
            const localMeta = await computeFileHash(destPath);
            if (localMeta && localMeta.sha256 === file.sha256) {
                return false;
            }
        }

        const startMs = Date.now();
        const downloadUrl = `${this.serverUrl}/api/download/${encodeURIComponent(file.name)}${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
        const buffer = await this.httpDownloadBuffer(downloadUrl);

        // Verify SHA-256 integrity
        const downloadedHash = computeBufferHash(buffer);
        if (downloadedHash !== file.sha256) {
            throw new Error(`Hash mismatch for ${file.name}: expected ${file.sha256}, got ${downloadedHash}`);
        }

        // Atomic write: write to temp file, then rename
        const tempFilename = `.${path.basename(file.name)}.tmp.${Date.now()}`;
        const tempPath = path.join(destDir, tempFilename);

        fs.writeFileSync(tempPath, buffer);
        fs.renameSync(tempPath, destPath);

        const durationMs = Date.now() - startMs;
        const kb = (file.size / 1024).toFixed(1);

        if (this.verbose) {
            console.log(`[CLIENT] [SYNC] Transferred ${file.name} (${kb} KB) in ${durationMs}ms -> ${destPath}`);
        }

        if (this.onSync) {
            this.onSync(file);
        }

        return true;
    }

    private connectSse(retryDelayMs: number): void {
        if (!this.isRunning) return;

        const sseUrl = `${this.serverUrl}/api/events${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
        const parsedUrl = new URL(sseUrl);
        const isHttps = parsedUrl.protocol === "https:";
        const transport = isHttps ? https : http;

        const req = transport.request(
            parsedUrl,
            {
                headers: {
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache"
                }
            },
            (res) => {
                if (res.statusCode !== 200) {
                    console.error(`[CLIENT] SSE connection rejected: HTTP ${res.statusCode}`);
                    this.scheduleReconnect(Math.min(retryDelayMs * 2, 15000));
                    return;
                }

                if (this.verbose) {
                    console.log("[CLIENT] Connected to real-time live sync stream. Watching for host changes...");
                }

                let buffer = "";

                res.on("data", (chunk: Buffer) => {
                    buffer += chunk.toString("utf8");
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop() || "";

                    for (const part of parts) {
                        this.processSseMessage(part.trim());
                    }
                });

                res.on("end", () => {
                    if (!this.isRunning) return;
                    if (this.verbose) {
                        console.log("[CLIENT] SSE connection closed by server.");
                    }
                    this.scheduleReconnect(Math.min(retryDelayMs * 2, 15000));
                });

                res.on("error", (err) => {
                    if (!this.isRunning) return;
                    console.error(`[CLIENT] SSE stream error: ${err.message}`);
                });
            }
        );

        this.currentSseReq = req;

        req.on("error", (err) => {
            if (!this.isRunning) return;
            console.error(`[CLIENT] Connection error: ${err.message}. Retrying in ${(retryDelayMs / 1000).toFixed(1)}s...`);
            this.scheduleReconnect(Math.min(retryDelayMs * 2, 15000));
        });

        req.end();
    }

    private scheduleReconnect(delayMs: number): void {
        if (!this.isRunning) return;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        this.reconnectTimeout = setTimeout(async () => {
            if (!this.isRunning) return;
            if (this.verbose) {
                console.log("[CLIENT] Reconnecting...");
            }
            await this.syncManifest();
            this.connectSse(delayMs);
        }, delayMs);
    }

    private processSseMessage(message: string): void {
        if (!message || message.startsWith(":")) {
            return;
        }

        const lines = message.split("\n");
        let eventType = "message";
        let data = "";

        for (const line of lines) {
            if (line.startsWith("event:")) {
                eventType = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
                data = line.slice("data:".length).trim();
            }
        }

        if (!data) return;

        try {
            const parsed = JSON.parse(data) as SyncEvent;
            if (eventType === "file_changed" && parsed.file) {
                this.downloadIfChanged(parsed.file).catch((err: unknown) => {
                    console.error(`[CLIENT] Error updating ${parsed.file?.name}: ${(err as Error).message}`);
                });
            } else if (eventType === "file_deleted" && parsed.filename) {
                const targetFile = path.join(this.targetDir, parsed.filename);
                if (fs.existsSync(targetFile)) {
                    try {
                        fs.unlinkSync(targetFile);
                    } catch {
                        // File may be locked
                    }
                }
                if (this.verbose) {
                    console.log(`[CLIENT] Host deleted: ${parsed.filename}`);
                }
                this.onDelete?.(parsed.filename);
            }
        } catch {
            // Ignore malformed payloads
        }
    }

    private httpRequest(urlStr: string): Promise<{ statusCode: number; body: string }> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(urlStr);
            const isHttps = parsed.protocol === "https:";
            const transport = isHttps ? https : http;

            const req = transport.get(parsed, (res) => {
                let body = "";
                res.on("data", (chunk: Buffer) => {
                    body += chunk.toString("utf8");
                });
                res.on("end", () => {
                    resolve({ statusCode: res.statusCode || 0, body });
                });
            });

            req.on("error", reject);
        });
    }

    private httpDownloadBuffer(urlStr: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(urlStr);
            const isHttps = parsed.protocol === "https:";
            const transport = isHttps ? https : http;

            const req = transport.get(parsed, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed with status ${res.statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks)));
            });

            req.on("error", reject);
        });
    }
}
