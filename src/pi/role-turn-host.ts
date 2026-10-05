/**
 * Pi adapter for the host-neutral main-session execution seam (#526 / S1b-2).
 * Owns argv construction, spawn/SIGTERM/close, and session codec helpers.
 * public-cli runners project RoleTurnRequest; this module is the sole argv owner.
 */
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnModelConfig,
  RoleTurnRequest,
  RoleTurnResult,
} from "../host-contracts.ts";
import { ExplicitInternalActivationError } from "../host-contracts.ts";
import { applyEngineChildEnv, ENGINE_MODEL_FLAG_NAME, normalizeEngineName } from "../engine-detour.ts";
import { projectActivationFlags } from "../role-activation-flags.ts";
import { encodeUserDialogueStdin } from "../user-dialogue-stdin.ts";
import { readLedgerSessionJsonlLines, readStrictPiSessionJsonl } from "../ledger-session-read.ts";
import { copyAndRecordHostDossier } from "../host-session-record.ts";
import { syncTurnRequestLivePlacement } from "../external-host-turn-loop.ts";
import { projectThrownFailureLeaf, retainPackageFault } from "../public-cli/settlement.ts";
import { describeErrorIdentity } from "../public-cli/run-lifecycle.ts";
import { RECEIPT_DELIVERY_LIMIT_ENV } from "../receipt-delivery-policy.ts";
import { createSessionIdentityAuthority } from "../session-identity.ts";
import { sitianReport } from "../sitian-facade.ts";

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

/**
 * Pi argv for seat model. Host only passes through resolved values — no local
 * thinking whitelist and no package default fill. Bare provider/model omits
 * --thinking so Pi owns its own default (#346/#384). Explicit thinking only.
 */
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

/**
 * Pi last hop only: shared envelope flags → controlled-session argv pairs (#819).
 * Flag membership/values stay in projectActivationFlags (middle layer).
 */
function activationFlagsToPiArgv(flags: ReadonlyMap<string, boolean | string>): string[] {
  const args: string[] = [];
  for (const [name, value] of flags) {
    if (value === false) continue;
    args.push(`--${name}`);
    if (value !== true) args.push(String(value));
  }
  return args;
}

function buildMethodArgs(methods: readonly MethodBinding[]): string[] {
  const skillArgs: string[] = [];
  for (const method of methods) {
    if (method.kind === "skill") {
      skillArgs.push("--skill", dirname(method.path));
    }
  }
  return skillArgs;
}

/**
 * Pi last-hop argv after `--no-extensions -e entry` (#819).
 * Activation flag membership comes from middle-layer projectActivationFlags;
 * this function only renders session coords, controlled constants, and pairs.
 * User dialogue is not an argv element (#879): it rides spawn stdin.
 */
export function buildPiTurnExtraArgs(
  request: RoleTurnRequest,
  authority: DurablePrincipalAuthority,
  extraPiArgs: readonly string[] = [],
): string[] {
  const { sessionFile, sessionDirectory } = authority.decode(request.principal);
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
    // Envelope assembly = projectActivationFlags; pi only renders argv pairs.
    ...activationFlagsToPiArgv(projectActivationFlags(request)),
    ...piEngineModelArgs(request),
    "--mode",
    "json",
    ...buildSeatModelCliArgs(request.model),
  ];
}

/** Engine name stays on child env; model has no env fallback (#883 / #879). */
function piEngineModelArgs(request: RoleTurnRequest): string[] {
  const model = normalizeEngineName(request.engineModel);
  if (model === undefined) return [];
  return [`--${ENGINE_MODEL_FLAG_NAME}`, model];
}

function piUserDialogueBody(request: RoleTurnRequest): string {
  const rawPrompt =
    request.continuation.kind === "initial" || request.continuation.kind === "resume"
      ? request.continuation.prompt
      : (() => {
          const _exhaustive: never = request.continuation;
          return _exhaustive;
        })();
  return rawPrompt;
}

