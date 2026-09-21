import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { computeFileHash } from "./hasher.js";
import type { SyncFileMeta, SyncManifest } from "./types.js";

const isIgnored = (name: string) =>
    name.startsWith(".") || name.includes(".tmp.") || name === "node_modules";

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
        fs.mkdirSync(this.syncDir, { recursive: true });

        const scan = async (dir: string, prefix = ""): Promise<void> => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (isIgnored(entry.name)) continue;

                const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await scan(fullPath, relPath);
                } else if (entry.isFile()) {
                    const meta = await computeFileHash(fullPath);
                    if (meta) {
                        this.cache.set(relPath, { name: relPath, ...meta });
                    }
                }
            }
        };

        await scan(this.syncDir);
        return this.getManifest();
    }

    public startWatching(): void {
        if (this.isClosed || this.fsWatcher) return;

        fs.mkdirSync(this.syncDir, { recursive: true });

        try {
            this.fsWatcher = fs.watch(this.syncDir, { recursive: true }, (_eventType, filename) => {
                if (!filename) return;

                const normalized = filename.split(path.sep).join("/");
                if (normalized.split("/").some(isIgnored)) return;

                this.scheduleEvaluation(normalized);
            });

            this.fsWatcher.on("error", (err) => this.emit("error", err));
        } catch (err: unknown) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
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
            if (!fs.existsSync(fullPath)) {
                if (this.cache.delete(relPath)) {
                    this.emit("delete", relPath);
                }
                return;
            }

            const meta = await computeFileHash(fullPath);
            if (!meta) return;

            const existing = this.cache.get(relPath);
            if (existing && existing.sha256 === meta.sha256 && existing.size === meta.size) {
                return;
            }

            const updated: SyncFileMeta = { name: relPath, ...meta };
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

        this.fsWatcher?.close();
        this.fsWatcher = null;
    }
}

// Backward compatibility export alias
export { DirectoryWatcher as DistWatcher };
