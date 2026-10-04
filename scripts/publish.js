#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { name, version } = pkg;

console.log(`Checking npm registry for ${name}@${version}...`);

let isPublished = false;
try {
    const stdout = execSync(`npm view ${name}@${version} version`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (stdout === version) {
        isPublished = true;
    }
} catch {
    isPublished = false;
}

if (isPublished) {
    console.log(`Version ${version} of ${name} is already published on npm. Skipping publish.`);
    process.exit(0);
}

console.log(`Publishing ${name}@${version} to npm...`);
try {
    execSync("pnpm publish --access public --no-git-checks", { stdio: "inherit" });
    console.log(`Successfully published ${name}@${version} to npm!`);
} catch (error) {
    console.error(`Failed to publish ${name}@${version}:`, error);
    process.exit(1);
}
