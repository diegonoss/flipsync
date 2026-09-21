#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { SyncEngine } from "../src/core/SyncEngine.js";
import { runHeadlessCli } from "../src/cli/index.js";
import { runTui } from "../src/tui/index.js";

interface CliOptions {
    dir?: string;
    port?: string;
    host?: string;
    token?: string;
    noToken?: boolean;
    tunnel?: boolean;
    server?: string;
    target?: string;
    once?: boolean;
    tui?: boolean;
    headless?: boolean;
    quiet?: boolean;
    format?: "text" | "json";
    debounce?: string;
}

function determineExecutionMode(options: CliOptions): "tui" | "headless" {
    // Explicit headless flag (--headless or --no-tui)
    if (options.headless === true || options.tui === false) {
        return "headless";
    }
    // Explicit TUI flag (--tui)
    if (options.tui === true) {
        return "tui";
    }
    // Default behavior: interactive TUI if TTY is present; fallback to headless if non-interactive
    if (process.stdin.isTTY && process.stdout.isTTY) {
        return "tui";
    }
    return "headless";
}

async function startEngine(role: "host" | "client", options: CliOptions): Promise<void> {
    const execMode = determineExecutionMode(options);

    const port = options.port ? parseInt(options.port, 10) : undefined;
    const debounceMs = options.debounce ? parseInt(options.debounce, 10) : undefined;

    const engine = new SyncEngine({
        role,
        dir: options.dir,
        syncDir: options.dir,
        targetDir: options.target,
        port,
        host: options.host,
        token: typeof options.token === "string" ? options.token : undefined,
        noToken: options.noToken === true || (options.token as unknown) === false,
        tunnel: options.tunnel,
        serverUrl: options.server,
        once: options.once,
        debounceMs
    });

    const hasExplicitDir = Boolean(
        options.dir ||
        options.target ||
        (role === "host" && process.env.SYNC_DIR) ||
        (role === "client" && process.env.SYNC_TARGET)
    );

    if (execMode === "tui") {
        try {
            await runTui(engine, { promptFolderOnStart: !hasExplicitDir });
        } catch (err: unknown) {
            // If TUI initialization fails (e.g. invalid terminal), fallback to headless
            const error = err instanceof Error ? err : new Error(String(err));
            process.stderr.write(`[WARN] TUI initialization failed: ${error.message}. Falling back to headless mode.\n`);
            await runHeadlessCli(engine, {
                format: options.format,
                quiet: options.quiet
            });
            await engine.start();
        }
    } else {
        await runHeadlessCli(engine, {
            format: options.format,
            quiet: options.quiet
        });
        await engine.start();
    }

    if (role === "client" && options.once) {
        // Once mode: shutdown after sync
        await engine.stop();
        process.exit(0);
    }
}

const program = new Command();

program
    .name("flipsync")
    .description("Zero-friction real-time file synchronization tool with interactive TUI and headless CLI")
    .version("1.0.0");

program
    .command("host", { isDefault: true })
    .description("Start FlipSync host server to watch and serve files (default command)")
    .option("-d, --dir <path>", "Directory to watch and sync (default: current directory '.')")
    .option("-p, --port <number>", "Port to listen on (default: 7890)")
    .option("-h, --host <ip>", "Host address to bind to (default: 0.0.0.0)")
    .option("-t, --token <secret>", "Authentication token")
    .option("--no-token", "Disable authentication (open network access)")
    .option("--tunnel", "Start automatic Cloudflare public tunnel")
    .option("-s, --server <url>", "FlipSync host URL (switches to client mode)")
    .option("--target <path>", "Target directory for client sync (default: '.')")
    .option("--once", "Sync once and exit immediately (client mode)")
    .option("--tui", "Launch interactive Terminal User Interface (default in TTY)")
    .option("--headless", "Run headless background daemon with structured stdout/stderr")
    .option("--no-tui", "Disable TUI and run in headless mode")
    .option("-q, --quiet", "Suppress non-essential progress output in headless mode")
    .option("--format <format>", "Output format for headless mode (text or json)", "text")
    .option("--debounce <ms>", "File watcher debounce window in ms (default: 150)")
    .action(async (options: CliOptions) => {
        const role = options.server ? "client" : "host";
        await startEngine(role, options);
    });

program
    .command("client")
    .description("Connect to a FlipSync host and sync files in real time")
    .requiredOption("-s, --server <url>", "FlipSync host URL (http/https)")
    .option("-t, --token <secret>", "Authentication token (if host requires one)")
    .option("--target <path>", "Target directory to sync files into (default: '.')")
    .option("--once", "Sync current files once and exit immediately")
    .option("--tui", "Launch interactive Terminal User Interface (default in TTY)")
    .option("--headless", "Run headless background daemon with structured stdout/stderr")
    .option("--no-tui", "Disable TUI and run in headless mode")
    .option("-q, --quiet", "Suppress non-essential progress output in headless mode")
    .option("--format <format>", "Output format for headless mode (text or json)", "text")
    .action(async (options: CliOptions) => {
        await startEngine("client", options);
    });

program.parseAsync(process.argv).catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exit(1);
});
