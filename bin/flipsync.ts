#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function printHelp(): void {
    console.log(`
FlipSync — Real-Time File Synchronization Tool

Usage:
  flipsync <command> [options]

Commands:
  host      Start the FlipSync host server to watch and serve files
  client    Connect to a FlipSync host and sync files in real time

Help:
  flipsync host --help
  flipsync client --help

Examples:
  flipsync host --dir ./build --tunnel
  flipsync client --server https://abc-xyz.trycloudflare.com --token mysecret --target ./dist
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === "--help" || command === "-h" || command === "help") {
        printHelp();
        process.exit(0);
    }

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    let targetScript = "";

    if (command === "host") {
        targetScript = path.join(currentDir, "flipsync-host.js");
        if (!targetScript.endsWith(".js") || !path.extname(process.argv[1] || "").endsWith(".js")) {
            // Running under tsx or node directly
            const tsPath = path.join(currentDir, "flipsync-host.ts");
            const jsPath = path.join(currentDir, "flipsync-host.js");
            targetScript = path.extname(process.argv[1] || "").endsWith(".ts") ? tsPath : jsPath;
        }
    } else if (command === "client") {
        const tsPath = path.join(currentDir, "flipsync-client.ts");
        const jsPath = path.join(currentDir, "flipsync-client.js");
        targetScript = path.extname(process.argv[1] || "").endsWith(".ts") ? tsPath : jsPath;
    } else {
        console.error(`[ERROR] Unknown command: "${command}"\n`);
        printHelp();
        process.exit(1);
    }

    const child = spawn(process.execPath, [targetScript, ...args.slice(1)], {
        stdio: "inherit"
    });

    child.on("exit", (code) => {
        process.exit(code ?? 0);
    });
}

main().catch((err) => {
    console.error("[ERROR]", err);
    process.exit(1);
});
