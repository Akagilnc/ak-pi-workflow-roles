import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureHostPiRuntimeResolvable } from "./host-pi-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
// dist/public-cli/main.js → package root is ../..
const packageRoot = join(here, "..", "..");

// The host-provided runtime must be resolvable before the CLI module graph loads it.
ensureHostPiRuntimeResolvable(packageRoot);

const { runAkRole } = await import("./cli.ts");
const result = await runAkRole(process.argv.slice(2), { packageRoot });
process.exitCode = result.exitCode;
