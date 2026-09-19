import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { computeFileHash } from "./hasher.js";
import type { SyncFileMeta, SyncManifest } from "./types.js";

export interface WatcherEvents {
    change: (file: SyncFileMeta) => void;
    delete: (filename: string) => void;
    error: (err: Error) => void;
}

export class DirectoryWatcher extends EventEmitter {
    private readonly syncDir: string;
    private readonly debounceMs: number;
    private readonly cache = new Map<string, SyncFileMeta>();
    private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
    private fsWatcher: fs.FSWatcher | null = null;
    private isClosed = false;

    constructor(syncDir: string, debounceMs = 150) {
        super();
        this.syncDir = path.resolve(syncDir);
        this.debounceMs = debounceMs;
    }

    public async initScan(): Promise<SyncManifest> {
        if (!fs.existsSync(this.syncDir)) {
            fs.mkdirSync(this.syncDir, { recursive: true });
        }

        const scanDirectory = async (dir: string, relativePrefix = ""): Promise<void> => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                // Ignore hidden files, temporary files, node_modules, and git directories
                if (
                    entry.name.startsWith(".") ||
                    entry.name.includes(".tmp.") ||
                    entry.name === "node_modules"
                ) {
                    continue;
                }

                const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await scanDirectory(fullPath, relativePath);
                } else if (entry.isFile()) {
                    const meta = await computeFileHash(fullPath);
                    if (meta) {
                        this.cache.set(relativePath, {
                            name: relativePath,
                            size: meta.size,
                            sha256: meta.sha256,
                            mtimeMs: meta.mtimeMs
                        });
                    }
                }
            }
        };

        await scanDirectory(this.syncDir);
        return this.getManifest();
    }

    public startWatching(): void {
        if (this.isClosed || this.fsWatcher) return;

        if (!fs.existsSync(this.syncDir)) {
            fs.mkdirSync(this.syncDir, { recursive: true });
        }

        try {
            this.fsWatcher = fs.watch(this.syncDir, { recursive: true }, (eventType, filename) => {
                if (!filename) return;

                // Normalize slashes for cross-platform consistency
                const normalized = filename.split(path.sep).join("/");

                // Ignore hidden files, temp files, and node_modules
                const parts = normalized.split("/");
                if (parts.some((p) => p.startsWith(".") || p.includes(".tmp.") || p === "node_modules")) {
                    return;
                }

                this.scheduleEvaluation(normalized);
            });

            this.fsWatcher.on("error", (err) => {
                this.emit("error", err);
            });
        } catch (err: unknown) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
    }

    public getManifest(): SyncManifest {
        const files: Record<string, SyncFileMeta> = {};
        for (const [name, meta] of this.cache.entries()) {
            files[name] = { ...meta };
        }
        return {
            serverTime: Date.now(),
            syncPath: this.syncDir,
            files
        };
    }

    public getFileMeta(filename: string): SyncFileMeta | undefined {
        const normalized = filename.split(path.sep).join("/");
        return this.cache.get(normalized);
    }

    private scheduleEvaluation(relPath: string): void {
        if (this.isClosed) return;

        const existingTimer = this.pendingTimers.get(relPath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            this.pendingTimers.delete(relPath);
            if (this.isClosed) return;

            const fullPath = path.join(this.syncDir, relPath);
            if (!fs.existsSync(fullPath)) {
                if (this.cache.has(relPath)) {
                    this.cache.delete(relPath);
                    this.emit("delete", relPath);
                }
                return;
            }

            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) return;

            const meta = await computeFileHash(fullPath);
            if (!meta) return;

            const existing = this.cache.get(relPath);
            if (existing && existing.sha256 === meta.sha256 && existing.size === meta.size) {
                // Content unchanged; suppress redundant event
                return;
            }

            const updated: SyncFileMeta = {
                name: relPath,
                size: meta.size,
                sha256: meta.sha256,
                mtimeMs: meta.mtimeMs
            };

            this.cache.set(relPath, updated);
            this.emit("change", updated);
        }, this.debounceMs);

        this.pendingTimers.set(relPath, timer);
    }

    public close(): void {
        this.isClosed = true;
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();

        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = null;
        }
    }
}

// Backward compatibility export alias
export { DirectoryWatcher as DistWatcher };
