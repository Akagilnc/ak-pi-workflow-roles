/**
 * Pi adapter for the host-neutral main-session execution seam (#526 / S1b-2).
 * Owns argv construction, spawn/SIGTERM/close, and session codec helpers.
 * public-cli runners project RoleTurnRequest; this module is the sole argv owner.
 */
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnActivation,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnModelConfig,
  RoleTurnRequest,
  RoleTurnResult,
} from "../host-contracts.ts";
import { ExplicitInternalActivationError } from "../host-contracts.ts";
import { applyEngineChildEnv } from "../engine-detour.ts";


/** Package-relative Internal role entrypoint (ADR 0052; same path as public-cli registry). */
const INTERNAL_ROLE_ENTRYPOINT_RELATIVE = "extensions/role-runtime.ts";

export function resolveInternalRoleEntrypoint(packageRoot: string): string {
  return join(packageRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
}

/** Non-dispatch args: load Internal once and exit via Pi help (no model turn). */
export const EXPLICIT_INTERNAL_LOAD_PROBE_ARGS = [
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-session",
  "--help",
] as const;

export function buildExplicitInternalActivationArgs(
  selectedRoleEntry: string,
  extraArgs: readonly string[] = [],
): string[] {
  return ["--no-extensions", "-e", selectedRoleEntry, ...extraArgs];
}

function buildSeatModelCliArgs(model: RoleTurnModelConfig | undefined): string[] {
  if (model === undefined) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    ...(model.thinking === undefined ? [] : ["--thinking", model.thinking]),
  ];
}

function buildActivationFlagArgs(activation: RoleTurnActivation): string[] {
  switch (activation.role) {
    case "judge":
      return ["--ak-role", "judge"];
    case "coder":
      return [
        "--ak-role",
        "coder",
        "--ak-coder-phase",
        activation.phase,
        "--ak-coder-task",
        activation.taskPath,
      ];
    case "fixer":
      return [
        "--ak-role",
        "fixer",
        "--ak-fixer-phase",
        activation.phase,
        "--ak-fix-packet",
        activation.packetPath,
        ...(activation.prerequisitesPath === undefined
          ? []
          : ["--ak-fixer-prerequisites", activation.prerequisitesPath]),
      ];
    case "reviewer":
      return [
        "--ak-role",
        "reviewer",
        "--ak-review-base",
        activation.baseRevision,
        ...(activation.authorityRefs.length === 0
          ? []
          : ["--ak-review-authority-refs", JSON.stringify([...activation.authorityRefs])]),
        ...(activation.ticketNumber === undefined
          ? []
          : ["--ak-review-ticket-number", String(activation.ticketNumber)]),
      ];
    case "merger":
      return ["--ak-role", "merger", "--ak-merger-input", activation.inputPath];
    case "collector":
      return [
        "--ak-role",
        "collector",
        "--ak-collector-repo",
        activation.repo,
        "--ak-collector-pr",
        activation.pr,
        ...(activation.requestManifestPath === undefined
          ? []
          : ["--ak-collector-request-manifest", activation.requestManifestPath]),
      ];
    case "doctor":
      return ["--ak-role", "doctor", "--ak-doctor-case", activation.casePath];
    case "notary":
      return [
        "--ak-role",
        "notary",
        "--ak-notary-source-run",
        activation.sourceRun,
        ...(activation.ticketNumber === undefined
          ? []
          : ["--ak-notary-ticket-number", String(activation.ticketNumber)]),
      ];
    case "countersign":
      return [
        "--ak-role",
        "countersign",
        ...(activation.ticketNumber === undefined
          ? []
          : ["--ak-countersign-ticket-number", String(activation.ticketNumber)]),
      ];
    case "gleaner-left":
      return [
        "--ak-role",
        "gleaner-left",
        "--ak-gleaner-left-base",
        activation.baseRevision,
      ];
    case "inspector":
      return ["--ak-role", "inspector"];
    default: {
      const _exhaustive: never = activation;
      return _exhaustive;
    }
  }
}

function buildMethodArgs(methods: readonly MethodBinding[]): string[] {
  const skillArgs: string[] = [];
  for (const method of methods) {
    if (method.kind === "skill") {
      skillArgs.push("--skill", method.path);
    }
  }
  return skillArgs;
}

/**
 * Translate a closed RoleTurnRequest into Pi argv after `--no-extensions -e entry`.
 * Controlled session constants and session coordinates are adapter-internal.
 */
