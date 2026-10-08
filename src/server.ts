import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { finished } from "node:stream";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { DirectoryWatcher } from "./watcher.js";
import type { ServerOptions, ServerInfo, SyncFileMeta } from "./types.js";

const MIME_TYPES: Record<string, string> = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ps1": "text/plain; charset=utf-8",
    ".sh": "text/x-shellscript; charset=utf-8"
};

export class SyncServer extends EventEmitter {
    private syncDir: string;
    private watcher: DirectoryWatcher;
    private server: http.Server | null = null;
    private readonly activeClients = new Set<http.ServerResponse>();
    private readonly activeDownloads = new Set<http.ServerResponse>();
    private readonly pollWaiters = new Set<{ res: http.ServerResponse; timer: NodeJS.Timeout }>();
    private lastChangeTime = Date.now();
    private keepaliveTimer: NodeJS.Timeout | null = null;
    private transferCounter = 0;

    constructor(private readonly options: ServerOptions) {
        super();
        this.syncDir = path.resolve(options.syncDir ?? options.distDir ?? ".");
        this.watcher = options.watcher ?? new DirectoryWatcher(this.syncDir, options.debounceMs ?? 150);
        this.bindWatcherEvents();
    }

    public bindWatcherEvents(): void {
        const verbose = this.options.verbose ?? true;
        this.watcher.on("change", (file: SyncFileMeta) => {
            this.lastChangeTime = Date.now();
            if (verbose) console.log(`[HOST] File changed: ${file.name} (${(file.size / 1024).toFixed(1)} KB, hash: ${file.sha256.slice(0, 8)}...)`);
            this.broadcast("file_changed", { type: "file_changed", timestamp: this.lastChangeTime, file });
            this.notifyPollWaiters({ changed: true, timestamp: this.lastChangeTime, file });
        });

        this.watcher.on("delete", (filename: string) => {
            this.lastChangeTime = Date.now();
            if (verbose) console.log(`[HOST] File deleted: ${filename}`);
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
        await this.watcher.startWatching();
        void this.watcher.initScan();

        const port = this.options.port ?? 7890;
        const host = this.options.host ?? "0.0.0.0";

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res))
                .on("error", reject)
                .listen(port, host, () => {
                    const addr = this.server?.address();
                    const actualPort = addr && typeof addr === "object" ? addr.port : port;
                    this.keepaliveTimer = setInterval(() => this.sendToClients(": keepalive\n\n"), 15000);
                    resolve({ port: actualPort, host, localUrl: `http://localhost:${actualPort}`, syncDir: this.syncDir });
                });
        });
    }

    public abortTransfers(): void {
        for (const res of this.activeDownloads) {
            try { res.destroy(); } catch {}
        }
        this.activeDownloads.clear();
    }

    public async stop(): Promise<void> {
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        for (const client of this.activeClients) {
            try { client.destroy(); } catch {}
        }
        this.activeClients.clear();
        this.abortTransfers();
        this.notifyPollWaiters({ changed: false, timestamp: Date.now() });
        this.watcher.close();

        if (this.server) {
            const srv = this.server;
            this.server = null;
            srv.closeAllConnections();
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 500);
                srv.close(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
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

    public broadcast(eventName: string, data: unknown): void {
        this.sendToClients(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    public notifyPollWaiters(data: unknown): void {
        const json = JSON.stringify(data);
        for (const { res, timer } of this.pollWaiters) {
            clearTimeout(timer);
            try {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(json);
            } catch {}
        }
        this.pollWaiters.clear();
    }

    private isAuthenticated(req: http.IncomingMessage, parsedUrl: URL): boolean {
        if (!this.options.token) return true;
        const auth = req.headers.authorization;
        let bearerToken: string | undefined;
        if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === "bearer ") {
            bearerToken = auth.slice(7).trim();
        }
        const token = bearerToken ?? parsedUrl.searchParams.get("token");
        if (!token) return false;
        const a = Buffer.from(token);
        const b = Buffer.from(this.options.token);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    private resolveClientScript(scriptName: string): string | null {
        const candidates = [
            this.options.scriptsDir && path.join(this.options.scriptsDir, scriptName),
            fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url)),
            fileURLToPath(new URL(`../../scripts/${scriptName}`, import.meta.url)),
            path.resolve("scripts", scriptName)
        ];
        return candidates.find((c): c is string => Boolean(c && fs.existsSync(c))) ?? null;
    }

    private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
    }

    private handleClientScript(pathname: string, res: http.ServerResponse): boolean {
        const scriptMatch = /^\/(?:sync-)?client\.(ps1|sh|js)$/.exec(pathname);
        if (!scriptMatch) return false;

        const file = this.resolveClientScript(`sync-client.${scriptMatch[1]}`);
        if (!file) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
                .end("Requested client script not found on host server.");
            return true;
        }
        res.writeHead(200, { "Content-Type": MIME_TYPES["." + scriptMatch[1]] });
        fs.createReadStream(file).pipe(res);
        return true;
    }

    private handleWaitChange(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL): void {
        const since = Number.parseInt(parsedUrl.searchParams.get("since") || "0", 10);
        if (since > 0 && this.lastChangeTime > since) {
            this.sendJson(res, 200, {
                changed: true,
                timestamp: this.lastChangeTime,
                manifest: this.watcher.getManifest()
            });
            return;
        }

        const waiter = {
            res,
            timer: setTimeout(() => {
                this.pollWaiters.delete(waiter);
                try {
                    this.sendJson(res, 200, { changed: false, timestamp: Date.now() });
                } catch {}
            }, 25000)
        };

        this.pollWaiters.add(waiter);
        req.on("close", () => {
            clearTimeout(waiter.timer);
            this.pollWaiters.delete(waiter);
        });
    }

    private handleDownload(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
        let filename: string;
        try {
            filename = decodeURIComponent(pathname.slice(14));
        } catch {
            this.sendJson(res, 400, { error: "Invalid URI encoding" });
            return;
        }

        filename = filename.replaceAll("\\", "/");
        const safePath = path.resolve(this.syncDir, filename);
        const rel = path.relative(this.syncDir, safePath);

        if (
            !filename ||
            filename.startsWith(".") ||
            filename.split("/").some((part) => part === ".." || part === ".") ||
            rel.startsWith("..") ||
            path.isAbsolute(rel)
        ) {
            this.sendJson(res, 400, { error: "Invalid filename" });
            return;
        }

        const stat = fs.statSync(safePath, { throwIfNoEntry: false });
        if (!stat?.isFile()) {
            this.sendJson(res, 404, { error: "File not found" });
            return;
        }

        const meta = this.watcher.getFileMeta(rel);
        const ext = path.extname(filename).toLowerCase();
        res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
            "Content-Length": stat.size,
            "Cache-Control": "no-cache",
            ...(meta ? { ETag: `"${meta.sha256}"`, "X-File-SHA256": meta.sha256 } : {})
        });

        if (req.method === "HEAD") {
            res.end();
            return;
        }

        const clientIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "client";
        const transferId = `${clientIp}:${filename}:${++this.transferCounter}`;
        this.emit("file_start", { id: transferId, file: filename, size: stat.size, clientIp });

        let transferred = 0;
        let lastTime = 0;
        const stream = fs.createReadStream(safePath);
        this.activeDownloads.add(res);

        stream.on("data", (chunk: Buffer | string) => {
            transferred += chunk.length;
            const now = Date.now();
            if (now - lastTime >= 100 || transferred >= stat.size) {
                lastTime = now;
                this.emit("file_progress", { id: transferId, file: filename, transferred, total: stat.size, clientIp });
            }
        });
        stream.on("error", () => res.destroy());

        finished(res, (err) => {
            this.activeDownloads.delete(res);
            stream.destroy();
            this.emit(err ? "file_aborted" : "file_served", { id: transferId, file: filename, size: stat.size, clientIp });
        });

        stream.pipe(res);
    }

    private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        });

        res.flushHeaders?.();
        res.write(":" + " ".repeat(2048) + "\n\n");
        this.activeClients.add(res);

        const verbose = this.options.verbose ?? true;
        if (verbose) console.log(`[HOST] Client connected to live sync stream. Total active: ${this.activeClients.size}`);

        const manifest = this.watcher.getManifest();
        const isIndexing = this.watcher.isScanning();
        res.write(`event: init\ndata: ${JSON.stringify({
            type: "init",
            timestamp: Date.now(),
            manifest,
            is_indexing: isIndexing
        })}\n\n`);

        req.on("close", () => {
            this.activeClients.delete(res);
            if (verbose) console.log(`[HOST] Client disconnected. Remaining: ${this.activeClients.size}`);
        });
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = parsedUrl.pathname;

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

        if (req.method === "OPTIONS") {
            res.writeHead(204).end();
            return;
        }

        if (this.handleClientScript(pathname, res)) return;

        if (pathname.startsWith("/api/") && !this.isAuthenticated(req, parsedUrl)) {
            this.sendJson(res, 401, { error: "Unauthorized: valid token required" });
            return;
        }

        if (pathname === "/" || pathname === "/api/status") {
            const manifest = this.watcher.getManifest();
            this.sendJson(res, 200, {
                app: "flipsync",
                status: "ok",
                version: "1.0.0",
                clientsConnected: this.activeClients.size,
                filesCount: Object.keys(manifest.files).length,
                serverTime: Date.now()
            });
            return;
        }

        if (pathname === "/api/manifest") {
            const manifest = this.watcher.getManifest();
            const isIndexing = this.watcher.isScanning();
            res.setHeader("X-Is-Indexing", isIndexing ? "true" : "false");
            this.sendJson(res, 200, {
                ...manifest,
                is_indexing: isIndexing
            });
            return;
        }

        if (pathname === "/api/wait-change") {
            this.handleWaitChange(req, res, parsedUrl);
            return;
        }

        if (pathname.startsWith("/api/download/")) {
            this.handleDownload(req, res, pathname);
            return;
        }

        if (pathname === "/api/events") {
            this.handleEvents(req, res);
            return;
        }

        this.sendJson(res, 404, { error: "Not Found" });
    }
}
