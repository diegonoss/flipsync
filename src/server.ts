import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { DirectoryWatcher } from "./watcher.js";
import type { ServerOptions, ServerInfo, SyncFileMeta } from "./types.js";

const MIME_TYPES: Record<string, string> = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8"
};

const SCRIPT_MIME: Record<string, string> = {
    ps1: "text/plain; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8",
    js: "application/javascript; charset=utf-8"
};

export class SyncServer extends EventEmitter {
    private readonly port: number;
    private readonly host: string;
    private syncDir: string;
    private readonly token?: string;
    private readonly verbose: boolean;
    private readonly scriptsDir?: string;
    private watcher: DirectoryWatcher;
    private server: http.Server | null = null;
    private activeClients = new Set<http.ServerResponse>();
    private pollWaiters = new Set<{ res: http.ServerResponse; timer: NodeJS.Timeout }>();
    private lastChangeTime = Date.now();
    private keepaliveTimer: NodeJS.Timeout | null = null;

    constructor(options: ServerOptions) {
        super();
        this.port = options.port ?? 7890;
        this.host = options.host ?? "0.0.0.0";
        this.syncDir = path.resolve(options.syncDir ?? options.distDir ?? ".");
        this.token = options.token;
        this.verbose = options.verbose ?? true;
        this.scriptsDir = options.scriptsDir;
        this.watcher = options.watcher ?? new DirectoryWatcher(this.syncDir, options.debounceMs ?? 150);

        this.bindWatcherEvents();
    }

    public bindWatcherEvents(): void {
        this.watcher.on("change", (file: SyncFileMeta) => {
            this.lastChangeTime = Date.now();
            if (this.verbose) {
                console.log(`[HOST] File changed: ${file.name} (${(file.size / 1024).toFixed(1)} KB, hash: ${file.sha256.slice(0, 8)}...)`);
            }
            this.broadcast("file_changed", { type: "file_changed", timestamp: this.lastChangeTime, file });
            this.notifyPollWaiters({ changed: true, timestamp: this.lastChangeTime, file });
        });

        this.watcher.on("delete", (filename: string) => {
            this.lastChangeTime = Date.now();
            if (this.verbose) console.log(`[HOST] File deleted: ${filename}`);
            this.broadcast("file_deleted", { type: "file_deleted", timestamp: this.lastChangeTime, filename });
            this.notifyPollWaiters({ changed: true, timestamp: this.lastChangeTime, deleted: filename });
        });
    }

    public setSyncDir(newDir: string, newWatcher?: DirectoryWatcher): void {
        this.syncDir = path.resolve(newDir);
        if (newWatcher) {
            this.watcher = newWatcher;
            this.bindWatcherEvents();
        }
    }

    public getWatcher(): DirectoryWatcher {
        return this.watcher;
    }

