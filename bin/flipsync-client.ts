#!/usr/bin/env node
import { Command } from "commander";
import { SyncEngine } from "../src/core/SyncEngine.js";
import { runHeadlessCli } from "../src/cli/index.js";
import { runTui } from "../src/tui/index.js";

interface ClientCliOptions {
    server: string;
    token?: string;
    target?: string;
    once?: boolean;
    tui?: boolean;
    headless?: boolean;
    quiet?: boolean;
    format?: "text" | "json";
}

function determineExecutionMode(options: ClientCliOptions): "tui" | "headless" {
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
        .name("flipsync-client")
        .description("FlipSync Client — Real-time file sync client with interactive TUI and headless CLI")
        .version("1.0.0")
        .requiredOption("-s, --server <url>", "FlipSync host URL (http/https)")
        .option("-t, --token <secret>", "Authentication token (if host requires one)")
        .option("--target <path>", "Target directory to sync files into (default: '.')")
        .option("--once", "Sync current files once and exit immediately")
        .option("--tui", "Launch interactive Terminal User Interface (default in TTY)")
        .option("--headless", "Run headless background daemon with structured stdout/stderr")
        .option("--no-tui", "Disable TUI and run in headless mode")
        .option("-q, --quiet", "Suppress non-essential progress output in headless mode")
        .option("--format <format>", "Output format for headless mode (text or json)", "text");

    await program.parseAsync(process.argv);
    const options = program.opts<ClientCliOptions>();

    const execMode = determineExecutionMode(options);

    const engine = new SyncEngine({
        role: "client",
        serverUrl: options.server,
        token: options.token,
        targetDir: options.target,
        syncDir: options.target,
        once: options.once
    });

    const hasExplicitDir = Boolean(options.target || process.env.SYNC_TARGET);

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

    if (options.once) {
        await engine.stop();
        process.exit(0);
    }
}

main().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[CLIENT] Fatal error: ${error.message}\n`);
    process.exit(1);
});
