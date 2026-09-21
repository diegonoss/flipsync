import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import { computeBufferHash, computeFileHash } from "../hasher.js";
import { DirectoryWatcher } from "../watcher.js";
import { SyncServer } from "../server.js";
import { startAutoTunnel, detectTailscaleIp, getLocalLanIp } from "../tunnel.js";
import type { SyncFileMeta, SyncManifest, SyncEvent, TunnelResult } from "../types.js";

export type SyncEngineRole = "host" | "client";
export type SyncEngineStatus = "idle" | "ready" | "syncing" | "paused" | "stopped" | "error";

export interface SyncEngineOptions {
    role?: SyncEngineRole;
    mode?: SyncEngineRole; // alias for role
    // Common options
    dir?: string;
    syncDir?: string; // alias
    token?: string;
    noToken?: boolean;

    // Host-specific options
    port?: number;
    host?: string;
    tunnel?: boolean;
    debounceMs?: number;
    scriptsDir?: string;

    // Client-specific options
    serverUrl?: string;
    targetDir?: string;
    once?: boolean;
}

export interface SyncFileProgressEvent {
    file: string;
    transferred: number;
    total: number;
    percent: number;
}

export interface SyncFileCompleteEvent {
    file: string;
    hash: string;
}

export interface SyncConflictEvent {
    file: string;
    localVersion: string;
    remoteVersion: string;
}

export interface SyncErrorEvent {
    error: Error;
    context?: string;
}

export interface SyncFileServedEvent {
    file: string;
    size: number;
    clientIp: string;
}

export interface SyncStartEvent {
    count: number;
    files: string[];
}

export interface SyncEngineReadyEvent {
    role: SyncEngineRole;
    syncDir: string;
    filesCount: number;
    localUrl?: string;
    lanUrl?: string | null;
    tailscaleIp?: string | null;
    tunnelUrl?: string | null;
    activeUrl?: string;
    endpoints: string[];
    token?: string;
    serverUrl?: string;
}

export interface ActiveTransfer {
    file: string;
    transferred: number;
    total: number;
    percent: number;
    speedBps: number;
    startTime: number;
    lastUpdateTime: number;
    lastTransferred: number;
}

export interface SyncEngineState {
    role: SyncEngineRole;
    status: SyncEngineStatus;
    isPaused: boolean;
    syncDir: string;
    endpoints: {
        local?: string;
        lan?: string | null;
        tailscale?: string | null;
        tunnel?: string | null;
        active?: string;
    };
    tunnelState: "disabled" | "connecting" | "online" | "error";
    token?: string;
    serverUrl?: string;
    stats: {
        totalFiles: number;
        syncedFiles: number;
        activeTransfers: number;
        bytesTransferred: number;
        speedBps: number;
        errorsCount: number;
        conflictsCount: number;
        lastSyncTime: number;
    };
    activeTransfers: Array<{
        file: string;
        transferred: number;
        total: number;
        percent: number;
        speedBps: number;
    }>;
}

export class SyncEngine extends EventEmitter {
    private readonly role: SyncEngineRole;
    private syncDir: string;
    private readonly token?: string;
    private readonly host: string;
    private readonly port: number;
    private readonly enableTunnel: boolean;
    private readonly debounceMs: number;
    private readonly scriptsDir?: string;
    private readonly serverUrl?: string;
    private readonly syncOnce: boolean;

    private status: SyncEngineStatus = "idle";
    private _isPaused = false;
    private isRunning = false;

    // Host components
    private server: SyncServer | null = null;
    private watcher: DirectoryWatcher | null = null;
    private tunnelResult: TunnelResult | null = null;
    private localUrl?: string;
    private lanUrl?: string | null;
    private tailscaleIp?: string | null;
    private tunnelUrl?: string | null;
    private tunnelState: "disabled" | "connecting" | "online" | "error" = "disabled";

    // Client components
    private currentSseReq: http.ClientRequest | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private readonly syncedHashes = new Map<string, string>();

    // Queued actions when paused
    private pausedQueue: Array<() => Promise<void>> = [];

    // Transfer tracking
    private readonly activeTransfersMap = new Map<string, ActiveTransfer>();
    private readonly stats = {
        totalFiles: 0,
        syncedFiles: 0,
        bytesTransferred: 0,
        speedBps: 0,
        errorsCount: 0,
        conflictsCount: 0,
        lastSyncTime: 0
    };

