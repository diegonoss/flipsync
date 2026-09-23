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
            tunnelDisplay = "{red-fg}✕ Error{/}";
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

    const renderTransferPanel = () => {
        const state = engine.getState();
        const active = state.activeTransfers.filter((t) => t.percent < 100);

        if (active.length === 0) {
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
                    `  • Errors Encountered: ${state.stats.errorsCount > 0 ? `{red-fg}{bold}${state.stats.errorsCount}{/}` : "0"}`
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
                `  • Conflicts Detected: ${state.stats.conflictsCount > 0 ? `{magenta-fg}{bold}${state.stats.conflictsCount}{/}` : "0"}`,
                `  • Errors Encountered: ${state.stats.errorsCount > 0 ? `{red-fg}{bold}${state.stats.errorsCount}{/}` : "0"}`
            ].join("\n"));
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
        const statusText = state.isPaused
            ? "PAUSED (press p to resume)"
            : state.indexing?.isIndexing
                ? `INDEXING ${state.indexing.completed}/${state.indexing.total} (${getIndexingPct(state.indexing)}%)`
                : state.status.toUpperCase();
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
    engine.on("scan:discovered", (e: { totalFiles: number }) =>
        addLog("INDEX", `Discovered ${e.totalFiles} file(s). Progressively indexing in background...`, "cyan"));
    engine.on("scan:progress", scheduleRender);
    engine.on("scan:complete", (e: { totalFiles: number }) =>
        addLog("INDEX", `Indexing complete. All ${e.totalFiles} file(s) indexed and verified.`, "green"));
    engine.on("engine:ready", (e: SyncEngineReadyEvent) => {
        addLog("READY", `Engine initialized. Watching ${e.filesCount} file(s) in ${e.syncDir}`, "green");
        if (e.tunnelUrl) addLog("TUNNEL", `Cloudflare public tunnel active: ${e.tunnelUrl}`, "cyan");
    });
    engine.on("sync:start", (e: SyncStartEvent) =>
        addLog("SYNC", `Batch sync started: ${e.count} file(s)`, "blue"));
    engine.on("sync:file-progress", scheduleRender);
    engine.on("sync:file-complete", (e: SyncFileCompleteEvent) =>
        addLog("COMPLETE", `Synchronized {bold}${e.file}{/} (${e.hash.slice(0, 8)}...)`, "green"));
    engine.on("sync:file-served", (e: SyncFileServedEvent) =>
        addLog("SERVED", `Sent {bold}${e.file}{/} (${(e.size / 1024).toFixed(1)} KB) to ${e.clientIp}`, "cyan"));
    engine.on("sync:conflict", (e: SyncConflictEvent) =>
        addLog("CONFLICT", `Conflict on {bold}${e.file}{/}! Local: ${e.localVersion} Remote: ${e.remoteVersion}`, "magenta"));
    engine.on("sync:error", (e: SyncErrorEvent) =>
        addLog("ERROR", `${e.context ? `[${e.context}] ` : ""}${e.error.message}`, "red"));
    engine.on("sync:idle", scheduleRender);
    engine.on("engine:pause", () => addLog("PAUSE", "Synchronization paused by user.", "yellow"));
    engine.on("engine:resume", () => addLog("RESUME", "Synchronization resumed.", "green"));
    engine.on("sync:cancelled", () => addLog("CANCEL", "Data transfers and file scan cancelled.", "yellow"));

    // Keybindings & Shutdown
    const restoreTerminalAndExit = (code: number): void => {
        try { screen.destroy(); } catch {}
        process.stdout.write("\x1b[?1049l\x1b[?25h");
        process.exit(code);
    };

    const cleanExit = async (code = 0): Promise<void> => {
        if (isExiting) return restoreTerminalAndExit(code);
        isExiting = true;

        const forceExitTimer = setTimeout(() => restoreTerminalAndExit(code), 1500);
        forceExitTimer.unref();

        if (renderTimer) clearTimeout(renderTimer);
        clearInterval(renderInterval);
        try { activeCommandModal?.close(); } catch {}

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

    const showFolderSelector = (isInitial = false) => {
        if (isModalOpen()) return;
        isPickerOpen = true;

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
                } catch (err) {
                    addLog("ERROR", `Failed to set folder: ${err instanceof Error ? err.message : String(err)}`, "red");
                }
            },
            () => {
                isPickerOpen = false;
                if (isInitial) cleanExit(0);
                else updateAll();
            }
        );
    };

    screen.key(["c", "C"], () => {
        if (isPickerOpen) return;
        if (activeCommandModal) activeCommandModal.close();
        else showCommandModal();
    });

    screen.key(["C-c"], () => cleanExit(0));

    screen.key(["q", "Q"], () => {
        if (activeCommandModal) activeCommandModal.close();
        else if (!isPickerOpen) cleanExit(0);
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
        if (!isModalOpen()) showFolderSelector(false);
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
    process.on("SIGINT", () => cleanExit(0));
    process.on("SIGTERM", () => cleanExit(0));

    // Periodic UI refresh for speed calculations and clock
    const renderInterval = setInterval(() => {
        if (!isExiting && !isModalOpen()) updateAll();
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
        stop: () => cleanExit(0)
    };
}
