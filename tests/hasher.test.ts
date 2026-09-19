import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeBufferHash, computeFileHash, verifyFileHash } from "../src/hasher.js";

export async function testHasher(): Promise<void> {
    console.log("  [TEST] Hasher & Checksum Verification");

    // 1. Buffer hashing
    const testBuf = Buffer.from("console.log('flipsync-test-buffer');", "utf8");
    const hash = computeBufferHash(testBuf);
    assert.equal(typeof hash, "string");
    assert.equal(hash.length, 64);

    // 2. File hashing
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipsync-test-hasher-"));
    try {
        const testFile = path.join(tempDir, "sample.txt");
        fs.writeFileSync(testFile, testBuf);

        const meta = await computeFileHash(testFile);
        assert.ok(meta);
        assert.equal(meta.sha256, hash);
        assert.equal(meta.size, testBuf.length);

        // verifyFileHash helper
        const valid = await verifyFileHash(testFile, hash);
        assert.equal(valid, true);

        const invalid = await verifyFileHash(testFile, "0000000000000000000000000000000000000000000000000000000000000000");
        assert.equal(invalid, false);

        // Non-existent file
        const missing = await computeFileHash(path.join(tempDir, "nonexistent.txt"), 2, 10);
        assert.equal(missing, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("  [PASS] Hasher: SHA-256 calculation and read resilience verified.");
}