    constructor(options: SyncEngineOptions = {}) {
        super();

        const role = options.role ?? options.mode ?? (options.serverUrl ? "client" : "host");
        this.role = role;

        const rawDir = options.syncDir ?? options.dir ?? options.targetDir ?? ".";
        this.syncDir = path.resolve(rawDir);

        this.host = options.host ?? process.env.SYNC_HOST ?? "0.0.0.0";
        this.port = options.port ?? parseInt(process.env.SYNC_PORT || "7890", 10);
        this.enableTunnel = options.tunnel ?? (process.env.SYNC_TUNNEL === "true");
        this.debounceMs = options.debounceMs ?? 150;
        this.scriptsDir = options.scriptsDir;
        this.syncOnce = options.once ?? false;

        if (options.serverUrl) {
            this.serverUrl = options.serverUrl.replace(/\/+$/, "");
        } else if (process.env.SYNC_SERVER) {
            this.serverUrl = process.env.SYNC_SERVER.replace(/\/+$/, "");
        }

        // Token resolution
        const noToken = options.noToken === true || (options.token as unknown) === false;
        if (noToken) {
            this.token = undefined;
        } else if (typeof options.token === "string" && options.token.length > 0) {
            this.token = options.token;
        } else if (process.env.SYNC_TOKEN) {
            this.token = process.env.SYNC_TOKEN;
        } else if (this.role === "host") {
            const tokenFile = path.resolve(".sync-token");
            if (fs.existsSync(tokenFile)) {
                try {
                    this.token = fs.readFileSync(tokenFile, "utf8").trim();
                } catch {
                    this.token = crypto.randomBytes(16).toString("hex");
                }
            } else {
                this.token = crypto.randomBytes(16).toString("hex");
                try {
                    fs.writeFileSync(tokenFile, this.token, { encoding: "utf8" });
                } catch {
                    // Ignore on read-only filesystems
                }
            }
        }
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.status = "syncing";

        if (!fs.existsSync(this.syncDir)) {
            try {
                fs.mkdirSync(this.syncDir, { recursive: true });
            } catch (err: unknown) {
                const error = err instanceof Error ? err : new Error(String(err));
                this.emit("sync:error", { error, context: "fs:mkdir" });
                throw error;
            }
        }

        if (this.role === "host") {
            await this.startHost();
        } else {
            await this.startClient();
        }
    }

    public async stop(): Promise<void> {
        this.isRunning = false;
        this.status = "stopped";

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.currentSseReq) {
            try {
                this.currentSseReq.destroy();
            } catch {
                // Ignore
            }
            this.currentSseReq = null;
        }

        if (this.tunnelResult) {
            try {
                this.tunnelResult.stop();
            } catch {
                // Ignore
            }
            this.tunnelResult = null;
        }

        if (this.watcher) {
            try {
                this.watcher.close();
            } catch {
                // Ignore
            }
            this.watcher = null;
        }

        if (this.server) {
            try {
                await this.server.stop();
            } catch {
                // Ignore
            }
            this.server = null;
        }

