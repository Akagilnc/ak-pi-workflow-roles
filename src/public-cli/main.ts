import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureHostPiRuntimeResolvable } from "./host-pi-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve install package root from the public bin location.
 *
 * Shipped layout is `<packageRoot>/dist/public-cli/main.js` → two levels up when
 * that ancestor owns package.json. A relocated single-file bundle (no package
 * tree beside the bin) must NOT keep climbing: `join("/tmp/<bin>","..","..")`
 * is `"/"` on Linux CI, and host-pi linking then does
 * `mkdir('/node_modules/@earendil-works')` → EACCES. Fall back to the bin
 * directory so links stay on the ESM ancestor walk and remain writable.
 */
function resolvePackageRoot(binDir: string): string {
  const canonical = join(binDir, "..", "..");
  if (existsSync(join(canonical, "package.json"))) {
    return canonical;
  }
  return binDir;
}

const packageRoot = resolvePackageRoot(here);

// Nested institutional summons resolve package root from this env (#675 / #645).
// Pin to the running bin's package so a stale outer install pin cannot load a
// host family this tree owns but the older install lacks.
process.env.AK_ROLE_PACKAGE_ROOT = packageRoot;

// The host-provided runtime must be resolvable before the CLI module graph loads it.
ensureHostPiRuntimeResolvable(packageRoot);

const { runAkRole, commandNeedsProcessCancel } = await import("./cli.ts");
const { installProcessCancelHandlers } = await import("./process-cancel.ts");

// #855: catchable signals only for role-turn commands. analyst/roles/config/help
// keep Node default termination — global handlers would swallow Ctrl+C.
const argv = process.argv.slice(2);
const processCancel = commandNeedsProcessCancel(argv)
  ? installProcessCancelHandlers()
  : undefined;
try {
  const result = await runAkRole(argv, {
    packageRoot,
    ...(processCancel === undefined ? {} : { signal: processCancel.signal }),
  });
  // Signal termination is never a successful public exit, even if a seat
  // somehow returned zero before settlement folded the abort.
  process.exitCode =
    processCancel !== undefined &&
    processCancel.receivedSignal() !== undefined &&
    result.exitCode === 0
      ? 1
      : result.exitCode;
} finally {
  processCancel?.dispose();
}
