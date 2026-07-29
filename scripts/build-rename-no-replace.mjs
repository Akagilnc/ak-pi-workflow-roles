/**
 * Compile the platform no-replace rename N-API binding into dist/recorder/.
 * Invoked from `npm run build:recorder` after tsc.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const source = join(scriptsDir, "rename_no_replace.c");
const outDir = join(packageRoot, "dist", "recorder");
const out = join(outDir, "rename_no_replace.node");

function nodeIncludeDir() {
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, "..", "include", "node"),
    join(execDir, "..", "..", "include", "node"),
    join(execDir, "include", "node"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "node_api.h"))) return dir;
  }
  throw new Error(
    "node_api.h not found relative to process.execPath; cannot build rename_no_replace.node",
  );
}

mkdirSync(outDir, { recursive: true });
const includeDir = nodeIncludeDir();
const platform = process.platform;

if (platform === "darwin") {
  execFileSync(
    "cc",
    [
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      `-I${includeDir}`,
      "-o",
      out,
      source,
    ],
    { stdio: "inherit" },
  );
} else if (platform === "linux") {
  execFileSync(
    "cc",
    [
      "-shared",
      "-fPIC",
      `-I${includeDir}`,
      "-o",
      out,
      source,
      "-D_GNU_SOURCE",
    ],
    { stdio: "inherit" },
  );
} else {
  throw new Error(
    `rename_no_replace native binding is not supported on ${platform}`,
  );
}

if (!existsSync(out)) {
  throw new Error(`native binding was not produced at ${out}`);
}
// stderr only — stdout must stay clean for `npm pack --json` via prepack.
console.error(`built ${out}`);
