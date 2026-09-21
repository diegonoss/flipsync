import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { URL, fileURLToPath } from "node:url";
import { DirectoryWatcher } from "./watcher.js";
import type { ServerOptions, ServerInfo, SyncFileMeta } from "./types.js";

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
                const kb = (file.size / 1024).toFixed(1);
                console.log(`[HOST] File changed: ${file.name} (${kb} KB, hash: ${file.sha256.slice(0, 8)}...)`);
            }
            this.broadcast("file_changed", {
                type: "file_changed",
                timestamp: this.lastChangeTime,
                file
            });
            this.notifyPollWaiters({
                changed: true,
                timestamp: this.lastChangeTime,
                file
            });
        });

        this.watcher.on("delete", (filename: string) => {
            this.lastChangeTime = Date.now();
            if (this.verbose) {
                console.log(`[HOST] File deleted: ${filename}`);
            }
            this.broadcast("file_deleted", {
                type: "file_deleted",
                timestamp: this.lastChangeTime,
                filename
            });
            this.notifyPollWaiters({
                changed: true,
                timestamp: this.lastChangeTime,
                deleted: filename
            });
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
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on("error", (err) => {
                reject(err);
            });

            this.server.listen(this.port, this.host, () => {
                const addr = this.server?.address();
                const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
                const localUrl = `http://localhost:${actualPort}`;

                this.startKeepalive();
                resolve({
                    port: actualPort,
                    host: this.host,
                    localUrl,
                    syncDir: this.syncDir
                });
            });
        });
    }

    public async stop(): Promise<void> {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }

        for (const client of this.activeClients) {
            try {
                client.end();
            } catch {
                // Ignore socket errors
            }
        }
        this.activeClients.clear();

        for (const waiter of this.pollWaiters) {
            clearTimeout(waiter.timer);
            try {
                waiter.res.writeHead(200, { "Content-Type": "application/json" });
                waiter.res.end(JSON.stringify({ changed: false, timestamp: Date.now() }));
            } catch {
                // Ignore
            }
        }
        this.pollWaiters.clear();

        this.watcher.close();

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server?.close(() => resolve());
            });
            this.server = null;
        }
    }

    public getConnectedClientsCount(): number {
        return this.activeClients.size + this.pollWaiters.size;
    }

    private startKeepalive(): void {
        this.keepaliveTimer = setInterval(() => {
            for (const client of this.activeClients) {
                try {
                    client.write(": keepalive\n\n");
                } catch {
                    this.activeClients.delete(client);
                }
            }
        }, 15000);
    }

    public broadcast(eventName: string, data: unknown): void {
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.activeClients) {
            try {
                client.write(payload);
            } catch {
                this.activeClients.delete(client);
            }
        }
    }

    public notifyPollWaiters(data: unknown): void {
        const json = JSON.stringify(data);
        for (const waiter of this.pollWaiters) {
            clearTimeout(waiter.timer);
            try {
                waiter.res.writeHead(200, { "Content-Type": "application/json" });
                waiter.res.end(json);
            } catch {
                // Ignore socket error
            }
        }
        this.pollWaiters.clear();
    }

    private isAuthenticated(req: http.IncomingMessage, parsedUrl: URL): boolean {
        if (!this.token) return true;

        const authHeader = req.headers.authorization;
        if (authHeader) {
            const parts = authHeader.split(" ");
            if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer" && parts[1] === this.token) {
                return true;
            }
        }

        const queryToken = parsedUrl.searchParams.get("token");
        if (queryToken && queryToken === this.token) {
            return true;
        }

        return false;
    }

    private resolveClientScript(scriptName: string): string | null {
        const candidates: string[] = [];
        if (this.scriptsDir) {
            candidates.push(path.join(this.scriptsDir, scriptName));
        }

        try {
            const currentDir = path.dirname(fileURLToPath(import.meta.url));
            candidates.push(path.resolve(currentDir, "../scripts", scriptName));
            candidates.push(path.resolve(currentDir, "../../scripts", scriptName));
        } catch {
            // fileURLToPath fallback
        }

        candidates.push(path.resolve("scripts", scriptName));
        candidates.push(path.resolve("dist-sync", scriptName));

        for (const c of candidates) {
            if (fs.existsSync(c)) {
                return c;
            }
        }
        return null;
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = parsedUrl.pathname;

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        // Helper client download endpoints
        if (pathname === "/client.ps1" || pathname === "/sync-client.ps1") {
            const scriptPath = this.resolveClientScript("sync-client.ps1");
            this.serveFileOrFallback(res, scriptPath, "text/plain; charset=utf-8");
            return;
        }

        if (pathname === "/client.sh" || pathname === "/sync-client.sh") {
            const scriptPath = this.resolveClientScript("sync-client.sh");
            this.serveFileOrFallback(res, scriptPath, "text/x-shellscript; charset=utf-8");
            return;
        }

        if (pathname === "/client.js" || pathname === "/sync-client.js") {
            const scriptPath = this.resolveClientScript("sync-client.js");
            this.serveFileOrFallback(res, scriptPath, "application/javascript; charset=utf-8");
            return;
        }

        // Authentication guard for API endpoints
        if (pathname.startsWith("/api/")) {
            if (!this.isAuthenticated(req, parsedUrl)) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized: valid token required" }));
                return;
            }
        }

        if (pathname === "/" || pathname === "/api/status") {
            const manifest = this.watcher.getManifest();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                app: "flipsync",
                status: "ok",
                version: "1.0.0",
                clientsConnected: this.activeClients.size,
                filesCount: Object.keys(manifest.files).length,
                serverTime: Date.now()
            }));
            return;
        }

        if (pathname === "/api/manifest") {
            const manifest = this.watcher.getManifest();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(manifest));
            return;
        }

        if (pathname === "/api/wait-change") {
            const sinceStr = parsedUrl.searchParams.get("since");
            const since = sinceStr ? parseInt(sinceStr, 10) : 0;

            if (since > 0 && this.lastChangeTime > since) {
                const manifest = this.watcher.getManifest();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    changed: true,
                    timestamp: this.lastChangeTime,
                    manifest
                }));
                return;
            }

            const waiter = {
                res,
                timer: setTimeout(() => {
                    this.pollWaiters.delete(waiter);
                    try {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            changed: false,
                            timestamp: Date.now()
                        }));
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
            const rawFilename = pathname.slice("/api/download/".length);
            const filename = decodeURIComponent(rawFilename);

            // Path traversal protection
            if (!filename || filename.startsWith(".") || filename.includes("..")) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid filename" }));
                return;
            }

            const safePath = path.resolve(this.syncDir, filename);
            const rel = path.relative(this.syncDir, safePath);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Access denied" }));
                return;
            }

            if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "File not found" }));
                return;
            }

            const meta = this.watcher.getFileMeta(filename);
            const stat = fs.statSync(safePath);
            const ext = path.extname(filename).toLowerCase();
            let contentType = "application/octet-stream";
            if (ext === ".js" || ext === ".mjs") contentType = "application/javascript";
            else if (ext === ".json") contentType = "application/json";
            else if (ext === ".txt" || ext === ".md") contentType = "text/plain; charset=utf-8";
            else if (ext === ".html") contentType = "text/html; charset=utf-8";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Length": stat.size,
                "ETag": meta ? `"${meta.sha256}"` : undefined,
                "X-File-SHA256": meta ? meta.sha256 : undefined,
                "Cache-Control": "no-cache"
            });

            const stream = fs.createReadStream(safePath);
            stream.pipe(res);

            const clientIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "client";
            this.emit("file_served", {
                file: filename,
                size: stat.size,
                clientIp
            });
            return;
        }

        if (pathname === "/api/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            });

            if (typeof res.flushHeaders === "function") {
                res.flushHeaders();
            }

            // Flush reverse-proxy buffers
            res.write(":" + " ".repeat(2048) + "\n\n");

            this.activeClients.add(res);

            if (this.verbose) {
                console.log(`[HOST] Client connected to live sync stream. Total active: ${this.activeClients.size}`);
            }

            const manifest = this.watcher.getManifest();
            const initEvent = JSON.stringify({
                type: "init",
                timestamp: Date.now(),
                manifest
            });
            res.write(`event: init\ndata: ${initEvent}\n\n`);

            req.on("close", () => {
                this.activeClients.delete(res);
                if (this.verbose) {
                    console.log(`[HOST] Client disconnected. Remaining: ${this.activeClients.size}`);
                }
            });
            return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
    }

    private serveFileOrFallback(res: http.ServerResponse, filePath: string | null, contentType: string): void {
        if (filePath && fs.existsSync(filePath)) {
            res.writeHead(200, { "Content-Type": contentType });
            fs.createReadStream(filePath).pipe(res);
        } else {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Requested client script not found on host server.");
        }
    }
}
