/** #922: copy canonical method trees into the packaged host-plugin layout. */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function materializeMethodHostPlugin(root = defaultRoot) {
  const outDir = join(root, "dist", "method-host-plugin");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(join(root, "resources/method-host-plugin/.claude-plugin"), join(outDir, ".claude-plugin"), { recursive: true });
  await cp(join(root, "resources/methods"), join(outDir, "skills"), { recursive: true });
  return outDir;
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await materializeMethodHostPlugin();
}
