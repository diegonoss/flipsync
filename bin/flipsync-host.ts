#!/usr/bin/env node
import { Command } from "commander";
import { SyncEngine } from "../src/core/SyncEngine.js";
import { runHeadlessCli } from "../src/cli/index.js";
import { runTui } from "../src/tui/index.js";

interface HostCliOptions {
    dir?: string;
    port?: string;
    host?: string;
    token?: string;
    noToken?: boolean;
    tunnel?: boolean;
    tui?: boolean;
    headless?: boolean;
    quiet?: boolean;
    format?: "text" | "json";
    debounce?: string;
}

function determineExecutionMode(options: HostCliOptions): "tui" | "headless" {
    if (options.headless === true || options.tui === false) {
        return "headless";
    }
    if (options.tui === true) {
        return "tui";
    }
    if (process.stdin.isTTY && process.stdout.isTTY) {
        return "tui";
    }
    return "headless";
}

async function main(): Promise<void> {
    const program = new Command();

    program
        .name("flipsync-host")
        .description("FlipSync Host — Real-time file sync server with interactive TUI and headless CLI")
        .version("1.0.0")
        .option("-d, --dir <path>", "Directory to watch and sync (default: current directory '.')")
        .option("-p, --port <number>", "Port to listen on (default: 7890 or SYNC_PORT)")
        .option("-h, --host <ip>", "Host address to bind to (default: 0.0.0.0 or SYNC_HOST)")
        .option("-t, --token <secret>", "Authentication token (default: auto-generated or SYNC_TOKEN)")
        .option("--no-token", "Disable authentication (open network access)")
        .option("--tunnel", "Start automatic Cloudflare public tunnel")
        .option("--tui", "Launch interactive Terminal User Interface (default in TTY)")
        .option("--headless", "Run headless background daemon with structured stdout/stderr")
        .option("--no-tui", "Disable TUI and run in headless mode")
        .option("-q, --quiet", "Suppress non-essential progress output in headless mode")
        .option("--format <format>", "Output format for headless mode (text or json)", "text")
        .option("--debounce <ms>", "File watcher debounce window in ms (default: 150)");

    await program.parseAsync(process.argv);
    const options = program.opts<HostCliOptions>();

    const execMode = determineExecutionMode(options);
    const port = options.port ? parseInt(options.port, 10) : undefined;
    const debounceMs = options.debounce ? parseInt(options.debounce, 10) : undefined;

    const engine = new SyncEngine({
        role: "host",
        dir: options.dir,
        syncDir: options.dir,
        port,
        host: options.host,
        token: typeof options.token === "string" ? options.token : undefined,
        noToken: options.noToken === true || (options.token as unknown) === false,
        tunnel: options.tunnel,
        debounceMs
    });

    const hasExplicitDir = Boolean(options.dir || process.env.SYNC_DIR);

    if (execMode === "tui") {
        try {
            await runTui(engine, { promptFolderOnStart: !hasExplicitDir });
        } catch (err: unknown) {
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
}

main().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[HOST] Fatal error: ${error.message}\n`);
    process.exit(1);
});
