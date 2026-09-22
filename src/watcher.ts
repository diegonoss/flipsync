import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { watch, type FSWatcher } from "chokidar";
import { computeFileHash } from "./hasher.js";
import type { SyncFileMeta, SyncManifest } from "./types.js";

export const isIgnored = (name: string) =>
    name.startsWith(".") ||
    name.includes(".tmp.") ||
    name === "node_modules" ||
    name.endsWith(".crdownload") ||
    name.endsWith(".part") ||
    name.endsWith(".download") ||
    name.startsWith("~$");

export const isIgnoredPath = (relPath: string) =>
    Boolean(relPath && relPath !== "." && relPath.split(/[\\/]/).some(isIgnored));

const toRelPath = (baseDir: string, filePath: string) =>
    (path.isAbsolute(filePath) ? path.relative(baseDir, filePath) : filePath).replace(/\\/g, "/");

export class DirectoryWatcher extends EventEmitter {
    private readonly syncDir: string;
    private readonly debounceMs: number;
    private readonly cache = new Map<string, SyncFileMeta>();
    private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
    private fsWatcher: FSWatcher | null = null;
    private isClosed = false;
    private scanPromise: Promise<SyncManifest> | null = null;
    private scanAbortController: AbortController | null = null;

    constructor(syncDir: string, debounceMs = 150) {
        super();
        this.syncDir = path.resolve(syncDir);
        this.debounceMs = debounceMs;
    }

    public isScanning(): boolean {
        return this.scanPromise !== null;
    }

    public cancelScan(): void {
        this.scanAbortController?.abort();
        this.scanAbortController = null;
    }

    public async initScan(): Promise<SyncManifest> {
        if (this.isClosed) return this.getManifest();
        if (this.scanPromise) return this.scanPromise;

        const abortController = new AbortController();
        this.scanAbortController = abortController;
        const signal = abortController.signal;

        this.scanPromise = (async () => {
            try {
                await fs.promises.mkdir(this.syncDir, { recursive: true });
            } catch {
                return this.getManifest();
            }

            // Phase 1 (Discovery): Fast traversal to collect entries without hashing
            interface DiscoveredEntry {
                relPath: string;
                fullPath: string;
                cachedMeta?: SyncFileMeta;
            }

            const discovered: DiscoveredEntry[] = [];

            const discover = async (dir: string, prefix = ""): Promise<void> => {
                if (this.isClosed || signal.aborted) return;
                let entries: fs.Dirent[];
                try {
                    entries = await fs.promises.readdir(dir, { withFileTypes: true });
                } catch {
                    return;
                }

                for (const entry of entries) {
                    if (this.isClosed || signal.aborted) return;
                    if (isIgnored(entry.name)) continue;
                    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                    const fullPath = path.join(dir, entry.name);

                    if (entry.isDirectory()) {
                        await discover(fullPath, relPath);
                    } else if (entry.isFile()) {
                        try {
                            const stat = await fs.promises.stat(fullPath);
                            const existing = this.cache.get(relPath);
                            const cachedMeta = existing && existing.size === stat.size && Math.abs(existing.mtimeMs - stat.mtimeMs) < 1 ? existing : undefined;
                            discovered.push({ relPath, fullPath, cachedMeta });
                        } catch {
                            // Ignore stat errors for inaccessible / transient files
                        }
                    }
                }
            };

            await discover(this.syncDir);
            if (this.isClosed || signal.aborted) return this.getManifest();

            const total = discovered.length;
            this.emit("scan:discovered", { totalFiles: total });

            // Phase 2 (Progressive Hashing & Immediate Sync): Compute SHA-256 file by file and yield
            const discoveredSet = new Set<string>();
            let completed = 0;

            for (const item of discovered) {
                if (this.isClosed || signal.aborted) break;
                discoveredSet.add(item.relPath);

                if (!item.cachedMeta) {
                    const meta = await computeFileHash(item.fullPath, 5, 40, signal);
                    if (meta && !this.isClosed && !signal.aborted) {
                        const fileMeta: SyncFileMeta = { name: item.relPath, ...meta };
                        const prev = this.cache.get(item.relPath);
                        this.cache.set(item.relPath, fileMeta);
                        if (!prev || prev.sha256 !== fileMeta.sha256) {
                            this.emit("change", fileMeta);
                        }
                    }
                    await setImmediate();
                }

                completed++;
                this.emit("scan:progress", { completed, total, file: item.relPath });
            }

            if (!signal.aborted && !this.isClosed) {
                for (const key of this.cache.keys()) {
                    if (!discoveredSet.has(key)) {
                        this.cache.delete(key);
                        this.emit("delete", key);
                    }
                }
            }

            this.emit("scan:complete", { totalFiles: this.cache.size });
            return this.getManifest();
        })().finally(() => {
            this.scanAbortController = null;
            this.scanPromise = null;
        });

        return this.scanPromise;
    }