    public async start(): Promise<ServerInfo> {
        await this.watcher.initScan();
        this.watcher.startWatching();

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res))
                .on("error", reject)
                .listen(this.port, this.host, () => {
                    const addr = this.server?.address();
                    const port = typeof addr === "object" && addr ? addr.port : this.port;
                    this.startKeepalive();
                    resolve({ port, host: this.host, localUrl: `http://localhost:${port}`, syncDir: this.syncDir });
                });
        });
    }

    public async stop(): Promise<void> {
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        for (const client of this.activeClients) {
            try { client.end(); } catch {}
        }
        this.activeClients.clear();
        this.notifyPollWaiters({ changed: false, timestamp: Date.now() });
        this.watcher.close();

        if (this.server) {
            await new Promise<void>((resolve) => this.server?.close(() => resolve()));
            this.server = null;
        }
    }

    public getConnectedClientsCount(): number {
        return this.activeClients.size + this.pollWaiters.size;
    }

    private sendToClients(payload: string): void {
        for (const client of this.activeClients) {
            try {
                client.write(payload);
            } catch {
                this.activeClients.delete(client);
            }
        }
    }

    private startKeepalive(): void {
        this.keepaliveTimer = setInterval(() => this.sendToClients(": keepalive\n\n"), 15000);
    }

    public broadcast(eventName: string, data: unknown): void {
        this.sendToClients(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    public notifyPollWaiters(data: unknown): void {
        const json = JSON.stringify(data);
        for (const waiter of this.pollWaiters) {
            clearTimeout(waiter.timer);
            try {
                waiter.res.writeHead(200, { "Content-Type": "application/json" }).end(json);
            } catch {
                // Ignore socket error
            }
        }
        this.pollWaiters.clear();
    }

    private isAuthenticated(req: http.IncomingMessage, parsedUrl: URL): boolean {
        if (!this.token) return true;
        const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
            ?? parsedUrl.searchParams.get("token");
        return token === this.token;
    }

    private resolveClientScript(scriptName: string): string | null {
        const candidates: (string | undefined | false)[] = [
            this.scriptsDir && path.join(this.scriptsDir, scriptName)
        ];
        try {
            const dir = path.dirname(fileURLToPath(import.meta.url));
            candidates.push(
                path.resolve(dir, "../scripts", scriptName),
                path.resolve(dir, "../../scripts", scriptName)
            );
        } catch {
            // Ignore fileURLToPath fallback
        }
        candidates.push(
            path.resolve("scripts", scriptName),
            path.resolve("dist-sync", scriptName)
        );
        return candidates.find((c): c is string => Boolean(c && fs.existsSync(c))) ?? null;
    }

    private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = parsedUrl.pathname;

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

        if (req.method === "OPTIONS") return void res.writeHead(204).end();

        // Helper client download endpoints
        const scriptMatch = pathname.match(/^\/(?:sync-)?client\.(ps1|sh|js)$/);
        if (scriptMatch) {
            const ext = scriptMatch[1];
            return this.serveFileOrFallback(res, this.resolveClientScript(`sync-client.${ext}`), SCRIPT_MIME[ext]);
        }

        // Authentication guard for API endpoints
        if (pathname.startsWith("/api/") && !this.isAuthenticated(req, parsedUrl)) {
            return this.sendJson(res, 401, { error: "Unauthorized: valid token required" });
        }

        if (pathname === "/" || pathname === "/api/status") {
            const manifest = this.watcher.getManifest();
            return this.sendJson(res, 200, {
                app: "flipsync",
                status: "ok",
                version: "1.0.0",
                clientsConnected: this.activeClients.size,
                filesCount: Object.keys(manifest.files).length,
                serverTime: Date.now()
            });
        }

        if (pathname === "/api/manifest") {
            return this.sendJson(res, 200, this.watcher.getManifest());
        }

        if (pathname === "/api/wait-change") {
            const since = parseInt(parsedUrl.searchParams.get("since") || "0", 10);
            if (since > 0 && this.lastChangeTime > since) {
                return this.sendJson(res, 200, {
                    changed: true,
                    timestamp: this.lastChangeTime,
                    manifest: this.watcher.getManifest()
                });
            }

            const waiter = {
                res,
                timer: setTimeout(() => {
                    this.pollWaiters.delete(waiter);
                    try {
                        this.sendJson(res, 200, { changed: false, timestamp: Date.now() });
                    } catch {
                        // Ignore
                    }
                }, 25000)
            };

            this.pollWaiters.add(waiter);
            req.on("close", () => {
                clearTimeout(waiter.timer);
                this.pollWaiters.delete(waiter);
            });
            return;
        }

        if (pathname.startsWith("/api/download/")) {
            const filename = decodeURIComponent(pathname.slice(14));

            // Path traversal protection
            if (!filename || filename.startsWith(".") || filename.includes("..")) {
                return this.sendJson(res, 400, { error: "Invalid filename" });
            }

            const safePath = path.resolve(this.syncDir, filename);
            const rel = path.relative(this.syncDir, safePath);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
                return this.sendJson(res, 400, { error: "Access denied" });
            }

            let stat: fs.Stats;
            try {
                stat = fs.statSync(safePath);
                if (!stat.isFile()) throw new Error();
            } catch {
                return this.sendJson(res, 404, { error: "File not found" });
            }

            const meta = this.watcher.getFileMeta(filename);
            const ext = path.extname(filename).toLowerCase();
            res.writeHead(200, {
                "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
                "Content-Length": stat.size,
                "Cache-Control": "no-cache",
                ...(meta ? { ETag: `"${meta.sha256}"`, "X-File-SHA256": meta.sha256 } : {})
            });

            fs.createReadStream(safePath).pipe(res);

            const clientIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "client";
            this.emit("file_served", { file: filename, size: stat.size, clientIp });
            return;
        }

        if (pathname === "/api/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no"
            });

            res.flushHeaders?.();
            res.write(":" + " ".repeat(2048) + "\n\n");
            this.activeClients.add(res);

            if (this.verbose) console.log(`[HOST] Client connected to live sync stream. Total active: ${this.activeClients.size}`);

            const initEvent = JSON.stringify({
                type: "init",
                timestamp: Date.now(),
                manifest: this.watcher.getManifest()
            });
            res.write(`event: init\ndata: ${initEvent}\n\n`);

            req.on("close", () => {
                this.activeClients.delete(res);
                if (this.verbose) console.log(`[HOST] Client disconnected. Remaining: ${this.activeClients.size}`);
            });
            return;
        }

        this.sendJson(res, 404, { error: "Not Found" });
    }

    private serveFileOrFallback(res: http.ServerResponse, filePath: string | null, contentType: string): void {
        if (!filePath) {
            return void res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
                .end("Requested client script not found on host server.");
        }
        res.writeHead(200, { "Content-Type": contentType });
        fs.createReadStream(filePath).pipe(res);
    }
}
