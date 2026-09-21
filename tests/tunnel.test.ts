import assert from "node:assert/strict";
import {
    getCloudflaredDownloadUrl,
    findCloudflaredBinary,
    isCommandAvailable,
    getLocalLanIp,
    detectTailscaleIp
} from "../src/tunnel.js";

export async function testTunnel(): Promise<void> {
    console.log("  [TEST] Tunnel & Auto-Download Helpers");

    // Test 1: Download URL formatting
    const url = getCloudflaredDownloadUrl();
    assert.match(
        url,
        /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/latest\/download\/cloudflared-/
    );
    if (process.platform === "win32") {
        assert.ok(url.endsWith(".exe"));
    }

    // Test 2: Command availability check
    assert.strictEqual(isCommandAvailable("node"), true);
    assert.strictEqual(isCommandAvailable("nonexistent-binary-for-test-xyz"), false);

    // Test 3: Binary lookup returns string or null safely
    const bin = findCloudflaredBinary();
    assert.ok(bin === null || typeof bin === "string");

    // Test 4: Local LAN IP and Tailscale detection return safely
    const lanIp = getLocalLanIp();
    assert.ok(lanIp === null || /^\d+\.\d+\.\d+\.\d+$/.test(lanIp));

    const tailscaleIp = detectTailscaleIp();
    assert.ok(tailscaleIp === null || /^\d+\.\d+\.\d+\.\d+$/.test(tailscaleIp));

    console.log("  [PASS] Tunnel: Platform URL resolution and command checks verified.");
}
