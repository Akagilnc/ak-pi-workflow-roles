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

async function resolvePiCliPath(piExecutable: string): Promise<string> {
  const marker = "AK_PI_CLI_ENTRY=";
  const probeSource = `process.stdout.write(${JSON.stringify(marker)} + encodeURIComponent(process.argv[1] ?? "") + "\\n")`;
  const probeUrl = `data:text/javascript,${encodeURIComponent(probeSource)}`;
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--import=${probeUrl}`,
  ].filter(Boolean).join(" ");
  const { stdout } = await execFileAsync(piExecutable, ["--version"], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    maxBuffer: 10 * 1024 * 1024,
  });
  const entry = stdout
    .split("\n")
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length);
  if (entry === undefined || entry === "") {
    throw new Error("cannot deploy Codex fast patch: pi did not expose its Node CLI entrypoint");
  }
  return await realpath(decodeURIComponent(entry));
}

async function resolveGlobalPiAiRoot(piExecutable: string): Promise<string> {
  const piCli = await resolvePiCliPath(piExecutable);
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

type PatchIdentity = {
  relativePath: string;
  pristineBlob: string;
  patchedBlob: string;
};

function readPatchIdentity(patchBytes: string): PatchIdentity {
  const indexes = [...patchBytes.matchAll(/^index ([0-9a-f]{40})\.\.([0-9a-f]{40}) 100644$/gm)];
  const oldPaths = [...patchBytes.matchAll(/^--- a\/(.+)$/gm)];
  const newPaths = [...patchBytes.matchAll(/^\+\+\+ b\/(.+)$/gm)];
  if (indexes.length !== 1 || oldPaths.length !== 1 || newPaths.length !== 1) {
    throw new Error("cannot deploy Codex fast patch: patch must change exactly one regular file");
  }
  const relativePath = oldPaths[0]![1]!;
  if (
    newPaths[0]![1] !== relativePath ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error("cannot deploy Codex fast patch: patch target path is invalid");
  }
  return {
    relativePath,
    pristineBlob: indexes[0]![1]!,
    patchedBlob: indexes[0]![2]!,
  };
}

async function gitBlobIdentity(root: string, relativePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["hash-object", relativePath], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function deployCodexFastPatch(options: {
  packageRoot: string;
}): Promise<CodexFastPatchDeployment> {
  const patchPath = resolve(options.packageRoot, CODEX_FAST_PATCH_RELATIVE);
  await access(patchPath);
  const patchIdentity = readPatchIdentity(await readFile(patchPath, "utf8"));
  const piExecutable = await findPiExecutable(process.env.PATH ?? "");
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

  const observedBlob = await gitBlobIdentity(
    piAiRoot,
    patchIdentity.relativePath,
  );
  if (observedBlob === patchIdentity.patchedBlob) {
    return {
      disposition: "already-applied",
      piAiRoot,
      version: CODEX_FAST_PATCH_PI_VERSION,
    };
  }
  if (observedBlob !== patchIdentity.pristineBlob) {
    throw new Error(
      `cannot deploy Codex fast patch: ${piAiRoot} has unknown bytes (neither pristine ${CODEX_FAST_PATCH_PI_VERSION} nor already applied)`,
    );
  }
  await execFileAsync("patch", ["-p1", "-i", patchPath], {
    cwd: piAiRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  const deployedBlob = await gitBlobIdentity(
    piAiRoot,
    patchIdentity.relativePath,
  );
  if (deployedBlob !== patchIdentity.patchedBlob) {
    throw new Error("cannot deploy Codex fast patch: applied bytes do not match the repo patch identity");
  }
  return {
    disposition: "applied",
    piAiRoot,
    version: CODEX_FAST_PATCH_PI_VERSION,
  };
}