export function buildPiTurnExtraArgs(
  request: RoleTurnRequest,
  authority: DurablePrincipalAuthority,
  extraPiArgs: readonly string[] = [],
): string[] {
  const { sessionFile, sessionDirectory } = authority.decode(request.principal);
  const prompt =
    request.continuation.kind === "initial" || request.continuation.kind === "resume"
      ? request.continuation.prompt
      : (() => {
          const _exhaustive: never = request.continuation;
          return _exhaustive;
        })();
  return [
    "--no-skills",
    ...buildMethodArgs(request.methods),
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    sessionFile,
    "--session-dir",
    sessionDirectory,
    ...extraPiArgs,
    ...buildActivationFlagArgs(request.activation),
    "--mode",
    "json",
    ...buildSeatModelCliArgs(request.model),
    prompt,
  ];
}

export type PiSpawnRunner = (
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
) => Promise<{
  code: number | null;
  stderr: string;
  timedOut: boolean;
  knownFailure?: RoleTurnKnownFailure;
}>;

export type LaunchedPiIdentity = {
  readonly executable: string;
  readonly version: string;
};

export type LaunchedRolePackageIdentity = {
  readonly roleEntry: string;
  readonly rolePackageRoot: string;
  readonly rolePackageVersion: string;
  readonly entryMode: "public-cli";
};

export type PiRoleTurnHostConfig = {
  readonly packageRoot: string;
  readonly principalAuthority: DurablePrincipalAuthority;
  /** Test / seat-specific extra Pi args (faux provider etc.). */
  readonly extraPiArgs?: readonly string[];
  readonly timeoutMs?: number;
  /** Low-level spawn seam (tests inject faux children). */
  readonly spawnRunner?: PiSpawnRunner;
  readonly recordLaunchedPiIdentity?: (
    runDirectory: string,
    identity: LaunchedPiIdentity,
  ) => Promise<void>;
  readonly recordLaunchedRolePackageIdentity?: (
    runDirectory: string,
    identity: LaunchedRolePackageIdentity,
  ) => Promise<void>;
  readonly observeLaunchedRolePackageIdentity?: (
    packageRoot: string,
    roleEntrypoint: string,
  ) => Promise<LaunchedRolePackageIdentity>;
};

const execFileAsync = promisify(execFile);

