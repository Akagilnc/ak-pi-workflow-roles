/**
 * Role-inside-role summons via the single public activation path (#675).
 * Gate / compliance / evidence callers invoke the same post-admission face a
 * human uses; no second institutional session open, no model-only seat page.
 *
 * Lazy-loads every local value dependency. Pi loads extensions through jiti
 * (CJS transform, moduleCache:false); a static import graph that re-enters this
 * module via settlement → compliance leaves binding slots undefined
 * (`reading 'dirname'`, `reading 'tryHomeFromAkRolesPath'`). Dynamic import
 * starts after the caller module has finished init, so those slots stay intact.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { CliIo } from "./public-cli/cli-io.ts";
import type { CredentialProviders, EffectiveSeat } from "./public-cli/config.ts";
import type { PublicCallableRole } from "./public-cli/registry.ts";
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnModelConfig,
} from "./host-contracts.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";
import type { HostSelectionFailure, NamedRoleTurnHostAdapter } from "./public-cli/role-turn-host-resolution.ts";
import { pickEngineAxis } from "./package-resources/engine-material.ts";

/** Env published by the parent activation so nested summons never re-derive root. */
export const AK_ROLE_PACKAGE_ROOT_ENV = "AK_ROLE_PACKAGE_ROOT" as const;


export type PublicSummonRole =
  | "inspector"
  | "notary"
  | "auditor"
  | "navigator"
  | "gatekeeper"
  | "judge"
  | "doctor"
  | "diarist"
  | "countersign"
  | "reviewer";

export type PublicSummonRequest = {
  readonly role: PublicSummonRole;
  /** Argv after the role token (same shape as `ak-role <role> …`). */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Package home; derived from source run when omitted. */
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
  readonly credentials?: CredentialProviders;
  /** Parent turn's effective seat axes for same-seat child legs. */
  readonly model?: RoleTurnModelConfig;
  readonly host?: string;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly agentDir?: string;
  /** Parent durable-principal authority; defaults to the Pi adapter. */
  readonly principalAuthority?: DurablePrincipalAuthority;
  /** Parent role-run timeout projected onto the child turn request. */
  readonly timeoutMs?: number;
  /**
   * Optional Pi argv forwarded to the role-turn host (same face as public CLI
   * seat extraPiArgs). Callers pass explicitly — no process.env test protocol.
   */
  readonly extraPiArgs?: readonly string[];
  /**
   * Parent cancellation. A nested summon is an in-process await over a child
   * activation; without this the child keeps running (and spending) after the
   * parent tool call is cancelled (#675).
   */
  readonly signal?: AbortSignal;
  /**
   * #753 plain-language re-ask when the prior officer reply was not three-state.
   * Nested gate officers (notary + inspector) — rides same-ticket resume
   * summons.instruction. Never folded into argv / parent-run lookup keys.
   */
  readonly reviewReask?: string;
  /**
   * #879 same-parent (and first-mint) gate summons: verbatim parent-submission body.
   * Rides summons.instruction / first-mint prompt when reviewReask is absent.
   * Never folded into argv / parent-run lookup keys (binding pointer stays pure).
   */
  readonly gateReviewInstruction?: string;
  /**
   * Pi-adapter inject (tests). Used only as the `pi` row when composing the
   * adapter table — never as an override of the child seat's selected host.
   */
  readonly roleTurnHost?: RoleTurnHost;
  /**
   * Composition-root adapter table (tests / parent CLI env). Child seat selects
   * from this table. Production leaves unset and composes the default table.
   */
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  /** Offline test inject for deterministic run ids (same face as public CLI). */
  readonly createRunId?: () => string;
  /** Typed ticket number handoff for diarist child run (#840). */
  readonly boundTicketNumber?: number;
  /** Caller correlation id for nested leg ledger (ADR 0010 / #924). */
  readonly correlationId?: string;
  /**
   * Resume an existing instruction-seat run via public CLI resume (host-native
   * session continuity). Used by navigator attendance so prior advice stays on
   * the host session — not a package-built advice ledger.
   */
  readonly resumeRunId?: string;
  /**
   * Ephemeral host-turn cwd override (#946 fresh-copy sandbox). Admission keeps
   * the public --project / cwd identity; the host turn runs under this path.
   */
  readonly executionCwd?: string;
  /**
   * Nested court station child (default true): omit Navigator auto-attendance
   * and use station-child resume. Ordinary public-equivalent legs (dual-lens
   * Reviewer axes) pass false so behavior matches a top-level single-axis call
   * (#946 / ADR 0082).
   */
  readonly stationChild?: boolean;
};

const execFileAsync = promisify(execFile);

export type PublicSummonResult = {
  readonly exitCode: number;
  readonly terminal?: TerminalResult;
  /** Independent officer/role run directory (正本); parent books pointer only. */
  readonly runDirectory?: string;
  /** Offline diagnostics from nested CLI (structural rejection text). */
  readonly stderr?: string;
  /** Admitted role invocation from nested run. */
  readonly admitted?: import("./public-cli/invocation.ts").AdmittedRoleInvocation;
};

function createCapturingIo(): { io: CliIo; stderrText(): string } {
  const chunks: string[] = [];
  return {
    io: {
      stdout() {},
      stderr(text: string) {
        chunks.push(text);
      },
    },
    stderrText: () => chunks.join(""),
  };
}

