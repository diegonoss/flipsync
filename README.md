# FlipSync

```
================================================================================
  ______ _ _       _____                 
 |  ____| (_)     / ____|                
 | |__  | |_ _ __| (___  _   _ _ __   ___ 
 |  __| | | | '_ \___ \| | | | '_ \ / __|
 | |    | | | |_) |___) | |_| | | | | (__ 
 |_|    |_|_| .__/_____/ \__, |_| |_|\___|
            | |           __/ |           
            |_|          |___/            
================================================================================
  Zero-Friction Real-Time File Synchronization Across Networks
================================================================================
```

FlipSync is a lightweight, high-performance host-client file synchronization tool designed to mirror files between machines in real time. It works seamlessly across different networks using automatic Cloudflare Tunnels, Tailscale VPNs, or direct local LAN connections.

Whenever a file is updated, built, or modified on the host machine, FlipSync instantly streams the change to the client and atomically updates the target folder with SHA-256 checksum verification.

---

## Why FlipSync?

When developing, compiling, or building on one workstation (such as a Linux development machine, remote build server, or CI runner) and testing on another (such as a Windows gaming PC, staging server, or remote VM), moving files manually is slow and error-prone.

FlipSync solves this with:
- **Zero-Install Client Support**: Windows clients can sync files immediately via PowerShell without installing Node.js, Python, or Git. Linux/macOS clients can sync using a standard Bash one-liner.
- **Cross-Network Connectivity**: Built-in Cloudflare Tunnel integration provides a secure public URL without opening firewall ports, configuring routers, or setting up DDNS.
- **Atomic Integrity**: Every file is downloaded to a temporary buffer first, verified against its remote SHA-256 hash, and atomically swapped into place. Your applications never read partially written or corrupt files.
- **Instant Latency**: Uses Server-Sent Events (SSE) combined with debounced filesystem watching for millisecond-level reaction times upon file saves or build completions.

---

## Architecture Overview

```
+-------------------------------------------------------------+
|                         HOST MACHINE                        |
|                                                             |
|   Watched Directory: ./sync                                 |
|   +---------------+     +---------------+                   |
|   | file-1.bin    |     | file-2.js     |                   |
|   +---------------+     +---------------+                   |
|          |                     |                            |
|          v                     v                            |
|   [ DirectoryWatcher (Debounce + SHA-256 Hash Caching) ]    |
|                          |                                  |
|                          v                                  |
|   [ FlipSync HTTP & SSE Server (Port: 7890) ]               |
|          |                                                  |
|          +--------------------------+                       |
|          |                          |                       |
|   [ Local LAN / Tailscale ]  [ Cloudflare Tunnel ]          |
|   http://192.168.1.50:7890   https://*.trycloudflare.com    |
+----------+--------------------------+-----------------------+
           |                          |
           | (Local Subnet)           | (Public Internet / VPN)
           v                          v
+-------------------------------------------------------------+
|                        CLIENT MACHINE                       |
|                                                             |
|   Clients Supported:                                        |
|   - Windows PowerShell Client (Zero Install)                |
|   - Linux / macOS Bash Client (Zero Install)                |
|   - Standalone Node.js Client (Zero External Dependencies)  |
|   - FlipSync CLI (npx flipsync client)                      |
|                                                             |
|   Pipeline:                                                 |
|   1. Manifest Check: Compare local hashes with host         |
|   2. Atomic Download: Fetch to temp file                    |
|   3. Verification: Verify SHA-256 matches expected digest   |
|   4. Replacement: Atomic file rename                        |
|   5. Streaming: Maintain live SSE link for instant updates  |
|                                                             |
|   Target Directory: ./sync                                  |
+-------------------------------------------------------------+
```

---

## Core Features

- **Real-Time Streaming**: File modifications trigger instant SSE broadcasts. No wasteful high-frequency polling.
- **Long-Polling Fallback**: Clients in restricted environments can use HTTP long-polling (`/api/wait-change`).
- **Cryptographic Verification**: Every file transfer is verified with SHA-256 checksums before local persistence.
- **Atomic File Writes**: Files are written to temporary files first and renamed atomically, preventing race conditions or locked file errors.
- **Debounced Change Detection**: Prevents syncing intermediate states during multi-stage compiler builds.
- **Redundant Change Suppression**: If a file is touched or rebuilt with identical contents, no sync event is broadcast.
- **Subdirectory & Nested Path Support**: Recursively preserves directory structures with path-traversal security.
- **Token Authentication**: Secure your sync stream using Bearer tokens or query parameters, or enable open access for local networks.
- **Single-Run Mode (`--once`)**: Run a one-time synchronization and exit, ideal for CI/CD pipelines and deployment scripts.

