import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import type { TunnelResult } from "./types.js";
export type { TunnelResult } from "./types.js";

export function getLocalLanIp(): string | null {
    for (const list of Object.values(os.networkInterfaces())) {
        const match = list?.find(
            (i) => !i.internal && i.family === "IPv4" && !i.address.startsWith("172.") && !i.address.startsWith("10.5.")
        );
        if (match) return match.address;
    }
    return null;
}

export function detectTailscaleIp(): string | null {
    try {
        const out = execSync("tailscale ip -4", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : null;
    } catch {
        return null;
    }
}

export function isCommandAvailable(cmd: string): boolean {
    try {
        execSync(process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

export function findCloudflaredBinary(): string | null {
    if (isCommandAvailable("cloudflared")) return "cloudflared";
    return [path.resolve(".bin/cloudflared"), path.resolve(".bin/cloudflared.exe")].find((p) => fs.existsSync(p)) ?? null;
}

export async function startCloudflareTunnel(localPort: number, binaryPath?: string): Promise<TunnelResult> {
    return new Promise((resolve, reject) => {
        const bin = binaryPath || findCloudflaredBinary() || "cloudflared";
        const proc = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
            stdio: ["ignore", "pipe", "pipe"]
        });

        let settled = false;
        const fail = (err: Error) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(err);
            }
        };

        const timeout = setTimeout(() => {
            proc.kill();
            fail(new Error("Cloudflare tunnel timed out waiting for public URL (30s)"));
        }, 30000);

        const onOutput = async (data: Buffer): Promise<void> => {
            const match = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match && !settled) {
                settled = true;
                clearTimeout(timeout);
                const publicUrl = match[0];

                // Pre-warm / wait for DNS and edge propagation (up to 15s)
                const probeStart = Date.now();
                while (Date.now() - probeStart < 15000) {
                    const probe = await fetch(`${publicUrl}/api/status`, {
                        signal: AbortSignal.timeout(2000)
                    }).catch(() => null);
                    if (probe?.status === 200) break;
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
        proc.on("error", fail);
        proc.on("exit", (code) => fail(new Error(`cloudflared exited early with code ${code}`)));
    });
}

export function getCloudflaredDownloadUrl(): string {
    const osName = process.platform === "win32" ? "windows" : process.platform;
    const archName = process.arch === "arm64" || process.arch === "arm" ? process.arch : process.arch === "ia32" ? "386" : "amd64";
    const ext = process.platform === "win32" ? ".exe" : "";
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${osName}-${archName}${ext}`;
}

export async function downloadCloudflaredBinary(): Promise<string> {
    const isWin = process.platform === "win32";
    const targetPath = path.resolve(`.bin/cloudflared${isWin ? ".exe" : ""}`);
    const tempPath = `${targetPath}.tmp`;
    const url = getCloudflaredDownloadUrl();

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
        fs.renameSync(tempPath, targetPath);
        if (!isWin) fs.chmodSync(targetPath, 0o755);
        return targetPath;
    } catch (err: unknown) {
        try { fs.unlinkSync(tempPath); } catch {}
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to download cloudflared (${msg}). Run: curl -fsSL -o ${targetPath} ${url} && chmod +x ${targetPath}`);
    }
}

export async function startAutoTunnel(localPort: number): Promise<TunnelResult> {
    const bin = findCloudflaredBinary();
    if (!bin) {
        throw new Error(
            "cloudflared binary not found. To use Cloudflare Tunnels safely, please install cloudflared via your package manager:\n" +
            "  - macOS: brew install cloudflared\n" +
            "  - Windows: winget install Cloudflare.cloudflared\n" +
            "  - Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n" +
            "Or place a verified cloudflared binary in your PATH."
        );
    }
    return startCloudflareTunnel(localPort, bin);
}
