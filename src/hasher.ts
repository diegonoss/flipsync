import fs from "node:fs";
import crypto from "node:crypto";
import { setTimeout } from "node:timers/promises";

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
            const stat = fs.statSync(filePath, { throwIfNoEntry: false });
            if (!stat?.isFile()) {
                return null;
            }
            // If the file is 0 bytes, it might be mid-truncation during a build write.
            // Wait briefly unless it remains 0 on the final attempt.
            if (stat.size === 0 && attempt < maxRetries - 1) {
                await setTimeout(retryDelayMs);
                continue;
            }
            return {
                sha256: computeBufferHash(fs.readFileSync(filePath)),
                size: stat.size,
                mtimeMs: stat.mtimeMs
            };
        } catch {
            if (attempt < maxRetries - 1) {
                await setTimeout(retryDelayMs);
            }
        }
    }
    return null;
}

export async function verifyFileHash(filePath: string, expectedHash: string): Promise<boolean> {
    return (await computeFileHash(filePath))?.sha256 === expectedHash;
}
