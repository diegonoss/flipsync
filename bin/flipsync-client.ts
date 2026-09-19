#!/usr/bin/env node
import path from "node:path";
import { SyncClient } from "../src/client.js";

function printHelp(): void {
    console.log(`
FlipSync Client — Real-time file sync client

Usage:
  flipsync-client --server <url> [options]
  flipsync client --server <url> [options]

Options:
  -s, --server <url>     FlipSync host URL (http/https) [required]
  -t, --token <secret>   Authentication token (if host requires one)
  --target <path>        Target directory to sync files into (default: current directory ".")
  --once                 Sync current files once and exit immediately
  -q, --quiet            Suppress verbose output
  --help                 Show this help message

Environment variables:
  SYNC_SERVER            Same as --server
  SYNC_TOKEN             Same as --token
  SYNC_TARGET            Same as --target

Examples:
  flipsync-client --server https://abc-xyz.trycloudflare.com --token mysecret --target ./downloads
  flipsync-client --server http://192.168.1.100:7890 --once
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-help")) {
        printHelp();
        process.exit(0);
    }

    const getArg = (shortFlag: string, longFlag: string): string | undefined => {
        const sIdx = args.indexOf(shortFlag);
        if (sIdx !== -1 && sIdx + 1 < args.length) return args[sIdx + 1];
        const lIdx = args.indexOf(longFlag);
        if (lIdx !== -1 && lIdx + 1 < args.length) return args[lIdx + 1];
        return undefined;
    };

    const hasFlag = (shortFlag: string, longFlag: string): boolean =>
        args.includes(shortFlag) || args.includes(longFlag);

    const serverUrl = getArg("-s", "--server") || process.env.SYNC_SERVER;
    if (!serverUrl) {
        console.error("[ERROR] Missing required option: --server <url>");
        printHelp();
        process.exit(1);
    }

    const token = getArg("-t", "--token") || process.env.SYNC_TOKEN;
    const targetDir = path.resolve(getArg("", "--target") || process.env.SYNC_TARGET || ".");
    const once = hasFlag("", "--once");
    const verbose = !hasFlag("-q", "--quiet");

    const client = new SyncClient({
        serverUrl,
        token,
        targetDir,
        once,
        verbose
    });

    const shutdown = (): void => {
        console.log("\n[CLIENT] Disconnecting FlipSync client...");
        client.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await client.start();
    if (once) {
        process.exit(0);
    }
}

main().catch((err) => {
    console.error("[CLIENT] Fatal error:", err);
    process.exit(1);
});
