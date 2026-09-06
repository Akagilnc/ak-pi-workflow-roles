/**
 * Minimal real-entry probe: first navigator summons → same-ticket re-summons → bare resume.
 * Also one judge with nested public navigator prepares, counting model hits + run dirs.
 * Structured facts only — no prose assertions.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

// Use tsx to load TS sources
const { register } = await import("node:module");
// Instead run via npx tsx
console.log("probe should be run via tsx");
