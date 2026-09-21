import assert from "node:assert/strict";
import { generateClientCommands, extractEndpoints, copyToClipboard } from "../src/tui/commandModal.js";
import type { SyncEngineState } from "../src/core/SyncEngine.js";

export async function testCommandModal(): Promise<void> {
    console.log("  [TEST] TUI Command Modal: Command Generation & Endpoints");

    // Test 1: Command generation with token
    const cmdsWithToken = generateClientCommands("https://flipsync-test.trycloudflare.com/", "secret123");
    assert.strictEqual(
        cmdsWithToken.powershell,
        '$s="https://flipsync-test.trycloudflare.com"; $t="secret123"; irm "$s/client.ps1" | iex'
    );
    assert.strictEqual(
        cmdsWithToken.bash,
        'curl -sSfL "https://flipsync-test.trycloudflare.com/client.sh" | bash -s -- --server "https://flipsync-test.trycloudflare.com" --token "secret123" --target ./sync'
    );
    assert.strictEqual(
        cmdsWithToken.node,
        'curl -sSfL "https://flipsync-test.trycloudflare.com/client.js" -o sync-client.js && node sync-client.js --server "https://flipsync-test.trycloudflare.com" --token "secret123" --target ./sync'
    );

    // Test 2: Command generation without token
    const cmdsNoToken = generateClientCommands("http://192.168.1.100:7890");
    assert.strictEqual(
        cmdsNoToken.powershell,
        '$s="http://192.168.1.100:7890"; irm "$s/client.ps1" | iex'
    );
    assert.strictEqual(
        cmdsNoToken.bash,
        'curl -sSfL "http://192.168.1.100:7890/client.sh" | bash -s -- --server "http://192.168.1.100:7890" --target ./sync'
    );
    assert.strictEqual(
        cmdsNoToken.node,
        'curl -sSfL "http://192.168.1.100:7890/client.js" -o sync-client.js && node sync-client.js --server "http://192.168.1.100:7890" --target ./sync'
    );

    // Test 3: Endpoint extraction
    const mockState: SyncEngineState = {
        role: "host",
        status: "idle",
        isPaused: false,
        syncDir: "/tmp/sync",
        endpoints: {
            local: "http://localhost:7890",
            lan: "http://192.168.1.50:7890",
            tailscale: "http://100.64.0.1:7890",
            tunnel: "https://my-tunnel.trycloudflare.com",
            active: "https://my-tunnel.trycloudflare.com"
        },
        tunnelState: "online",
        token: "my-token",
        stats: {
            totalFiles: 5,
            syncedFiles: 5,
            activeTransfers: 0,
            bytesTransferred: 1024,
            speedBps: 0,
            errorsCount: 0,
            conflictsCount: 0,
            lastSyncTime: Date.now()
        },
        activeTransfers: []
    };

    const endpoints = extractEndpoints(mockState);
    assert.strictEqual(endpoints.length, 4);
    assert.strictEqual(endpoints[0].label, "Public Tunnel");
    assert.strictEqual(endpoints[0].url, "https://my-tunnel.trycloudflare.com");
    assert.strictEqual(endpoints[1].label, "Local LAN");
    assert.strictEqual(endpoints[1].url, "http://192.168.1.50:7890");
    assert.strictEqual(endpoints[2].label, "Tailscale");
    assert.strictEqual(endpoints[3].label, "Localhost");

    // Test 4: Clipboard helper non-hanging test
    const copyResult = await copyToClipboard("echo test");
    assert.strictEqual(typeof copyResult, "boolean");

    console.log("  [PASS] TUI Command Modal: Verified client command generation, endpoints, and clipboard handling.");
}