    public async startWatching(): Promise<void> {
        if (this.isClosed || this.fsWatcher) return;

        await fs.promises.mkdir(this.syncDir, { recursive: true });

        return new Promise<void>((resolve) => {
            try {
                this.fsWatcher = watch(this.syncDir, {
                    ignoreInitial: true,
                    cwd: this.syncDir,
                    ignored: (filePath: string) => isIgnoredPath(toRelPath(this.syncDir, filePath))
                });

                this.fsWatcher.on("ready", () => resolve());
                this.fsWatcher.on("error", (err) => {
                    this.emit("error", err instanceof Error ? err : new Error(String(err)));
                    resolve();
                });

                this.fsWatcher.on("all", (event, filePath) => {
                    if (!filePath || event === "addDir") return;
                    const relPath = toRelPath(this.syncDir, filePath);
                    if (!relPath || relPath === "." || isIgnoredPath(relPath)) return;

                    if (event === "unlinkDir") {
                        const dirPrefix = relPath.endsWith("/") ? relPath : `${relPath}/`;
                        for (const key of this.cache.keys()) {
                            if (key.startsWith(dirPrefix)) {
                                this.scheduleEvaluation(key);
                            }
                        }
                        return;
                    }

                    this.scheduleEvaluation(relPath);
                });
            } catch (err: unknown) {
                this.emit("error", err instanceof Error ? err : new Error(String(err)));
                resolve();
            }
        });
    }

    public getManifest(): SyncManifest {
        return {
            serverTime: Date.now(),
            syncPath: this.syncDir,
            files: Object.fromEntries(this.cache)
        };
    }

    public getFileMeta(filename: string): SyncFileMeta | undefined {
        return this.cache.get(filename.split(path.sep).join("/"));
    }

    private scheduleEvaluation(relPath: string): void {
        if (this.isClosed) return;

        clearTimeout(this.pendingTimers.get(relPath));

        const timer = setTimeout(async () => {
            this.pendingTimers.delete(relPath);
            if (this.isClosed) return;

            const fullPath = path.join(this.syncDir, relPath);
            try {
                const stat = await fs.promises.stat(fullPath);
                if (!stat.isFile()) throw new Error();

                const existing = this.cache.get(relPath);
                if (existing && existing.size === stat.size && Math.abs(existing.mtimeMs - stat.mtimeMs) < 1) {
                    return;
                }

                const meta = await computeFileHash(fullPath);
                if (!meta) throw new Error();

                if (existing && existing.sha256 === meta.sha256 && existing.size === meta.size) {
                    return;
                }

                const updated: SyncFileMeta = { name: relPath, ...meta };
                this.cache.set(relPath, updated);
                this.emit("change", updated);
            } catch {
                if (this.cache.delete(relPath)) {
                    this.emit("delete", relPath);
                }
            }
        }, this.debounceMs);

        this.pendingTimers.set(relPath, timer);
    }

    public close(): void {
        this.isClosed = true;
        this.cancelScan();
        this.scanPromise = null;
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();

        void this.fsWatcher?.close();
        this.fsWatcher = null;
    }
}

// Backward compatibility export alias
export { DirectoryWatcher as DistWatcher };
