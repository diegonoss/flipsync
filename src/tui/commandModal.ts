import blessed from "blessed";
import { spawn } from "node:child_process";
import type { SyncEngineState } from "../core/SyncEngine.js";

export interface EndpointOption {
    label: string;
    url: string;
}

export interface ClientCommands {
    powershell: string;
    bash: string;
    node: string;
}

export interface CommandModalOptions {
    state: SyncEngineState;
    onClose?: () => void;
}

/**
 * Copies text to the OS system clipboard across Windows, macOS, and Linux.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    const platform = process.platform;

    return new Promise<boolean>((resolve) => {
        let cmd = "";
        let args: string[] = [];

        if (platform === "win32") {
            cmd = "clip.exe";
        } else if (platform === "darwin") {
            cmd = "pbcopy";
        } else {
            if (process.env.WAYLAND_DISPLAY) {
                cmd = "wl-copy";
            } else {
                cmd = "xclip";
                args = ["-selection", "clipboard"];
            }
        }

        let resolved = false;
        const done = (val: boolean) => {
            if (!resolved) {
                resolved = true;
                resolve(val);
            }
        };

        const timer = setTimeout(() => done(false), 2000);

        try {
            const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });

            proc.on("error", () => {
                if (platform === "linux" && cmd === "wl-copy") {
                    try {
                        const fallbackProc = spawn("xclip", ["-selection", "clipboard"], {
                            stdio: ["pipe", "ignore", "ignore"]
                        });
                        fallbackProc.on("error", () => {
                            clearTimeout(timer);
                            done(false);
                        });
                        fallbackProc.on("close", (code) => {
                            clearTimeout(timer);
                            done(code === 0);
                        });
                        fallbackProc.stdin.write(text);
                        fallbackProc.stdin.end();
                        return;
                    } catch {
                        clearTimeout(timer);
                        done(false);
                        return;
                    }
                }
                clearTimeout(timer);
                done(false);
            });

            proc.on("close", (code) => {
                clearTimeout(timer);
                done(code === 0);
            });

            proc.stdin.write(text);
            proc.stdin.end();
        } catch {
            clearTimeout(timer);
            done(false);
        }
    });
}

/**
 * Extracts and prioritizes all available server endpoints from the engine state.
 */
export function extractEndpoints(state: SyncEngineState): EndpointOption[] {
    const list: EndpointOption[] = [];

    if (state.endpoints?.tunnel) {
        list.push({ label: "Public Tunnel", url: state.endpoints.tunnel });
    }
    if (state.endpoints?.lan) {
        list.push({ label: "Local LAN", url: state.endpoints.lan });
    }
    if (state.endpoints?.tailscale) {
        list.push({ label: "Tailscale", url: state.endpoints.tailscale });
    }
    if (state.endpoints?.local) {
        list.push({ label: "Localhost", url: state.endpoints.local });
    }
    if (state.serverUrl && !list.some((e) => e.url === state.serverUrl)) {
        list.push({ label: "Host Server", url: state.serverUrl });
    }

    if (list.length === 0) {
        list.push({ label: "Default", url: "http://localhost:7890" });
    }

    return list;
}

/**
 * Generates ready-to-run zero-install commands for Windows PowerShell, Linux/macOS Bash, and Node.js.
 */
export function generateClientCommands(serverUrl: string, token?: string): ClientCommands {
    const cleanUrl = serverUrl.trim().replace(/\/+$/, "");
    const tokenPartBash = token ? ` --token "${token}"` : "";

    const powershell = token
        ? `$s="${cleanUrl}"; $t="${token}"; irm "$s/client.ps1" | iex`
        : `$s="${cleanUrl}"; irm "$s/client.ps1" | iex`;

    const bash = `curl -sSfL "${cleanUrl}/client.sh" | bash -s -- --server "${cleanUrl}"${tokenPartBash} --target ./sync`;

    const node = `curl -sSfL "${cleanUrl}/client.js" -o sync-client.js && node sync-client.js --server "${cleanUrl}"${tokenPartBash} --target ./sync`;

    return { powershell, bash, node };
}

/**
 * Opens an interactive TUI modal dialog displaying the client run commands with copy shortcuts.
 */
