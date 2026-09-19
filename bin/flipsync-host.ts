#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SyncServer } from "../src/server.js";
import { detectTailscaleIp, getLocalLanIp, startAutoTunnel, type TunnelResult } from "../src/tunnel.js";

function printHelp(): void {
    console.log(`
FlipSync Host — Real-time file sync server

Usage:
  flipsync-host [options]
  flipsync host [options]

Options:
  -d, --dir <path>       Directory to watch and sync (default: current directory ".")
  -p, --port <number>    Port to listen on (default: 7890 or SYNC_PORT)
  -h, --host <ip>        Host address to bind to (default: 0.0.0.0 or SYNC_HOST)
  -t, --token <secret>   Authentication token (default: auto-generated or SYNC_TOKEN)
  --no-token             Disable authentication (open network access)
  --tunnel               Start an automatic Cloudflare public tunnel
  -q, --quiet            Suppress verbose logging
  --help                 Show this help message

Environment variables:
  SYNC_DIR               Same as --dir
  SYNC_PORT              Same as --port
  SYNC_HOST              Same as --host
  SYNC_TOKEN             Same as --token
  SYNC_TUNNEL            Set to "true" to enable tunnel
`);
}

function printBanner(
    localUrl: string,
    tailscaleIp: string | null,
    port: number,
    tunnelUrl: string | null,
    syncDir: string,
    token?: string
): void {
    const divider = "=".repeat(68);
    const subDivider = "-".repeat(68);
    const lanIp = getLocalLanIp();
    const lanUrl = lanIp ? `http://${lanIp}:${port}` : null;

    console.log(`\n${divider}`);
    console.log("       FlipSync — Real-Time File Synchronization Host");
    console.log(`${divider}`);
    console.log(`  Directory:  ${syncDir}`);
    console.log(`  Localhost:  ${localUrl}`);
    if (lanUrl) {
        console.log(`  Local LAN:  ${lanUrl} (Same Wi-Fi / Subnet)`);
    }
    if (tailscaleIp) {
        console.log(`  Tailscale:  http://${tailscaleIp}:${port}`);
    }
    if (tunnelUrl) {
        console.log(`  Public URL: ${tunnelUrl} (Internet Tunnel)`);
    }
    if (token) {
        console.log(`  Auth Token: ${token}`);
    } else {
        console.log("  Auth Token: (None - Open Access)");
    }

    console.log(`\n${subDivider}`);
    console.log("  Client Connection Commands:");
    console.log(subDivider);

    const activeUrl = tunnelUrl || lanUrl || localUrl;

    console.log("\n  [Windows PowerShell (Zero-Install)]");
    const psCmd = token
        ? `$s='${activeUrl}'; $t='${token}'; 1..5 | %{ try { irm "$s/client.ps1" | iex; break } catch { Start-Sleep 2 } }`
        : `$s='${activeUrl}'; 1..5 | %{ try { irm "$s/client.ps1" | iex; break } catch { Start-Sleep 2 } }`;
    console.log(`  ${psCmd}`);

    console.log("\n  [Linux / macOS Bash]");
    const bashCmd = token
        ? `curl -sSfL "${activeUrl}/client.sh" | bash -s -- --server "${activeUrl}" --token "${token}"`
        : `curl -sSfL "${activeUrl}/client.sh" | bash -s -- --server "${activeUrl}"`;
    console.log(`  ${bashCmd}`);

    console.log("\n  [Node.js / FlipSync CLI]");
    const cliCmd = token
        ? `npx flipsync client --server "${activeUrl}" --token "${token}"`
        : `npx flipsync client --server "${activeUrl}"`;
    console.log(`  ${cliCmd}`);

    console.log(`\n${divider}\n`);
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

    const port = parseInt(getArg("-p", "--port") || process.env.SYNC_PORT || "7890", 10);
    const host = getArg("-h", "--host") || process.env.SYNC_HOST || "0.0.0.0";
    const syncDirInput = getArg("-d", "--dir") || getArg("", "--dist") || process.env.SYNC_DIR || ".";
    const syncDir = path.resolve(syncDirInput);
    const enableTunnel = hasFlag("", "--tunnel") || process.env.SYNC_TUNNEL === "true";
    const verbose = !hasFlag("-q", "--quiet");
    const noToken = hasFlag("", "--no-token");

    // Resolve or generate token
    let token: string | undefined;
    const tokenFile = path.resolve(".sync-token");
    if (noToken) {
        token = undefined;
    } else if (getArg("-t", "--token")) {
        token = getArg("-t", "--token");
    } else if (process.env.SYNC_TOKEN) {
        token = process.env.SYNC_TOKEN;
    } else {
        if (fs.existsSync(tokenFile)) {
            token = fs.readFileSync(tokenFile, "utf8").trim();
        } else {
            token = crypto.randomBytes(16).toString("hex");
            try {
                fs.writeFileSync(tokenFile, token, { encoding: "utf8" });
            } catch {
                // Ignore if read-only filesystem
            }
        }
    }

    const server = new SyncServer({
        port,
        host,
        syncDir,
        token,
        verbose
    });

    let info: { port: number; host: string; localUrl: string; syncDir: string };
    try {
        info = await server.start();
    } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "EADDRINUSE") {
            console.error(`\n[HOST] [ERROR] Port ${port} is already in use.`);
            console.error(`  Another process is currently listening on ${host}:${port}.`);
            console.error(`  - Run on another port:   flipsync host --port ${port + 1}`);
            console.error(`  - Or kill process on port: kill $(lsof -t -i:${port} 2>/dev/null)\n`);
            process.exit(1);
        }
        console.error(`\n[HOST] [ERROR] Failed to start server: ${error.message}\n`);
        process.exit(1);
    }
    const tailscaleIp = detectTailscaleIp();

    let tunnel: TunnelResult | null = null;
    let tunnelUrl: string | null = null;

    if (enableTunnel) {
        console.log("[HOST] Initializing public Cloudflare tunnel for cross-network access...");
        try {
            tunnel = await startAutoTunnel(info.port);
            tunnelUrl = tunnel.url;
            console.log(`[HOST] Tunnel online: ${tunnelUrl}`);
            if (tunnelUrl) {
                try {
                    fs.writeFileSync(".sync-url", tunnelUrl, "utf8");
                } catch {
                    // Ignore
                }
            }
        } catch (err: unknown) {
            console.warn(`[HOST] [WARN] Tunnel could not start: ${(err as Error).message}`);
        }
    }

    printBanner(info.localUrl, tailscaleIp, info.port, tunnelUrl, syncDir, token);

    const shutdown = async (): Promise<void> => {
        console.log("\n[HOST] Shutting down FlipSync host...");
        if (tunnel) tunnel.stop();
        await server.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("[HOST] Fatal error:", err);
    process.exit(1);
});