/** Path parent without depending on a jiti-bound `path.dirname` closure. */
function parentDir(path: string): string {
  const end = path.endsWith("/") || path.endsWith("\\") ? path.slice(0, -1) : path;
  const idx = Math.max(end.lastIndexOf("/"), end.lastIndexOf("\\"));
  if (idx <= 0) return end;
  return end.slice(0, idx);
}

function walkPackageRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "souls"))) {
      return dir;
    }
    const parent = parentDir(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve install package root for nested public summons.
 * Prefer explicit / env coordinates; never require import.meta under jiti.
 */
export function resolveSummonsPackageRoot(explicit?: string): string {
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit;
  }
  const fromEnv = process.env[AK_ROLE_PACKAGE_ROOT_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv;
  }
  const fromCwd = walkPackageRoot(process.cwd());
  if (fromCwd !== undefined) return fromCwd;
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === "string" && metaUrl.startsWith("file:")) {
      const filePath = decodeURIComponent(metaUrl.slice("file://".length));
      const fromMeta = walkPackageRoot(parentDir(filePath));
      if (fromMeta !== undefined) return fromMeta;
    }
  } catch {
    // import.meta unavailable — fall through.
  }
  throw new Error(
    "public role summons cannot resolve package root (pass packageRoot or set AK_ROLE_PACKAGE_ROOT)",
  );
}

async function resolveSummonHome(options: PublicSummonRequest): Promise<string> {
  if (options.home !== undefined && options.home.trim() !== "") {
    return options.home;
  }
  const { tryHomeFromAkRolesPath, packageMachineHome } = await import(
    "./activation-ledger-topology.ts"
  );
  const fromCwd = tryHomeFromAkRolesPath(options.cwd);
  if (fromCwd !== undefined && fromCwd.length > 0) return fromCwd;
  return packageMachineHome();
}

/** Seat axes only — no parent-env fallback (#675 / #617 DK-3 / #883). */
function projectSeatEngine(seat: EffectiveSeat): {
  engine?: string;
  engineModel?: string;
} {
  return pickEngineAxis(seat);
}

function projectSeatHost(seat: EffectiveSeat): { host?: string } {
  return seat.host === undefined ? {} : { host: seat.host };
}

function hostSelectionFailureFromUnknown(error: unknown): HostSelectionFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ((error as { name?: unknown }).name !== "HostSelectionError") return undefined;
  const failure = (error as { failure?: HostSelectionFailure }).failure;
  return failure;
}

type SummonEnvOk = {
  readonly home: string;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly agentDir: string;
  readonly sessionAppender: typeof import("./pi/role-turn-host.ts").appendPiSessionCustomEntry;
  readonly packageRoot: string;
  readonly roleTurnHost: RoleTurnHost;
  readonly cwd: string;
  readonly credentials: CredentialProviders;
  readonly model?: import("./host-contracts.ts").HostInstitutionalModelSelection;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly host?: string;
  readonly timeoutMs?: number;
};

/** #178: missing model is ok:false (typed fact), not a thrown message. */
type SummonEnvBuild =
  | { readonly ok: true; readonly env: SummonEnvOk }
  | { readonly ok: false; readonly missingModelMessage: string };

