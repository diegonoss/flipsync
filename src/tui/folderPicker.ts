import blessed from "blessed";
import fs from "node:fs";
import path from "node:path";

export interface FolderPickerOptions {
    initialDir?: string;
    title?: string;
    canCancel?: boolean;
}

function getSubdirectories(dirPath: string): string[] {
    try {
        if (!fs.existsSync(dirPath)) return [];
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
            .filter((e) => {
                try {
                    return (
                        e.isDirectory() &&
                        !e.name.startsWith(".") &&
                        e.name !== "node_modules"
                    );
                } catch {
                    return false;
                }
            })
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

export function openFolderPicker(
    screen: blessed.Widgets.Screen,
    options: FolderPickerOptions,
    onSelect: (selectedPath: string) => void,
    onCancel?: () => void
): { close: () => void } {
    let currentDir = path.resolve(options.initialDir || process.cwd());
    let isPromptOpen = false;

    // Overlay backdrop to dim the background
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

    // Main Modal Dialog Box
    const modalBox = blessed.box({
        parent: overlay,
        top: "center",
        left: "center",
        width: "82%",
        height: 20,
        border: { type: "line" },
        style: {
            border: { fg: "green" },
            bg: "black"
        },
        tags: true,
        label: ` ${options.title ?? "Select Folder to Synchronize"} `
    });

    const infoBox = blessed.box({
        parent: modalBox,
        top: 0,
        left: 1,
        right: 1,
        height: 2,
        tags: true,
        style: { bg: "black" }
    });

    // Directory list view
    const list = blessed.list({
        parent: modalBox,
        top: 3,
        left: 1,
        right: 1,
        bottom: 3,
        keys: true,
        vi: true,
        mouse: true,
        scrollable: true,
        scrollbar: {
            ch: " ",
            track: { bg: "cyan" },
            style: { inverse: true }
        },
        style: {
            bg: "black",
            selected: {
                bg: "blue",
                fg: "white",
                bold: true
            },
            item: {
                bg: "black",
                fg: "white"
            }
        },
        tags: true
    });

    const hintBox = blessed.box({
        parent: modalBox,
        bottom: 0,
        left: 1,
        right: 1,
        height: 2,
        tags: true,
        style: { bg: "black" },
        content:
            "{gray-fg}[Enter] Navigate/Select  [Space/s] Select Current Folder  [Backspace] Up  [q/Esc] Cancel{/}"
    });

    let currentSubdirs: string[] = [];

    const refreshList = () => {
        currentSubdirs = getSubdirectories(currentDir);
        const folderName = path.basename(currentDir) || "/";

        infoBox.setContent(
            `{bold}Current Folder:{/} {underline}${currentDir}{/}\n` +
            `{gray-fg}Subdirectories: ${currentSubdirs.length}{/}`
        );

        const items: string[] = [
            `{bold}{green-fg}[✓] [Select Current Folder: ${folderName}]{/}`,
            `{bold}{cyan-fg}[+] [Enter Custom Path...]{/}`,
            `{yellow-fg}▸{/}   ../ (Parent Directory)`
        ];

        for (const sub of currentSubdirs) {
            items.push(`{blue-fg}▸{/}   ${sub}/`);
        }

        list.setItems(items);
        list.select(0);
        list.focus();
        screen.render();
    };

    const cleanup = () => {
        try {
            overlay.detach();
            screen.render();
        } catch {
            // Ignore
        }
    };

    const confirmSelection = (dirToSelect: string) => {
        cleanup();
        onSelect(dirToSelect);
    };

    const promptCustomPath = () => {
        isPromptOpen = true;

        const inputModal = blessed.box({
            parent: modalBox,
            top: "center",
            left: "center",
            width: "70%",
            height: 7,
            border: { type: "line" },
            style: {
                border: { fg: "yellow" },
                bg: "black"
            },
            tags: true,
            label: " Enter Custom Directory Path "
        });

        const label = blessed.box({
            parent: inputModal,
            top: 0,
            left: 1,
            content: "Folder Path (relative or absolute):",
            tags: true,
            style: { bg: "black" }
        });

        const input = blessed.textbox({
            parent: inputModal,
            top: 2,
            left: 1,
            right: 1,
            height: 1,
            inputOnFocus: true,
            keys: true,
            mouse: true,
            style: {
                bg: "blue",
                fg: "white"
            }
        });

        input.setValue(currentDir);
        input.focus();
        screen.render();

        input.on("submit", (val: string) => {
            inputModal.detach();
            isPromptOpen = false;
            const target = (val || "").trim();
            if (target) {
                const resolved = path.resolve(currentDir, target);
                if (!fs.existsSync(resolved)) {
                    try {
                        fs.mkdirSync(resolved, { recursive: true });
                    } catch {
                        // Ignore
                    }
                }
                confirmSelection(resolved);
            } else {
                refreshList();
            }
        });

        input.on("cancel", () => {
            inputModal.detach();
            isPromptOpen = false;
            refreshList();
        });
    };

    list.on("select", (_item, index) => {
        if (isPromptOpen) return;

        if (index === 0) {
            // Confirm current directory
            confirmSelection(currentDir);
        } else if (index === 1) {
            // Prompt custom path
            promptCustomPath();
        } else if (index === 2) {
            // Navigate up
            const parent = path.dirname(currentDir);
            if (parent !== currentDir) {
                currentDir = parent;
                refreshList();
            }
        } else {
            // Navigate down into subdirectory
            const subdirName = currentSubdirs[index - 3];
            if (subdirName) {
                const nextDir = path.join(currentDir, subdirName);
                if (fs.existsSync(nextDir)) {
                    currentDir = nextDir;
                    refreshList();
                }
            }
        }
    });

    list.key(["s", "S", "space"], () => {
        if (isPromptOpen) return;
        confirmSelection(currentDir);
    });

    list.key(["backspace"], () => {
        if (isPromptOpen) return;
        const parent = path.dirname(currentDir);
        if (parent !== currentDir) {
            currentDir = parent;
            refreshList();
        }
    });

    list.key(["escape", "q", "C-c"], () => {
        if (isPromptOpen) return;
        cleanup();
        if (onCancel) {
            onCancel();
        }
    });

    refreshList();

    return {
        close: cleanup
    };
}
