import type {
    SyncEngine,
    SyncEngineReadyEvent,
    SyncStartEvent,
    SyncFileProgressEvent,
    SyncFileCompleteEvent,
    SyncConflictEvent,
    SyncErrorEvent
} from "../core/SyncEngine.js";

export interface HeadlessCliOptions {
    format?: "text" | "json";
    quiet?: boolean;
}

export interface HeadlessCliController {
    stop: () => Promise<void>;
}

export async function runHeadlessCli(
    engine: SyncEngine,
    options: HeadlessCliOptions = {}
): Promise<HeadlessCliController> {
    const format = options.format ?? (process.env.SYNC_FORMAT?.toLowerCase() === "json" ? "json" : "text");
    const quiet = options.quiet ?? false;

    const logOut = (msg: string) => {
        process.stdout.write(msg + "\n");
    };

    const logErr = (msg: string) => {
        process.stderr.write(msg + "\n");
    };

    const timestamp = (): string => {
        return new Date().toISOString();
    };

    // Wire up lifecycle events
    engine.on("engine:ready", (event: SyncEngineReadyEvent) => {
        if (format === "json") {
            logOut(JSON.stringify({
                timestamp: timestamp(),
                event: "engine:ready",
                role: event.role,
                syncDir: event.syncDir,
                filesCount: event.filesCount,
                endpoints: event.endpoints,
                localUrl: event.localUrl,
                lanUrl: event.lanUrl,
                tailscaleIp: event.tailscaleIp,
                tunnelUrl: event.tunnelUrl,
                token: event.token ? "present" : "none"
            }));
        } else {
            const divider = "-".repeat(50);
            logOut(`\n${divider}`);
            logOut(`[READY] FlipSync ${event.role.toUpperCase()} Online`);
            logOut(`  Directory:  ${event.syncDir}`);
            logOut(`  Files:      ${event.filesCount}`);
            if (event.localUrl) {
                logOut(`  Localhost:  ${event.localUrl}`);
            }
            if (event.lanUrl) {
                logOut(`  Local LAN:  ${event.lanUrl}`);
            }
            if (event.tailscaleIp) {
                logOut(`  Tailscale:  http://${event.tailscaleIp}`);
            }
            if (event.tunnelUrl) {
                logOut(`  Public URL: ${event.tunnelUrl}`);
            }
            if (event.serverUrl) {
                logOut(`  Connected:  ${event.serverUrl}`);
            }
            if (event.token) {
                logOut(`  Auth Token: ${event.token}`);
            }
            logOut(`${divider}\n`);
        }
    });

    engine.on("sync:start", (event: SyncStartEvent) => {
        if (format === "json") {
            logOut(JSON.stringify({
                timestamp: timestamp(),
                event: "sync:start",
                count: event.count,
                files: event.files
            }));
        } else if (!quiet) {
            logOut(`[SYNC] Batch sync started (${event.count} file(s))`);
        }
    });

    let lastProgressFile = "";
    let lastProgressPercent = -1;

    engine.on("sync:file-progress", (event: SyncFileProgressEvent) => {
        if (quiet) return;

        // In headless mode, throttle progress output to 25% increments per file
        if (format === "json") {
            if (event.percent === 100 || event.percent - lastProgressPercent >= 25 || lastProgressFile !== event.file) {
                lastProgressFile = event.file;
                lastProgressPercent = event.percent;
                logOut(JSON.stringify({
                    timestamp: timestamp(),
                    event: "sync:file-progress",
                    file: event.file,
                    transferred: event.transferred,
                    total: event.total,
                    percent: event.percent
                }));
            }
        } else {
            if (event.percent === 100 || event.percent - lastProgressPercent >= 25 || lastProgressFile !== event.file) {
                lastProgressFile = event.file;
                lastProgressPercent = event.percent;
                const kb = (event.transferred / 1024).toFixed(1);
                const totalKb = (event.total / 1024).toFixed(1);
                logOut(`[PROGRESS] ${event.file}: ${event.percent}% (${kb} / ${totalKb} KB)`);
            }
        }
    });

    engine.on("sync:file-complete", (event: SyncFileCompleteEvent) => {
        if (format === "json") {
            logOut(JSON.stringify({
                timestamp: timestamp(),
                event: "sync:file-complete",
                file: event.file,
                hash: event.hash
            }));
        } else {
            logOut(`[COMPLETE] ${event.file} (sha256: ${event.hash.slice(0, 10)}...)`);
        }
    });

    engine.on("sync:conflict", (event: SyncConflictEvent) => {
        if (format === "json") {
            logErr(JSON.stringify({
                timestamp: timestamp(),
                event: "sync:conflict",
                file: event.file,
                localVersion: event.localVersion,
                remoteVersion: event.remoteVersion
            }));
        } else {
            logErr(`[CONFLICT] File modified locally: ${event.file} (local: ${event.localVersion}, remote: ${event.remoteVersion})`);
        }
    });

    engine.on("sync:error", (event: SyncErrorEvent) => {
        if (format === "json") {
            logErr(JSON.stringify({
                timestamp: timestamp(),
                event: "sync:error",
                error: event.error.message,
                context: event.context
            }));
        } else {
            const ctx = event.context ? `[${event.context}] ` : "";
            logErr(`[ERROR] ${ctx}${event.error.message}`);
        }
    });

    engine.on("sync:idle", () => {
        if (format === "json") {
            logOut(JSON.stringify({
                timestamp: timestamp(),
                event: "sync:idle",
                timestampMs: Date.now()
            }));
        } else if (!quiet) {
            logOut(`[IDLE] Sync queue empty. Watching for changes...`);
        }
    });

    let isStopping = false;
    const shutdown = async (): Promise<void> => {
        if (isStopping) return;
        isStopping = true;
        if (!quiet) {
            if (format === "json") {
                logOut(JSON.stringify({ timestamp: timestamp(), event: "shutdown" }));
            } else {
                logOut("\n[SHUTDOWN] Shutting down FlipSync cleanly...");
            }
        }
        await engine.stop();
    };

    const sigintHandler = () => {
        shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
    };

    const sigtermHandler = () => {
        shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
    };

    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);

    return {
        stop: async () => {
            process.removeListener("SIGINT", sigintHandler);
            process.removeListener("SIGTERM", sigtermHandler);
            await shutdown();
        }
    };
}