        this.activeTransfersMap.clear();
        this.pausedQueue = [];
        this.emit("engine:stopped");
    }

    public pause(): void {
        if (this._isPaused) return;
        this._isPaused = true;
        this.status = "paused";
        this.emit("engine:pause");
    }

    public resume(): void {
        if (!this._isPaused) return;
        this._isPaused = false;
        this.status = "idle";
        this.emit("engine:resume");

        // Drain queued tasks
        if (this.pausedQueue.length > 0) {
            const queue = [...this.pausedQueue];
            this.pausedQueue = [];
            (async () => {
                for (const task of queue) {
                    if (this._isPaused || !this.isRunning) break;
                    try {
                        await task();
                    } catch (err: unknown) {
                        const error = err instanceof Error ? err : new Error(String(err));
                        this.emit("sync:error", { error, context: "queue:drain" });
                    }
                }
                if (this.activeTransfersMap.size === 0) {
                    this.emit("sync:idle");
                }
            })();
        }
    }

    public togglePause(): boolean {
        if (this._isPaused) {
            this.resume();
            return false;
        } else {
            this.pause();
            return true;
        }
    }

    public isPaused(): boolean {
        return this._isPaused;
    }

    public async forceRehash(): Promise<void> {
        if (!this.isRunning) return;

        this.status = "syncing";
        if (this.role === "host") {
            if (this.watcher) {
                const manifest = await this.watcher.initScan();
                const files = Object.values(manifest.files);
                this.stats.totalFiles = files.length;
                this.emit("sync:start", { count: files.length, files: files.map((f) => f.name) });

                for (const f of files) {
                    this.emit("sync:file-complete", { file: f.name, hash: f.sha256 });
                }

                if (this.server) {
                    this.server.notifyPollWaiters({
                        changed: true,
                        timestamp: Date.now(),
                        manifest
                    });
                    this.server.broadcast("manifest_refresh", { timestamp: Date.now() });
                }
            }
            this.status = "idle";
            this.emit("sync:idle");
        } else {
            // Client: re-scan and sync
            await this.syncManifest();
            this.status = "idle";
            this.emit("sync:idle");
        }
    }

    public getState(): SyncEngineState {
        const activeUrl = this.tunnelUrl || this.lanUrl || this.localUrl || this.serverUrl;
        const endpointsList: string[] = [];
        if (this.localUrl) endpointsList.push(this.localUrl);
        if (this.lanUrl) endpointsList.push(this.lanUrl);
        if (this.tailscaleIp) endpointsList.push(`http://${this.tailscaleIp}:${this.port}`);
        if (this.tunnelUrl) endpointsList.push(this.tunnelUrl);
        if (this.serverUrl) endpointsList.push(this.serverUrl);

        return {
            role: this.role,
            status: this.status,
            isPaused: this._isPaused,
            syncDir: this.syncDir,
            endpoints: {
                local: this.localUrl,
                lan: this.lanUrl,
                tailscale: this.tailscaleIp ? `http://${this.tailscaleIp}:${this.port}` : null,
                tunnel: this.tunnelUrl,
                active: activeUrl
            },
            tunnelState: this.tunnelState,
            token: this.token,
            serverUrl: this.serverUrl,
            stats: {
                ...this.stats,
                activeTransfers: this.activeTransfersMap.size
            },
            activeTransfers: Array.from(this.activeTransfersMap.values()).map((t) => ({
                file: t.file,
                transferred: t.transferred,
                total: t.total,
                percent: t.percent,
                speedBps: t.speedBps
            }))
        };
    }

    public getRole(): SyncEngineRole {
        return this.role;
    }

    public getSyncDir(): string {
        return this.syncDir;
    }

    public async setSyncDir(newDir: string): Promise<void> {
        const resolved = path.resolve(newDir);
        this.syncDir = resolved;

        if (!fs.existsSync(this.syncDir)) {
            try {
                fs.mkdirSync(this.syncDir, { recursive: true });
            } catch (err: unknown) {
                const error = err instanceof Error ? err : new Error(String(err));
                this.emit("sync:error", { error, context: "setSyncDir:mkdir" });
                throw error;
            }
        }

        if (this.isRunning) {
            this.status = "syncing";
            if (this.role === "host") {
                if (this.watcher) {
                    try {
                        this.watcher.close();
                    } catch {
                        // Ignore
                    }
                }
                this.watcher = new DirectoryWatcher(this.syncDir, this.debounceMs);
                this.watcher.on("change", (file: SyncFileMeta) => {
                    if (this._isPaused) {
                        this.pausedQueue.push(async () => this.handleHostFileChange(file));
                        return;
                    }
                    this.handleHostFileChange(file);
                });
                this.watcher.on("delete", (filename: string) => {
                    this.stats.totalFiles = Math.max(0, this.stats.totalFiles - 1);
                    this.emit("sync:file-deleted", { file: filename });
                    if (this.activeTransfersMap.size === 0) {
                        this.emit("sync:idle");
                    }
                });
                this.watcher.on("error", (err: Error) => {
                    this.stats.errorsCount++;
                    this.emit("sync:error", { error: err, context: "watcher" });
                });

                const manifest = await this.watcher.initScan();
                this.watcher.startWatching();
                this.stats.totalFiles = Object.keys(manifest.files).length;

                if (this.server) {
                    this.server.setSyncDir(this.syncDir, this.watcher);
                    this.server.notifyPollWaiters({
                        changed: true,
                        timestamp: Date.now(),
                        manifest
                    });
                    this.server.broadcast("manifest_refresh", { timestamp: Date.now() });
                }

                const endpointsList: string[] = [];
                if (this.localUrl) endpointsList.push(this.localUrl);
                if (this.lanUrl) endpointsList.push(this.lanUrl);
                if (this.tailscaleIp) endpointsList.push(`http://${this.tailscaleIp}:${this.port}`);
                if (this.tunnelUrl) endpointsList.push(this.tunnelUrl);

                this.emit("engine:ready", {
                    role: "host",
                    syncDir: this.syncDir,
                    filesCount: this.stats.totalFiles,
                    localUrl: this.localUrl,
                    lanUrl: this.lanUrl,
                    tailscaleIp: this.tailscaleIp,
                    tunnelUrl: this.tunnelUrl,
                    activeUrl: this.tunnelUrl || this.lanUrl || this.localUrl,
                    endpoints: endpointsList,
                    token: this.token
                });
                this.status = "idle";
                this.emit("sync:idle");
            } else {
                this.syncedHashes.clear();
                await this.scanLocalTargetDir();
                await this.syncManifest();
                this.emit("engine:ready", {
                    role: "client",
                    syncDir: this.syncDir,
                    filesCount: this.stats.totalFiles,
                    serverUrl: this.serverUrl,
                    activeUrl: this.serverUrl,
                    endpoints: [this.serverUrl!],
                    token: this.token
                });
                this.status = "idle";
                this.emit("sync:idle");
            }
        }
    }

    public getToken(): string | undefined {
        return this.token;
    }

    // =========================================================================
    // Host Mode Implementation
    // =========================================================================
    private async startHost(): Promise<void> {
        this.watcher = new DirectoryWatcher(this.syncDir, this.debounceMs);

        this.watcher.on("change", (file: SyncFileMeta) => {
            if (this._isPaused) {
                this.pausedQueue.push(async () => {
                    this.handleHostFileChange(file);
                });
                return;
            }
            this.handleHostFileChange(file);
        });

        this.watcher.on("delete", (filename: string) => {
            this.stats.totalFiles = Math.max(0, this.stats.totalFiles - 1);
            this.emit("sync:file-deleted", { file: filename });
            if (this.activeTransfersMap.size === 0) {
                this.emit("sync:idle");
            }
        });

        this.watcher.on("error", (err: Error) => {
            this.stats.errorsCount++;
            this.emit("sync:error", { error: err, context: "watcher" });
        });

        // 1. Initial scan
        let initialManifest: SyncManifest;
        try {
            initialManifest = await this.watcher.initScan();
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: "watcher:initScan" });
            throw error;
        }

        const files = Object.values(initialManifest.files);
        this.stats.totalFiles = files.length;
        for (const file of files) {
            this.syncedHashes.set(file.name, file.sha256);
        }

        this.watcher.startWatching();

        // 2. Start HTTP & SSE Server
        this.server = new SyncServer({
            port: this.port,
            host: this.host,
            syncDir: this.syncDir,
            token: this.token,
            scriptsDir: this.scriptsDir,
            verbose: false,
            watcher: this.watcher
        });

        this.server.on("file_served", (event: { file: string; size: number; clientIp: string }) => {
            this.stats.syncedFiles++;
            this.stats.bytesTransferred += event.size;
            this.stats.lastSyncTime = Date.now();
            this.emit("sync:file-served", event);
        });

        try {
            const info = await this.server.start();
            this.localUrl = info.localUrl;
            const lanIp = getLocalLanIp();
            this.lanUrl = lanIp ? `http://${lanIp}:${info.port}` : null;
            this.tailscaleIp = detectTailscaleIp();
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: "server:start" });
            throw error;
        }

        // 3. Optional Tunnel
        if (this.enableTunnel) {
            this.tunnelState = "connecting";
            try {
                this.tunnelResult = await startAutoTunnel(this.port);
                this.tunnelUrl = this.tunnelResult.url;
                this.tunnelState = "online";
                if (this.tunnelUrl) {
                    try {
                        fs.writeFileSync(".sync-url", this.tunnelUrl, "utf8");
                    } catch {
                        // Ignore
                    }
                }
            } catch (err: unknown) {
                this.tunnelState = "error";
                const error = err instanceof Error ? err : new Error(String(err));
                this.stats.errorsCount++;
                this.emit("sync:error", { error, context: "tunnel:start" });
            }
        }

        this.status = "ready";

        const endpointsList: string[] = [];
        if (this.localUrl) endpointsList.push(this.localUrl);
        if (this.lanUrl) endpointsList.push(this.lanUrl);
        if (this.tailscaleIp) endpointsList.push(`http://${this.tailscaleIp}:${this.port}`);
        if (this.tunnelUrl) endpointsList.push(this.tunnelUrl);

        const readyEvent: SyncEngineReadyEvent = {
            role: "host",
            syncDir: this.syncDir,
            filesCount: this.stats.totalFiles,
            localUrl: this.localUrl,
            lanUrl: this.lanUrl,
            tailscaleIp: this.tailscaleIp,
            tunnelUrl: this.tunnelUrl,
            activeUrl: this.tunnelUrl || this.lanUrl || this.localUrl,
            endpoints: endpointsList,
            token: this.token
        };

        this.emit("engine:ready", readyEvent);
        this.status = "idle";
        this.emit("sync:idle");
    }

    private handleHostFileChange(file: SyncFileMeta): void {
        this.status = "syncing";
        this.syncedHashes.set(file.name, file.sha256);
        this.stats.lastSyncTime = Date.now();

        this.emit("sync:start", { count: 1, files: [file.name] });
        this.emit("sync:file-progress", {
            file: file.name,
            transferred: file.size,
            total: file.size,
            percent: 100
        });
        this.emit("sync:file-complete", {
            file: file.name,
            hash: file.sha256
        });

        this.status = "idle";
        this.emit("sync:idle");
    }

    // =========================================================================
    // Client Mode Implementation
    // =========================================================================
    private async startClient(): Promise<void> {
        if (!this.serverUrl) {
            const error = new Error("Missing required server URL for client mode");
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: "client:init" });
            throw error;
        }

        // Initial scan of local target dir to discover existing hashes
        await this.scanLocalTargetDir();

        // Initial manifest sync
        await this.syncManifest();

        const readyEvent: SyncEngineReadyEvent = {
            role: "client",
            syncDir: this.syncDir,
            filesCount: this.stats.totalFiles,
            serverUrl: this.serverUrl,
            activeUrl: this.serverUrl,
            endpoints: [this.serverUrl],
            token: this.token
        };

        this.status = "ready";
        this.emit("engine:ready", readyEvent);

        if (this.syncOnce) {
            this.status = "idle";
            this.emit("sync:idle");
            return;
        }

        // Connect to SSE stream
        this.connectSse(1000);
        this.status = "idle";
        this.emit("sync:idle");
    }

    private async scanLocalTargetDir(): Promise<void> {
        const scanDir = async (dir: string, relPrefix = ""): Promise<void> => {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith(".") || entry.name.includes(".tmp.") || entry.name === "node_modules") {
                    continue;
                }
                const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await scanDir(full, rel);
                } else if (entry.isFile()) {
                    const meta = await computeFileHash(full);
                    if (meta) {
                        this.syncedHashes.set(rel, meta.sha256);
                    }
                }
            }
        };

        await scanDir(this.syncDir);
    }

    private url(endpoint: string): string {
        return `${this.serverUrl}${endpoint}${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
    }

    private failFatal(message: string, context: string): Error {
        const error = new Error(message);
        this.stats.errorsCount++;
        this.emit("sync:error", { error, context });
        this.status = "error";
        this.stop();
        return error;
    }

    public async syncManifest(): Promise<void> {
        if (!this.serverUrl) return;

        try {
            const res = await this.httpRequest(this.url("/api/manifest"));
            if (res.statusCode === 401 || res.statusCode === 403) {
                throw this.failFatal(`Authentication failed: HTTP ${res.statusCode} (valid bearer token required)`, "auth");
            }
            if (res.statusCode !== 200) {
                throw new Error(`Server returned HTTP ${res.statusCode}: ${res.body}`);
            }

            const manifest = JSON.parse(res.body) as SyncManifest;
            const files = Object.values(manifest.files || {});
            this.stats.totalFiles = files.length;

            const filesToDownload: SyncFileMeta[] = [];
            for (const file of files) {
                const destPath = path.join(this.syncDir, file.name);
                if (fs.existsSync(destPath)) {
                    const localMeta = await computeFileHash(destPath);
                    if (localMeta && localMeta.sha256 === file.sha256) {
                        this.syncedHashes.set(file.name, file.sha256);
                        continue;
                    }
                }
                filesToDownload.push(file);
            }

            if (filesToDownload.length > 0) {
                this.status = "syncing";
                this.emit("sync:start", {
                    count: filesToDownload.length,
                    files: filesToDownload.map((f) => f.name)
                });

                for (const file of filesToDownload) {
                    if (!this.isRunning) break;
                    if (this._isPaused) {
                        this.pausedQueue.push(async () => {
                            await this.downloadFileWithProgress(file);
                        });
                        continue;
                    }
                    await this.downloadFileWithProgress(file);
                }
            }

            this.status = "idle";
            this.emit("sync:idle");
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.message.includes("Authentication failed")) throw error;
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: "syncManifest" });
            if (this.syncOnce) throw error;
        }
    }

    public async downloadFileWithProgress(file: SyncFileMeta): Promise<boolean> {
        const destPath = path.join(this.syncDir, file.name);
        const destDir = path.dirname(destPath);

        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        // Conflict detection: if local file exists and was modified since last sync
        if (fs.existsSync(destPath)) {
            const localMeta = await computeFileHash(destPath);
            if (localMeta) {
                if (localMeta.sha256 === file.sha256) {
                    this.syncedHashes.set(file.name, file.sha256);
                    return false;
                }

                // If known last-synced hash differs from current local hash, user modified it locally!
                const lastKnown = this.syncedHashes.get(file.name);
                if (lastKnown && lastKnown !== localMeta.sha256) {
                    this.stats.conflictsCount++;
                    this.emit("sync:conflict", {
                        file: file.name,
                        localVersion: localMeta.sha256.slice(0, 8),
                        remoteVersion: file.sha256.slice(0, 8)
                    });

                    // Safely backup conflicting local version
                    try {
                        const conflictBackup = path.join(
                            destDir,
                            `${path.basename(file.name)}.conflict.${Date.now()}`
                        );
                        fs.copyFileSync(destPath, conflictBackup);
                    } catch {
                        // Ignore backup failure
                    }
                }
            }
        }

        const downloadUrl = this.url(`/api/download/${encodeURIComponent(file.name)}`);
        const startTime = Date.now();
        let lastUpdateTime = startTime;
        let lastTransferred = 0;

        const transferInfo: ActiveTransfer = {
            file: file.name,
            transferred: 0,
            total: file.size,
            percent: 0,
            speedBps: 0,
            startTime,
            lastUpdateTime,
            lastTransferred: 0
        };
        this.activeTransfersMap.set(file.name, transferInfo);

        let buffer: Buffer;
        try {
            buffer = await new Promise<Buffer>((resolve, reject) => {
                const parsed = new URL(downloadUrl);
                const isHttps = parsed.protocol === "https:";
                const transport = isHttps ? https : http;

                const req = transport.get(parsed, (res) => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        reject(this.failFatal(`Authentication failed downloading ${file.name}: HTTP ${res.statusCode} (valid bearer token required)`, "auth"));
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`Download failed with status ${res.statusCode}`));
                        return;
                    }

                    const contentLength = parseInt(res.headers["content-length"] || "0", 10);
                    const total = contentLength || file.size;
                    transferInfo.total = total;

                    let transferred = 0;
                    const chunks: Buffer[] = [];

                    res.on("data", (chunk: Buffer) => {
                        chunks.push(chunk);
                        transferred += chunk.length;
                        const now = Date.now();
                        const timeDiff = (now - lastUpdateTime) / 1000;

                        if (timeDiff >= 0.1 || transferred >= total) {
                            const speed = timeDiff > 0 ? (transferred - lastTransferred) / timeDiff : 0;
                            transferInfo.speedBps = speed;
                            transferInfo.transferred = transferred;
                            transferInfo.percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 100;
                            lastUpdateTime = now;
                            lastTransferred = transferred;

                            this.emit("sync:file-progress", {
                                file: file.name,
                                transferred,
                                total,
                                percent: transferInfo.percent
                            });
                        }
                    });

                    res.on("end", () => {
                        transferInfo.transferred = transferred;
                        transferInfo.percent = 100;
                        resolve(Buffer.concat(chunks));
                    });

                    res.on("error", reject);
                });

                req.on("error", reject);
            });
        } catch (err: unknown) {
            this.activeTransfersMap.delete(file.name);
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.message.includes("Authentication failed")) throw error;
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: `download:${file.name}` });
            throw error;
        }

        // Verify SHA-256 integrity
        const downloadedHash = computeBufferHash(buffer);
        if (downloadedHash !== file.sha256) {
            this.activeTransfersMap.delete(file.name);
            const error = new Error(`Hash mismatch for ${file.name}: expected ${file.sha256}, got ${downloadedHash}`);
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: `verify:${file.name}` });
            throw error;
        }

        // Atomic write
        const tempFilename = `.${path.basename(file.name)}.tmp.${Date.now()}`;
        const tempPath = path.join(destDir, tempFilename);

        try {
            fs.writeFileSync(tempPath, buffer);
            fs.renameSync(tempPath, destPath);
        } catch (err: unknown) {
            this.activeTransfersMap.delete(file.name);
            const error = err instanceof Error ? err : new Error(String(err));
            this.stats.errorsCount++;
            this.emit("sync:error", { error, context: `write:${file.name}` });
            throw error;
        }

        this.activeTransfersMap.delete(file.name);
        this.syncedHashes.set(file.name, downloadedHash);
        this.stats.syncedFiles++;
        this.stats.bytesTransferred += buffer.length;
        this.stats.lastSyncTime = Date.now();

        this.emit("sync:file-complete", {
            file: file.name,
            hash: downloadedHash
        });

        return true;
    }

    private connectSse(retryDelayMs = 1000): void {
        if (!this.isRunning || !this.serverUrl) return;

        if (retryDelayMs > 30000) {
            this.failFatal(`Connection lost: retry timer (${(retryDelayMs / 1000).toFixed(1)}s) exceeded limit (30.0s)`, "reconnect:limit");
            return;
        }

        const parsed = new URL(this.url("/api/events"));
        const transport = parsed.protocol === "https:" ? https : http;

        const req = transport.request(
            parsed,
            {
                headers: {
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache"
                }
            },
            (res) => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    this.failFatal(`Authentication failed: HTTP ${res.statusCode} (valid bearer token required)`, "auth");
                    return;
                }

                if (res.statusCode !== 200) {
                    const err = new Error(`SSE connection rejected: HTTP ${res.statusCode}`);
                    this.emit("sync:error", { error: err, context: "sse:status" });
                    this.scheduleReconnect(retryDelayMs);
                    return;
                }

                retryDelayMs = 1000;

                let buffer = "";
                res.on("data", (chunk: Buffer) => {
                    buffer += chunk.toString("utf8");
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop() || "";
                    for (const part of parts) this.processSseMessage(part.trim());
                });

                res.on("end", () => { if (this.isRunning) this.scheduleReconnect(retryDelayMs); });
                res.on("error", (err) => { if (this.isRunning) this.emit("sync:error", { error: err, context: "sse:stream" }); });
            }
        );

        this.currentSseReq = req;

        req.on("error", (err) => {
            if (this.isRunning) {
                this.emit("sync:error", { error: err, context: "sse:request" });
                this.scheduleReconnect(retryDelayMs);
            }
        });

        req.end();
    }

    private scheduleReconnect(delayMs: number): void {
        if (!this.isRunning) return;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        this.reconnectTimeout = setTimeout(async () => {
            if (!this.isRunning) return;
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
                const file = parsed.file;
                if (this._isPaused) {
                    this.pausedQueue.push(async () => {
                        await this.downloadFileWithProgress(file);
                    });
                    return;
                }

                this.status = "syncing";
                this.emit("sync:start", { count: 1, files: [file.name] });
                this.downloadFileWithProgress(file)
                    .then(() => {
                        this.status = "idle";
                        this.emit("sync:idle");
                    })
                    .catch((err: unknown) => {
                        const error = err instanceof Error ? err : new Error(String(err));
                        this.emit("sync:error", { error, context: `sse:${file.name}` });
                        this.status = "idle";
                        this.emit("sync:idle");
                    });
            } else if (eventType === "file_deleted" && parsed.filename) {
                const targetFile = path.join(this.syncDir, parsed.filename);
                if (fs.existsSync(targetFile)) {
                    try {
                        fs.unlinkSync(targetFile);
                    } catch {
                        // Ignore if locked
                    }
                }
                this.syncedHashes.delete(parsed.filename);
                this.emit("sync:file-deleted", { file: parsed.filename });
                if (this.activeTransfersMap.size === 0) {
                    this.emit("sync:idle");
                }
            }
        } catch {
            // Malformed SSE payload ignored
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
}
