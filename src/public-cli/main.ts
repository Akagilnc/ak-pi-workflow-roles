import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAkRole } from "./cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
// dist/public-cli/main.js → package root is ../..
const packageRoot = join(here, "..", "..");

const result = await runAkRole(process.argv.slice(2), { packageRoot });
process.exitCode = result.exitCode;