---

## Installation

### Using pnpm (Recommended)

```bash
pnpm add -g flipsync
```

### Using npm

```bash
npm install -g flipsync
```

### Run Directly via npx / pnpm dlx

```bash
# Start host
pnpm dlx flipsync host --dir ./dist

# Connect client
pnpm dlx flipsync client --server https://abc.trycloudflare.com
```

---

## Quick Start

### 1. Start the Host

On the machine where your files are generated or edited:

```bash
# Basic usage: Watch and serve ./sync folder on local network
flipsync host --dir ./sync

# Cross-network access: Start an automatic Cloudflare Tunnel
flipsync host --dir ./dist --tunnel

# Specify a custom port and explicit authentication token
flipsync host --dir ./dist --port 7890 --token my-secret-token
```

When the host starts, it displays an interactive TUI dashboard (or banner in headless mode) with:
- Localhost URL
- Local LAN IP (for machines on the same Wi-Fi / subnet)
- Tailscale IP (if active)
- Public Cloudflare URL (if `--tunnel` is passed)
- Auth token
- Ready-to-copy one-liners for Windows, Linux/macOS, and Node.js

> **TUI Tip**: Press **`c`** at any time inside the interactive TUI to open the **Client Connection Commands** modal with quick one-keystroke clipboard copying (`[w]` for Windows, `[l]` for Linux/macOS, `[n]` for Node.js)!

---

### 2. Connect the Client

You have multiple client options depending on the target machine:

#### Option A: Windows PowerShell (Zero Install)

On a Windows machine, open PowerShell and run:

```powershell
# One-liner execution (downloads script directly from host memory and runs)
$s="https://<HOST_URL>"; $t="<TOKEN>"; irm "$s/client.ps1" | iex
```

Or using the downloaded script:

```powershell
.\scripts\sync-client.ps1 -Server "https://<HOST_URL>" -Token "<TOKEN>" -Target "C:\MyTargetFolder"
```

#### Option B: Linux / macOS Bash (Zero Install)

On Linux or macOS with `curl`:

```bash
# One-liner execution
curl -sSfL "https://<HOST_URL>/client.sh" | bash -s -- --server "https://<HOST_URL>" --token "<TOKEN>" --target ./sync
```

Or using the downloaded script:

```bash
chmod +x ./scripts/sync-client.sh
./scripts/sync-client.sh --server "https://<HOST_URL>" --token "<TOKEN>" --target ./sync
```

#### Option C: Standalone Node.js Client (Zero External Dependencies)

On any machine with Node.js installed:

```bash
node scripts/sync-client.js --server "https://<HOST_URL>" --token "<TOKEN>" --target ./sync
```

#### Option D: FlipSync CLI

```bash
flipsync client --server "https://<HOST_URL>" --token "<TOKEN>" --target ./sync
```

---

## Command Reference

### `flipsync host`

| Option | Shorthand | Default | Description |
| :--- | :--- | :--- | :--- |
| `--dir <path>` | `-d` | `.` (Current Dir) | Directory to watch and serve |
| `--port <num>` | `-p` | `7890` | Port to listen on (or `SYNC_PORT`) |
| `--host <ip>` | `-h` | `0.0.0.0` | Host IP binding (or `SYNC_HOST`) |
| `--token <sec>` | `-t` | Auto-generated | Secret token required for access |
| `--no-token` | | `false` | Disable authentication (open access) |
| `--tunnel` | | `false` | Launch automatic Cloudflare Tunnel |
| `--quiet` | `-q` | `false` | Suppress verbose log messages |
| `--help` | | | Display help information |

### `flipsync client`

| Option | Shorthand | Default | Description |
| :--- | :--- | :--- | :--- |
| `--server <url>` | `-s` | *Required* | URL of the FlipSync host |
| `--token <sec>` | `-t` | | Secret token matching the host |
| `--target <path>`| | `.` (Current Dir) | Directory where files are synced |
| `--once` | | `false` | Sync current files once and exit |
| `--quiet` | `-q` | `false` | Suppress verbose output |
| `--help` | | | Display help information |

