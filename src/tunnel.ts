import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import type { TunnelResult } from "./types.js";
export type { TunnelResult } from "./types.js";

export function getLocalLanIp(): string | null {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (
                !iface.internal &&
                iface.family === "IPv4" &&
                !iface.address.startsWith("172.") &&
                !iface.address.startsWith("10.5.")
            ) {
                return iface.address;
            }
        }
    }
    return null;
}

export function detectTailscaleIp(): string | null {
    try {
        const out = execSync("tailscale ip -4", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) {
            return out;
        }
    } catch {
        // Tailscale not installed or not running
    }
    return null;
}

export function isCommandAvailable(cmd: string): boolean {
    try {
        const checkCmd = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
        execSync(checkCmd, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

export function findCloudflaredBinary(): string | null {
    if (isCommandAvailable("cloudflared")) return "cloudflared";
    const localBin = path.resolve(".bin/cloudflared");
    if (fs.existsSync(localBin)) return localBin;
    const localBinWin = path.resolve(".bin/cloudflared.exe");
    if (fs.existsSync(localBinWin)) return localBinWin;
    return null;
}

export async function startCloudflareTunnel(localPort: number): Promise<TunnelResult> {
    return new Promise((resolve, reject) => {
        const bin = findCloudflaredBinary() || "cloudflared";
        const proc = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
            stdio: ["ignore", "pipe", "pipe"]
        });

        let resolved = false;
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                proc.kill();
                reject(new Error("Cloudflare tunnel timed out waiting for public URL (30s)"));
            }
        }, 30000);

        const onOutput = async (data: Buffer): Promise<void> => {
            const text = data.toString();
            // Look for URL pattern: https://<subdomain>.trycloudflare.com
            const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match && !resolved) {
                resolved = true;
                clearTimeout(timeout);
                const publicUrl = match[0];

                // Pre-warm / wait for DNS and edge propagation (up to 15s)
                const probeStart = Date.now();
                while (Date.now() - probeStart < 15000) {
                    try {
                        const probe = await fetch(`${publicUrl}/api/status`, {
                            signal: AbortSignal.timeout(2000)
                        });
                        if (probe.status === 200) {
                            break;
                        }
                    } catch {
                        // Edge DNS still propagating, wait briefly
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                }

                resolve({
                    url: publicUrl,
                    type: "cloudflare",
                    process: proc,
                    stop: () => {
                        try {
                            proc.kill("SIGINT");
                        } catch {
                            // Process already dead
                        }
                    }
                });
            }
        };

        proc.stdout.on("data", onOutput);
        proc.stderr.on("data", onOutput);

        proc.on("error", (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(err);
            }
        });

        proc.on("exit", (code) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(new Error(`cloudflared exited early with code ${code}`));
            }
        });
    });
}

export async function startAutoTunnel(localPort: number): Promise<TunnelResult> {
    const bin = findCloudflaredBinary();
    if (!bin) {
        throw new Error(
            "cloudflared binary not found in PATH or .bin/cloudflared. " +
            "Install cloudflared or run: curl -fsSL -o .bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x .bin/cloudflared"
        );
    }
    return await startCloudflareTunnel(localPort);
}
