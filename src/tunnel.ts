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
        const isWin = process.platform === "win32";
        const candidates = isWin
            ? [String.raw`C:\Program Files\Tailscale\tailscale.exe`, "tailscale.exe"]
            : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"];
        const tailscaleBin = candidates.find((p) => p.includes(path.sep) ? fs.existsSync(p) : false) ?? "tailscale";
        const safePath = isWin
            ? String.raw`C:\Windows\System32;C:\Program Files\Tailscale`
            : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        const out = execSync(`"${tailscaleBin}" ip -4`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, PATH: safePath }
        }).trim();
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
    const exeName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const candidates = [
        path.join(os.homedir(), ".flipsync", "bin", exeName),
        path.resolve(".bin", exeName),
        path.resolve(".bin/cloudflared"),
        path.resolve(".bin/cloudflared.exe")
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function waitForTunnelPropagation(publicUrl: string, maxDurationMs = 15000): Promise<void> {
    const probeStart = Date.now();
    const probeNext = async (): Promise<void> => {
        if (Date.now() - probeStart >= maxDurationMs) return;
        const probe = await fetch(`${publicUrl}/api/status`, {
            signal: AbortSignal.timeout(2000)
        }).catch(() => null);
        if (probe && (probe.status === 200 || probe.status === 401)) return;
        await new Promise((r) => setTimeout(r, 1000));
        return probeNext();
    };
    await probeNext();
}

export async function startCloudflareTunnel(localPort: number, binaryPath?: string): Promise<TunnelResult> {
    return new Promise((resolve, reject) => {
        const bin = binaryPath || findCloudflaredBinary() || "cloudflared";
        const proc = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
            stdio: ["ignore", "pipe", "pipe"]
        });

        const recentLogs: string[] = [];
        const captureLog = (chunk: Buffer) => {
            const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
                recentLogs.push(line);
                if (recentLogs.length > 20) recentLogs.shift();
            }
        };

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
            const details = recentLogs.length > 0 ? `\nRecent logs:\n${recentLogs.slice(-5).join("\n")}` : "";
            fail(new Error(`Cloudflare tunnel timed out waiting for public URL (30s).${details}`));
        }, 30000);

        const onOutput = async (data: Buffer): Promise<void> => {
            captureLog(data);
            const match = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/.exec(data.toString());
            if (match && !settled) {
                settled = true;
                clearTimeout(timeout);
                const publicUrl = match[0];

                await waitForTunnelPropagation(publicUrl);

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
            fail(new Error(`Failed to execute cloudflared binary '${bin}': ${err.message}`));
        });
        proc.on("exit", (code) => {
            const errorDetails = recentLogs.length > 0 ? `: ${recentLogs.slice(-3).join(" ").trim()}` : "";
            fail(new Error(`cloudflared exited early with code ${code}${errorDetails}`));
        });
    });
}

export function getCloudflaredDownloadUrl(): string {
    const osName = process.platform === "win32" ? "windows" : process.platform;
    let archName = "amd64";
    if (process.arch === "arm64" || process.arch === "arm") {
        archName = process.arch;
    } else if (process.arch === "ia32") {
        archName = "386";
    }
    const ext = process.platform === "win32" ? ".exe" : "";
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${osName}-${archName}${ext}`;
}

export async function downloadCloudflaredBinary(destinationPath?: string): Promise<string> {
    const isWin = process.platform === "win32";
    const exeName = isWin ? "cloudflared.exe" : "cloudflared";
    const targetPath = destinationPath || path.join(os.homedir(), ".flipsync", "bin", exeName);
    const tempPath = `${targetPath}.tmp.${Date.now()}`;
    const url = getCloudflaredDownloadUrl();

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()), { mode: 0o700 });
        fs.renameSync(tempPath, targetPath);
        if (!isWin) fs.chmodSync(targetPath, 0o700);
        return targetPath;
    } catch (err: unknown) {
        try { fs.unlinkSync(tempPath); } catch {}
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to download cloudflared (${msg}). Run: curl -fsSL -o ${targetPath} ${url} && chmod +x ${targetPath}`);
    }
}

export async function startAutoTunnel(localPort: number): Promise<TunnelResult> {
    let bin = findCloudflaredBinary();
    if (!bin) {
        try {
            bin = await downloadCloudflaredBinary();
        } catch (downloadErr: unknown) {
            const downloadMsg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
            throw new Error(
                `cloudflared binary not found and auto-download failed (${downloadMsg}).\n` +
                "Please install cloudflared manually:\n" +
                "  - macOS: brew install cloudflared\n" +
                "  - Windows: winget install Cloudflare.cloudflared\n" +
                "  - Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n" +
                "Or place a verified cloudflared binary in ~/.flipsync/bin/ or in your PATH."
            );
        }
    }
    return startCloudflareTunnel(localPort, bin);
}
