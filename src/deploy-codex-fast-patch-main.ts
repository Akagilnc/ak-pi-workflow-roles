import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deployCodexFastPatch } from "./codex-fast-patch-deployment.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

try {
  const result = await deployCodexFastPatch({ packageRoot });
  const action =
    result.disposition === "applied" ? "applied" : "already applied";
  process.stdout.write(
    `Codex fast patch ${action} for pi-ai ${result.version} at ${result.piAiRoot}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
