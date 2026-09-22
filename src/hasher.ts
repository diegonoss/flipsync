import fs from "node:fs";
import crypto from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { pipeline } from "node:stream/promises";

export function computeBufferHash(buffer: Buffer | Uint8Array): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function computeFileHash(
    filePath: string,
    maxRetries = 5,
    retryDelayMs = 40
): Promise<{ sha256: string; size: number; mtimeMs: number } | null> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) return null;

            // If the file is 0 bytes and was modified within the last 500ms,
            // it may be mid-truncation during a live build write. Wait once.
            if (stat.size === 0 && Date.now() - stat.mtimeMs < 500 && attempt === 0 && maxRetries > 1) {
                await setTimeout(retryDelayMs);
                continue;
            }
            const hash = crypto.createHash("sha256");
            await pipeline(fs.createReadStream(filePath, { highWaterMark: 256 * 1024 }), hash);
            return {
                sha256: hash.digest("hex"),
                size: stat.size,
                mtimeMs: stat.mtimeMs
            };
        } catch {
            if (attempt < maxRetries - 1) await setTimeout(retryDelayMs);
        }
    }
    return null;
}

export async function verifyFileHash(filePath: string, expectedHash: string): Promise<boolean> {
    return (await computeFileHash(filePath))?.sha256 === expectedHash;
}
