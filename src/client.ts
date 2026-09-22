import fs from "node:fs";
import path from "node:path";
import { computeBufferHash, verifyFileHash } from "./hasher.js";
import type { ClientOptions, SyncEvent, SyncFileMeta, SyncManifest } from "./types.js";

export class SyncClient {
    private readonly serverUrl: string;
    private readonly targetDir: string;
    private readonly verbose: boolean;
    private isRunning = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private abortController: AbortController | null = null;

    constructor(private readonly options: ClientOptions) {
        this.serverUrl = options.serverUrl.replace(/\/+$/, "");
        this.targetDir = path.resolve(options.targetDir);
        this.verbose = options.verbose ?? true;
    }

    public async start(): Promise<void> {
        this.isRunning = true;
        fs.mkdirSync(this.targetDir, { recursive: true });

        if (this.verbose) {
            console.log(`[CLIENT] Connecting to host: ${this.serverUrl}`);
            console.log(`[CLIENT] Target folder:   ${this.targetDir}`);
        }

        await this.syncManifest();

        if (this.options.once) {
            if (this.verbose) console.log("[CLIENT] Initial sync complete (--once specified). Exiting.");
            return;
        }

        this.connectSse(1000);
    }

    public stop(): void {
        this.isRunning = false;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.abortController?.abort();
        this.reconnectTimeout = this.abortController = null;
    }

    private fail(message: string): Error {
        const error = new Error(message);
        if (this.verbose) console.error(`[CLIENT] [FATAL] ${message}`);
        this.options.onError?.(error);
        this.stop();
        return error;
    }

    public async syncManifest(): Promise<void> {
        try {
            const res = await fetch(this.url("/api/manifest"));
            if (res.status === 401 || res.status === 403) {
                throw this.fail(`Authentication failed: HTTP ${res.status} (valid bearer token required)`);
            }
            if (!res.ok) throw new Error(`Server returned HTTP ${res.status}: ${await res.text()}`);

            const manifest = (await res.json()) as SyncManifest;
            const files = Object.values(manifest.files || {});

            let syncedCount = 0;
            for (const file of files) {
                if (await this.downloadIfChanged(file)) syncedCount++;
            }

            if (this.verbose) {
                console.log(`[CLIENT] Verified ${files.length} remote file(s). ${syncedCount} downloaded/updated.`);
            }
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.message.includes("Authentication failed")) throw error;
            if (this.verbose) console.error(`[CLIENT] Failed to sync manifest: ${error.message}`);
            this.options.onError?.(error);
            if (this.options.once) throw error;
        }
    }

    public async downloadIfChanged(file: SyncFileMeta): Promise<boolean> {
        const destPath = path.resolve(this.targetDir, file.name);
        const rel = path.relative(this.targetDir, destPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`Path traversal blocked for file: ${file.name}`);
        }
        const destDir = path.dirname(destPath);
        fs.mkdirSync(destDir, { recursive: true });

        if (await verifyFileHash(destPath, file.sha256)) return false;

        const startMs = Date.now();
        const res = await fetch(this.url(`/api/download/${encodeURIComponent(file.name)}`));
        if (res.status === 401 || res.status === 403) {
            throw this.fail(`Authentication failed downloading ${file.name}: HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`Download failed with status ${res.status}`);

        const buffer = Buffer.from(await res.arrayBuffer());
        const downloadedHash = computeBufferHash(buffer);
        if (downloadedHash !== file.sha256) {
            throw new Error(`Hash mismatch for ${file.name}: expected ${file.sha256}, got ${downloadedHash}`);
        }

        const tempPath = path.join(destDir, `.${path.basename(file.name)}.tmp.${Date.now()}`);
        fs.writeFileSync(tempPath, buffer);
        fs.renameSync(tempPath, destPath);

        if (this.verbose) {
            const kb = (file.size / 1024).toFixed(1);
            console.log(`[CLIENT] [SYNC] Transferred ${file.name} (${kb} KB) in ${Date.now() - startMs}ms -> ${destPath}`);
        }

        this.options.onSync?.(file);
        return true;
    }

    private async connectSse(retryDelayMs = 1000): Promise<void> {
        if (!this.isRunning) return;

        if (retryDelayMs > 30000) {
            this.fail(`Connection lost: retry timer (${(retryDelayMs / 1000).toFixed(1)}s) exceeded limit (30.0s)`);
            return;
        }

        const controller = new AbortController();
        this.abortController = controller;

        try {
            const res = await fetch(this.url("/api/events"), {
                headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
                signal: controller.signal
            });

            if (res.status === 401 || res.status === 403) {
                this.fail(`Authentication failed: HTTP ${res.status} (valid bearer token required)`);
                return;
            }

            if (!res.ok) {
                if (this.verbose) console.error(`[CLIENT] SSE connection rejected: HTTP ${res.status}`);
                this.options.onError?.(new Error(`SSE connection rejected: HTTP ${res.status}`));
                this.scheduleReconnect(retryDelayMs);
                return;
            }

            if (this.verbose) console.log("[CLIENT] Connected to real-time live sync stream. Watching for host changes...");

            retryDelayMs = 1000;

            let buffer = "";
            for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
                buffer += Buffer.from(chunk).toString("utf8");
                const parts = buffer.split("\n\n");
                buffer = parts.pop() || "";
                for (const part of parts) this.processSseMessage(part.trim());
            }

            if (!this.isRunning) return;
            if (this.verbose) console.log("[CLIENT] SSE connection closed by server.");
            this.scheduleReconnect(retryDelayMs);
        } catch (err: unknown) {
            if (!this.isRunning || (err instanceof Error && err.name === "AbortError")) return;
            const error = err instanceof Error ? err : new Error(String(err));
            if (this.verbose) console.error(`[CLIENT] Connection error: ${error.message}. Retrying in ${(retryDelayMs / 1000).toFixed(1)}s...`);
            this.options.onError?.(error);
            this.scheduleReconnect(retryDelayMs);
        }
    }

    private scheduleReconnect(delayMs: number): void {
        if (!this.isRunning) return;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        this.reconnectTimeout = setTimeout(async () => {
            if (!this.isRunning) return;
            if (this.verbose) console.log("[CLIENT] Reconnecting...");
            try {
                await this.syncManifest();
            } catch (err: unknown) {
                if (err instanceof Error && err.message.includes("Authentication failed")) return;
            }
            this.connectSse(delayMs * 2);
        }, delayMs);
    }

    private processSseMessage(message: string): void {
        if (!message || message.startsWith(":")) return;
        let eventType = "message", data = "";
        for (const line of message.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (!data) return;

        try {
            const parsed = JSON.parse(data) as SyncEvent;
            if (eventType === "file_changed" && parsed.file) {
                this.downloadIfChanged(parsed.file).catch((err: unknown) => {
                    const error = err instanceof Error ? err : new Error(String(err));
                    if (this.verbose) console.error(`[CLIENT] Error updating ${parsed.file?.name}: ${error.message}`);
                    this.options.onError?.(error);
                });
            } else if (eventType === "file_deleted" && parsed.filename) {
                const destPath = path.resolve(this.targetDir, parsed.filename);
                const rel = path.relative(this.targetDir, destPath);
                if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                    try { fs.unlinkSync(destPath); } catch {}
                    if (this.verbose) console.log(`[CLIENT] Host deleted: ${parsed.filename}`);
                    this.options.onDelete?.(parsed.filename);
                }
            }
        } catch {}
    }

    private url(endpoint: string): string {
        return `${this.serverUrl}${endpoint}${this.options.token ? `?token=${encodeURIComponent(this.options.token)}` : ""}`;
    }
}
