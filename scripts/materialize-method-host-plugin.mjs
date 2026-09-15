/** #922 C1: real skill trees into dist/method-host-plugin (npm pack drops symlinks). */
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function materializeMethodHostPlugin(root = defaultRoot) {
  const outDir = join(root, "dist", "method-host-plugin");
  const methodsRoot = join(root, "resources", "methods");
  const staging = `${outDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(join(staging, "skills"), { recursive: true });
    await mkdir(join(staging, ".claude-plugin"), { recursive: true });
    await cp(
      join(root, "resources/method-host-plugin/.claude-plugin/plugin.json"),
      join(staging, ".claude-plugin/plugin.json"),
    );
    for (const name of await readdir(methodsRoot)) {
      if (name.startsWith(".")) continue;
      const src = join(methodsRoot, name);
      try {
        const st = await lstat(src);
        if (!st.isDirectory() && !st.isSymbolicLink()) continue;
      } catch { continue; }
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

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await materializeMethodHostPlugin();
}