async function resolveSelectedPi(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const searchPath =
    env.PATH ?? (platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin");
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [resolve(cwd, command)]
      : searchPath.split(delimiter).map((dir) => resolve(cwd, dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") continue;
      throw new ExplicitInternalActivationError(
        `Pi executable resolution failed: ${String((error as Error).message)}`,
        { knownCause: "activation", cause: error },
      );
    }
    return await realpath(candidate);
  }
  throw new ExplicitInternalActivationError(`Pi executable not found: ${command}`, {
    knownCause: "activation",
  });
}

async function selectedPiIdentity(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<LaunchedPiIdentity> {
  const executable = await resolveSelectedPi(command, cwd, env);
  const { stdout } = await execFileAsync(executable, ["--version"], {
    cwd,
    env,
    encoding: "utf8",
  });
  const version = stdout.trim();
  if (version === "") throw new Error(`Pi executable returned an empty version: ${executable}`);
  return { executable, version };
}

/**
 * Default child runner: canonically select `pi` on PATH (or PI_BINARY) and launch
 * that exact file. Close settles exactly once for natural return / error / SIGTERM.
 */
export function createDefaultPiSpawnRunner(options: {
  recordLaunchedPiIdentity?: (
    runDirectory: string,
    identity: LaunchedPiIdentity,
  ) => Promise<void>;
}): PiSpawnRunner {
  return async (args, spawnOptions) => {
    const command = spawnOptions.env.PI_BINARY ?? "pi";
    const piIdentity = await selectedPiIdentity(command, spawnOptions.cwd, spawnOptions.env);
    return await new Promise((resolveResult, reject) => {
      // Child stdout is discarded at the stdio seam (CLAUDE.md Role invocation
      // evidence). Do not pipe or accumulate it. stderr stays piped for diagnostics.
      const child = spawn(piIdentity.executable, [...args], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      if (child.stderr === null) {
        throw new Error("Pi child stderr pipe was not created");
      }
      let stderr = "";
      let timedOut = false;
      // No default wall clock. Only an explicit caller budget arms a timer (ADR 0010).
      // SIGKILL is unconditionally forbidden — graceful SIGTERM only.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      // `error` fires for pre-spawn failures (ENOENT after identity check is a
      // true activation failure) or kill/dispatch errors. Retain it so `close`
      // remains the SOLE settlement point (spec-B: child close once). Only
      // fall back to rejecting on `error` if `close` never fires (e.g. spawn
      // never succeeded so no `close` event will arrive).
      let hasSpawned = false;
      let executionError: Error | undefined;
      const armTimeoutAfterChildReady = (): void => {
        if (spawnOptions.timeoutMs === undefined) return;
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, spawnOptions.timeoutMs);
      };
      let identityRecorded: Promise<void> = Promise.resolve();
      child.once("spawn", () => {
        hasSpawned = true;
        armTimeoutAfterChildReady();
        const runDirectory = spawnOptions.env.AK_ROLE_RUN_DIR;
        if (
          typeof runDirectory === "string" &&
          runDirectory !== "" &&
          options.recordLaunchedPiIdentity !== undefined
        ) {
          identityRecorded = options.recordLaunchedPiIdentity(runDirectory, piIdentity);
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        // A pre-spawn error has no child lifecycle to close. After spawn,
        // retain the execution error and let the mandatory close event own
        // cleanup and the single settlement.
        if (settled || hasSpawned) {
          executionError = error;
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        settled = true;
        reject(error);
      });
      child.on("close", (code) => {
        if (timer !== undefined) clearTimeout(timer);
        void identityRecorded.then(
          () => {
            if (settled) return;
            settled = true;
            if (executionError !== undefined) {
              reject(executionError);
              return;
            }
            resolveResult({
              code,
              stderr,
              timedOut,
            });
          },
          (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      });
    });
  };
}

/** Create the production Pi RoleTurnHost (composition-root assembly). */
export function createPiRoleTurnHost(config: PiRoleTurnHostConfig): RoleTurnHost {
  const spawnRunner =
    config.spawnRunner ??
    createDefaultPiSpawnRunner({
      ...(config.recordLaunchedPiIdentity === undefined
        ? {}
        : { recordLaunchedPiIdentity: config.recordLaunchedPiIdentity }),
    });

  return {
    async executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult> {
      // #617 DK-7: Pi argv gets projected native paths once; never record bytes.
      let turnRequest = request;
      const paths = request.hostTransition?.priorNativePaths;
      if (
        request.continuation.kind === "resume"
        && paths !== undefined
        && paths.length > 0
      ) {
        turnRequest = {
          ...request,
          continuation: {
            ...request.continuation,
            prompt: `${request.continuation.prompt}\n${paths.join("\n")}`,
          },
        };
      }
      const roleEntry = await realpath(resolveInternalRoleEntrypoint(config.packageRoot));
      const extraArgs = buildPiTurnExtraArgs(
        turnRequest,
        config.principalAuthority,
        config.extraPiArgs ?? [],
      );
      const args = buildExplicitInternalActivationArgs(roleEntry, extraArgs);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: request.home,
        PI_CODING_AGENT_DIR: request.agentDir,
        AK_ROLE_RUN_DIR: request.runDirectory,
      };
      applyEngineChildEnv(env, request.engine);
      if (request.correlationId !== undefined && request.correlationId.trim() !== "") {
        env.AK_CORRELATION_ID = request.correlationId;
      }
      if (
        config.recordLaunchedRolePackageIdentity !== undefined &&
        config.observeLaunchedRolePackageIdentity !== undefined
      ) {
        await config.recordLaunchedRolePackageIdentity(
          request.runDirectory,
          await config.observeLaunchedRolePackageIdentity(config.packageRoot, roleEntry),
        );
      }
      const timeoutMs = request.timeoutMs ?? config.timeoutMs;
      return await spawnRunner(args, {
        cwd: request.cwd,
        env,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
  };
}

import { sitianReport } from "../sitian-facade.ts";

/**
 * Append one custom JSONL entry to the durable principal's session file.
 * Pi session codec only — AK artifact O_EXCL retention stays in public-cli.
 */
export async function appendPiSessionCustomEntry(
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
  customType: string,
  data: unknown,
): Promise<void> {
  const { sessionFile } = authority.decode(principal);
  const text = await readFile(sessionFile, "utf8");
  let parentId: string | null = null;
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as { id?: unknown; type?: unknown };
    if (typeof entry.id === "string" && entry.type !== "session") parentId = entry.id;
  }
  const timestamp = new Date().toISOString();
  const pointerLine = `${JSON.stringify({
    type: "custom",
    customType,
    data,
    id: randomUUID(),
    parentId,
    timestamp,
  })}\n`;
  await appendFile(sessionFile, pointerLine, "utf8");
  try {
    sitianReport({
      level: "event",
      kind: "dispatch-error",
      sessionParent: sessionFile,
      payload: { customType, data },
      source: "pi-role-turn-host",
    });
  } catch {}
}