export function openCommandModal(
    screen: blessed.Widgets.Screen,
    options: CommandModalOptions
): { close: () => void } {
    const { state, onClose } = options;
    const endpoints = extractEndpoints(state);
    let activeIndex = 0;
    let statusMessage = "";
    let isClosed = false;

    // Overlay backdrop
    const overlay = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        style: {
            bg: "black",
            transparent: true
        }
    });

    // Modal Box
    const modalBox = blessed.box({
        parent: overlay,
        top: "center",
        left: "center",
        width: "88%",
        height: 22,
        border: { type: "line" },
        style: {
            border: { fg: "cyan" },
            bg: "black"
        },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: " ",
            track: { bg: "cyan" },
            style: { inverse: true }
        },
        keys: true,
        vi: true,
        mouse: true,
        label: " FlipSync — Client Connection Commands "
    });

    const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        try {
            overlay.detach();
            screen.render();
        } catch {
            // Ignore
        }
        if (onClose) {
            onClose();
        }
    };

    const updateContent = () => {
        if (isClosed) return;
        const current = endpoints[activeIndex] || endpoints[0];
        const cmds = generateClientCommands(current.url, state.token);

        const cycleHint = endpoints.length > 1
            ? ` {gray-fg}[${activeIndex + 1}/${endpoints.length}] (Press [Tab] to cycle endpoint){/}`
            : "";

        const tokenDisplay = state.token
            ? `{green-fg}${state.token}{/}`
            : `{gray-fg}(Open Access — No Token){/}`;

        const lines = [
            `{bold}{cyan-fg}Run directly on client PC without downloading/installing packages:{/}`,
            `{bold}Server URL:{/} {underline}${current.url}{/} {yellow-fg}[${current.label}]{/}${cycleHint}`,
            `{bold}Auth Token:{/} ${tokenDisplay}`,
            "",
            `{bold}{yellow-fg}▶ Option 1: Windows PowerShell (Zero Install){/}`,
            `  {white-fg}${cmds.powershell}{/}`,
            "",
            `{bold}{green-fg}▶ Option 2: Linux / macOS Bash (Zero Install){/}`,
            `  {white-fg}${cmds.bash}{/}`,
            "",
            `{bold}{cyan-fg}▶ Option 3: Standalone Node.js (Zero npm Packages){/}`,
            `  {white-fg}${cmds.node}{/}`,
            "",
            statusMessage
                ? `${statusMessage}`
                : `{gray-fg}Press shortcut to copy command to system clipboard:{/}`,
            "",
            `{bold}[w]{/} Copy Windows  {bold}[l]{/} Copy Linux  {bold}[n]{/} Copy Node  {bold}[Tab]{/} Next URL  {bold}[Esc/c]{/} Close`
        ];

        modalBox.setContent(lines.join("\n"));
        screen.render();
    };

    const handleCopy = async (cmd: string, name: string) => {
        const ok = await copyToClipboard(cmd);
        if (ok) {
            statusMessage = `{green-bg}{black-fg}{bold} ✔ COPIED {/} {green-fg}${name} command copied to clipboard!{/}`;
        } else {
            statusMessage = `{yellow-fg}Command displayed above. Select text in terminal to copy.{/}`;
        }
        updateContent();
    };

    modalBox.key(["w", "W", "1"], async () => {
        const current = endpoints[activeIndex] || endpoints[0];
        const cmds = generateClientCommands(current.url, state.token);
        await handleCopy(cmds.powershell, "Windows PowerShell");
    });

    modalBox.key(["l", "L", "2"], async () => {
        const current = endpoints[activeIndex] || endpoints[0];
        const cmds = generateClientCommands(current.url, state.token);
        await handleCopy(cmds.bash, "Linux/macOS Bash");
    });

    modalBox.key(["n", "N", "3"], async () => {
        const current = endpoints[activeIndex] || endpoints[0];
        const cmds = generateClientCommands(current.url, state.token);
        await handleCopy(cmds.node, "Standalone Node.js");
    });

    modalBox.key(["tab", "t", "T"], () => {
        if (endpoints.length > 1) {
            activeIndex = (activeIndex + 1) % endpoints.length;
            const current = endpoints[activeIndex];
            statusMessage = `{cyan-fg}Switched active URL to [${current.label}]: ${current.url}{/}`;
            updateContent();
        }
    });

    modalBox.key(["escape", "enter", "space", "c", "C", "q", "Q"], () => {
        cleanup();
    });

    updateContent();
    modalBox.focus();
    screen.render();

    return {
        close: cleanup
    };
}
