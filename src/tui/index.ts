import blessed from "blessed";
import { openFolderPicker } from "./folderPicker.js";
import { openCommandModal } from "./commandModal.js";
import type {
    SyncEngine,
    SyncEngineReadyEvent,
    SyncStartEvent,
    SyncFileCompleteEvent,
    SyncConflictEvent,
    SyncErrorEvent,
    SyncFileServedEvent
} from "../core/SyncEngine.js";

export interface TuiOptions {
    title?: string;
    promptFolderOnStart?: boolean;
}

export interface TuiController {
    stop: () => Promise<void>;
    destroy: () => void;
}

function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i] ?? "TB"}`;
}

const formatSpeed = (bytesPerSec: number): string =>
    bytesPerSec <= 0 ? "0 B/s" : `${formatBytes(bytesPerSec)}/s`;

function renderProgressBar(percent: number, width = 26): string {
    const p = Math.max(0, Math.min(100, percent));
    const filled = Math.round((p / 100) * width);
    const bar = "=".repeat(Math.max(0, filled - 1)) + (filled > 0 ? ">" : "");
    return `[${bar.padEnd(width, " ")}] ${p.toString().padStart(3, " ")}%`;
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

    const headerBox = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: "100%",
        height: 8,
        border: { type: "line" },
        style: { border: { fg: "cyan" } },
        tags: true,
        label: " FlipSync Status & Endpoints "
    });

    const transferBox = blessed.box({
        parent: screen,
        top: 8,
        left: 0,
        width: "100%",
        height: 9,
        border: { type: "line" },
        style: { border: { fg: "blue" } },
        tags: true,
        label: " Active Transfers & Sync Progress "
    });

    const logBox = blessed.log({
        parent: screen,
        top: 17,
        left: 0,
        width: "100%",
        bottom: 2,
        border: { type: "line" },
        style: { border: { fg: "white" } },
        tags: true,
        label: " Activity Log & Conflict Notices ",
        scrollable: true,
        scrollback: 1000,
        scrollbar: {
            ch: " ",
            track: { bg: "cyan" },
            style: { inverse: true }
        },
        mouse: true,
        keys: true
    });

    const footerBox = blessed.box({
        parent: screen,
        bottom: 0,
        left: 0,
        width: "100%",
        height: 2,
        style: { bg: "blue", fg: "white" },
        tags: true
    });

    const addLog = (tag: string, message: string, color = "white") => {
        logBox.add(`{gray-fg}[${new Date().toTimeString().slice(0, 8)}]{/} {${color}-fg}[${tag}]{/} ${message}`);
        scheduleRender();
    };

    const getIndexingPct = (idx?: { completed: number; total: number }) =>
        idx && idx.total > 0 ? Math.round((idx.completed / idx.total) * 100) : 0;

    const renderHeader = () => {
        const state = engine.getState();
        const indexingPct = getIndexingPct(state.indexing);

        let statusBadge = "{green-bg}{black-fg}{bold} ACTIVE {/}";
        if (state.isPaused) statusBadge = "{yellow-bg}{black-fg}{bold} PAUSED {/}";
        else if (state.indexing?.isIndexing) statusBadge = `{cyan-bg}{black-fg}{bold} INDEXING (${indexingPct}%) {/}`;
        else if (state.status === "syncing") statusBadge = "{cyan-bg}{black-fg}{bold} SYNCING {/}";
        else if (state.status === "error") statusBadge = "{red-bg}{white-fg}{bold} ERROR {/}";

        let tunnelDisplay = "{gray-fg}Disabled{/}";
        if (state.tunnelState === "online" && state.endpoints.tunnel) {
            tunnelDisplay = `{green-fg}● Online{/} ({bold}${state.endpoints.tunnel}{/})`;
        } else if (state.tunnelState === "connecting") {
            tunnelDisplay = "{yellow-fg}○ Connecting...{/}";
        } else if (state.tunnelState === "error") {
            const shortErr = state.tunnelError ? ` (${state.tunnelError.split("\n")[0].slice(0, 45)})` : "";
            tunnelDisplay = `{red-fg}✕ Error${shortErr}{/}`;
        }

        const indexingText = state.indexing?.isIndexing
            ? ` {yellow-fg}(Indexing: ${state.indexing.completed}/${state.indexing.total} - ${indexingPct}%){/}`
            : "";

        const lines = [
            `{bold}FlipSync{/} {cyan-fg}${state.role.toUpperCase()}{/}  |  Status: ${statusBadge}  |  Tunnel: ${tunnelDisplay}`,
            state.serverUrl ? `{bold}Connected Server:{/} {underline}${state.serverUrl}{/}` : "",
            `{bold}Endpoints:{/} Local: {underline}${state.endpoints.local || "N/A"}{/}  |  LAN: {underline}${state.endpoints.lan || "N/A"}{/}  |  Tailscale: ${state.endpoints.tailscale || "N/A"}`,
            `{bold}Directory:{/} {underline}${state.syncDir}{/}  |  {bold}Files:{/} ${state.stats.totalFiles}${indexingText}  |  {bold}Auth Token:{/} ${state.token || "{gray-fg}(Open Access){/}"}`
        ].filter(Boolean);

        headerBox.setContent(lines.join("\n"));
    };

    const renderIdlePanel = (state: ReturnType<typeof engine.getState>) => {
        const errorsFormatted = state.stats.errorsCount > 0 ? `{red-fg}{bold}${state.stats.errorsCount}{/}` : "0";
        const conflictsFormatted = state.stats.conflictsCount > 0 ? `{magenta-fg}{bold}${state.stats.conflictsCount}{/}` : "0";

        if (state.indexing?.isIndexing) {
            const pct = getIndexingPct(state.indexing);
            const lines = [
                `{cyan-fg}{bold}Indexing files: ${state.indexing.completed}/${state.indexing.total} (${pct}%){/}`,
                `  ${renderProgressBar(pct, 26)}`,
                state.indexing.currentFile ? `  • Current File:       {bold}${state.indexing.currentFile}{/}` : "",
                "",
                `{bold}Stats Summary:{/}`,
                `  • Discovered Files:   {bold}${state.stats.totalFiles}{/}`,
                `  • Synced Files:       {bold}${state.stats.syncedFiles}{/}`,
                `  • Errors Encountered: ${errorsFormatted}`
            ].filter(Boolean);
            transferBox.setContent(lines.join("\n"));
            return;
        }

        transferBox.setContent([
            `{gray-fg}Engine idle - All queues empty and up to date.{/}`,
            "",
            `{bold}Stats Summary:{/}`,
            `  • Synced Files:       {bold}${state.stats.syncedFiles}{/}`,
            `  • Total Data:         {bold}${formatBytes(state.stats.bytesTransferred)}{/}`,
            `  • Conflicts Detected: ${conflictsFormatted}`,
            `  • Errors Encountered: ${errorsFormatted}`
        ].join("\n"));
    };

    const renderTransferPanel = () => {
        const state = engine.getState();
        const active = state.activeTransfers.filter((t) => t.percent < 100);

        if (active.length === 0) {
            renderIdlePanel(state);
            return;
        }

        const maxLen = Math.max(30, (screen.width as number) - 6);
        const half = (maxLen - 3) >> 1;
        const lines: string[] = [];
        for (const t of active.slice(0, 3)) {
            const name = t.file.length > maxLen ? `${t.file.slice(0, half)}...${t.file.slice(-half)}` : t.file;
            lines.push(
                `{bold}${name}{/}`,
                `  ${renderProgressBar(t.percent, 24)}  ${formatBytes(t.transferred)} / ${formatBytes(t.total)}  ({cyan-fg}${formatSpeed(t.speedBps)}{/})`
            );
        }

        if (active.length > 3) {
            lines.push(`{gray-fg}... and ${active.length - 3} more file(s) transferring{/}`);
        }

        transferBox.setContent(lines.join("\n"));
    };

    const renderFooter = () => {
        const state = engine.getState();
        let statusText = state.status.toUpperCase();
        if (state.isPaused) {
            statusText = "PAUSED (press p to resume)";
        } else if (state.indexing?.isIndexing) {
            statusText = `INDEXING ${state.indexing.completed}/${state.indexing.total} (${getIndexingPct(state.indexing)}%)`;
        }
        footerBox.setContent(
            ` {bold}[c]{/} Client Cmds  {bold}[f]{/} Folder  {bold}[p]{/} Pause  {bold}[x]{/} Cancel  {bold}[r]{/} Re-sync  {bold}[↑/↓]{/} Scroll  {bold}[q]{/} Quit  |  State: {bold}${statusText}{/}`
        );
    };

    let isExiting = false;
    let isPickerOpen = false;
    let activeCommandModal: { close: () => void } | null = null;
    let renderTimer: NodeJS.Timeout | null = null;

    const isModalOpen = () => isPickerOpen || !!activeCommandModal;

    const updateAll = () => {
        if (isExiting || isModalOpen()) return;
        renderHeader();
        renderTransferPanel();
        renderFooter();
        screen.render();
    };

    const scheduleRender = () => {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            updateAll();
        }, 50);
    };

    // Wire up SyncEngine events to TUI
    const engineListeners: Array<[string, (...args: any[]) => void]> = [];
    const bindEngine = (event: string, handler: (...args: any[]) => void) => {
        engine.on(event, handler);
        engineListeners.push([event, handler]);
    };

    bindEngine("scan:discovered", (e: { totalFiles: number }) =>
        addLog("INDEX", `Discovered ${e.totalFiles} file(s). Progressively indexing in background...`, "cyan"));
    bindEngine("scan:progress", scheduleRender);
    bindEngine("scan:complete", (e: { totalFiles: number }) =>
        addLog("INDEX", `Indexing complete. All ${e.totalFiles} file(s) indexed and verified.`, "green"));
    bindEngine("engine:ready", (e: SyncEngineReadyEvent) => {
        addLog("READY", `Engine initialized. Watching ${e.filesCount} file(s) in ${e.syncDir}`, "green");
        if (e.tunnelUrl) addLog("TUNNEL", `Cloudflare public tunnel active: ${e.tunnelUrl}`, "cyan");
    });
    bindEngine("sync:start", (e: SyncStartEvent) =>
        addLog("SYNC", `Batch sync started: ${e.count} file(s)`, "blue"));
    bindEngine("sync:file-progress", scheduleRender);
    bindEngine("sync:file-complete", (e: SyncFileCompleteEvent) =>
        addLog("COMPLETE", `Synchronized {bold}${e.file}{/} (${e.hash.slice(0, 8)}...)`, "green"));
    bindEngine("sync:file-served", (e: SyncFileServedEvent) =>
        addLog("SERVED", `Sent {bold}${e.file}{/} (${(e.size / 1024).toFixed(1)} KB) to ${e.clientIp}`, "cyan"));
    bindEngine("sync:conflict", (e: SyncConflictEvent) =>
        addLog("CONFLICT", `Conflict on {bold}${e.file}{/}! Local: ${e.localVersion} Remote: ${e.remoteVersion}`, "magenta"));
    bindEngine("sync:error", (e: SyncErrorEvent) => {
        const tag = e.context?.startsWith("tunnel") ? "TUNNEL" : "ERROR";
        const prefix = e.context ? `[${e.context}] ` : "";
        const lines = e.error.message.split("\n");
        for (const line of lines) {
            addLog(tag, `${prefix}${line}`, "red");
        }
    });
    bindEngine("sync:idle", scheduleRender);
    bindEngine("engine:pause", () => addLog("PAUSE", "Synchronization paused by user.", "yellow"));
    bindEngine("engine:resume", () => addLog("RESUME", "Synchronization resumed.", "green"));
    bindEngine("sync:cancelled", () => addLog("CANCEL", "Data transfers and file scan cancelled.", "yellow"));

    // Keybindings & Shutdown
    let renderInterval: NodeJS.Timeout | null = null;

    const onSigInt = () => void cleanExit(0);
    const onSigTerm = () => void cleanExit(0);

    const destroyTui = (): void => {
        if (renderTimer) clearTimeout(renderTimer);
        if (renderInterval) clearInterval(renderInterval);
        process.removeListener("SIGINT", onSigInt);
        process.removeListener("SIGTERM", onSigTerm);
        for (const [event, handler] of engineListeners) {
            engine.removeListener(event, handler);
        }
        engineListeners.length = 0;
        try { activeCommandModal?.close(); } catch {}
        try { screen.destroy(); } catch {}
        process.stdout.write("\x1b[?1049l\x1b[?25h");
    };

    const restoreTerminalAndExit = (code: number): void => {
        destroyTui();
        process.exit(code);
    };

    const cleanExit = async (code = 0): Promise<void> => {
        if (isExiting) return restoreTerminalAndExit(code);
        isExiting = true;

        const forceExitTimer = setTimeout(() => restoreTerminalAndExit(code), 1500);
        forceExitTimer.unref();

        try {
            await engine.stop();
        } catch {
            // Ignore during shutdown
        }

        clearTimeout(forceExitTimer);
        restoreTerminalAndExit(code);
    };

    const showCommandModal = () => {
        if (isModalOpen()) return;
        activeCommandModal = openCommandModal(screen, {
            state: engine.getState(),
            onClose: () => {
                activeCommandModal = null;
                updateAll();
            }
        });
    };

    const showFolderSelector = (isInitial = false): Promise<void> => {
        if (isModalOpen()) return Promise.resolve();
        isPickerOpen = true;

        return new Promise<void>((resolve, reject) => {
            openFolderPicker(
                screen,
                {
                    initialDir: engine.getSyncDir(),
                    title: isInitial ? "Select Folder to Synchronize" : "Change Synchronization Directory"
                },
                async (chosenDir: string) => {
                    isPickerOpen = false;
                    try {
                        await engine.setSyncDir(chosenDir);
                        await engine.start();
                        addLog("FOLDER", `Sync directory set to: {underline}${chosenDir}{/}`, "cyan");
                        updateAll();
                        resolve();
                    } catch (err) {
                        if (isInitial) {
                            reject(err);
                        } else {
                            addLog("ERROR", `Failed to set folder: ${err instanceof Error ? err.message : String(err)}`, "red");
                            resolve();
                        }
                    }
                },
                () => {
                    isPickerOpen = false;
                    if (isInitial) void cleanExit(0);
                    else updateAll();
                    resolve();
                }
            );
        });
    };

    screen.key(["c", "C"], () => {
        if (isPickerOpen) return;
        if (activeCommandModal) activeCommandModal.close();
        else showCommandModal();
    });

    screen.key(["C-c"], () => void cleanExit(0));

    screen.key(["q", "Q"], () => {
        if (activeCommandModal) activeCommandModal.close();
        else if (!isPickerOpen) void cleanExit(0);
    });

    screen.key(["x", "X"], () => {
        if (!isModalOpen()) engine.cancelTransfers();
    });

    screen.key(["p", "P"], () => {
        if (!isModalOpen()) {
            engine.togglePause();
            updateAll();
        }
    });

    screen.key(["r", "R"], async () => {
        if (!isModalOpen()) {
            addLog("REHASH", "Forcing full directory re-hash...", "cyan");
            updateAll();
            await engine.forceRehash();
            addLog("REHASH", "Re-hash complete. All files verified.", "green");
            updateAll();
        }
    });

    screen.key(["f", "F"], () => {
        if (!isModalOpen()) void showFolderSelector(false);
    });

    const scrollLog = (lines: number) => {
        if (!isModalOpen()) {
            logBox.scroll(lines);
            screen.render();
        }
    };
    screen.key(["up", "k"], () => scrollLog(-1));
    screen.key(["down", "j"], () => scrollLog(1));
    screen.key(["pageup"], () => scrollLog(-5));
    screen.key(["pagedown"], () => scrollLog(5));

    // Handle OS signals
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);

    // Periodic UI refresh for speed calculations and clock
    renderInterval = setInterval(() => {
        if (!isExiting && !isModalOpen()) updateAll();
    }, 500);

    // Initial render
    updateAll();

    try {
        // If folder wasn't specified on CLI, prompt user to select folder immediately upon entering TUI
        if (options.promptFolderOnStart) {
            await showFolderSelector(true);
        } else {
            await engine.start();
        }
    } catch (err) {
        destroyTui();
        throw err;
    }

    return {
        stop: () => cleanExit(0),
        destroy: destroyTui
    };
}