async function createSummonEnv(
  options: {
    readonly role: PublicCallableRole;
    readonly home: string;
    readonly agentDir: string;
    readonly cwd: string;
    readonly packageRoot: string;
    readonly credentials: CredentialProviders;
    readonly seat: EffectiveSeat;
    readonly extraPiArgs?: readonly string[];
    readonly roleTurnHost?: RoleTurnHost;
    readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
    readonly principalAuthority?: DurablePrincipalAuthority;
    readonly timeoutMs?: number;
    /** Parent env model already host-facing — never project a second time. */
    readonly hostFacingModel?: RoleTurnModelConfig;
  },
  /** #178: after host selection, before missing-model — structural argv parse once. */
  afterHost?: () => void,
): Promise<SummonEnvBuild> {
  const [
    { piDurablePrincipalAuthority },
    { appendPiSessionCustomEntry },
    { resolveRoleTurnHost },
    { missingResolvedSeatModelMessage, resolvedSeatWithModel },
  ] = await Promise.all([
    import("./pi/durable-principal.ts"),
    import("./pi/role-turn-host.ts"),
    import("./public-cli/role-turn-host-resolution.ts"),
    import("./public-cli/config.ts"),
  ]);
  const principalAuthority = options.principalAuthority ?? piDurablePrincipalAuthority;
  // Host first → argv (afterHost) → missing-model → provider projection (#617/#178/#840).
  const roleTurnHost = resolveRoleTurnHost(
    {
      packageRoot: options.packageRoot,
      ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
      ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
      ...(options.extraPiArgs === undefined || options.extraPiArgs.length === 0
        ? {}
        : { extraPiArgs: options.extraPiArgs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    { role: options.role, seat: options.seat, principalAuthority },
  );
  afterHost?.();
  const seatWithModel = resolvedSeatWithModel(options.seat);
  if (seatWithModel === undefined) {
    return {
      ok: false,
      missingModelMessage: missingResolvedSeatModelMessage(options.role),
    };
  }
  const hostName = seatWithModel.host ?? "pi";
  let hostFacingSelection: RoleTurnModelConfig | undefined = options.hostFacingModel;
  if (hostFacingSelection === undefined) {
    const { loadHostProvidersTable, projectHostFacingProvider } = await import(
      "./public-cli/host-providers.ts"
    );
    hostFacingSelection = projectHostFacingProvider(
      seatWithModel.selection,
      hostName,
      loadHostProvidersTable(options.home),
      options.home,
    );
  }
  return {
    ok: true,
    env: {
      home: options.home,
      principalAuthority,
      agentDir: options.agentDir,
      sessionAppender: appendPiSessionCustomEntry,
      packageRoot: options.packageRoot,
      roleTurnHost,
      cwd: options.cwd,
      credentials: options.credentials,
      ...(hostFacingSelection === undefined ? {} : { model: hostFacingSelection }),
      ...projectSeatEngine(seatWithModel),
      ...projectSeatHost(seatWithModel),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  };
}

/**
 * Summon one public callable role through the same runners the CLI uses
 * (ADR 0052 / #675). Seat axes come from the live table.
 */
export async function summonPublicRole(
  options: PublicSummonRequest,
): Promise<PublicSummonResult> {
  const packageRoot = resolveSummonsPackageRoot(options.packageRoot);
  const home = await resolveSummonHome(options);
  const agentDir =
    options.agentDir
    ?? process.env.PI_CODING_AGENT_DIR
    ?? join(home, ".pi", "agent");
  const {
    loadCredentialProviders,
    loadPublicCliConfig,
    resolveEffectiveSeat,
  } = await import("./public-cli/config.ts");
  const credentials =
    options.credentials ?? (await loadCredentialProviders(agentDir));
  const config = await loadPublicCliConfig(home);
  // Nested summons: officer seat only (flag>seat>default pi). #178 order below.
  const resolvedSeat = resolveEffectiveSeat(config, options.role, credentials);
  const inheritedSelection = options.model === undefined
    ? undefined
    : {
        provider: options.model.provider,
        model: options.model.model,
        ...(options.model.thinking === undefined
          ? {}
          : { thinking: options.model.thinking as import("./public-cli/registry.ts").PublicThinkingLevel }),
      };
  const seat: EffectiveSeat = {
    ...resolvedSeat,
    ...(inheritedSelection === undefined
      ? {}
      : { selection: inheritedSelection, source: "invocation" as const }),
    ...(options.host === undefined
      ? {}
      : { host: options.host, hostSource: "invocation" as const }),
    ...(options.engine === undefined
      ? {}
      : { engine: options.engine, engineSource: "invocation" as const }),
    ...(options.engineModel === undefined ? {} : { engineModel: options.engineModel }),
  };
  const captured = options.io === undefined ? createCapturingIo() : undefined;
  const io = options.io ?? captured!.io;

  const summonEnvInput = {
    role: options.role,
    home,
    agentDir,
    cwd: options.cwd,
    packageRoot,
    credentials,
    seat,
    ...(options.extraPiArgs === undefined ? {} : { extraPiArgs: options.extraPiArgs }),
    ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
    ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
    ...(options.principalAuthority === undefined
      ? {}
      : { principalAuthority: options.principalAuthority }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    // Parent model is already host-facing; child must not project again.
    ...(options.model === undefined ? {} : { hostFacingModel: options.model }),
  } as const;

  type Prepared =
    | { readonly ok: true; readonly env: Record<string, unknown> }
    | { readonly ok: false; readonly exitCode: number; readonly stderr?: string };

  async function prepareSummonEnv(afterHost: () => void): Promise<Prepared> {
    try {
      const built = await createSummonEnv(summonEnvInput, afterHost);
      if (!built.ok) {
        return { ok: false, exitCode: 1, stderr: built.missingModelMessage };
      }
      return {
        ok: true,
        env: {
          ...built.env,
          // Nested court stations keep station-child semantics; dual-lens
          // ordinary Reviewer axes opt out (#946 / ADR 0082).
          ...(options.stationChild === false ? {} : { stationChild: true }),
          // Forward composition-root adapters so nested court stations (e.g.
          // countersign → diarist) select the same faux/production table (#924).
          ...(options.hostAdapters === undefined
            ? {}
            : { hostAdapters: options.hostAdapters }),
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.reviewReask === undefined ? {} : { reviewReask: options.reviewReask }),
          ...(options.gateReviewInstruction === undefined
            ? {}
            : { gateReviewInstruction: options.gateReviewInstruction }),
          ...(options.boundTicketNumber === undefined
            ? {}
            : { boundTicketNumber: options.boundTicketNumber }),
          ...(options.correlationId === undefined || options.correlationId.trim() === ""
            ? {}
            : { correlationId: options.correlationId }),
          ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
          ...(options.executionCwd === undefined ? {} : { executionCwd: options.executionCwd }),
        },
      };
    } catch (error) {
      const failure = hostSelectionFailureFromUnknown(error);
      if (failure !== undefined) {
        const { formatHostSelectionFailure } = await import("./public-cli/role-turn-host-resolution.ts");
        return { ok: false, exitCode: 1, stderr: formatHostSelectionFailure(failure) };
      }
      const { CliUsageError } = await import("./public-cli/cli-errors.ts");
      if (error instanceof CliUsageError) {
        const { presentStructuralRejection } = await import("./public-cli/settlement.ts");
        presentStructuralRejection(error, io);
        return { ok: false, exitCode: 2 };
      }
      throw error;
    }
  }

  function projectPrepareFailure(prepared: Extract<Prepared, { ok: false }>): PublicSummonResult {
    const parts = [prepared.stderr, captured?.stderrText()].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    const stderr = parts.length === 0 ? undefined : parts.join("");
    return {
      exitCode: prepared.exitCode,
      ...(stderr === undefined ? {} : { stderr }),
    };
  }

  /** Host → argv once → missing-model → runner. */
  async function runPrepared<TParsed>(
    parse: (argv: readonly string[]) => TParsed,
    run: (
      env: Record<string, unknown>,
      parseOnce: () => TParsed,
    ) => Promise<{
      exitCode: number;
      terminal?: TerminalResult;
      admitted?: { readonly runDirectory?: string };
    }>,
  ) {
    let parsedArgv!: TParsed;
    const prepared = await prepareSummonEnv(() => {
      parsedArgv = parse(options.argv);
    });
    if (!prepared.ok) return { fail: projectPrepareFailure(prepared) as PublicSummonResult };
    return { ok: await run(prepared.env, () => parsedArgv) };
  }

  let result: {
    exitCode: number;
    terminal?: TerminalResult;
    admitted?: { readonly runDirectory?: string };
  };
  switch (options.role) {
    case "notary": {
      const [{ runPublicNotary }, { parseNotaryArgv }] = await Promise.all([
        import("./public-cli/notary-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseNotaryArgv, (env, once) =>
        runPublicNotary(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
    case "inspector": {
      const [{ runPublicInspector }, { parseInspectorArgv }] = await Promise.all([
        import("./public-cli/inspector-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseInspectorArgv, (env, once) =>
        runPublicInspector(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
    case "auditor":
    case "navigator":
    case "gatekeeper": {
      const seat = options.role;
      const [{ runPublicInstructionSeat, runPublicInstructionSeatResume }, invocation] = await Promise.all([
        import("./public-cli/instruction-seat-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const parse =
        seat === "auditor"
          ? invocation.parseAuditorArgv
          : seat === "navigator"
            ? invocation.parseNavigatorArgv
            : invocation.parseGatekeeperArgv;
      const resumeRunId = typeof options.resumeRunId === "string" && options.resumeRunId.trim() !== ""
        ? options.resumeRunId.trim()
        : undefined;
      if (resumeRunId !== undefined) {
        // Host CLI resume — same face as `ak-role resume <runId> [message]`.
        // Instruction/materials ride summons.instruction (not package memory).
        const instruction = options.argv[0] ?? "";
        const stepped = await runPrepared(parse, (env) =>
          runPublicInstructionSeatResume(
            {
              runId: resumeRunId,
              summons: {
                instruction,
                instructionEmpty: instruction.trim() === "",
              },
            },
            env as never,
            io,
          ));
        if ("fail" in stepped) return stepped.fail;
        result = stepped.ok;
      } else {
        const stepped = await runPrepared(parse, (env, once) =>
          runPublicInstructionSeat(options.argv, env as never, io, seat, once));
        if ("fail" in stepped) return stepped.fail;
        result = stepped.ok;
      }
      break;
    }
    case "judge": {
      const [{ runPublicJudge }, { parseJudgeArgv }] = await Promise.all([
        import("./public-cli/judge-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseJudgeArgv, (env, once) =>
        runPublicJudge(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
    case "doctor": {
      const [{ runPublicDoctor }, { parseDoctorArgv }] = await Promise.all([
        import("./public-cli/doctor-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseDoctorArgv, (env, once) =>
        runPublicDoctor(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
    case "diarist": {
      const [{ runPublicDiarist }, { parseDiaristArgv }] = await Promise.all([
        import("./public-cli/diarist-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseDiaristArgv, (env, once) =>
        runPublicDiarist(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
    case "countersign": {
      const [{ runPublicCountersign }, { parseCountersignArgv }] = await Promise.all([
        import("./public-cli/countersign-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseCountersignArgv, (env, once) =>
        runPublicCountersign(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
    case "reviewer": {
      const [{ runPublicReviewer }, { parseReviewerArgv }] = await Promise.all([
        import("./public-cli/reviewer-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const stepped = await runPrepared(parseReviewerArgv, (env, once) =>
        runPublicReviewer(options.argv, env as never, io, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
      break;
    }
  }

  const stderr = captured?.stderrText();
  const runDirectory = result.admitted?.runDirectory;
  return {
    exitCode: result.exitCode,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
    ...(result.admitted === undefined ? {} : { admitted: result.admitted as import("./public-cli/invocation.ts").AdmittedRoleInvocation }),
    ...(typeof runDirectory === "string" && runDirectory.trim() !== ""
      ? { runDirectory }
      : {}),
    ...(stderr === undefined || stderr === "" ? {} : { stderr }),
  };
}

/**
 * Inject `--lens` into a public Reviewer argv that has none. Keeps every other
 * token (including `--project` and `--`) exactly as the single-axis entry saw it.
 */
function withReviewerLens(
  argv: readonly string[],
  lens: "completeness" | "correctness",
): string[] {
  const separator = argv.indexOf("--");
  if (separator === -1) return [...argv, "--lens", lens];
  return [...argv.slice(0, separator), "--lens", lens, ...argv.slice(separator)];
}

/** Caller project may be a repo subdirectory; sandboxes keep that relative path. */
async function resolveReviewerWorktreeRoots(projectRoot: string): Promise<{
  readonly callerProjectRoot: string;
  readonly sourceProjectRoot: string;
  readonly projectRelative: string;
}> {
  const callerProjectRoot = await realpath(projectRoot);
  const sourceProjectRoot = await realpath((await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: callerProjectRoot },
  )).stdout.trim());
  const callerRelative = relative(sourceProjectRoot, callerProjectRoot);
  const projectRelative =
    callerRelative === ""
    || callerRelative === "."
    || callerRelative.startsWith(`..${sep}`)
    || callerRelative === ".."
      ? ""
      : callerRelative;
  return { callerProjectRoot, sourceProjectRoot, projectRelative };
}

function reviewerSandboxPath(worktreeAxis: string, projectRelative: string): string {
  return projectRelative === "" ? worktreeAxis : join(worktreeAxis, projectRelative);
}

/** True when `candidate` is the same path as `root` or a path under it. */
function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Copy `source` onto `destination` as real files/directories (no retained
 * symlinks). Used when a dependency link would otherwise resolve outside the
 * sandbox copy.
 */
async function copyTreeMaterialized(
  source: string,
  destination: string,
  stack: Set<string> = new Set(),
): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    const real = await realpath(source);
    if (stack.has(real)) {
      await mkdir(destination, { recursive: true });
      return;
    }
    stack.add(real);
    try {
      await copyTreeMaterialized(real, destination, stack);
    } finally {
      stack.delete(real);
    }
    return;
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      await copyTreeMaterialized(join(source, name), join(destination, name), stack);
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/** Lexical symlink target (no existence check) — for dangling / looping links. */
async function lexicalSymlinkTarget(linkPath: string): Promise<string> {
  const target = await readlink(linkPath);
  return isAbsolute(target) ? resolve(target) : resolve(dirname(linkPath), target);
}

/**
 * After a deps tree copy: keep symlinks that stay inside the sandbox; replace
 * any resolvable link whose realpath escapes with a materialized copy; drop
 * unresolvable (dangling / looping) links that lexically escape. In-sandbox
 * dangling links are kept so provision does not fail closed on common broken
 * bins (#983).
 *
 * `sandboxModulesRootReal` is realpath'd (macOS `/private/var`); 
 * `sandboxModulesRootLexical` is the path form used by the copy walk (`/var`).
 * Resolvable links are compared with the real root; dangling links with the
 * lexical root so `/var` vs `/private/var` does not false-escape.
 */
async function materializeEscapingDependencySymlinks(
  sandboxModulesRootReal: string,
  sandboxModulesRootLexical: string,
  current: string,
): Promise<void> {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) {
    let real: string | undefined;
    try {
      real = await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP") {
        throw error;
      }
    }
    if (real !== undefined) {
      if (isPathInsideRoot(sandboxModulesRootReal, real)) {
        return;
      }
      await rm(current, { force: true });
      await copyTreeMaterialized(real, current);
      return;
    }
    const lexical = await lexicalSymlinkTarget(current);
    if (isPathInsideRoot(sandboxModulesRootLexical, lexical)) {
      return;
    }
    await rm(current, { force: true });
    return;
  }
  if (!currentStat.isDirectory()) {
    return;
  }
  for (const name of await readdir(current)) {
    await materializeEscapingDependencySymlinks(
      sandboxModulesRootReal,
      sandboxModulesRootLexical,
      join(current, name),
    );
  }
}

/**
 * Ignored dependency trees (node_modules) do not follow `git worktree add`.
 * When the source checkout already has them, mirror that material into the
 * ephemeral sandbox so Reviewer probes and focused tests resolve the same way
 * as in the caller tree (#983). Shape is a recursive directory copy that keeps
 * in-tree relative links and materializes any link that would resolve outside
 * the sandbox — same shared seam for all Reviewer paths, no second install, no
 * public flag, and no writable path back into the caller tree. Absence in the
 * source is left absent.
 */
async function provisionReviewerWorktreeDeps(
  sourceProjectRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const sourceModules = join(sourceProjectRoot, "node_modules");
  if (!existsSync(sourceModules)) {
    return;
  }
  const target = join(worktreeRoot, "node_modules");
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      throw new Error(
        `reviewer worktree deps target must not be a symlink: ${target}`,
      );
    }
    if (!existing.isDirectory()) {
      throw new Error(
        `reviewer worktree deps target exists and is not a directory: ${target}`,
      );
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  // verbatimSymlinks: keep relative in-tree targets relative. Node's default
  // rewrites them to absolute source paths and re-opens a write-through channel.
  await cp(sourceModules, target, { recursive: true, verbatimSymlinks: true });
  await materializeEscapingDependencySymlinks(await realpath(target), target, target);
}


export type EphemeralReviewerWorktree = {
  readonly executionCwd: string;
  /** Always safe to call once; delete failure is diagnostic only (#946 10a). */
  readonly close: () => Promise<void>;
};

/**
 * Open one ephemeral detached worktree at the source tree's current HEAD.
 * Caller must close. Shared by explicit `--lens` and any Reviewer resume.
 * Dual-lens batch mints its own pair so both legs share one PRE_HEAD snapshot.
 */
export async function openEphemeralReviewerWorktree(options: {
  readonly projectRoot: string;
  readonly onCleanupDiagnostic?: (diagnostic: string) => void;
}): Promise<EphemeralReviewerWorktree> {
  const { sourceProjectRoot, projectRelative } = await resolveReviewerWorktreeRoots(
    options.projectRoot,
  );
  const { stdout: headStdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: sourceProjectRoot },
  );
  const targetCommit = headStdout.trim();
  const root = await mkdtemp(join(tmpdir(), "ak-reviewer-sandbox-"));
  const worktreeRoot = join(root, "work");
  let registered = false;
  const rollback = async (cause: unknown): Promise<never> => {
    // From registration onward, any pre-handle failure must remove the worktree
    // and root. Keep the original prep cause; cleanup failures are diagnostic
    // only (10a) — same face as close(), never silent (#946).
    const cleanupErrors: unknown[] = [];
    if (registered) {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreeRoot], {
          cwd: sourceProjectRoot,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      options.onCleanupDiagnostic?.([
        "reviewer worktree cleanup failed",
        ...cleanupErrors.map((error) =>
          error instanceof Error ? error.message : String(error)),
      ].join("\n"));
    }
    throw cause;
  };
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", worktreeRoot, targetCommit], {
      cwd: sourceProjectRoot,
    });
    registered = true;
    // Preserve caller subdirectory even when absent from the pinned commit.
    if (projectRelative !== "") {
      await mkdir(reviewerSandboxPath(worktreeRoot, projectRelative), { recursive: true });
    }
    // After registration: provision ignored deps so prep failure still rolls back.
    await provisionReviewerWorktreeDeps(sourceProjectRoot, worktreeRoot);
  } catch (error) {
    await rollback(error);
  }
  let closed = false;
  return {
    executionCwd: reviewerSandboxPath(worktreeRoot, projectRelative),
    close: async () => {
      if (closed) return;
      closed = true;
      const cleanupErrors: unknown[] = [];
      try {
        // --force: ephemeral sandboxes may carry provisioned ignored deps (#983).
        await execFileAsync("git", ["worktree", "remove", "--force", worktreeRoot], {
          cwd: sourceProjectRoot,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        options.onCleanupDiagnostic?.([
          "reviewer worktree cleanup failed",
          ...cleanupErrors.map((error) =>
            error instanceof Error ? error.message : String(error)),
        ].join("\n"));
      }
    },
  };
}

/**
 * One ephemeral detached worktree at the source tree's current HEAD.
 * Always removed after `run` settles; delete failure is diagnostic only (#946 10a).
 */
export async function withEphemeralReviewerWorktree<T>(options: {
  readonly projectRoot: string;
  readonly run: (executionCwd: string) => Promise<T>;
  readonly onCleanupDiagnostic?: (diagnostic: string) => void;
}): Promise<T> {
  const sandbox = await openEphemeralReviewerWorktree({
    projectRoot: options.projectRoot,
    ...(options.onCleanupDiagnostic === undefined
      ? {}
      : { onCleanupDiagnostic: options.onCleanupDiagnostic }),
  });
  try {
    return await options.run(sandbox.executionCwd);
  } finally {
    await sandbox.close();
  }
}

/**
 * Default Reviewer call: two explicit single-axis public legs in independent
 * ephemeral detached worktrees, started as one parallel batch. Each leg reuses
 * the caller's public argv and only adds `--lens` (10a). Worktrees are stateless
 * execution sandboxes — created from the caller's current HEAD, always deleted
 * when the call ends (delete failure is diagnostic only). Lifecycle stays in
 * this shared summons seam, never in the role module (#946).
 */
export async function summonParallelReviewerLenses(options: {
  /** Public argv after the role token; must not already carry `--lens`. */
  readonly argv: readonly string[];
  /** Same cwd the single-axis public entry would receive for this call. */
  readonly cwd: string;
  readonly projectRoot: string;
  /** Typed --base from the public parse; used only for pre-worktree fail-closed check. */
  readonly baseRevision: string;
  readonly home: string;
  readonly agentDir?: string;
  readonly credentials?: CredentialProviders;
  readonly model?: RoleTurnModelConfig;
  readonly host?: string;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly packageRoot?: string;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly roleTurnHost?: RoleTurnHost;
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  readonly principalAuthority?: DurablePrincipalAuthority;
  readonly timeoutMs?: number;
}): Promise<{
  readonly completeness: PublicSummonResult;
  readonly correctness: PublicSummonResult;
}> {
  const describeFailure = (error: unknown): string => {
    if (error instanceof AggregateError) {
      return [error.message, ...error.errors.map(describeFailure)].join("\n");
    }
    return error instanceof Error ? error.message : String(error);
  };
  const failedResult = (error: unknown): PublicSummonResult => ({
    exitCode: 1,
    stderr: describeFailure(error),
  });
  const dualFailure = (error: unknown) => {
    const failure = failedResult(error);
    return { completeness: failure, correctness: failure } as const;
  };

  // Worktree prep shares one root: git toplevel, never a subdir input.
  // Caller project may be a repo subdirectory; child sandboxes keep that relative path.
  // Every pre-dispatch target check failure keeps the existing dual-child batch surface.
  let sourceProjectRoot: string;
  let projectRelative: string;
  let targetCommit: string;
  const statusArgs = [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ":/",
    ":(top,exclude).claude/worktrees/**",
  ] as const;
  try {
    const roots = await resolveReviewerWorktreeRoots(options.projectRoot);
    sourceProjectRoot = roots.sourceProjectRoot;
    projectRelative = roots.projectRelative;
    const { stdout: statusStdout } = await execFileAsync("git", statusArgs, {
      cwd: sourceProjectRoot,
    });
    if (statusStdout !== "") {
      const diagnostic = [
        "Reviewer target status gate failed:",
        "git status --porcelain=v1 --untracked-files=all -- :/ ':(top,exclude).claude/worktrees/**'",
        statusStdout,
      ].join("\n");
      return dualFailure(new Error(diagnostic));
    }
    const { stdout: targetStdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: sourceProjectRoot },
    );
    targetCommit = targetStdout.trim();
    // Typed base from the public parse — covers --base value and --base=value alike.
    // Child legs still carry the original argv token unchanged (10a).
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${options.baseRevision}^{commit}`],
      { cwd: sourceProjectRoot },
    );
  } catch (error) {
    return dualFailure(error);
  }
  const root = await mkdtemp(join(tmpdir(), "ak-reviewer-lenses-"));
  const completenessRoot = join(root, "completeness");
  const correctnessRoot = join(root, "correctness");
  const worktrees = [completenessRoot, correctnessRoot] as const;
  const created = new Set<string>();
  let results: { completeness: PublicSummonResult; correctness: PublicSummonResult };
  const creation = await Promise.allSettled(
    worktrees.map(async (path) => {
      await execFileAsync("git", ["worktree", "add", "--detach", path, targetCommit], {
        cwd: sourceProjectRoot,
      });
      // Git has registered the worktree — enter the rollback set before any further
      // prep (mkdir / deps) so a later failure cannot leak the entry.
      created.add(path);
      // Preserve caller subdirectory even when it is not present in the pinned commit.
      if (projectRelative !== "") {
        await mkdir(reviewerSandboxPath(path, projectRelative), { recursive: true });
      }
      await provisionReviewerWorktreeDeps(sourceProjectRoot, path);
    }),
  );
  const creationFailures = creation.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (creationFailures.length > 0) {
    const failure = failedResult(new AggregateError(
      creationFailures,
      "parallel reviewer worktree creation failed",
    ));
    results = { completeness: failure, correctness: failure };
  } else {
    const summon = (
      lens: "completeness" | "correctness",
      worktreeAxis: string,
    ): Promise<PublicSummonResult> => {
      // Single-axis public entry as-is: caller's argv + only --lens, under the
      // same cwd the omitted-lens call used. Durable projectRoot admits from
      // that argv/cwd pair. Ephemeral worktree is executionCwd only (#946).
      const sandbox = reviewerSandboxPath(worktreeAxis, projectRelative);
      return summonPublicRole({
        role: "reviewer",
        argv: withReviewerLens(options.argv, lens),
        cwd: options.cwd,
        executionCwd: sandbox,
        // Ordinary single-axis public semantics — not a nested court station.
        stationChild: false,
        home: options.home,
        ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(options.engineModel === undefined ? {} : { engineModel: options.engineModel }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
        ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
        ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
        ...(options.principalAuthority === undefined
          ? {}
          : { principalAuthority: options.principalAuthority }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    };
    const settled = await Promise.allSettled([
      summon("completeness", completenessRoot),
      summon("correctness", correctnessRoot),
    ]);
    results = {
      completeness: settled[0].status === "fulfilled"
        ? settled[0].value
        : failedResult(settled[0].reason),
      correctness: settled[1].status === "fulfilled"
        ? settled[1].value
        : failedResult(settled[1].reason),
    };
  }
  let sealDiagnostic: string | undefined;
  try {
    const { stdout: headBeforeStdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: sourceProjectRoot },
    );
    const { stdout: sealedStatusStdout } = await execFileAsync("git", statusArgs, {
      cwd: sourceProjectRoot,
    });
    const { stdout: headAfterStdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: sourceProjectRoot },
    );
    const headBefore = headBeforeStdout.trim();
    const headAfter = headAfterStdout.trim();
    if (
      headBefore !== targetCommit
      || headAfter !== targetCommit
      || sealedStatusStdout !== ""
    ) {
      sealDiagnostic = [
        "Reviewer target final seal failed:",
        `HEAD before status => ${headBefore}`,
        `HEAD after status => ${headAfter}`,
        `expected PRE_HEAD ${targetCommit}`,
        "git status --porcelain=v1 --untracked-files=all -- :/ ':(top,exclude).claude/worktrees/**'",
        sealedStatusStdout,
      ].join("\n");
    }
  } catch (error) {
    sealDiagnostic = `Reviewer target final seal failed:\n${describeFailure(error)}`;
  }
  if (sealDiagnostic !== undefined) {
    const withSealFailure = (result: PublicSummonResult): PublicSummonResult => ({
      ...result,
      exitCode: 1,
      stderr: [result.stderr, sealDiagnostic].filter(
        (text): text is string => typeof text === "string" && text !== "",
      ).join("\n"),
    });
    results = {
      completeness: withSealFailure(results.completeness),
      correctness: withSealFailure(results.correctness),
    };
  }
  // Stateless worktrees: always remove every axis created for this call.
  // Delete failure is diagnostic only — do not flip child exit codes; leftover
  // tmp dirs are left to the OS and git worktree prune (#946).
  const cleanup = await Promise.allSettled(
    [...created].map((path) =>
      // --force: ephemeral sandboxes may carry provisioned ignored deps (#983).
      execFileAsync("git", ["worktree", "remove", "--force", path], { cwd: sourceProjectRoot })),
  );
  const cleanupFailures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (cleanupFailures.length === 0) {
    const rootCleanup = await Promise.allSettled([rm(root, { recursive: true, force: true })]);
    cleanupFailures.push(...rootCleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []));
  }
  if (cleanupFailures.length > 0) {
    const diagnostic = [
      "parallel reviewer worktree cleanup failed",
      ...cleanupFailures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure)),
    ].join("\n");
    const withCleanupDiagnostic = (result: PublicSummonResult): PublicSummonResult => ({
      ...result,
      stderr: [result.stderr, diagnostic].filter(
        (text): text is string => typeof text === "string" && text !== "",
      ).join("\n"),
    });
    results = {
      completeness: withCleanupDiagnostic(results.completeness),
      correctness: withCleanupDiagnostic(results.correctness),
    };
  }
  return results;
}

/** Gate officer summons: notary/auditor via --source-run; inspector via pointer; countersign via ticket (#969). */
export async function summonGateOfficer(options: {
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  readonly sourceRunDirectory: string;
  readonly cwd: string;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
  /** Parent cancellation for the nested officer activation (#675). */
  readonly signal?: AbortSignal;
  /**
   * Plain-language re-ask when the prior officer reply was not three-state (#753 / #756).
   * Officers: reviewReask → same-ticket resume summons.instruction.
   * Never concatenated into argv (inspector parentRunPath is the pure 卷宗指针).
   */
  readonly reask?: string;
  /**
   * In-flight parent 交卷 body (tool-call arguments). Relayed verbatim as officer
   * dialogue content when reask is absent (#879). Binding pointer stays on
   * --source-run / 卷宗指针 / ticket argv — never a content substitute.
   */
  readonly submission?: unknown;
  /** Pi-adapter inject — forwarded to summonPublicRole (not a parent-host override). */
  readonly roleTurnHost?: RoleTurnHost;
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  /** Offline test inject — forwarded to summonPublicRole. */
  readonly createRunId?: () => string;
}): Promise<PublicSummonResult> {
  let home = options.home;
  if (home === undefined) {
    const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
    // Hard path resolve: fail loud — never fall through to packageMachineHome (#604 / #675).
    home = homeFromRunDirectory(options.sourceRunDirectory);
  }
  // Officer host is seat-owned only (#821). Parent invocation.json.host stays a
  // hostTransition consumer in post-admission — not an officer override channel.
  // #879: binding pointer = parent run directory; dialogue content = submission body.
  // Conclusion re-ask keeps sole ownership of reviewReask when present.
  let gateReviewInstruction: string | undefined;
  if (options.reask === undefined && options.submission !== undefined) {
    const { readableGateItem } = await import("./readable-gate-item.ts");
    gateReviewInstruction = readableGateItem(options.submission);
  }
  const common = {
    cwd: options.cwd,
    ...(home === undefined ? {} : { home }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.io === undefined ? {} : { io: options.io }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.reask === undefined ? {} : { reviewReask: options.reask }),
    ...(gateReviewInstruction === undefined
      ? {}
      : { gateReviewInstruction }),
    ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
    ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
  } as const;
  if (options.officer === "notary") {
    // #753/#879: reask or verbatim body rides summons.instruction / first-mint prompt.
    // Binding stays --source-run (never folded into content).
    return summonPublicRole({
      role: "notary",
      argv: ["--source-run", options.sourceRunDirectory, "--project", options.cwd],
      ...common,
    });
  }
  if (options.officer === "auditor") {
    // #756: judge compliance path — same queue law as notary/inspector.
    // Binding pointer on argv; dialogue content rides gateReviewInstruction.
    return summonPublicRole({
      role: "auditor",
      argv: [
        "--subject",
        "judge",
        "--source-run",
        options.sourceRunDirectory,
        `卷宗指针：${options.sourceRunDirectory}`,
      ],
      ...common,
    });
  }
  if (options.officer === "countersign") {
    // #969: Secretariat submission gate → 给事中.
    // Dialogue / identity instruction = parent typed payload 原话 (ADR 0079) or reask;
    // no code-authored summons prose (#924). Ticket identity = parent run durable
    // board binding only (readBoardTicketNumber) — receipt ticketNumber is payload
    // content, never the sole identity source; parent true-unbound stays unbound.
    // correlationId only on this officer — notary/auditor/inspector stay untouched.
    const { runIdFromRunDirectory } = await import("./run-terminal-artifacts.ts");
    const correlationId = runIdFromRunDirectory(options.sourceRunDirectory);
    if (correlationId === undefined || correlationId.trim() === "") {
      throw new Error(
        `countersign gate summon requires parent runId from sourceRunDirectory: ${options.sourceRunDirectory}`,
      );
    }
    const { readBoardTicketNumber } = await import("./run-ticket-number.ts");
    const parentTicket = await readBoardTicketNumber(options.sourceRunDirectory);
    // Argv instruction = reask or parent payload bytes only (never a fabricated line).
    const instruction = options.reask ?? gateReviewInstruction ?? "";
    return summonPublicRole({
      role: "countersign",
      argv: ["--project", options.cwd, "--", instruction],
      ...common,
      correlationId,
      ...(parentTicket === undefined ? {} : { boundTicketNumber: parentTicket }),
    });
  }
  // Inspector: argv stays pure 卷宗指针 (#747 parentRunPath lookup key).
  // Content (body/reask) rides env → summons.instruction / first-mint prompt.
  return summonPublicRole({
    role: "inspector",
    argv: [`卷宗指针：${options.sourceRunDirectory}`],
    ...common,
  });
}
