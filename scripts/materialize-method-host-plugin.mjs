/**
 * #922 C1: copy resources/methods into dist/method-host-plugin/skills as real
 * trees. npm pack drops resource skill symlinks, which left an empty plugin.
 */
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function materializeMethodHostPlugin(root = defaultRoot) {
  const outDir = join(root, "dist", "method-host-plugin");
  const methodsRoot = join(root, "resources", "methods");
  const pluginJson = join(root, "resources", "method-host-plugin", ".claude-plugin", "plugin.json");
  const staging = `${outDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(join(staging, ".claude-plugin"), { recursive: true });
    await mkdir(join(staging, "skills"), { recursive: true });
    await cp(pluginJson, join(staging, ".claude-plugin", "plugin.json"));
    for (const name of await readdir(methodsRoot)) {
      if (name.startsWith(".")) continue;
      const src = join(methodsRoot, name);
      try {
        const st = await lstat(src);
        if (!st.isDirectory() && !st.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      await cp(src, join(staging, "skills", name), { recursive: true });
    }
    await rm(outDir, { recursive: true, force: true });
    await mkdir(dirname(outDir), { recursive: true });
    await rename(staging, outDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return outDir;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) await materializeMethodHostPlugin();
