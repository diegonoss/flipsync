import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import * as esbuild from "esbuild";

async function build() {
    console.log("[BUILD] Compiling FlipSync...");

    // Ensure output directories exist
    fs.mkdirSync("dist/bin", { recursive: true });
    fs.mkdirSync("dist/core", { recursive: true });
    fs.mkdirSync("dist/cli", { recursive: true });
    fs.mkdirSync("dist/tui", { recursive: true });

    // 1. Build library and CLI with esbuild
    await esbuild.build({
        entryPoints: {
            "index": "src/index.ts",
            "core/SyncEngine": "src/core/SyncEngine.ts",
            "core/index": "src/core/index.ts",
            "cli/index": "src/cli/index.ts",
            "tui/index": "src/tui/index.ts",
            "bin/flipsync": "bin/flipsync.ts",
            "bin/flipsync-host": "bin/flipsync-host.ts",
            "bin/flipsync-client": "bin/flipsync-client.ts"
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node18",
        outdir: "dist",
        packages: "external",
        sourcemap: true,
        banner: {
            js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
        }
    });

    console.log("[BUILD] Emitting TypeScript type definitions...");
    try {
        execSync("npx tsc --emitDeclarationOnly --outDir dist", { stdio: "inherit" });
    } catch {
        console.warn("[BUILD] [WARN] Declaration emit encountered warnings, continuing...");
    }

    // 2. Copy client scripts to dist/scripts
    fs.mkdirSync("dist/scripts", { recursive: true });
    for (const script of ["sync-client.js", "sync-client.sh", "sync-client.ps1"]) {
        const srcPath = path.join("scripts", script);
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join("dist/scripts", script));
        }
    }

    // 3. Ensure executable permissions
    const binaries = [
        "dist/bin/flipsync.js",
        "dist/bin/flipsync-host.js",
        "dist/bin/flipsync-client.js",
        "dist/scripts/sync-client.sh",
        "dist/scripts/sync-client.js",
        "scripts/sync-client.sh",
        "scripts/sync-client.js"
    ];

    for (const bin of binaries) {
        if (fs.existsSync(bin)) {
            try {
                fs.chmodSync(bin, 0o755);
            } catch {
                // Ignore on non-posix systems
            }
        }
    }

    console.log("[BUILD] Build complete successfully.");
}

build().catch((err) => {
    console.error("[BUILD] [ERROR] Build failed:", err);
    process.exit(1);
});
