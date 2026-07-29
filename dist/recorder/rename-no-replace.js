/**
 * Platform kernel-atomic create-if-absent rename (directories and files).
 *
 * Ownership of the entire source tree transfers in one operation, or the call
 * fails without altering the destination name. Empty directories, files, and
 * symlinks at the destination all count as occupied.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
let cached = null;
function resolveBindingPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        // Compiled output sibling (production dist/recorder).
        join(here, "rename_no_replace.node"),
        // tsx execution from src/recorder → dist/recorder.
        join(here, "..", "..", "dist", "recorder", "rename_no_replace.node"),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    throw new Error("rename_no_replace.node binding missing; run npm run build:recorder");
}
function loadBinding() {
    if (cached)
        return cached;
    const path = resolveBindingPath();
    cached = require(path);
    return cached;
}
export function isOccupiedRenameError(error) {
    if (typeof error !== "object" || error === null)
        return false;
    const code = "code" in error && typeof error.code === "string"
        ? error.code
        : null;
    return (code === "EEXIST" ||
        code === "ENOTEMPTY" ||
        code === "EISDIR" ||
        code === "ENOTDIR");
}
/** Atomically rename `from` to `to` only if `to` does not exist. */
export function renameNoReplace(from, to) {
    loadBinding().renameNoReplace(from, to);
}
