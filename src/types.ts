import type { ChildProcess } from "node:child_process";

export interface SyncFileMeta {
    name: string;
    size: number;
    sha256: string;
    mtimeMs: number;
}

export interface SyncManifest {
    serverTime: number;
    syncPath: string;
    files: Record<string, SyncFileMeta>;
}

export type SyncEventType = "init" | "file_changed" | "file_deleted" | "ping";

export interface SyncEvent {
    type: SyncEventType;
    timestamp: number;
    file?: SyncFileMeta;
    filename?: string;
    manifest?: SyncManifest;
}

export interface ServerOptions {
    port?: number;
    host?: string;
    syncDir?: string;
    distDir?: string; // Backward compatibility alias for syncDir
    token?: string;
    tunnel?: boolean;
    scriptsDir?: string;
    verbose?: boolean;
    debounceMs?: number;
    watcher?: any; // DirectoryWatcher instance
}

export interface ClientOptions {
    serverUrl: string;
    token?: string;
    targetDir: string;
    pollIntervalMs?: number;
    once?: boolean;
    verbose?: boolean;
    onSync?: (file: SyncFileMeta) => void;
    onDelete?: (filename: string) => void;
    onError?: (err: Error) => void;
}

export interface TunnelResult {
    url: string;
    type: "cloudflare" | "ssh" | "custom";
    process?: ChildProcess;
    stop: () => void;
}

export interface ServerInfo {
    port: number;
    host: string;
    localUrl: string;
    syncDir: string;
}
