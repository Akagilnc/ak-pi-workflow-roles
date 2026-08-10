import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CODEX_FAST_PATCH_PI_VERSION = "0.84.1" as const;
export const CODEX_FAST_PATCH_RELATIVE =
  "patches/@earendil-works__pi-ai@0.84.1.patch" as const;

export type CodexFastPatchDeployment = {
  disposition: "applied" | "already-applied";
  piAiRoot: string;
  version: typeof CODEX_FAST_PATCH_PI_VERSION;
};

async function findPiExecutable(pathValue: string): Promise<string> {
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") continue;
    const candidate = resolve(entry, "pi");
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("cannot deploy Codex fast patch: pi executable is not on PATH");
}

async function resolveGlobalPiAiRoot(piExecutable: string): Promise<string> {
  const piCli = await realpath(piExecutable);
  const codingAgentRoot = dirname(dirname(piCli));
  const codingManifest = JSON.parse(
    await readFile(join(codingAgentRoot, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    codingManifest.name !== "@earendil-works/pi-coding-agent" ||
    codingManifest.version !== CODEX_FAST_PATCH_PI_VERSION
  ) {
    throw new Error(
      `cannot deploy Codex fast patch: expected global @earendil-works/pi-coding-agent@${CODEX_FAST_PATCH_PI_VERSION}, found ${String(codingManifest.name)}@${String(codingManifest.version)}`,
    );
  }
  return await realpath(
    join(
      codingAgentRoot,
      "node_modules",
      "@earendil-works",
      "pi-ai",
    ),
  );
}

async function patchCheck(
  piAiRoot: string,
  patchPath: string,
  reverse: boolean,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["apply", ...(reverse ? ["--reverse"] : []), "--check", patchPath],
      { cwd: piAiRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    return true;
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") return false;
    throw error;
  }
}

export async function deployCodexFastPatch(options: {
  packageRoot: string;
  path?: string;
  piExecutable?: string;
}): Promise<CodexFastPatchDeployment> {
  const patchPath = resolve(options.packageRoot, CODEX_FAST_PATCH_RELATIVE);
  await access(patchPath);
  const piExecutable =
    options.piExecutable ??
    (await findPiExecutable(options.path ?? process.env.PATH ?? ""));
  const piAiRoot = await resolveGlobalPiAiRoot(piExecutable);
  const piAiManifest = JSON.parse(
    await readFile(join(piAiRoot, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    piAiManifest.name !== "@earendil-works/pi-ai" ||
    piAiManifest.version !== CODEX_FAST_PATCH_PI_VERSION
  ) {
    throw new Error(
      `cannot deploy Codex fast patch: expected @earendil-works/pi-ai@${CODEX_FAST_PATCH_PI_VERSION}, found ${String(piAiManifest.name)}@${String(piAiManifest.version)}`,
    );
  }

  if (await patchCheck(piAiRoot, patchPath, false)) {
    await execFileAsync("git", ["apply", patchPath], {
      cwd: piAiRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      disposition: "applied",
      piAiRoot,
      version: CODEX_FAST_PATCH_PI_VERSION,
    };
  }
  if (await patchCheck(piAiRoot, patchPath, true)) {
    return {
      disposition: "already-applied",
      piAiRoot,
      version: CODEX_FAST_PATCH_PI_VERSION,
    };
  }
  throw new Error(
    `cannot deploy Codex fast patch: ${piAiRoot} has unknown bytes (neither pristine ${CODEX_FAST_PATCH_PI_VERSION} nor already applied)`,
  );
}