---

## Environment Variables

You can configure FlipSync using environment variables in `.env` or your shell:

| Variable | Description |
| :--- | :--- |
| `SYNC_SERVER` | Server URL for the client |
| `SYNC_DIR` | Watched directory on the host |
| `SYNC_TARGET` | Destination directory on the client |
| `SYNC_PORT` | Port for the host server (default: `7890`) |
| `SYNC_HOST` | Host binding interface (default: `0.0.0.0`) |
| `SYNC_TOKEN` | Authentication secret token |
| `SYNC_TUNNEL` | Set to `"true"` to enable Cloudflare Tunnel |

---

## Programmatic API

FlipSync can also be used as a TypeScript / JavaScript library inside other applications:

### Server API

```typescript
import { SyncServer } from "flipsync";

const server = new SyncServer({
    port: 7890,
    syncDir: "./dist",
    token: "my-secret-key",
    verbose: true,
    debounceMs: 150
});

const info = await server.start();
console.log(`[HOST] Running at: ${info.localUrl}`);

// Graceful shutdown
// await server.stop();
```

### Client API

```typescript
import { SyncClient } from "flipsync";

const client = new SyncClient({
    serverUrl: "http://192.168.1.50:7890",
    token: "my-secret-key",
    targetDir: "./downloads",
    verbose: true,
    onSync: (file) => {
        console.log(`[SYNC] Received update for: ${file.name}`);
    },
    onDelete: (filename) => {
        console.log(`[SYNC] Host deleted: ${filename}`);
    }
});

await client.start();

// Graceful shutdown
// client.stop();
```

---

## Security Guardrails

- **Path Traversal Defenses**: All file requests through `/api/download/:filename` are strictly validated to prevent directory traversal (`..`, absolute paths, leading slashes).
- **Hidden File Protection**: Hidden files (`.*`), temporary write caches (`*.tmp.*`), and `node_modules` are automatically excluded from syncing.
- **Authentication**: When a token is configured, all API endpoints reject unauthorized calls with `401 Unauthorized`.
- **Integrity Validation**: If any transferred byte is modified in transit, SHA-256 verification fails immediately and the target file remains untouched.

---

## Repository Structure

```
flipsync/
├── bin/
│   ├── flipsync.ts           # Unified CLI router
│   ├── flipsync-host.ts      # Host server executable
│   └── flipsync-client.ts    # Client executable
├── src/
│   ├── index.ts              # Library entry point
│   ├── server.ts             # HTTP server, SSE broadcaster, long-poll
│   ├── client.ts             # Sync client, SSE listener, retry backoff
│   ├── watcher.ts            # Debounced directory watcher & hash cache
│   ├── hasher.ts             # SHA-256 computation & read resilience
│   ├── tunnel.ts             # Cloudflare tunnel & network discovery
│   └── types.ts              # TypeScript definitions
├── scripts/
│   ├── sync-client.ps1       # Zero-install PowerShell client for Windows
│   ├── sync-client.sh        # Zero-install Bash client for Linux / macOS
│   ├── sync-client.js        # Zero-dependency Node.js client
│   └── build.js              # esbuild + tsc build script
├── tests/
│   ├── hasher.test.ts        # SHA-256 & file read retry tests
│   ├── watcher.test.ts       # Watcher debouncing & cache tests
│   ├── server.test.ts        # Auth, routes, and path traversal tests
│   ├── e2e.test.ts           # Full end-to-end live sync integration test
│   ├── standalone.test.ts    # Standalone script test suite
│   └── run.ts                # Test runner
├── package.json              # Package definition & scripts
├── tsconfig.json             # TypeScript configuration
├── LICENSE                   # MIT License
└── README.md                 # Project documentation
```

---

## Development & Testing

```bash
# Install dependencies
pnpm install

# Run full test suite
pnpm test

# Type check
pnpm run typecheck

# Compile production bundles
pnpm run build
```

---

## License

MIT License (c) 2025-2026 Flipsi. See [LICENSE](file:///home/flipsi/Documentos/flipsync/LICENSE) for full details.
