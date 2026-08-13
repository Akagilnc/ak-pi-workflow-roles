/**
 * Standalone-invocation runtime resolution. The public CLI runs outside Pi, while
 * the @earendil-works peers are optional and host-provided (ADR: the machine's Pi
 * installation is the single runtime authority). When the local install cannot
 * resolve them, link the host Pi's own modules into this package's node_modules
 * instead of materializing a second runtime from the registry.
 *
 * Package presence is probed by directory (ancestor node_modules walk, the same
 * package lookup ESM uses) — entry-point resolution is unusable here because the
 * peers export "." with an `import` condition only, which CJS require cannot see.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const HOST_PROVIDED_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "typebox",
] as const;

type HostProvidedPackage = (typeof HOST_PROVIDED_PACKAGES)[number];

/**
 * Make the host-provided runtime packages resolvable from `packageRoot`.
 * Local resolution wins untouched; otherwise the host `pi` executable on PATH
 * anchors the lookup and the packages are symlinked into the package-own
 * node_modules (highest resolution precedence for the package and its child
 * processes). Throws when neither source can provide a package.
 */
export function ensureHostPiRuntimeResolvable(
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const missing = missingPackages(packageRoot);
  if (missing.length === 0) {
    return;
  }
  const hostCli = findHostPiCli(env);
  if (hostCli === undefined) {
    throw new Error(
      `ak-role cannot resolve ${missing.join(", ")} next to the installed package and found no host \`pi\` executable on PATH. ` +
        "Install Pi (@earendil-works/pi-coding-agent) on this machine or provide the peer packages locally.",
    );
  }
  for (const name of missing) {
    const hostDir = findPackageDirFrom(dirname(hostCli), name);
    if (hostDir === undefined) {
      throw new Error(`ak-role found the host pi at ${hostCli} but could not locate ${name} in its tree.`);
    }
    linkPackage(packageRoot, name, hostDir);
  }
  const unresolved = missingPackages(packageRoot);
  if (unresolved.length > 0) {
    throw new Error(
      `ak-role linked the host Pi runtime from ${hostCli} but ${unresolved.join(", ")} remained unresolvable.`,
    );
  }
}

function missingPackages(packageRoot: string): HostProvidedPackage[] {
  return HOST_PROVIDED_PACKAGES.filter((name) => findPackageDirFrom(packageRoot, name) === undefined);
}

/** Ancestor node_modules walk — the package-directory half of bare-specifier lookup. */
function findPackageDirFrom(startDir: string, name: string): string | undefined {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function findHostPiCli(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, "pi");
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  return undefined;
}

function linkPackage(packageRoot: string, name: HostProvidedPackage, targetDir: string): void {
  const linkPath = join(packageRoot, "node_modules", ...name.split("/"));
  mkdirSync(dirname(linkPath), { recursive: true });
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `ak-role found ${linkPath} present but unresolvable; refusing to replace a non-symlink install.`,
      );
    }
    rmSync(linkPath);
  }
  try {
    symlinkSync(targetDir, linkPath, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}
