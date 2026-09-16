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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CliIo } from "./public-cli/cli-io.ts";
import type { CredentialProviders, EffectiveSeat } from "./public-cli/config.ts";
import type { PublicCallableRole } from "./public-cli/registry.ts";
import type { RoleTurnHost, RoleTurnRequest } from "./host-contracts.ts";
import type { AdmittedReviewerInvocation } from "./public-cli/invocation.ts";
import type { PostAdmissionAdapters, PostAdmissionEnv } from "./public-cli/post-admission.ts";
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
  readonly model?: import("./host-contracts.ts").RoleTurnModelConfig;
  readonly host?: string;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly agentDir?: string;
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
  readonly principalAuthority: import("./host-contracts.ts").DurablePrincipalAuthority;
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
  const principalAuthority = piDurablePrincipalAuthority;
  // Host first → argv (afterHost) → missing-model → provider projection (#617/#178/#840).
  const roleTurnHost = resolveRoleTurnHost(
    {
      packageRoot: options.packageRoot,
      ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
      ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
      ...(options.extraPiArgs === undefined || options.extraPiArgs.length === 0
        ? {}
        : { extraPiArgs: options.extraPiArgs }),
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
  const { loadHostProvidersTable, projectHostFacingProvider } = await import(
    "./public-cli/host-providers.ts"
  );
  const hostFacingSelection = projectHostFacingProvider(
    seatWithModel.selection,
    hostName,
    loadHostProvidersTable(options.home),
    options.home,
  );
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
          stationChild: true,
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
      const [{ runPublicInstructionSeat }, invocation] = await Promise.all([
        import("./public-cli/instruction-seat-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      const parse =
        seat === "auditor"
          ? invocation.parseAuditorArgv
          : seat === "navigator"
            ? invocation.parseNavigatorArgv
            : invocation.parseGatekeeperArgv;
      const stepped = await runPrepared(parse, (env, once) =>
        runPublicInstructionSeat(options.argv, env as never, io, seat, once));
      if ("fail" in stepped) return stepped.fail;
      result = stepped.ok;
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
 * Default Reviewer call: two explicit single-axis public legs in independent
 * detached worktrees, started as one parallel batch. Worktree lifecycle stays
 * in this shared summons seam, never in the role module.
 */
export async function summonParallelReviewerLenses(options: {
  readonly projectRoot: string;
  readonly baseRevision: string;
  readonly authorityRefs: readonly string[];
  readonly instruction: string;
  readonly home: string;
  readonly agentDir?: string;
  readonly credentials?: CredentialProviders;
  readonly model?: import("./host-contracts.ts").RoleTurnModelConfig;
  readonly host?: string;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly packageRoot?: string;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly roleTurnHost?: RoleTurnHost;
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  readonly createRunId?: () => string;
}): Promise<{
  readonly completeness: PublicSummonResult;
  readonly correctness: PublicSummonResult;
}> {
  const statusArgs = [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ":/",
    ":(top,exclude).claude/worktrees/**",
  ] as const;
  const { stdout: statusStdout } = await execFileAsync("git", statusArgs, {
    cwd: options.projectRoot,
  });
  if (statusStdout !== "") {
    const diagnostic = [
      "Reviewer target status gate failed:",
      "git status --porcelain=v1 --untracked-files=all -- :/ ':(top,exclude).claude/worktrees/**'",
      statusStdout,
    ].join("\n");
    const failure = { exitCode: 1, stderr: diagnostic } as const;
    return { completeness: failure, correctness: failure };
  }
  const { stdout: targetStdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: options.projectRoot },
  );
  const targetCommit = targetStdout.trim();
  const { stdout: baseStdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${options.baseRevision}^{commit}`],
    { cwd: options.projectRoot },
  );
  const baseCommit = baseStdout.trim();
  const root = await mkdtemp(join(tmpdir(), "ak-reviewer-lenses-"));
  const completenessRoot = join(root, "completeness");
  const correctnessRoot = join(root, "correctness");
  const worktrees = [completenessRoot, correctnessRoot] as const;
  const created = new Set<string>();
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
  let results: { completeness: PublicSummonResult; correctness: PublicSummonResult };
  const creation = await Promise.allSettled(
    worktrees.map(async (path) => {
      await execFileAsync("git", ["worktree", "add", "--detach", path, targetCommit], {
        cwd: options.projectRoot,
      });
      created.add(path);
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
    const summon = (lens: "completeness" | "correctness", cwd: string) =>
      summonPublicRole({
        role: "reviewer",
        argv: [
          "--project", cwd,
          "--base", baseCommit,
          ...options.authorityRefs.flatMap((ref) => ["--authority-ref", ref]),
          "--lens", lens,
          ...(options.instruction === "" ? [] : ["--", options.instruction]),
        ],
        cwd,
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
        ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
      });
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
      { cwd: options.projectRoot },
    );
    const { stdout: sealedStatusStdout } = await execFileAsync("git", statusArgs, {
      cwd: options.projectRoot,
    });
    const { stdout: headAfterStdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: options.projectRoot },
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
  const resumableWorktrees = new Set([
    ...(results.completeness.terminal?.resume === undefined ? [] : [completenessRoot]),
    ...(results.correctness.terminal?.resume === undefined ? [] : [correctnessRoot]),
  ]);
  const cleanup = await Promise.allSettled(
    [...created]
      .filter((path) => !resumableWorktrees.has(path))
      .map((path) =>
        execFileAsync("git", ["worktree", "remove", path], { cwd: options.projectRoot })),
  );
  const cleanupFailures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (cleanupFailures.length === 0 && resumableWorktrees.size === 0) {
    const rootCleanup = await Promise.allSettled([rm(root, { recursive: true })]);
    cleanupFailures.push(...rootCleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []));
  }
  if (cleanupFailures.length > 0) {
    const diagnostic = [
      "parallel reviewer worktree cleanup failed",
      ...cleanupFailures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure)),
    ].join("\n");
    const withCleanupFailure = (result: PublicSummonResult): PublicSummonResult => ({
      ...result,
      exitCode: 1,
      stderr: [result.stderr, diagnostic].filter(
        (text): text is string => typeof text === "string" && text !== "",
      ).join("\n"),
    });
    results = {
      completeness: withCleanupFailure(results.completeness),
      correctness: withCleanupFailure(results.correctness),
    };
  }
  return results;
}

export function createParallelReviewerExecution(
  admitted: () => AdmittedReviewerInvocation,
  instruction: () => string,
  env: PostAdmissionEnv,
  fallback: PostAdmissionAdapters<AdmittedReviewerInvocation>,
  defaultAutoResumeLimit: number,
) {
  let children: Awaited<ReturnType<typeof summonParallelReviewerLenses>> | undefined;
  const adapters: PostAdmissionAdapters<AdmittedReviewerInvocation> = {
    async trySettle(parent, authority, scope) {
      if (parent.lens !== "all") return fallback.trySettle(parent, authority, scope);
      if (children === undefined) return undefined;
      const { settleParallelReviewerTerminalResult } = await import("./public-cli/settlement.ts");
      return settleParallelReviewerTerminalResult(parent, authority, children);
    },
    shouldPresentSettled: (terminal: TerminalResult) =>
      admitted().lens === "all" || terminal.roleOutcome.kind === "accepted",
    ...(fallback.resolveRunnerKnownFailure === undefined
      ? {}
      : { resolveRunnerKnownFailure: fallback.resolveRunnerKnownFailure }),
  };
  return {
    env: {
      ...env,
      get autoResumeLimit() {
        return admitted().lens === "all"
          ? 0
          : env.autoResumeLimit ?? defaultAutoResumeLimit;
      },
      roleTurnHost: {
        async executeTurn(request: RoleTurnRequest) {
          const parent = admitted();
          if (parent.lens !== "all") return env.roleTurnHost.executeTurn(request);
          const coordinates = env.principalAuthority.decode(parent.principal);
          await mkdir(coordinates.sessionDirectory, { recursive: true });
          await writeFile(coordinates.sessionFile, "", { encoding: "utf8", flag: "a" });
          children = await summonParallelReviewerLenses({
            projectRoot: parent.projectRoot,
            baseRevision: parent.baseRevision,
            authorityRefs: parent.authorityRefs,
            instruction: instruction(),
            home: env.home,
            ...(env.model === undefined ? {} : { model: env.model }),
            ...(env.host === undefined ? {} : { host: env.host }),
            ...(env.engine === undefined ? {} : { engine: env.engine }),
            ...(env.engineModel === undefined ? {} : { engineModel: env.engineModel }),
            packageRoot: env.packageRoot,
            agentDir: env.agentDir,
            ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
            ...(env.signal === undefined ? {} : { signal: env.signal }),
            correlationId: parent.runId,
            roleTurnHost: env.roleTurnHost,
            ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
          });
          return { code: 0, stderr: "", timedOut: false };
        },
      },
    },
    adapters,
  };
}

/** Gate officer summons: notary/auditor via --source-run; inspector via pointer instruction. */
export async function summonGateOfficer(options: {
  readonly officer: "inspector" | "notary" | "auditor";
  readonly sourceRunDirectory: string;
  readonly cwd: string;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
  /** Parent cancellation for the nested officer activation (#675). */
  readonly signal?: AbortSignal;
  /**
   * Plain-language re-ask when the prior officer reply was not three-state (#753 / #756).
   * All three officers: reviewReask → same-ticket resume summons.instruction.
   * Never concatenated into argv (inspector parentRunPath is the pure 卷宗指针).
   */
  readonly reask?: string;
  /**
   * In-flight parent 交卷 body (tool-call arguments). Relayed verbatim as officer
   * dialogue content when reask is absent (#879). Binding pointer stays on
   * --source-run / 卷宗指针 argv — never a content substitute.
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
  // Inspector: argv stays pure 卷宗指针 (#747 parentRunPath lookup key).
  // Content (body/reask) rides env → summons.instruction / first-mint prompt.
  return summonPublicRole({
    role: "inspector",
    argv: [`卷宗指针：${options.sourceRunDirectory}`],
    ...common,
  });
}
