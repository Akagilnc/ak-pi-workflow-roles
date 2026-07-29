/**
 * Compile the platform no-replace rename N-API binding into dist/recorder/.
 *
 * Single publisher for every build/install caller: compile to a unique temporary
 * file on the same filesystem as the destination, validate the completed
 * artifact, then atomically rename it over the published binding. Temporary
 * output lives outside package `dist/` so concurrent pack never ships scratch,
 * and is removed on failure so readers never observe a truncated published path.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const source = join(scriptsDir, "rename_no_replace.c");
const outDir = join(packageRoot, "dist", "recorder");
const out = join(outDir, "rename_no_replace.node");
// Same filesystem as `out` (package root), but outside the packed `dist/` tree.
const stagingDir = join(packageRoot, ".native-build-staging");
const require = createRequire(import.meta.url);

const SUPPORTED_OS = new Set(["darwin", "linux"]);
const SUPPORTED_CPU = new Set(["x64", "arm64"]);

function toolchainHint() {
  return (
    "Requires a working C compiler (`cc` on PATH) and Node.js N-API headers " +
    "(node_api.h, usually shipped next to the Node install under include/node)."
  );
}

function assertSupportedPlatform() {
  if (
    !SUPPORTED_OS.has(process.platform) ||
    !SUPPORTED_CPU.has(process.arch)
  ) {
    throw new Error(
      `rename_no_replace native binding supports only darwin/linux on x64/arm64; ` +
        `refusing ${process.platform}/${process.arch}. ${toolchainHint()}`,
    );
  }
}

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
    `node_api.h not found relative to process.execPath (${process.execPath}). ` +
      `${toolchainHint()}`,
  );
}

function compileTo(target) {
  const includeDir = nodeIncludeDir();
  if (process.platform === "darwin") {
    execFileSync(
      "cc",
      [
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        `-I${includeDir}`,
        "-o",
        target,
        source,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  if (process.platform === "linux") {
    execFileSync(
      "cc",
      [
        "-shared",
        "-fPIC",
        `-I${includeDir}`,
        "-o",
        target,
        source,
        "-D_GNU_SOURCE",
      ],
      { stdio: "inherit" },
    );
    return;
  }
  throw new Error(
    `rename_no_replace native binding is not supported on ${process.platform}`,
  );
}

function assertCompleteArtifact(path) {
  if (!existsSync(path)) {
    throw new Error(`native binding was not produced at ${path}`);
  }
  const st = statSync(path);
  if (!st.isFile() || st.size <= 0) {
    throw new Error(`native binding artifact is empty or not a file: ${path}`);
  }
  const fd = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    const n = readSync(fd, magic, 0, 4, 0);
    if (n !== 4) {
      throw new Error(`native binding artifact is truncated: ${path}`);
    }
    const darwin =
      magic.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) ||
      magic.equals(Buffer.from([0xce, 0xfa, 0xed, 0xfe])) ||
      magic.equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    const linux = magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (process.platform === "darwin" && !darwin) {
      throw new Error(
        `native binding magic is not Mach-O (${magic.toString("hex")})`,
      );
    }
    if (process.platform === "linux" && !linux) {
      throw new Error(
        `native binding magic is not ELF (${magic.toString("hex")})`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

function assertLoadablePublished(path) {
  let binding;
  try {
    // Bust prior cache for this exact path so rebuilds are observed in-process.
    try {
      delete require.cache[path];
    } catch {
      // ignore
    }
    binding = require(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`native binding failed to load after publish: ${message}`);
  }
  if (typeof binding?.renameNoReplace !== "function") {
    throw new Error(
      "native binding loaded but renameNoReplace export is missing",
    );
  }
}

function tempArtifactPath() {
  const token = randomBytes(8).toString("hex");
  // Must end in `.node` so tools/file(1) treat it as a native artifact.
  return join(
    stagingDir,
    `rename_no_replace.${process.pid}.${token}.tmp.node`,
  );
}

function rmQuiet(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup only
  }
}

assertSupportedPlatform();
if (!existsSync(source)) {
  throw new Error(`native source missing at ${source}`);
}
mkdirSync(outDir, { recursive: true });
mkdirSync(stagingDir, { recursive: true });

const tmpOut = tempArtifactPath();
try {
  compileTo(tmpOut);
  assertCompleteArtifact(tmpOut);
  // Same-filesystem rename is atomic on Linux/Darwin: readers either keep the
  // previous complete inode or open the new complete artifact — never a
  // compiler-truncated published path.
  renameSync(tmpOut, out);
} catch (error) {
  rmQuiet(tmpOut);
  throw error;
}

assertCompleteArtifact(out);
assertLoadablePublished(out);

// stderr only — stdout must stay clean for `npm pack --json` via prepack.
console.error(`built ${out}`);