export type PiSpawnRunner = (
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Parent cancellation; the child gets the same graceful SIGTERM as a budget. */
    signal?: AbortSignal;
    /** User dialogue body; omitted from argv so execve cannot E2BIG (#879). */
    stdin?: string;
  },
) => Promise<{
  code: number | null;
  stderr: string;
  timedOut: boolean;
  signal?: string;
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
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (child.stdin === null) {
        throw new Error("Pi child stdin pipe was not created");
      }
      if (child.stderr === null) {
        throw new Error("Pi child stderr pipe was not created");
      }
      let stdinDeliveryError: Error | undefined;
      child.stdin.on("error", (error) => {
        stdinDeliveryError ??= error;
      });
      if (spawnOptions.stdin !== undefined) {
        child.stdin.write(spawnOptions.stdin);
      }
      child.stdin.end();
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
      const armTimeoutAfterChildReady = (): void => {
        if (spawnOptions.timeoutMs === undefined) return;
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, spawnOptions.timeoutMs);
      };
      // Parent cancellation reaches the nested activation: same graceful SIGTERM,
      // same single close settlement. SIGKILL stays forbidden (#675 / ADR 0010).
      const parentSignal = spawnOptions.signal;
      const terminateForParentAbort = (): void => {
        child.kill("SIGTERM");
      };
      parentSignal?.addEventListener("abort", terminateForParentAbort, { once: true });
      const packageErrors: unknown[] = [];
      let identityFailure: RoleTurnKnownFailure | undefined;
      let identityRecorded: Promise<void> = Promise.resolve();
      child.once("spawn", () => {
        hasSpawned = true;
        if (parentSignal?.aborted === true) terminateForParentAbort();
        armTimeoutAfterChildReady();
        const runDirectory = spawnOptions.env.AK_ROLE_RUN_DIR;
        if (
          typeof runDirectory === "string" &&
          runDirectory !== "" &&
          options.recordLaunchedPiIdentity !== undefined
        ) {
          identityRecorded = Promise.resolve().then(() =>
            options.recordLaunchedPiIdentity!(runDirectory, piIdentity),
          ).catch((error) => {
            packageErrors.push(error);
            identityFailure = projectThrownFailureLeaf(error);
          });
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        // A pre-spawn error has no child lifecycle to close. After spawn,
        // retain the execution error and let the mandatory close event own
        // cleanup and the single settlement.
        if (settled) return;
        if (hasSpawned) {
          packageErrors.push(error);
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        parentSignal?.removeEventListener("abort", terminateForParentAbort);
        settled = true;
        reject(error);
      });
      // `close` carries (code, signal): a signal-killed child reports code null.
      // Both travel out so a signal death is never read as a clean exit.
      child.on("close", (code, closeSignal) => {
        if (timer !== undefined) clearTimeout(timer);
        parentSignal?.removeEventListener("abort", terminateForParentAbort);
        void (async () => {
          if (settled) return;
          settled = true;
          await identityRecorded;
          if (stdinDeliveryError !== undefined) packageErrors.push(stdinDeliveryError);
          for (const error of packageErrors) {
            const diagnostic = `Pi transport handling failed beside host terminal: ${describeErrorIdentity(error)}`;
            const runDirectory = spawnOptions.env.AK_ROLE_RUN_DIR;
            if (runDirectory !== undefined) {
              await retainPackageFault({ runDirectory, diagnostic, error });
            } else {
              // Bare runner callers have no admitted artifact directory.
              try { process.stderr.write(`${diagnostic}\n`); }
              catch { /* Best-effort presentation beside the already closed child. */ }
            }
          }
          resolveResult({
            code,
            stderr,
            timedOut,
            ...(closeSignal === null ? {} : { signal: closeSignal }),
            ...(code === 0 && !timedOut && closeSignal === null && identityFailure !== undefined
              ? { knownFailure: identityFailure }
              : {}),
          });
        })();
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
      const turnRequest = request;
      const roleEntry = await realpath(resolveInternalRoleEntrypoint(config.packageRoot));
      const extraArgs = buildPiTurnExtraArgs(
        turnRequest,
        config.principalAuthority,
        config.extraPiArgs ?? [],
      );
      const args = buildExplicitInternalActivationArgs(roleEntry, extraArgs);
      const stdin = encodeUserDialogueStdin(piUserDialogueBody(turnRequest));
      // Shared envelope isolates this call's court identity: omitting courtAttemptId
      // must not inherit a parent process.env.AK_ROLE_COURT_ATTEMPT (#637).
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: request.home,
        PI_CODING_AGENT_DIR: request.agentDir,
        AK_ROLE_RUN_DIR: request.runDirectory,
        // Nested public summons resolve package root without import.meta under jiti (#675).
        // Child-process scoped only — not written back onto the parent process.env.
        AK_ROLE_PACKAGE_ROOT: config.packageRoot,
      };
      if (request.courtAttemptId === undefined) delete env.AK_ROLE_COURT_ATTEMPT;
      else env.AK_ROLE_COURT_ATTEMPT = request.courtAttemptId;
      // Public-invocation scope (#537): omit must not inherit a parent env value.
      if (request.invocationScopeId === undefined) delete env.AK_ROLE_INVOCATION_SCOPE;
      else env.AK_ROLE_INVOCATION_SCOPE = request.invocationScopeId;
      // Selected host axis (#537 / ADR 0082): omit must not inherit a parent env value.
      if (request.host === undefined || request.host.trim() === "") delete env.AK_ROLE_HOST;
      else env.AK_ROLE_HOST = request.host.trim();
      // #1132: the one effective delivery-request ceiling travels to the child
      // on its own env so the in-child role runtime and the worker submission
      // gate count with the same configured number the AK seam resolved. Omit
      // must not inherit a parent value (same rule as the other AK_ROLE_ axes).
      if (request.deliveryRequestLimit === undefined) delete env[RECEIPT_DELIVERY_LIMIT_ENV];
      else env[RECEIPT_DELIVERY_LIMIT_ENV] = String(request.deliveryRequestLimit);
      applyEngineChildEnv(env, request.engine);
      // Nested auditor dossier tool binds the parent run pointer when published.
      if (
        typeof process.env.AK_ROLE_AUDITOR_SOURCE_RUN === "string"
        && process.env.AK_ROLE_AUDITOR_SOURCE_RUN.trim() !== ""
      ) {
        env.AK_ROLE_AUDITOR_SOURCE_RUN = process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
      }
      // Audited-subject input selects soul materials (same for nested and direct).
      if (
        typeof process.env.AK_ROLE_AUDITOR_SUBJECT === "string"
        && process.env.AK_ROLE_AUDITOR_SUBJECT.trim() !== ""
      ) {
        env.AK_ROLE_AUDITOR_SUBJECT = process.env.AK_ROLE_AUDITOR_SUBJECT;
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
      const result = await spawnRunner(args, {
        cwd: request.cwd,
        env,
        stdin,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      // Deliver already-written Pi host facts. Pi lands at session/session.jsonl;
      // bind projects host.sessions; copy records the landing. Host adapters do
      // not write current.json — public bind/settlement seams own that render.
      try {
        await syncTurnRequestLivePlacement(request);
        const { sessionFile, sessionDirectory } = config.principalAuthority.decode(request.principal);
        const sessionId = await readPiSessionHeaderId(sessionFile);
        if (sessionId !== undefined) {
          await createSessionIdentityAuthority(config.principalAuthority, "pi").bind(
            request.principal,
            sessionId,
          );
          copyAndRecordHostDossier({
            host: "pi",
            sessionId,
            cwd: request.cwd,
            sessionDirectory,
            sessionParent: sessionFile,
            ...(request.home !== undefined ? { home: request.home } : {}),
          });
        }
      } catch (error) {
        await retainPackageFault({
          runDirectory: await syncTurnRequestLivePlacement(request),
          diagnostic: `pi host dossier record failed beside host terminal: ${describeErrorIdentity(error)}`,
          error,
        });
      }
      return result;
    },
  };
}

/**
 * Session header id from the Pi volume the child (or fixture) already wrote.
 * Reuses the ledger line kernel: a later malformed line must not erase a valid
 * header already present (ADR 0086 originals are not validated whole-file).
 */
async function readPiSessionHeaderId(sessionFile: string): Promise<string | undefined> {
  try {
    for (const line of await readLedgerSessionJsonlLines(sessionFile)) {
      const entry = line.row;
      if (entry === undefined || entry.type !== "session") continue;
      if (typeof entry.id === "string" && entry.id.trim() !== "") return entry.id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return undefined;
}

/** Last non-session entry id. Session headers are not parents of custom lines. */
export function piSessionCustomParentId(
  entries: readonly { id?: unknown; type?: unknown }[],
): string | null {
  let parentId: string | null = null;
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.type !== "session") parentId = entry.id;
  }
  return parentId;
}

/** One Pi custom JSONL line: type, customType, data, id, parentId, timestamp. */
export function formatPiSessionCustomEntry(input: {
  readonly customType: string;
  readonly data: unknown;
  readonly parentId: string | null;
  readonly timestamp: string;
}): string {
  return `${JSON.stringify({
    type: "custom",
    customType: input.customType,
    data: input.data,
    id: randomUUID(),
    parentId: input.parentId,
    timestamp: input.timestamp,
  })}\n`;
}

/**
 * Append one custom JSONL entry to the durable principal's session file.
 * Pi session codec only — AK artifact O_EXCL retention stays in public-cli.
 * Read is raw JSON.parse (SyntaxError propagates). Sitian full-traversal stays elsewhere.
 */
export async function appendPiSessionCustomEntry(
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
  customType: string,
  data: unknown,
): Promise<void> {
  const { sessionFile } = authority.decode(principal);
  const entries = await readStrictPiSessionJsonl(sessionFile) as { id?: unknown; type?: unknown }[];
  const timestamp = new Date().toISOString();
  const pointerLine = formatPiSessionCustomEntry({
    customType,
    data,
    parentId: piSessionCustomParentId(entries),
    timestamp,
  });
  await appendFile(sessionFile, pointerLine, "utf8");
  sitianReport({
    level: "event",
    kind: "dispatch-error",
    sessionParent: sessionFile,
    payload: { customType, data },
    source: "pi-role-turn-host",
  });
}
