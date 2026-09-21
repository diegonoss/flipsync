import blessed from "blessed";
import { openFolderPicker } from "./folderPicker.js";
import type {
    SyncEngine,
    SyncEngineReadyEvent,
    SyncStartEvent,
    SyncFileProgressEvent,
    SyncFileCompleteEvent,
    SyncConflictEvent,
    SyncErrorEvent
} from "../core/SyncEngine.js";

export interface TuiOptions {
    title?: string;
    promptFolderOnStart?: boolean;
}

export interface TuiController {
    stop: () => Promise<void>;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec <= 0) return "0 B/s";
    return `${formatBytes(bytesPerSec)}/s`;
}

function renderProgressBar(percent: number, width = 26): string {
    const p = Math.max(0, Math.min(100, percent));
    const filled = Math.round((p / 100) * width);
    const empty = width - filled;
    const bar = "=".repeat(Math.max(0, filled - 1)) + (filled > 0 ? ">" : "");
    return `[${bar}${" ".repeat(empty)}] ${p.toString().padStart(3, " ")}%`;
}

export async function runTui(engine: SyncEngine, options: TuiOptions = {}): Promise<TuiController> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            "Interactive TUI requires an interactive TTY terminal (stdin and stdout must be TTY). " +
            "Please run with --headless or in an interactive terminal."
        );
    }

    const screen = blessed.screen({
        smartCSR: true,
        title: options.title ?? "FlipSync — Real-Time Folder Sync Dashboard",
        fullUnicode: true,
        dockBorders: true,
        autoPadding: true
    });

    // 1. Header Box
    const headerBox = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: "100%",
        height: 8,
        border: { type: "line" },
        style: {
            border: { fg: "cyan" }
        },
        tags: true,
        label: " FlipSync Status & Endpoints "
    });

    // 2. Transfer Panel
    const transferBox = blessed.box({
        parent: screen,
        top: 8,
        left: 0,
        width: "100%",
        height: 9,
        border: { type: "line" },
        style: {
            border: { fg: "blue" }
        },
        tags: true,
        label: " Active Transfers & Sync Progress "
    });

    // 3. Event Log
    const logBox = blessed.log({
        parent: screen,
        top: 17,
        left: 0,
        width: "100%",
        bottom: 2,
        border: { type: "line" },
        style: {
            border: { fg: "white" }
        },
        tags: true,
        label: " Activity Log & Conflict Notices ",
        scrollable: true,
        scrollbar: {
            ch: " ",
            track: { bg: "cyan" },
            style: { inverse: true }
        },
        mouse: true,
        keys: true
    });

    // 4. Footer Panel
    const footerBox = blessed.box({
        parent: screen,
        bottom: 0,
        left: 0,
        width: "100%",
        height: 2,
        style: {
            bg: "blue",
            fg: "white"
        },
        tags: true
    });

    const getFormattedTime = (): string => {
        const d = new Date();
        const h = d.getHours().toString().padStart(2, "0");
        const m = d.getMinutes().toString().padStart(2, "0");
        const s = d.getSeconds().toString().padStart(2, "0");
        return `${h}:${m}:${s}`;
    };

    const addLog = (tag: string, message: string, color = "white") => {
        const time = getFormattedTime();
        logBox.add(`{gray-fg}[${time}]{/} {${color}-fg}[${tag}]{/} ${message}`);
        screen.render();
    };

    const renderHeader = () => {
        const state = engine.getState();
        const role = state.role.toUpperCase();

        let statusBadge = "{green-bg}{black-fg}{bold} ACTIVE {/}";
        if (state.isPaused) {
            statusBadge = "{yellow-bg}{black-fg}{bold} PAUSED {/}";
        } else if (state.status === "syncing") {
            statusBadge = "{cyan-bg}{black-fg}{bold} SYNCING {/}";
        } else if (state.status === "error") {
            statusBadge = "{red-bg}{white-fg}{bold} ERROR {/}";
        }

        let tunnelDisplay = "{gray-fg}Disabled{/}";
        if (state.tunnelState === "online" && state.endpoints.tunnel) {
            tunnelDisplay = `{green-fg}● Online{/} ({bold}${state.endpoints.tunnel}{/})`;
        } else if (state.tunnelState === "connecting") {
            tunnelDisplay = "{yellow-fg}○ Connecting...{/}";
        } else if (state.tunnelState === "error") {
            tunnelDisplay = "{red-fg}✕ Error{/}";
        }

        const lines = [
            `{bold}FlipSync{/} {cyan-fg}${role}{/}  |  Status: ${statusBadge}  |  Tunnel: ${tunnelDisplay}`,
            `{bold}Endpoints:{/} Local: {underline}${state.endpoints.local || "N/A"}{/}  |  LAN: {underline}${state.endpoints.lan || "N/A"}{/}  |  Tailscale: ${state.endpoints.tailscale || "N/A"}`,
            `{bold}Directory:{/} {underline}${state.syncDir}{/}  |  {bold}Files:{/} ${state.stats.totalFiles}  |  {bold}Auth Token:{/} ${state.token ? state.token : "{gray-fg}(Open Access){/}"}`
        ];

        if (state.serverUrl) {
            lines.splice(1, 0, `{bold}Connected Server:{/} {underline}${state.serverUrl}{/}`);
        }

        headerBox.setContent(lines.join("\n"));
    };

    const renderTransferPanel = () => {
        const state = engine.getState();
        const active = state.activeTransfers;

        if (active.length === 0) {
            const lines = [
                `{gray-fg}Engine idle - All queues empty and up to date.{/}`,
                "",
                `{bold}Stats Summary:{/}`,
                `  • Synced Files:       {bold}${state.stats.syncedFiles}{/}`,
                `  • Total Data:         {bold}${formatBytes(state.stats.bytesTransferred)}{/}`,
                `  • Conflicts Detected: ${state.stats.conflictsCount > 0 ? `{magenta-fg}{bold}${state.stats.conflictsCount}{/}` : "0"}`,
                `  • Errors Encountered: ${state.stats.errorsCount > 0 ? `{red-fg}{bold}${state.stats.errorsCount}{/}` : "0"}`
            ];
            transferBox.setContent(lines.join("\n"));
            return;
        }

        const lines: string[] = [];
        for (const t of active.slice(0, 3)) {
            const bar = renderProgressBar(t.percent, 24);
            const speed = formatSpeed(t.speedBps);
            const sizeStr = `${formatBytes(t.transferred)} / ${formatBytes(t.total)}`;
            lines.push(`{bold}${t.file}{/}`);
            lines.push(`  ${bar}  ${sizeStr}  ({cyan-fg}${speed}{/})`);
        }

        if (active.length > 3) {
            lines.push(`{gray-fg}... and ${active.length - 3} more file(s) transferring{/}`);
        }

        transferBox.setContent(lines.join("\n"));
    };

    const renderFooter = () => {
        const state = engine.getState();
        const statusText = state.isPaused ? "PAUSED (press p to resume)" : state.status.toUpperCase();
        footerBox.setContent(
            ` {bold}[q]{/} Quit  {bold}[p]{/} Pause/Resume  {bold}[r]{/} Force Re-hash  {bold}[f]{/} Select Folder  {bold}[↑/↓]{/} Scroll Log  |  State: {bold}${statusText}{/}`
        );
    };

    const updateAll = () => {
        renderHeader();
        renderTransferPanel();
        renderFooter();
        screen.render();
    };

    // Wire up SyncEngine events to TUI
    engine.on("engine:ready", (event: SyncEngineReadyEvent) => {
        addLog("READY", `Engine initialized. Watching ${event.filesCount} file(s) in ${event.syncDir}`, "green");
        if (event.tunnelUrl) {
            addLog("TUNNEL", `Cloudflare public tunnel active: ${event.tunnelUrl}`, "cyan");
        }
        updateAll();
    });

    engine.on("sync:start", (event: SyncStartEvent) => {
        addLog("SYNC", `Batch sync started: ${event.count} file(s)`, "blue");
        updateAll();
    });

    engine.on("sync:file-progress", (_event: SyncFileProgressEvent) => {
        renderTransferPanel();
        screen.render();
    });

    engine.on("sync:file-complete", (event: SyncFileCompleteEvent) => {
        addLog("COMPLETE", `Synchronized {bold}${event.file}{/} (${event.hash.slice(0, 8)}...)`, "green");
        updateAll();
    });

    engine.on("sync:conflict", (event: SyncConflictEvent) => {
        addLog(
            "CONFLICT",
            `Conflict on {bold}${event.file}{/}! Local: ${event.localVersion} Remote: ${event.remoteVersion}`,
            "magenta"
        );
        updateAll();
    });

    engine.on("sync:error", (event: SyncErrorEvent) => {
        const ctx = event.context ? `[${event.context}] ` : "";
        addLog("ERROR", `${ctx}${event.error.message}`, "red");
        updateAll();
    });

    engine.on("sync:idle", () => {
        updateAll();
    });

    engine.on("engine:pause", () => {
        addLog("PAUSE", "Synchronization paused by user.", "yellow");
        updateAll();
    });

    engine.on("engine:resume", () => {
        addLog("RESUME", "Synchronization resumed.", "green");
        updateAll();
    });

    // Keybindings & Shutdown
    let isExiting = false;
    let isPickerOpen = false;

    const cleanExit = async (code = 0): Promise<void> => {
        if (isExiting) return;
        isExiting = true;

        if (renderInterval) {
            clearInterval(renderInterval);
        }

        try {
            await engine.stop();
        } catch {
            // Ignore during shutdown
        }

        try {
            screen.destroy();
        } catch {
            // Ignore
        }

        // Guarantee cursor is visible and terminal alternate screen buffer is restored
        process.stdout.write("\x1b[?1049l\x1b[?25h");
        process.exit(code);
    };

    const showFolderSelector = (isInitial = false) => {
        if (isPickerOpen) return;
        isPickerOpen = true;

        openFolderPicker(
            screen,
            {
                initialDir: engine.getSyncDir(),
                title: isInitial
                    ? "Select Folder to Synchronize"
                    : "Change Synchronization Directory"
            },
            async (chosenDir: string) => {
                isPickerOpen = false;
                try {
                    await engine.setSyncDir(chosenDir);
                    await engine.start();
                    addLog("FOLDER", `Sync directory set to: {underline}${chosenDir}{/}`, "cyan");
                    updateAll();
                } catch (err: unknown) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    addLog("ERROR", `Failed to set folder: ${error.message}`, "red");
                }
            },
            () => {
                isPickerOpen = false;
                if (isInitial) {
                    cleanExit(0);
                } else {
                    updateAll();
                }
            }
        );
    };

    screen.key(["q", "C-c"], () => {
        if (!isPickerOpen) {
            cleanExit(0);
        }
    });

    screen.key(["p", "P"], () => {
        if (!isPickerOpen) {
            engine.togglePause();
            updateAll();
        }
    });

    screen.key(["r", "R"], async () => {
        if (!isPickerOpen) {
            addLog("REHASH", "Forcing full directory re-hash...", "cyan");
            updateAll();
            await engine.forceRehash();
            addLog("REHASH", "Re-hash complete. All files verified.", "green");
            updateAll();
        }
    });

    screen.key(["f", "F"], () => {
        if (!isPickerOpen) {
            showFolderSelector(false);
        }
    });

    screen.key(["up", "k"], () => {
        if (!isPickerOpen) {
            logBox.scroll(-1);
            screen.render();
        }
    });

    screen.key(["down", "j"], () => {
        if (!isPickerOpen) {
            logBox.scroll(1);
            screen.render();
        }
    });

    screen.key(["pageup"], () => {
        if (!isPickerOpen) {
            logBox.scroll(-5);
            screen.render();
        }
    });

    screen.key(["pagedown"], () => {
        if (!isPickerOpen) {
            logBox.scroll(5);
            screen.render();
        }
    });

    // Handle OS signals
    process.once("SIGINT", () => cleanExit(0));
    process.once("SIGTERM", () => cleanExit(0));

    // Periodic UI refresh for speed calculations and clock
    const renderInterval = setInterval(() => {
        if (!isExiting && !isPickerOpen) {
            updateAll();
        }
    }, 500);

    // Initial render
    updateAll();

    // If folder wasn't specified on CLI, prompt user to select folder immediately upon entering TUI
    if (options.promptFolderOnStart) {
        showFolderSelector(true);
    } else {
        await engine.start();
    }

    return {
        stop: async () => {
            await cleanExit(0);
        }
    };
}
